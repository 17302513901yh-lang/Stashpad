# Stashpad memory file format (v0)

One memory is one Markdown file. The file name is the id: `<id>.md`.

## Frontmatter

The file starts with `---`, then one `key: value` line per field, then `---`.
All fields are required. Use `null` where a field has no value.

| Field | Meaning |
|---|---|
| `id` | Lowercase letters, digits and hyphens. Must match the file name. |
| `kind` | `fact`, `preference`, `decision` or `task` |
| `created_at` | Date the memory was written, `YYYY-MM-DD` |
| `valid_from` | Date from which the memory is true |
| `valid_to` | Date it stopped being true, or `null` while it is current |
| `supersedes` | Id of the memory this one replaces, or `null` |
| `superseded_by` | Id of the memory that replaced this one, or `null` |
| `source_type` | `user`, `agent`, `tool` or `web` |
| `source_ref` | Short plain-text description of where it came from |
| `trust` | Derived from `source_type` (see below). Never chosen by the writer. |
| `last_confirmed_at` | Last date a person confirmed the memory, `YYYY-MM-DD` |

## Trust

`trust` follows from `source_type`:

- `user` gives `user-stated`
- `agent` gives `agent-inferred`
- `tool` and `web` give `external`

Nothing an agent or a web page writes can claim to be user-stated.

## Rules

- Facts are never edited into a new value. A changed fact gets a new file.
  The old file gets `valid_to` and `superseded_by`. The new file gets `supersedes`.
- The body is plain Markdown text, written so a person can read it.
- Frontmatter is deliberately tiny: one scalar per line, no lists, no
  multi-line values. Quotes are optional. This keeps diffs small and readable.
- Dates are real calendar dates in `YYYY-MM-DD`.

## Check a folder

```bash
node scripts/validate-memory.mjs            # checks examples/memories
node scripts/validate-memory.mjs <folder>   # checks any folder
```

The check exits with code 1 and names each problem and its file.

## Search words and synonyms

Search matches words. A note can help itself by ending with a line such as `Also: db, datastore`. Those words are part of the text and are searched like any other.

A store can also hold `synonyms.json` next to the memories (it is not a memory file and is ignored by the format checks):

```json
{ "groups": [["deployment", "rollout", "uitrol"], ["pr", "pull request"]] }
```

A match through a synonym counts half as much as an exact word, so exact matches rank first. Small English and Dutch groups are built in. At most 500 groups of 2 to 20 words; the file may be up to 64 KB. A broken file is ignored and `stashpad doctor` reports it.

