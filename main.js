/*
 * Auto Note Mover Plus (v1.0.0)
 *
 * A fork of faru's Auto Note Mover v1.2.0 (MIT, https://github.com/farux/obsidian-auto-note-mover). The original semantics are
 * preserved exactly, because they are what this vault is already filed by:
 *
 *   - rules are evaluated in `folder_tag_pattern` order, FIRST MATCH WINS
 *   - a rule with a pattern is a regex against the note BASENAME
 *   - a rule with a tag is EXACT tag equality (getAllTags), unless regex tags are on
 *   - excluded folders are compared to the note's CURRENT PARENT path
 *   - `AutoNoteMover: disable` in frontmatter skips the note
 *   - `trigger_auto_manual` gates everything except the command path
 *
 * Added in this fork, all backwards compatible with the v1.2.0 data.json:
 *
 *   - property conditions with Excel-style comparison + dates
 *     ({property: "due", op: "older_than", value: "14d"}, gt/lt/between/in/...)
 *   - optional arrays `conditions` / `block` for multi-condition rules
 *   - per-rule `settle` and a global `settle_ms`: a note is only filed after it
 *     has been quiet that long, so a half-typed tag never files it
 *   - "Preview moves" dialog with per-row checkboxes; nothing moves unconfirmed
 *   - destination folders are created instead of failing
 */

const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, Notice, Modal, TFile, normalizePath } = obsidian;

/* ------------------------------------------------------------------ */
/* Engine                                                             */
/* ------------------------------------------------------------------ */

const OPS = [
  'equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with',
  'regex', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'not_in',
  'exists', 'missing', 'empty', 'not_empty',
  'before', 'after', 'on', 'within', 'older_than', 'newer_than', 'weekday', 'month',
];
const DURATION_OPS = new Set(['within', 'older_than', 'newer_than']);
const ORDERING_OPS = new Set(['gt', 'gte', 'lt', 'lte', 'between']);
const FILE_PROPS = new Set(['file.mtime', 'file.ctime', 'file.age', 'file.size',
  'file.name', 'file.folder', 'file.path', 'file.ext']);
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

const DT_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;
const DUR_RE = /^([+-]?)(\d+(?:\.\d+)?)\s*(ms|s|min|m|h|d|w|mo|y)$/i;

function parseDateMs(value) {
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value !== 'string') return null;
  const m = DT_RE.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, frac, off] = m;
  const ms = frac ? Number((frac + '000000').slice(0, 3)) : 0;
  let t;
  if (off) {
    let offsetMin = 0;
    if (off.toUpperCase() !== 'Z') {
      const sign = off[0] === '+' ? 1 : -1;
      const digits = off.slice(1).replace(':', '');
      offsetMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
    }
    t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh || 0), Number(mm || 0),
      Number(ss || 0), ms) - offsetMin * 60000;
  } else {
    t = new Date(Number(y), Number(mo) - 1, Number(d), Number(hh || 0), Number(mm || 0),
      Number(ss || 0), ms).getTime();
  }
  return isNaN(t) ? null : t;
}

function parseDurationMs(value) {
  if (typeof value === 'number') return value * 1000;
  if (typeof value !== 'string') return null;
  const m = DUR_RE.exec(value.trim());
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const n = Number(m[2]);
  const unit = m[3].toLowerCase();
  const factor = { ms: 1, s: 1000, min: 60000, m: 60000, h: 3600000, d: 86400000,
    w: 604800000, mo: 2629800000, y: 31557600000 }[unit];
  return factor ? sign * n * factor : null;
}

function parseWhenMs(value, nowMs) {
  const abs = parseDateMs(value);
  if (abs !== null) return abs;
  if (typeof value !== 'string') return null;
  const word = value.trim().toLowerCase();
  const now = new Date(nowMs);
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const DAY = 86400000;
  if (word === 'now') return nowMs;
  if (word === 'today') return dayStart;
  if (word === 'yesterday') return dayStart - DAY;
  if (word === 'tomorrow') return dayStart + DAY;
  if (word === 'start_of_week') return dayStart - ((now.getDay() + 6) % 7) * DAY;
  if (word === 'start_of_month') return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  if (word === 'start_of_year') return new Date(now.getFullYear(), 0, 1).getTime();
  if (word === 'end_of_month') return new Date(now.getFullYear(), now.getMonth() + 1, 0).getTime();
  if (word === 'end_of_year') return new Date(now.getFullYear(), 11, 31).getTime();
  const dur = parseDurationMs(value);
  return dur === null ? null : nowMs + dur;
}

const asList = (v) => (v === undefined || v === null ? null : (Array.isArray(v) ? v : [v]));
const isBoolLike = (v) => typeof v === 'boolean' || (typeof v === 'string' && /^(true|false)$/i.test(v.trim()));
const toBool = (v) => (typeof v === 'boolean' ? v : String(v).trim().toLowerCase() === 'true');
function numOrNull(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'boolean') return null;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return null;
}

function eqValues(a, b) {
  if (isBoolLike(a) && isBoolLike(b)) return toBool(a) === toBool(b);
  const na = numOrNull(a), nb = numOrNull(b);
  if (na !== null && nb !== null) return Math.abs(na - nb) < 1e-9;
  const da = parseDateMs(a), db = parseDateMs(b);
  if (da !== null && db !== null) return da === db;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function weekdayOf(value) {
  if (typeof value === 'number' && value >= 0 && value <= 6) return WEEKDAYS[value];
  const s = String(value).trim().toLowerCase();
  return WEEKDAYS.find((w) => w.startsWith(s.slice(0, 3))) || null;
}

function monthOf(value) {
  if (typeof value === 'number' && value >= 1 && value <= 12) return value;
  const s = String(value).trim().toLowerCase();
  if (/^\d{1,2}$/.test(s)) { const n = Number(s); return n >= 1 && n <= 12 ? n : null; }
  const i = MONTHS.findIndex((m) => m.startsWith(s.slice(0, 3)));
  return i >= 0 ? i + 1 : null;
}

function valuesFor(cond, ctx) {
  const prop = cond.property;
  if (!prop) return null;
  if (prop.startsWith('file.')) {
    if (!FILE_PROPS.has(prop)) return null;
    const st = ctx.stat || {};
    switch (prop) {
      // Date pseudo-properties are wrapped as Date objects: parseDateMs rejects
      // bare numbers (they are values in their own right), so handing it an epoch
      // millisecond count silently made every file.mtime rule false.
      case 'file.mtime': return st.mtime != null ? [new Date(st.mtime)] : null;
      case 'file.ctime': return st.ctime != null ? [new Date(st.ctime)] : null;
      case 'file.age': return st.mtime != null ? [(ctx.now - st.mtime) / 86400000] : null;
      case 'file.size': return st.size != null ? [st.size] : null;
      case 'file.name': return [ctx.basename];
      case 'file.folder': return [ctx.folder];
      case 'file.path': return [ctx.path];
      case 'file.ext': return ['md'];
      default: return null;
    }
  }
  const fm = ctx.frontmatter || {};
  if (!Object.prototype.hasOwnProperty.call(fm, prop)) return null;
  return asList(fm[prop]);
}

function checkCondition(cond, ctx) {
  if (!cond || typeof cond !== 'object') return [false, 'empty condition'];

  if (cond.tag !== undefined) {
    const want = String(cond.tag).trim();
    if (!want) return [false, 'empty tag'];
    const tagged = want.startsWith('#') ? want : '#' + want;
    return [ctx.tags.includes(tagged), ''];
  }
  if (cond.pattern !== undefined) {
    try { return [new RegExp(cond.pattern).test(ctx.basename), '']; }
    catch (e) { return [false, 'bad pattern: ' + e.message]; }
  }

  const op = cond.op || 'equals';
  const vals = valuesFor(cond, ctx);
  const name = cond.property;
  if (vals === null) return [op === 'missing', 'no such property: ' + name];
  if (!vals.length && (op === 'exists' || op === 'not_empty')) return [false, name + ' is empty'];

  const want = cond.value;
  if (op === 'exists') return [true, ''];
  if (op === 'empty' || op === 'not_empty') {
    const isEmpty = !vals.length || vals.every((v) => v === '' || v === null || v === undefined);
    return op === 'empty' ? [isEmpty, ''] : [!isEmpty, ''];
  }
  if (op === 'in' || op === 'not_in') {
    const allowed = Array.isArray(want) ? want : [want];
    const hit = vals.some((v) => allowed.some((a) => eqValues(v, a)));
    return op === 'in' ? [hit, ''] : [!hit, ''];
  }
  if (op === 'between') {
    const [lo, hi] = Array.isArray(want) ? want : [null, null];
    const loMs = parseWhenMs(lo, ctx.now), hiMs = parseWhenMs(hi, ctx.now);
    return [vals.some((v) => {
      const ms = parseDateMs(v);
      if (ms !== null && loMs !== null && hiMs !== null) return ms >= loMs && ms <= hiMs;
      const n = numOrNull(v), l = numOrNull(lo), h = numOrNull(hi);
      return n !== null && l !== null && h !== null && n >= l && n <= h;
    }), ''];
  }
  if (DURATION_OPS.has(op)) {
    const dur = parseDurationMs(want);
    if (dur === null) return [false, op + ' needs a duration'];
    const threshold = ctx.now - Math.abs(dur);
    return [vals.some((v) => {
      const ms = parseDateMs(v);
      if (ms === null) return false;
      return op === 'older_than' ? ms <= threshold : ms >= threshold;
    }), ''];
  }
  if (op === 'weekday' || op === 'month') {
    const wanted = (Array.isArray(want) ? want : [want])
      .map(op === 'weekday' ? weekdayOf : monthOf).filter((x) => x !== null);
    if (!wanted.length) return [false, op + ' needs a valid value'];
    return [vals.some((v) => {
      const ms = parseDateMs(v);
      if (ms === null) return false;
      const d = new Date(ms);
      return op === 'weekday' ? wanted.includes(WEEKDAYS[(d.getDay() + 6) % 7]) : wanted.includes(d.getMonth() + 1);
    }), ''];
  }
  if (op === 'before' || op === 'after' || op === 'on') {
    const target = parseWhenMs(want, ctx.now);
    if (target === null) return [false, op + ' needs a date'];
    return [vals.some((v) => {
      const ms = parseDateMs(v);
      if (ms === null) return false;
      if (op === 'on') {
        const a = new Date(ms), b = new Date(target);
        return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
      }
      return op === 'before' ? ms < target : ms > target;
    }), ''];
  }

  for (const v of vals) {
    let ok = false;
    if (op === 'equals') ok = eqValues(v, want);
    else if (op === 'not_equals') ok = !eqValues(v, want);
    else if (op === 'contains') ok = String(v).toLowerCase().includes(String(want).toLowerCase());
    else if (op === 'not_contains') ok = !String(v).toLowerCase().includes(String(want).toLowerCase());
    else if (op === 'starts_with') ok = String(v).toLowerCase().startsWith(String(want).toLowerCase());
    else if (op === 'ends_with') ok = String(v).toLowerCase().endsWith(String(want).toLowerCase());
    else if (op === 'regex') {
      try { ok = new RegExp(String(want), 'i').test(String(v)); } catch (e) { return [false, 'bad regex']; }
    } else if (ORDERING_OPS.has(op)) {
      const vm = parseDateMs(v), wm = parseWhenMs(want, ctx.now);
      if (vm !== null && wm !== null) {
        ok = op === 'gt' ? vm > wm : op === 'gte' ? vm >= wm : op === 'lt' ? vm < wm : vm <= wm;
      } else {
        const vn = numOrNull(v), wn = numOrNull(want);
        if (vn === null || wn === null) return [false, 'not comparable'];
        ok = op === 'gt' ? vn > wn : op === 'gte' ? vn >= wn : op === 'lt' ? vn < wn : vn <= wn;
      }
    } else return [false, 'unknown op ' + op];
    if (ok) return [true, ''];
  }
  return [false, `${name} fails ${op}`];
}

/**
 * Does a rule match? Extended rules first (`conditions`, then `property`), then the
 * original Auto Note Mover branches (pattern, then tag) so v1.2.0 rule arrays keep
 * behaving exactly as before.
 */
function ruleMatches(rule, ctx) {
  if (!rule || rule.enabled === false) return false;

  const blockers = rule.block || [];
  for (const b of blockers) if (checkCondition(b, ctx)[0]) return false;

  if (Array.isArray(rule.conditions) && rule.conditions.length) {
    const results = rule.conditions.map((c) => checkCondition(c, ctx)[0]);
    return String(rule.match || 'all').toLowerCase() === 'any'
      ? results.some(Boolean) : results.every(Boolean);
  }
  if (rule.property) {
    return checkCondition({ property: rule.property, op: rule.op || 'equals', value: rule.value }, ctx)[0];
  }
  if (rule.pattern) {
    try { return new RegExp(rule.pattern).test(ctx.basename); } catch (e) { return false; }
  }
  if (rule.tag) return ctx.tags.includes(String(rule.tag).trim());
  return false;
}

function firstMatch(rules, ctx) {
  for (const r of rules || []) if (ruleMatches(r, ctx)) return r;
  return null;
}

/* ------------------------------------------------------------------ */
/* Plugin                                                             */
/* ------------------------------------------------------------------ */

const DEFAULTS = {
  trigger_auto_manual: 'Automatic',
  use_regex_to_check_for_tags: false,
  statusBar_trigger_indicator: true,
  folder_tag_pattern: [],
  use_regex_to_check_for_excluded_folder: false,
  excluded_folder: [],
  settle_ms: 2000,
};

class AutoNoteMoverPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.pending = new Map();
    this.addSettingTab(new AnmSettingTab(this.app, this));

    this.statusEl = null;
    if (this.settings.statusBar_trigger_indicator) {
      this.statusEl = this.addStatusBarItem();
      this.renderStatus();
    }

    const auto = () => String(this.settings.trigger_auto_manual) !== 'Manual';
    const onEvent = (kind) => (file) => {
      if (!auto()) return;
      this.schedule(file, kind);
    };

    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on('create', onEvent('created')));
      this.registerEvent(this.app.metadataCache.on('changed', onEvent('modified')));
      this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
        if (!auto()) return;
        // Original guard: a rename that keeps the filename is a MOVE, not a rename.
        if (oldPath.split('/').pop() === file.name) return;
        this.schedule(file, 'renamed');
      }));
    });

    this.addCommand({ id: 'move-the-note', name: 'Move the note', checkCallback: (checking) => {
      const f = this.app.workspace.getActiveFile();
      if (!f) return false;
      if (!checking) this.moveNow(f, 'cmd', true);
      return true;
    } });
    this.addCommand({ id: 'preview-moves', name: 'Preview moves (whole vault)', callback: () => this.preview() });
    this.addCommand({ id: 'toggle-auto-manual', name: 'Toggle automatic filing', callback: async () => {
      this.settings.trigger_auto_manual = String(this.settings.trigger_auto_manual) === 'Automatic' ? 'Manual' : 'Automatic';
      await this.saveSettings();
      this.renderStatus();
      new Notice(`[Auto Note Mover+] Trigger is ${this.settings.trigger_auto_manual}.`);
    } });
  }

  onunload() {
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

  renderStatus() {
    if (!this.statusEl) return;
    this.statusEl.setText(String(this.settings.trigger_auto_manual) === 'Automatic' ? '[A]' : '[M]');
  }

  async loadSettings() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULTS, data);
    if (!Array.isArray(this.settings.folder_tag_pattern)) this.settings.folder_tag_pattern = [];
    if (!Array.isArray(this.settings.excluded_folder)) this.settings.excluded_folder = [];
  }

  async saveSettings() { await this.saveData(this.settings); }

  /** Quiet-period debounce; a rule's own `settle` wins over the global value. */
  schedule(file, kind) {
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    const prior = this.pending.get(file.path);
    if (prior) clearTimeout(prior.timer);

    const ctx = this.context(file);
    const rule = ctx ? firstMatch(this.settings.folder_tag_pattern, ctx) : null;
    const raw = rule && rule.settle !== undefined ? rule.settle : this.settings.settle_ms;
    const ms = parseDurationMs(raw);
    const wait = Math.max(0, ms === null ? 2000 : ms);

    const timer = setTimeout(() => {
      this.pending.delete(file.path);
      const fresh = this.app.vault.getAbstractFileByPath(file.path);
      if (fresh instanceof TFile) this.moveNow(fresh, kind, true);
    }, wait);

    this.pending.set(file.path, { timer, kind });
  }

  context(file) {
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache) return null;
    let tags = [];
    try { tags = obsidian.getAllTags(cache) || []; } catch (e) { tags = Object.keys(cache.tags || {}); }
    return {
      frontmatter: cache.frontmatter || {},
      tags,
      basename: file.basename,
      folder: file.parent && file.parent.path !== '/' ? file.parent.path : '',
      path: file.path,
      now: Date.now(),
      stat: { mtime: file.stat && file.stat.mtime, ctime: file.stat && file.stat.ctime, size: file.stat && file.stat.size },
    };
  }

  isExcluded(ctx) {
    const useRegex = !!this.settings.use_regex_to_check_for_excluded_folder;
    for (const entry of this.settings.excluded_folder || []) {
      const folder = typeof entry === 'string' ? entry : entry && entry.folder;
      if (!folder) continue;
      if (useRegex) {
        try { if (new RegExp(folder).test(ctx.folder)) return true; } catch (e) { /* ignore */ }
      } else if (ctx.folder === String(folder).replace(/^\/+|\/+$/g, '')) {
        return true;
      }
    }
    const fm = ctx.frontmatter || {};
    if (typeof fm.AutoNoteMover === 'string' && /^disable/i.test(fm.AutoNoteMover.trim())) return true;
    return false;
  }

  decide(file) {
    const ctx = this.context(file);
    if (!ctx) return { reason: 'no metadata yet' };
    if (this.isExcluded(ctx)) return { reason: 'excluded folder or AutoNoteMover: disable' };

    const rule = firstMatch(this.settings.folder_tag_pattern, ctx);
    if (!rule) return { reason: 'no rule matched' };

    const target = String(rule.folder || '').replace(/^\/+|\/+$/g, '');
    if (target === ctx.folder) return { reason: 'already in place' };
    const dest = (target ? target + '/' : '') + file.name;
    if (this.app.vault.getAbstractFileByPath(dest)) return { reason: `name collision in ${target || 'root'}` };

    return {
      row: {
        note: file.path, from: ctx.folder || '(root)', to: target || '(root)',
        rule: this.ruleLabel(rule), file,
      },
    };
  }

  ruleLabel(rule) {
    if (Array.isArray(rule.conditions) && rule.conditions.length) {
      return rule.conditions.map(describeCond).join(String(rule.match || 'all') === 'any' ? ' OR ' : ' AND ');
    }
    if (rule.property) return `${rule.property} ${rule.op || 'equals'} ${JSON.stringify(rule.value)}`;
    if (rule.pattern) return `name ~ /${rule.pattern}/`;
    if (rule.tag) return `tag ${rule.tag}`;
    return '(no trigger)';
  }

  async moveNow(file, kind, notify) {
    const decision = this.decide(file);
    if (!decision.row) {
      if (notify && /collision|no metadata/.test(decision.reason || '')) {
        new Notice(`[Auto Note Mover+] ${file.name}: ${decision.reason}`);
      }
      return null;
    }
    const row = decision.row;
    try {
      const target = row.to === '(root)' ? '' : row.to;
      if (target && !this.app.vault.getAbstractFileByPath(target)) await this.app.vault.createFolder(target);
      await this.app.fileManager.renameFile(file, normalizePath((target ? target + '/' : '') + file.name));
      if (notify) new Notice(`[Auto Note Mover+] ${file.name} → ${row.to}`);
      return row;
    } catch (e) {
      if (notify) new Notice(`[Auto Note Mover+] could not move ${file.name}: ${e.message}`);
      return null;
    }
  }

  plan() {
    const rows = [], skipped = {};
    for (const file of this.app.vault.getMarkdownFiles()) {
      const d = this.decide(file);
      if (d.row) rows.push(d.row);
      else if (d.reason) skipped[d.reason] = (skipped[d.reason] || 0) + 1;
    }
    return { rows, skipped };
  }

  preview() {
    const { rows, skipped } = this.plan();
    new PreviewModal(this.app, rows, skipped, async (chosen) => {
      let moved = 0;
      for (const row of chosen) {
        const fresh = this.app.vault.getAbstractFileByPath(row.note);
        if (fresh instanceof TFile && await this.moveNow(fresh, 'preview', false)) moved++;
      }
      new Notice(`[Auto Note Mover+] moved ${moved} of ${chosen.length}`);
    }).open();
  }
}

function describeCond(c) {
  if (c.tag !== undefined) return `tag ${c.tag}`;
  if (c.pattern !== undefined) return `name ~ /${c.pattern}/`;
  return `${c.property} ${c.op || 'equals'} ${JSON.stringify(c.value)}`;
}

/* ------------------------------------------------------------------ */
/* Preview modal                                                      */
/* ------------------------------------------------------------------ */

class PreviewModal extends Modal {
  constructor(app, rows, skipped, onConfirm) {
    super(app);
    this.rows = rows; this.skipped = skipped; this.onConfirm = onConfirm;
    this.selected = new Set(rows.map((r) => r.note));
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: `Preview moves (${this.rows.length})` });
    const skippedText = Object.entries(this.skipped || {}).map(([k, v]) => `${v}× ${k}`).join(' · ');
    if (skippedText) {
      const s = contentEl.createDiv({ cls: 'anm-skipped' });
      s.createEl('strong', { text: 'Skipped: ' });
      s.createSpan({ text: skippedText });
    }
    contentEl.createEl('p', { text: 'Untick anything that should stay put, then confirm.', cls: 'anm-hint' });
    const list = contentEl.createDiv({ cls: 'anm-list' });
    for (const row of this.rows) {
      const line = list.createDiv({ cls: 'anm-row' });
      const cb = line.createEl('input', { type: 'checkbox' });
      cb.checked = true;
      cb.onchange = () => { cb.checked ? this.selected.add(row.note) : this.selected.delete(row.note); };
      line.createSpan({ text: `${row.note} → ${row.to}` });
      line.createEl('em', { text: `  [${row.rule}]` });
    }
    const bar = contentEl.createDiv({ cls: 'anm-actions' });
    const go = bar.createEl('button', { text: 'Move selected' });
    go.addClass('mod-cta');
    go.onclick = async () => {
      const chosen = this.rows.filter((r) => this.selected.has(r.note));
      this.close();
      await this.onConfirm(chosen);
    };
    bar.createEl('button', { text: 'Cancel' }).onclick = () => this.close();
  }

  onClose() { this.contentEl.empty(); }
}

/* ------------------------------------------------------------------ */
/* Input suggestions (folder / tag) — dependency-free                 */
/* ------------------------------------------------------------------ */

/**
 * Attaches an Obsidian-styled suggestion list to a text input. Upstream Auto
 * Note Mover depends on @popperjs/core for this; here the list is positioned
 * from the input's rect and reuses Obsidian's own classes so it looks native.
 */
function attachSuggest(inputEl, source, onPick) {
  if (!inputEl) return;
  const wrap = document.createElement('div');
  wrap.className = 'suggestion-container anm-suggest';
  const list = document.createElement('div');
  list.className = 'suggestion';
  wrap.appendChild(list);
  wrap.style.position = 'fixed';
  wrap.style.display = 'none';
  wrap.style.zIndex = '1000';
  document.body.appendChild(wrap);

  let items = [];

  const close = () => {
    wrap.style.display = 'none';
    items = [];
  };

  const place = () => {
    const r = inputEl.getBoundingClientRect();
    wrap.style.left = r.left + 'px';
    wrap.style.top = r.bottom + 2 + 'px';
    wrap.style.width = r.width + 'px';
  };

  const open = () => {
    const q = inputEl.value.trim().toLowerCase();
    items = source()
      .filter((v) => !q || v.toLowerCase().includes(q))
      .slice(0, 50);
    if (!items.length) return close();
    list.empty();
    for (const value of items) {
      const el = list.createDiv({ cls: 'suggestion-item', text: value });
      el.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        inputEl.value = value;
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        onPick(value);
        close();
      });
    }
    place();
    wrap.style.display = 'block';
  };

  inputEl.addEventListener('input', open);
  inputEl.addEventListener('focus', open);
  inputEl.addEventListener('blur', () => setTimeout(close, 120));
  inputEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') close();
  });
}

const vaultFolders = (app) => () =>
  app.vault.getAllLoadedFiles()
    .filter((f) => f.children)            // TFolder
    .map((f) => f.path)
    .filter((p) => p && p !== '/');

const vaultTags = (app) => () => {
  const set = new Set();
  for (const file of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(file);
    let tags = [];
    try { tags = obsidian.getAllTags(cache) || []; } catch (e) { tags = Object.keys((cache && cache.tags) || {}); }
    for (const t of tags) set.add(t);
  }
  return [...set].sort();
};

function arrayMove(array, fromIndex, toIndex) {
  array.splice(toIndex, 0, array.splice(fromIndex, 1)[0]);
}

/* ------------------------------------------------------------------ */
/* Settings — upstream layout, extended                              */
/* ------------------------------------------------------------------ */

class AnmSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('anm-settings');
    this.containerEl.empty();
    this.add_auto_note_mover_setting();
  }

  add_auto_note_mover_setting() {
    const s = this.plugin.settings;
    this.containerEl.createEl('h2', { text: 'Auto Note Mover Plus' });

    // Same framing sentence as upstream, with the fork's extra trigger source named.
    new Setting(this.containerEl).setDesc(
      'Auto Note Mover Plus will automatically move the active notes to their respective folders according to the rules.',
    );

    /* ---- Trigger (upstream wording) ---- */
    const descEl = document.createDocumentFragment();
    const triggerDesc = document.createDocumentFragment();
    triggerDesc.append(
      'Choose how the trigger will be activated.', descEl.createEl('br'),
      descEl.createEl('strong', { text: 'Automatic ' }),
      'is triggered when you create, edit, or rename a note, and moves the note if it matches the rules.',
      descEl.createEl('br'), 'You can also activate the trigger with a command.',
      descEl.createEl('br'), descEl.createEl('strong', { text: 'Manual ' }),
      'will not automatically move notes.', descEl.createEl('br'), 'You can trigger by command.',
    );
    new Setting(this.containerEl).setName('Trigger').setDesc(triggerDesc)
      .addDropdown((dropDown) => dropDown
        .addOption('Automatic', 'Automatic')
        .addOption('Manual', 'Manual')
        .setValue(String(s.trigger_auto_manual))
        .onChange(async (value) => {
          s.trigger_auto_manual = value;
          await this.plugin.saveSettings();
          this.display();
        }));

    /* ---- Added: settle delay ---- */
    const settleDesc = document.createDocumentFragment();
    settleDesc.append(
      'Choose how long a note must stay unchanged before it is moved, in milliseconds.',
      descEl.createEl('br'),
      'A note is moved only after it has been quiet for this long, so a half-typed tag does not send it away.',
      descEl.createEl('br'),
      descEl.createEl('strong', { text: '2000 ' }), 'is two seconds and suits most folders.',
      descEl.createEl('br'),
      'A single rule can set its own delay with ', descEl.createEl('strong', { text: 'Condition…' }), '.',
    );
    new Setting(this.containerEl).setName('Settle delay').setDesc(settleDesc)
      .addText((text) => text
        .setPlaceholder('2000')
        .setValue(String(s.settle_ms))
        .onChange(async (value) => {
          const n = Number(value);
          if (!Number.isNaN(n) && n >= 0) {
            s.settle_ms = n;
            await this.plugin.saveSettings();
          }
        }));

    /* ---- Use regex for tags (upstream) ---- */
    const useRegexToCheckForTags = document.createDocumentFragment();
    useRegexToCheckForTags.append(
      'If enabled, tags will be checked with regular expressions.', descEl.createEl('br'),
      'For example, if you want to match the #tag, you would write ',
      descEl.createEl('strong', { text: '^#tag$' }), descEl.createEl('br'),
      'This setting is for a specific purpose, such as specifying nested tags in bulk.',
      descEl.createEl('br'),
      descEl.createEl('strong', { text: 'If you want to use the suggested tags as they are, it is recommended to disable this setting.' }),
    );
    new Setting(this.containerEl).setName('Use regular expressions to check for tags').setDesc(useRegexToCheckForTags)
      .addToggle((toggle) => toggle.setValue(!!s.use_regex_to_check_for_tags).onChange(async (value) => {
        s.use_regex_to_check_for_tags = value;
        await this.plugin.saveSettings();
        this.display();
      }));

    /* ---- Add new rule (upstream wording, plus Preview) ---- */
    const ruleDesc = document.createDocumentFragment();
    ruleDesc.append(
      '1. Set the destination folder.', descEl.createEl('br'),
      '2. Set a tag or title that matches the note you want to move. ',
      descEl.createEl('strong', { text: 'You can set either the tag or the title. ' }),
      descEl.createEl('br'),
      '3. The rules are checked in order from the top. The notes will be moved to the folder with the ',
      descEl.createEl('strong', { text: 'first matching rule.' }), descEl.createEl('br'),
      'Tag: Be sure to add a', descEl.createEl('strong', { text: ' # ' }), 'at the beginning.',
      descEl.createEl('br'), 'Title: Tested by JavaScript regular expressions.',
      descEl.createEl('br'),
      'Condition: For a frontmatter property, a date, or a combination of them — open ',
      descEl.createEl('strong', { text: 'Condition…' }), ' on the rule.',
      descEl.createEl('br'), descEl.createEl('br'), 'Notice:', descEl.createEl('br'),
      '1. Attached files will not be moved, but they will still appear in the note.',
      descEl.createEl('br'),
      '2. Auto Note Mover Plus will not move notes that have "',
      descEl.createEl('strong', { text: 'AutoNoteMover: disable' }), '" in the frontmatter.',
    );
    new Setting(this.containerEl).setName('Add new rule').setDesc(ruleDesc)
      .addButton((button) => button
        .setTooltip('Add new rule').setButtonText('+').setCta()
        .onClick(async () => {
          s.folder_tag_pattern.push({ folder: '', tag: '', pattern: '' });
          await this.plugin.saveSettings();
          this.display();
        }))
      .addButton((button) => button
        .setTooltip('Preview moves').setButtonText('Preview moves')
        .onClick(() => this.plugin.preview()));

    /* ---- One row per rule: same three inputs, one extra button ---- */
    s.folder_tag_pattern.forEach((rule, index) => {
      const settings = s.folder_tag_pattern;
      const settingTag = settings.map((e) => e.tag);
      const settingPattern = settings.map((e) => e.pattern);
      const checkArr = (arr, val) => arr.some((arrVal) => val === arrVal);

      const row = new Setting(this.containerEl)
        .addSearch((cb) => {
          cb.setPlaceholder('Folder')
            .setValue(rule.folder || '')
            .onChange(async (newFolder) => {
              settings[index].folder = newFolder.trim();
              await this.plugin.saveSettings();
            });
          attachSuggest(cb.inputEl, vaultFolders(this.app), (picked) => {
            settings[index].folder = picked;
            this.plugin.saveSettings();
          });
        })
        .addSearch((cb) => {
          cb.setPlaceholder('Tag')
            .setValue(rule.tag || '')
            .onChange(async (newTag) => {
              if (settings[index].pattern) {
                this.display();
                return new Notice('You can set either the tag or the title.');
              }
              if (settings[index].property || (settings[index].conditions || []).length) {
                this.display();
                return new Notice('You can set either the tag, the title, or a condition.');
              }
              if (newTag && checkArr(settingTag, newTag)) {
                new Notice('This tag is already used.');
                return;
              }
              settings[index].tag = s.use_regex_to_check_for_tags ? newTag : newTag.trim();
              await this.plugin.saveSettings();
            });
          attachSuggest(cb.inputEl, vaultTags(this.app), (picked) => {
            settings[index].tag = s.use_regex_to_check_for_tags ? picked : picked.trim();
            this.plugin.saveSettings();
          });
        })
        .addSearch((cb) => {
          cb.setPlaceholder('Title by regex')
            .setValue(rule.pattern || '')
            .onChange(async (newPattern) => {
              if (settings[index].tag) {
                this.display();
                return new Notice('You can set either the tag or the title.');
              }
              if (settings[index].property || (settings[index].conditions || []).length) {
                this.display();
                return new Notice('You can set either the tag, the title, or a condition.');
              }
              if (newPattern && checkArr(settingPattern, newPattern)) {
                new Notice('This pattern is already used.');
                return;
              }
              settings[index].pattern = newPattern;
              await this.plugin.saveSettings();
            });
        })
        /* Added: the property / advanced editor */
        .addExtraButton((cb) => cb
          .setIcon('sliders-horizontal').setTooltip('Condition…')
          .onClick(() => {
            new ConditionModal(this.app, settings[index], async () => {
              await this.plugin.saveSettings();
              this.display();
            }).open();
          }))
        .addExtraButton((cb) => cb
          .setIcon('chevron-up').setTooltip('Move up')
          .onClick(async () => {
            arrayMove(s.folder_tag_pattern, index, index - 1);
            await this.plugin.saveSettings();
            this.display();
          }))
        .addExtraButton((cb) => cb
          .setIcon('chevron-down').setTooltip('Move down')
          .onClick(async () => {
            arrayMove(s.folder_tag_pattern, index, index + 1);
            await this.plugin.saveSettings();
            this.display();
          }))
        .addExtraButton((cb) => cb
          .setIcon('x').setTooltip('Delete')
          .onClick(async () => {
            s.folder_tag_pattern.splice(index, 1);
            await this.plugin.saveSettings();
            this.display();
          }));

      // Upstream hides the empty label column so a row reads as three inputs.
      // A rule that uses a condition keeps its label, because the condition is
      // worth seeing at a glance.
      if (this.hasCondition(rule)) row.setName(this.plugin.ruleLabel(rule));
      else row.infoEl.remove();
    });

    /* ---- Excluded folders (upstream) ---- */
    const useRegexToCheckForExcludedFolder = document.createDocumentFragment();
    useRegexToCheckForExcludedFolder.append('If enabled, excluded folder will be checked with regular expressions.');
    new Setting(this.containerEl).setName('Use regular expressions to check for excluded folder').setDesc(useRegexToCheckForExcludedFolder)
      .addToggle((toggle) => toggle.setValue(!!s.use_regex_to_check_for_excluded_folder).onChange(async (value) => {
        s.use_regex_to_check_for_excluded_folder = value;
        await this.plugin.saveSettings();
        this.display();
      }));

    const excludedFolderDesc = document.createDocumentFragment();
    excludedFolderDesc.append(
      'Notes in the excluded folder will not be moved.', descEl.createEl('br'),
      'This takes precedence over the notes movement rules.',
    );
    new Setting(this.containerEl).setName('Add Excluded Folder').setDesc(excludedFolderDesc)
      .addButton((button) => button
        .setTooltip('Add Excluded Folders').setButtonText('+').setCta()
        .onClick(async () => {
          s.excluded_folder.push({ folder: '' });
          await this.plugin.saveSettings();
          this.display();
        }));

    s.excluded_folder.forEach((entry, index) => {
      const current = typeof entry === 'string' ? entry : (entry && entry.folder) || '';
      const row = new Setting(this.containerEl)
        .addSearch((cb) => {
          cb.setPlaceholder('Folder').setValue(current)
            .onChange(async (newFolder) => {
              s.excluded_folder[index] = { folder: newFolder };
              await this.plugin.saveSettings();
            });
          attachSuggest(cb.inputEl, vaultFolders(this.app), (picked) => {
            s.excluded_folder[index] = { folder: picked };
            this.plugin.saveSettings();
          });
        })
        .addExtraButton((cb) => cb.setIcon('chevron-up').setTooltip('Move up').onClick(async () => {
          arrayMove(s.excluded_folder, index, index - 1);
          await this.plugin.saveSettings();
          this.display();
        }))
        .addExtraButton((cb) => cb.setIcon('chevron-down').setTooltip('Move down').onClick(async () => {
          arrayMove(s.excluded_folder, index, index + 1);
          await this.plugin.saveSettings();
          this.display();
        }))
        .addExtraButton((cb) => cb.setIcon('x').setTooltip('Delete').onClick(async () => {
          s.excluded_folder.splice(index, 1);
          await this.plugin.saveSettings();
          this.display();
        }));
      row.infoEl.remove();
    });

    /* ---- Status bar (upstream) ---- */
    const statusBarTriggerIndicatorDesc = document.createDocumentFragment();
    statusBarTriggerIndicatorDesc.append(
      'The status bar will display [A] if the trigger is Automatic, and [M] for Manual.', descEl.createEl('br'),
      'To change the setting, you need to restart Obsidian.', descEl.createEl('br'),
      'Desktop only.',
    );
    new Setting(this.containerEl).setName('Status Bar Trigger Indicator').setDesc(statusBarTriggerIndicatorDesc)
      .addToggle((toggle) => toggle.setValue(!!s.statusBar_trigger_indicator).onChange(async (value) => {
        s.statusBar_trigger_indicator = value;
        await this.plugin.saveSettings();
        this.display();
      }));
  }

  hasCondition(rule) {
    return !!(rule.property || (Array.isArray(rule.conditions) && rule.conditions.length)
      || (Array.isArray(rule.block) && rule.block.length));
  }
}

/* ------------------------------------------------------------------ */
/* Condition editor — the added trigger source                        */
/* ------------------------------------------------------------------ */

class ConditionModal extends Modal {
  constructor(app, rule, onSave) { super(app); this.rule = rule; this.onSave = onSave; }

  onOpen() {
    const { contentEl } = this;
    const r = this.rule;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Condition' });

    const intro = document.createDocumentFragment();
    intro.append(
      'Use a condition instead of a tag or a title when the note is identified by its frontmatter.',
      intro.createEl('br'),
      'A note is moved when the property satisfies the operator, for example ',
      intro.createEl('strong', { text: 'due older_than 14d' }),
      intro.createEl('br'),
      'Dates are read as instants, and ', intro.createEl('strong', { text: 'today' }),
      ', ', intro.createEl('strong', { text: '-30d' }),
      ' and ', intro.createEl('strong', { text: 'start_of_month' }), ' are understood.',
    );
    const introEl = contentEl.createEl('p', { cls: 'setting-item-description' });
    introEl.appendChild(intro);

    let property = r.property || '';
    let op = r.op || 'equals';
    let value = r.value === undefined ? '' : (typeof r.value === 'string' ? r.value : JSON.stringify(r.value));
    let settle = r.settle === undefined ? '' : String(r.settle);
    let extra = JSON.stringify(r.conditions && r.conditions.length ? r.conditions : [], null, 2);
    let blockers = JSON.stringify(r.block && r.block.length ? r.block : [], null, 2);

    new Setting(contentEl).setName('Property').setDesc('The frontmatter key, or file.mtime, file.age and so on.')
      .addText((t) => t.setPlaceholder('due').setValue(property).onChange((v) => { property = v.trim(); }));

    new Setting(contentEl).setName('Operator').setDesc('How the property is compared.')
      .addDropdown((d) => {
        OPS.forEach((o) => d.addOption(o, o));
        return d.setValue(op).onChange((v) => { op = v; });
      });

    new Setting(contentEl).setName('Value').setDesc('A literal, a date, a list in brackets, or a duration such as 14d.')
      .addText((t) => t.setPlaceholder('value').setValue(value).onChange((v) => { value = v; }));

    new Setting(contentEl).setName('Settle for this rule').setDesc('Optional. Overrides the settle delay above; leave empty to inherit it.')
      .addText((t) => t.setPlaceholder('2000').setValue(settle).onChange((v) => { settle = v.trim(); }));

    // Advanced stays out of the way: two empty JSON boxes read as noise (and on
    // mobile render as little more than a pair of []), so they are collapsed
    // unless this rule already uses them.
    const hasAdvanced = (Array.isArray(r.conditions) && r.conditions.length)
      || (Array.isArray(r.block) && r.block.length);
    let advancedOpen = !!hasAdvanced;
    const advWrap = contentEl.createDiv({ cls: 'anm-advanced' });
    advWrap.style.display = advancedOpen ? '' : 'none';

    new Setting(contentEl)
      .setName('Advanced')
      .setDesc('Optional. Several conditions combined with all or any, and blockers that veto the rule. Most rules do not need this.')
      .addToggle((toggle) => toggle.setValue(advancedOpen).onChange((value) => {
        advancedOpen = value;
        advWrap.style.display = value ? '' : 'none';
      }));

    advWrap.createEl('p', { text: 'Conditions', cls: 'setting-item-name' });
    const extraArea = advWrap.createEl('textarea', { cls: 'anm-json' });
    extraArea.value = extra; extraArea.rows = 6;
    extraArea.addEventListener('input', () => { extra = extraArea.value; });

    advWrap.createEl('p', { text: 'Blockers', cls: 'setting-item-name' });
    const blockArea = advWrap.createEl('textarea', { cls: 'anm-json' });
    blockArea.value = blockers; blockArea.rows = 4;
    blockArea.addEventListener('input', () => { blockers = blockArea.value; });

    const err = contentEl.createEl('p', { cls: 'anm-error' });

    new Setting(contentEl)
      .addButton((b) => b.setButtonText('Save').setCta().onClick(async () => {
        try {
          const parsedExtra = JSON.parse(extra || '[]');
          const parsedBlock = JSON.parse(blockers || '[]');
          if (!Array.isArray(parsedExtra) || !Array.isArray(parsedBlock)) throw new Error('conditions and blockers must be arrays');
          for (const c of parsedExtra.concat(parsedBlock)) {
            if (!c || typeof c !== 'object') throw new Error('each condition must be an object');
            if (c.op && !OPS.includes(c.op)) throw new Error(`unknown operator "${c.op}"`);
            if (c.tag === undefined && c.pattern === undefined && !c.property) {
              throw new Error('a condition needs "property", "tag" or "pattern"');
            }
          }
          if (!parsedExtra.length && !property) throw new Error('enter a property, or add a condition under Advanced');

          // A condition replaces the tag and the title, as upstream keeps them exclusive.
          delete r.tag;
          delete r.pattern;

          if (property) {
            r.property = property;
            r.op = op;
            const trimmed = String(value).trim();
            if (/^-?\d+(\.\d+)?$/.test(trimmed)) r.value = Number(trimmed);
            else if (/^\[.*\]$/.test(trimmed)) r.value = JSON.parse(trimmed);
            else r.value = trimmed;
          } else {
            delete r.property; delete r.op; delete r.value;
          }

          r.conditions = parsedExtra;
          r.block = parsedBlock;
          if (settle === '') delete r.settle; else r.settle = settle;

          await this.onSave();
          this.close();
        } catch (e) {
          err.setText('Invalid: ' + e.message);
        }
      }))
      .addButton((b) => b.setButtonText('Clear condition').onClick(async () => {
        delete r.property; delete r.op; delete r.value; delete r.conditions; delete r.block;
        await this.onSave();
        this.close();
      }))
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));
  }

  onClose() { this.contentEl.empty(); }
}

// Test seam: the settings tab and condition editor are exercised headlessly.
AutoNoteMoverPlugin._ui = { AnmSettingTab, ConditionModal, PreviewModal, attachSuggest, arrayMove };
AutoNoteMoverPlugin._engine = {
  OPS, parseDateMs, parseDurationMs, parseWhenMs, checkCondition, ruleMatches, firstMatch, eqValues,
};
module.exports = AutoNoteMoverPlugin;
