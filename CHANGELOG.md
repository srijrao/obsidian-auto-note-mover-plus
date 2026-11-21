# Changelog

## 1.1.0 — rules as pills, properties from the vault

- **Rule layout switch** (Settings → Rule layout): *Pills* or *Classic rows*. Classic is
  upstream's three inputs untouched; pills is the new view.
- **A rule reads as a sentence**: `→ folder` then condition pills joined by `∧` (all) or
  `∨` (any), then `unless` blockers. Tap any pill or the folder to edit the rule; the row
  keeps upstream's move-up / move-down / delete buttons.
- **Rule sheet**: folder with autocomplete, all/any, the condition list with per-condition
  type (tag, title by regex, property), an `unless` blocker list, a per-rule settle, and a
  live count — "N notes in the vault match this rule" — computed against the vault as you
  edit.
- **Property editor**: keys come from the vault's own frontmatter (most-used first, with a
  note count), operators are filtered by the key's value type (dates get before/after/on/
  older_than, numbers get gt/lt/between, booleans get equals), values are offered from the
  values actually seen for that key, and the same live match count is shown.
- **Storage stays compatible**: a rule with one condition and no blockers is still written
  in the original flat shape (`tag` / `pattern` / `property`+`op`+`value`), so existing rules
  and older copies read it unchanged; the list shape (`when`, `match`, `block`) is written
  only when a rule needs more than one condition or a blocker.
## 1.0.3 — no more stray [] boxes in the condition editor

- The two advanced JSON boxes (Conditions, Blockers) were always rendered and pre-filled
  with `[]`, so the dialog ended in a pair of empty boxes — on mobile that reads as two
  bare `[]` under the form. They now sit behind an **Advanced** toggle, closed unless the
  rule already has advanced conditions or blockers.
- Textareas are width-constrained and single-column, so they lay out the same on a phone.
## 1.0.2 — rule rows flow like upstream again

- Adding the `Condition…` button made each rule row four buttons wide, pushing the three
  inputs past the settings pane width so they stacked into a column. Rows now share the
  line: the inputs get a flex share with a 7rem floor and the buttons stay fixed, so they
  wrap the way they did in the original instead of forming a column.
- Stylesheet is scoped to `.anm-settings`, the class the settings tab now carries, so no
  other plugin's rows are affected.
## 1.0.1 — settings match upstream Auto Note Mover

- The settings tab now follows the original layout exactly: same heading, same
  introduction, same section order (Trigger → regex tags → Add new rule → rules →
  regex excluded folders → Add Excluded Folder → Status Bar Trigger Indicator), same
  wording and the same level of explanation, including upstream's numbered rule guide
  and its notices about attachments and `AutoNoteMover: disable`.
- Rule rows are upstream's again: **Folder** and **Tag** inputs with folder/tag
  autocomplete, plus **Title by regex**, three icon buttons for move up / move down /
  delete, and the hidden label column (`infoEl`) that keeps a row reading as three inputs.
  Tag and title stay mutually exclusive with upstream's "You can set either the tag or
  the title." notice and its duplicate-tag/duplicate-pattern warnings.
- Consolidated to `AnmSettingTab` (the old duplicate tab and JSON-only editor are gone).
- The additions, in the same voice and place: a **Settle delay** setting right after
  Trigger; a fourth icon button per rule opening **Condition…** (property, operator,
  value, per-rule settle, and optional advanced conditions/blockers) instead of raw JSON;
  a **Preview moves** button next to "+" on Add new rule. Rows that use a condition keep
  their label so the condition is visible at a glance.
## 1.0.0 — first public release

Fork of [Auto Note Mover](https://github.com/farux/obsidian-auto-note-mover) v1.2.0 (MIT).

**Kept from upstream**

- Ordered rules, first match wins.
- Tag trigger with exact tag equality; filename trigger as a regex on the basename.
- Excluded folders compared against the note's current parent folder.
- `AutoNoteMover: disable` frontmatter escape hatch.
- Automatic / Manual trigger with the `[A]` / `[M]` status bar indicator.
- "Move the note" command.

**Added**

- **Property trigger**: compare a frontmatter value with `equals`, `contains`,
  `starts_with`, `ends_with`, `regex`, `gt`, `gte`, `lt`, `lte`, `between`, `in`, `not_in`,
  `exists`, `missing`, `empty`, `not_empty`.
- **Dates**: `before`, `after`, `on`, `within`, `older_than`, `newer_than`, `weekday`,
  `month`, with relative operands (`today`, `-30d`, `start_of_month`) and timezone-aware
  parsing of ISO dates.
- **Settle delay** (2000 ms default, per-rule override): a note is filed only after it has
  been quiet that long, so a half-typed tag never files it.
- **Advanced rules**: `conditions` (all/any), `block` vetoes, per-rule `settle`.
- **Preview moves**: every planned move listed with a checkbox; nothing moves unconfirmed.
- Destination folders are created when missing instead of failing.
- File pseudo-properties: `file.mtime`, `file.ctime`, `file.age`, `file.size`, `file.name`,
  `file.folder`, `file.path`, `file.ext`.
