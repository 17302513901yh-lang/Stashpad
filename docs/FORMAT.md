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

## Files a memory is about (anchors.json)

A memory can be anchored to the files or folders it talks about, so recall, the brief and lint can say when they
changed. The memory file does not change: anchors live next to the memories in `anchors.json`, like `pins.json`:

```json
{
  "anchors": { "tax-rules": { "src/billing/tax.ts": "2f1c…", "src/billing/": "dir:9ab0…" } },
  "requested": { "agent-note": ["src/db/schema.ts"] }
}
```

- **Paths** are relative to the project: the folder that holds `.stashpad/memories` (else the git root of the current
  folder). A folder ends in `/`. At most 20 per memory.
- **Hashes** are git blob ids over LF line endings (so a Windows and a Linux checkout agree, with or without git). A
  folder's hash covers the sorted list of its files and their hashes, so an added file counts too (at most 2000 files;
  links, `.git` and `node_modules` are skipped).
- **Who reads files:** Stashpad computes every hash itself. A person anchors with `stashpad save … --files a,b`,
  `stashpad anchor <id> <path...>` or `stashpad confirm <id>` (which re-anchors to the files as they are now). An
  agent can only ask (`stashpad_save` with `files`, kept under `requested`); the files are read when a person accepts
  the memory and dropped when it is rejected.
- **States:** same, changed, moved (the same content elsewhere in the project), moved and changed (the only file with
  that name elsewhere), gone. Recall and the brief add a short note, skip a memory whose files are all gone, and
  `stashpad lint` reports `anchor-changed` and `anchor-gone`. `stashpad anchors --changed` lists them.
- **Safety:** paths in the file are treated as untrusted. Absolute paths, drive letters, UNC paths, `..`, device names
  and `.git` are refused; the real path (links resolved) must stay inside the project; only regular files up to 5 MB
  and folders are read. No git command is run. The file is sealed when the store is encrypted and is part of
  snapshots.

## Check a folder

```bash
node scripts/validate-memory.mjs            # checks examples/memories
node scripts/validate-memory.mjs <folder>   # checks any folder
```

The check exits with code 1 and names each problem and its file.

## Search words and synonyms

Search matches words. A note can help itself by ending with a line such as `Also: db, datastore`. Those words are part of the text and are searched like any other.

Combining accents on Latin letters are ignored, so a search for `cafe` also matches `café`; accents in other writing systems remain significant.

A store can also hold `synonyms.json` next to the memories (it is not a memory file and is ignored by the format checks):

```json
{ "groups": [["deployment", "rollout", "uitrol"], ["pr", "pull request"]] }
```

A match through a synonym counts half as much as an exact word, so exact matches rank first. Small English and Dutch groups are built in. At most 500 groups of 2 to 20 words; the file may be up to 64 KB. A broken file is ignored and `stashpad doctor` reports it.

## Finding the words that are missing

Searches that find nothing are logged by their meaningful words only (never the whole query) in `misses.jsonl`, sealed in an encrypted store and capped in size. `stashpad misses` lists the most missed words with close words from your memories, and the command to join them:

```bash
stashpad misses
#   3x  postgresql  close: postgres  ->  stashpad synonym add postgresql postgres
stashpad synonym add postgresql postgres
```

