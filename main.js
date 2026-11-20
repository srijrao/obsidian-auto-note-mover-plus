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
/* Settings — same shape as Auto Note Mover, with the new fields      */
/* ------------------------------------------------------------------ */

class AnmSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Auto Note Mover+' });

    new Setting(containerEl)
      .setName('Trigger')
      .setDesc('Automatic files notes as you edit. Manual only files when you run a command.')
      .addDropdown((d) => d.addOption('Automatic', 'Automatic').addOption('Manual', 'Manual')
        .setValue(String(s.trigger_auto_manual))
        .onChange(async (v) => { s.trigger_auto_manual = v; await this.plugin.saveSettings(); this.plugin.renderStatus(); }));

    new Setting(containerEl)
      .setName('Settle delay (ms)')
      .setDesc('A note is filed only after it has been quiet this long, so a half-typed tag never files it. A rule can override it.')
      .addText((t) => t.setValue(String(s.settle_ms))
        .onChange(async (v) => { const n = Number(v); if (!isNaN(n) && n >= 0) { s.settle_ms = n; await this.plugin.saveSettings(); } }));

    new Setting(containerEl)
      .setName('Show status bar indicator')
      .addToggle((t) => t.setValue(!!s.statusBar_trigger_indicator)
        .onChange(async (v) => { s.statusBar_trigger_indicator = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Use regex to check for tags')
      .addToggle((t) => t.setValue(!!s.use_regex_to_check_for_tags)
        .onChange(async (v) => { s.use_regex_to_check_for_tags = v; await this.plugin.saveSettings(); }));

    containerEl.createEl('h3', { text: 'Rules (first match wins)' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'A rule uses ONE trigger: tag, filename pattern, or a property condition. Advanced multi-condition rules and per-rule delays are in "Advanced…".',
    });

    s.folder_tag_pattern.forEach((rule, i) => this.renderRule(containerEl, rule, i));

    new Setting(containerEl)
      .addButton((b) => b.setButtonText('Add rule').setCta().onClick(async () => {
        s.folder_tag_pattern.push({ folder: '', tag: '', pattern: '' });
        await this.plugin.saveSettings();
        this.display();
      }))
      .addButton((b) => b.setButtonText('Preview moves').onClick(() => this.plugin.preview()));

    containerEl.createEl('h3', { text: 'Excluded folders' });
    containerEl.createEl('p', { cls: 'setting-item-description', text: 'A note whose current folder matches one of these is never moved.' });
    (s.excluded_folder || []).forEach((entry, i) => {
      const current = typeof entry === 'string' ? entry : (entry && entry.folder) || '';
      new Setting(containerEl)
        .addText((t) => t.setValue(current)
          .onChange(async (v) => {
            s.excluded_folder[i] = { folder: v.trim() };
            await this.plugin.saveSettings();
          }))
        .addButton((b) => b.setButtonText('Remove').setWarning().onClick(async () => {
          s.excluded_folder.splice(i, 1);
          await this.plugin.saveSettings();
          this.display();
        }));
    });
    new Setting(containerEl).addButton((b) => b.setButtonText('Add excluded folder').onClick(async () => {
      s.excluded_folder.push({ folder: '' });
      await this.plugin.saveSettings();
      this.display();
    }));
  }

  renderRule(containerEl, rule, index) {
    const s = this.plugin.settings;
    const kind = Array.isArray(rule.conditions) && rule.conditions.length ? 'conditions'
      : rule.property ? 'property' : rule.pattern ? 'pattern' : 'tag';

    const setting = new Setting(containerEl);

    setting.addText((t) => t.setPlaceholder('Folder').setValue(rule.folder || '')
      .onChange(async (v) => { rule.folder = v.trim(); await this.plugin.saveSettings(); }));

    setting.addDropdown((d) => d
      .addOption('tag', 'Tag')
      .addOption('pattern', 'Title by regex')
      .addOption('property', 'Property')
      .addOption('conditions', 'Advanced…')
      .setValue(kind)
      .onChange(async (v) => {
        // Mirror the original XOR: exactly one trigger kind at a time.
        delete rule.tag; delete rule.pattern; delete rule.property;
        delete rule.op; delete rule.value; delete rule.conditions;
        if (v === 'tag') rule.tag = '';
        else if (v === 'pattern') rule.pattern = '';
        else if (v === 'property') { rule.property = ''; rule.op = 'equals'; rule.value = ''; }
        else rule.conditions = [{ property: '', op: 'equals', value: '' }];
        await this.plugin.saveSettings();
        this.display();
      }));

    if (kind === 'tag') {
      setting.addText((t) => t.setPlaceholder('#tag').setValue(rule.tag || '')
        .onChange(async (v) => { rule.tag = v.trim(); await this.plugin.saveSettings(); }));
    } else if (kind === 'pattern') {
      setting.addText((t) => t.setPlaceholder('regex on filename').setValue(rule.pattern || '')
        .onChange(async (v) => { rule.pattern = v; await this.plugin.saveSettings(); }));
    } else if (kind === 'property') {
      setting.addText((t) => t.setPlaceholder('property').setValue(rule.property || '')
        .onChange(async (v) => { rule.property = v.trim(); await this.plugin.saveSettings(); }));
      setting.addDropdown((d) => {
        OPS.forEach((op) => d.addOption(op, op));
        return d.setValue(rule.op || 'equals')
          .onChange(async (v) => { rule.op = v; await this.plugin.saveSettings(); });
      });
      setting.addText((t) => t.setPlaceholder('value').setValue(rule.value === undefined ? '' : String(rule.value))
        .onChange(async (v) => {
          if (/^-?\d+(\.\d+)?$/.test(v.trim())) rule.value = Number(v.trim());
          else if (/^\[.*\]$/.test(v.trim())) { try { rule.value = JSON.parse(v); } catch (e) { rule.value = v; } }
          else rule.value = v;
          await this.plugin.saveSettings();
        }));
    } else {
      setting.addButton((b) => b.setButtonText('Edit conditions…').onClick(() => {
        new ConditionsModal(this.app, rule, async () => { await this.plugin.saveSettings(); this.display(); }).open();
      }));
    }

    setting.addExtraButton((b) => b.setIcon('arrow-up').setTooltip('Move up').onClick(async () => {
      if (index > 0) {
        s.folder_tag_pattern.splice(index - 1, 0, s.folder_tag_pattern.splice(index, 1)[0]);
        await this.plugin.saveSettings(); this.display();
      }
    }));
    setting.addExtraButton((b) => b.setIcon('arrow-down').setTooltip('Move down').onClick(async () => {
      if (index < s.folder_tag_pattern.length - 1) {
        s.folder_tag_pattern.splice(index + 1, 0, s.folder_tag_pattern.splice(index, 1)[0]);
        await this.plugin.saveSettings(); this.display();
      }
    }));
    setting.addExtraButton((b) => b.setIcon('trash').setTooltip('Delete').onClick(async () => {
      s.folder_tag_pattern.splice(index, 1);
      await this.plugin.saveSettings(); this.display();
    }));

    const summary = this.plugin.ruleLabel(rule);
    const note = rule.settle !== undefined ? ` · settle ${rule.settle}` : '';
    if (summary !== '(no trigger)') {
      containerEl.createEl('div', { cls: 'anm-rule-summary', text: summary + note });
    }
  }
}

class ConditionsModal extends Modal {
  constructor(app, rule, onSave) { super(app); this.rule = rule; this.onSave = onSave; }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Conditions' });
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'JSON. One object per condition: {"property":"due","op":"older_than","value":"14d"} · {"tag":"#haco/email"} · {"pattern":"Dalton Chat"}. Blockers veto the rule.',
    });

    const whenArea = contentEl.createEl('textarea', { cls: 'anm-json' });
    whenArea.value = JSON.stringify(this.rule.conditions || [], null, 2);
    whenArea.rows = 8;
    whenArea.style.width = '100%';

    contentEl.createEl('p', { text: 'Blockers (optional)' });
    const blockArea = contentEl.createEl('textarea', { cls: 'anm-json' });
    blockArea.value = JSON.stringify(this.rule.block || [], null, 2);
    blockArea.rows = 4;
    blockArea.style.width = '100%';

    const err = contentEl.createEl('p', { cls: 'anm-error' });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText('Save').setCta().onClick(async () => {
        try {
          const when = JSON.parse(whenArea.value || '[]');
          const block = JSON.parse(blockArea.value || '[]');
          if (!Array.isArray(when) || !Array.isArray(block)) throw new Error('both must be arrays');
          for (const c of when.concat(block)) {
            if (!c || typeof c !== 'object') throw new Error('each condition must be an object');
            if (c.op && !OPS.includes(c.op)) throw new Error(`unknown op "${c.op}"`);
            if (c.tag === undefined && c.pattern === undefined && !c.property) {
              throw new Error('a condition needs "property", "tag" or "pattern"');
            }
          }
          this.rule.conditions = when;
          this.rule.block = block;
          await this.onSave();
          this.close();
        } catch (e) { err.setText('Invalid: ' + e.message); }
      }))
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));
  }

  onClose() { this.contentEl.empty(); }
}

AutoNoteMoverPlugin._engine = {
  OPS, parseDateMs, parseDurationMs, parseWhenMs, checkCondition, ruleMatches, firstMatch, eqValues,
};
module.exports = AutoNoteMoverPlugin;
