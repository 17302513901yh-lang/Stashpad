# Decision: search backend (pure JavaScript now, SQLite later if needed)

Status: provisional. Linux measured. Windows and macOS measurements pending (see below).

## Measured (Linux, Node 22.22, synthetic data, median of 60 queries)

| Notes | Pure JS BM25, query (ms) | SQLite FTS5, build (ms) | SQLite FTS5, query (ms) |
|---|---|---|---|
| 100 | 2.12 | 3.11 | 0.07 |
| 1,000 | 11.53 | 7.10 | 0.10 |
| 5,000 | 66.97 | 40.78 | 0.34 |

Reproduce with `npm run bench`. The numbers are from one machine and one synthetic corpus.
Treat them as order of magnitude, not as a promise.

## Decision

Keep pure JavaScript BM25 as the default backend for version 1. Reasons:

1. It runs on Node 20, which is the minimum Stashpad supports. `node:sqlite` needs Node 22.13 or newer, and prints an experimental warning.
2. It needs no native module and no install step, so Windows installs are less likely to fail.
3. At personal scale (up to about 1,000 notes) a query takes about 12 ms. That is well below anything an agent notices.
4. Memories stay plain files. Search does not add a second source of truth.

## When to revisit

Add an optional SQLite FTS5 backend when either of these is true:

- A typical store grows past about 5,000 notes, and query time above about 50 ms matters.
- Users need prefix or stemming search that BM25 does not give.

The backend stays optional. The Markdown files remain the source of truth, and the index can always be rebuilt from them.

## Open items

- Windows and macOS measurements. The CI runs `npm run bench` on all three systems and uploads the output. Those results still need to be read and copied into this file.
- Stemming. Plural folding is in: "tools" finds "tool" and "policies" finds "policy". It is not a full stemmer. Synonyms ("database" for "SQLite") are still not found, and a full stemmer would need a decision of its own.
- Word matching adds false hits. The eval caught this when plural folding let "return" match "returns". The absent questions in `stashpad eval` therefore share no word with the fixed set.
