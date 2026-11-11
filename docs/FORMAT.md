# Stashpad memory file format (v0)

One memory is one Markdown file. The file name is the id: `<id>.md`.

## Frontmatter

The file starts with `---`, then one `key: value` line per field, then `---`.
All fields are required. Use `null` where a field has no value.

| Field | Meaning |
|---|---|
| `id` | Lowercase letters, digits and hyphens. Must match the file name. Windows device names (`con`, `prn`, `aux`, `nul`, `com1`–`com9`, `lpt1`–`lpt9`) are refused so the store stays portable; `con-notes` and `com10` are fine. |
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

## Decisions: the choice, why, and what lost

A decision is a memory of kind `decision`. When it is written with `stashpad decide` (or `stashpad_save` with `why`),
its body follows a fixed layout that a person can read and Stashpad can parse:

```markdown
We use Postgres for the main database.
Why: several workers write at the same time
Rejected: SQLite, MongoDB
Decided by: the team in the planning call
```

The first line is the choice; `Why:`, `Rejected:` and `Decided by:` are optional and come in this order. Recall and
the brief show it as `We use Postgres for the main database. (rejected: SQLite, MongoDB; why: several workers write at
the same time)`, so an agent that is about to propose SQLite sees that it lost, and why: a request that names a
rejected option is enough to bring the decision up. A prompt that asks why (or about a decision, choice, convention
or policy) puts matching decisions first.

```bash
stashpad decide "We use Postgres for the main database" --why "several workers write at the same time" --rejected "SQLite, MongoDB"
stashpad decide "Tabs for indentation" --why "the linter wants them" --id indent-style --by "the team"
```

Without `--id` the id comes from the choice (`decision-we-use-postgres-for-the-main`). The other `save` options
(`--source-ref`, `--source-type`, `--supersedes`, `--files`, `--expires`) work too; a person's decision is stored right
away, an agent's waits for review.

## Files a memory is about (anchors.json)

A memory can be anchored to the files or folders it talks about, so recall, the brief and lint can say when they
changed. The memory file does not change: anchors live next to the memories in `anchors.json`, like `pins.json`:

```json
{
  "anchors": { "tax-rules": { "src/billing/tax.ts": "2f1c…", "src/billing/": "dir:9ab0…" } },
  "requested": { "agent-note": ["src/db/schema.ts"] },
  "sizes": { "tax-rules": { "src/billing/tax.ts": 1234 } }
}
```

- **Paths** are relative to the project: the folder that holds `.stashpad/memories` (else the top of the current
  checkout). In a git worktree they are relative to the worktree itself, also when the store sits in the main checkout.
  A folder ends in `/`. At most 20 per memory. Memories in the global store cannot be anchored.
- **Hashes** are git blob ids over LF line endings (so a Windows and a Linux checkout agree, with or without git). A
  folder's hash covers the sorted list of its files and their hashes, so an added file counts too (at most 2000 files;
  links, `.git`, `node_modules` and build or cache folders such as `dist`, `build`, `target`, `.venv` and `.godot` are
  skipped). `sizes` keeps each anchored file's size (over LF line endings), so a moved file is looked for among files
  of a fitting size only.
- **Who reads files:** Stashpad computes every hash itself. A person anchors with `stashpad save … --files a,b`,
  `stashpad anchor <id> <path...>` or `stashpad confirm <id>` (which re-anchors to the files as they are now). An
  agent can only ask (`stashpad_save` with `files`, kept under `requested`); the files are read when a person accepts
  the memory and dropped when it is rejected.
- **States:** same, changed, moved (the same content elsewhere in the project), moved and changed (the only file with
  that name elsewhere), gone. The hooks do not look for moved files (they say "missing here"; `stashpad anchors` and
  lint look), and one round of checks reads at most 50 MB; hashes are cached in `.sessions/anchor-hashes.json` by path,
  size and modification time. Recall and the brief add a short note, skip a memory whose files are all gone, and
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

