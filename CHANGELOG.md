# Changelog

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
