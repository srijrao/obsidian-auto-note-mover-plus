# Auto Note Mover Plus

Move notes into folders by ordered rules — on tags, filenames, **or frontmatter
conditions**, including comparisons and dates — with a settle delay and a preview before
anything moves.

A fork of [faru's Auto Note Mover](https://github.com/farux/obsidian-auto-note-mover) (MIT)
that keeps its rule model and adds the parts that made frontmatter-driven filing safe:
property comparisons, date arithmetic, a quiet-period delay, and a confirm-before-move
dialog.

## What it does

Rules are evaluated **in order, first match wins**. Each rule has a destination folder and
exactly one trigger:

| Trigger | Matches |
| --- | --- |
| **Tag** | Exact tag equality, e.g. `#haco/email`. Nested tags are separate values. |
| **Title by regex** | A regular expression against the note's filename (no extension). |
| **Property** | A frontmatter property compared with an operator and a value. |

A note is only filed after it has been **quiet** for the settle delay (2 s by default), so a
half-typed tag or property never sends it away. A rename that keeps the filename is ignored —
something else already decided where that note goes.

Nothing is ever overwritten: if a note with that name already exists in the destination, the
move is skipped and reported.

## Install

**From the community directory** (once published): Settings → Community plugins → Browse →
"Auto Note Mover Plus".

**Manually:** copy `main.js`, `manifest.json` and `styles.css` into
`<vault>/.obsidian/plugins/auto-note-mover-plus/`, then enable it in
Settings → Community plugins.

## Rule syntax

Settings → Auto Note Mover Plus. Each row is a folder plus one trigger; use the arrows to
reorder (order is precedence) and the trash icon to remove.

For anything beyond a single condition, choose **Advanced…** on the trigger dropdown and
edit the JSON:

```jsonc
// One condition per object; "op" defaults to equals.
{"property": "due", "op": "older_than", "value": "14d"}
{"tag": "#haco/email"}
{"pattern": "\\d{4}-\\d{2}-\\d{2} Dalton Chat"}
```

### Operators

| Group | Operators |
| --- | --- |
| Text | `equals` `not_equals` `contains` `not_contains` `starts_with` `ends_with` `regex` |
| Number | `gt` `gte` `lt` `lte` `between` `in` `not_in` |
| Presence | `exists` `missing` `empty` `not_empty` |
| Dates | `before` `after` `on` `within` `older_than` `newer_than` `weekday` `month` |

Dates are parsed as instants: `2026-11-17`, `2026-11-17T22:30:00-06:00` and
`2026-11-18T04:00:00Z` are understood, offsets included, and a value without an offset is
read in your local timezone. Operands may also be relative — `today`, `yesterday`,
`tomorrow`, `now`, `start_of_week`, `start_of_month`, `start_of_year`, `end_of_month`,
`end_of_year` — or durations such as `30d`, `2w`, `3h`, `90m`, `1y`, `mo`.

File timestamps are available as properties: `file.mtime`, `file.ctime`, `file.age` (days),
`file.size`, `file.name`, `file.folder`, `file.path`, `file.ext`.

### Multi-condition rules

Advanced rules take an array of conditions plus optional blockers:

```jsonc
{
  "folder": "Archive/_stale",
  "match": "all",                       // or "any"
  "conditions": [
    {"property": "status", "op": "equals", "value": "open"},
    {"property": "file.mtime", "op": "older_than", "value": "180d"}
  ],
  "block": [                            // any hit vetoes the rule
    {"property": "pinned", "op": "equals", "value": true}
  ],
  "settle": "5s"                        // per-rule delay
}
```

## Preview before moving

Run **Preview moves (whole vault)** from the command palette or the settings tab. You get a
list of every planned move with a checkbox each; nothing is filed until you confirm.

Other commands: **Move the note** (this note now) and **Toggle automatic filing**. The
status bar shows `[A]` for automatic and `[M]` for manual, matching the original plugin.

## Settings

| Setting | Meaning |
| --- | --- |
| Trigger | Automatic files as you edit; Manual only files on command. |
| Settle delay (ms) | Quiet period before a changed note is evaluated. A rule's own `settle` overrides it. |
| Show status bar indicator | The `[A]` / `[M]` marker. |
| Use regex to check for tags | Treat tag values as regular expressions. |
| Excluded folders | A note whose current folder matches is never moved. |
| Rules / Excluded folders | Ordered rule list; add, reorder, edit, delete. |

Frontmatter `AutoNoteMover: disable` exempts a single note, and `note-mover: disable` is
honoured too.

## Compatibility with Auto Note Mover

This is a drop-in for an existing Auto Note Mover setup: the rule array, exclusions, trigger
mode and status-bar flag use the same keys, and the tag and filename semantics are unchanged
(tag = exact equality, filename = regex on the basename, first match wins). Rules carrying
the new `property`, `conditions`, `block` or `settle` fields are extensions; everything else
behaves exactly as before.

If you have both plugins installed, enable only one — two movers writing the same note's
path is a race, and the last one to fire wins.

## Development

Plain JavaScript, no build step. `main.js` is the source and the artifact; `manifest.json`
declares `main.js` as the entry point. The rule engine is exported for tests as
`module.exports._engine`.

## Credits and license

Forked from [Auto Note Mover](https://github.com/farux/obsidian-auto-note-mover) by faru
(MIT). Original copyright © 2022 faru; fork changes © 2026 Justin Changalpet. Released under
the [MIT license](./LICENSE).
