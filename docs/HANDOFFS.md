# Handoffs, feedback, lint and expiry

## Handoffs: read once, by the next session

A memory is something that stays true. A handoff is different: "this is where I stopped, and this is what comes next".
It is meant for one reader, so it is read exactly once.

```bash
stashpad handoff leave --text "Parser half done; next: tests for the lexer." --from codex
stashpad handoff list            # open handoffs; listing never takes one
stashpad handoff claim --by claude-code   # take one: the text, labelled as recalled data
stashpad handoff cancel <id> --reason "already done"
```

- **States:** open → claimed (by the first session that takes it), cancelled, or expired. A handoff expires after
  7 days unless `--expires-days` says otherwise (1 to 90).
- **Order:** a note a person leaves (manual) goes before a note a tool or hook leaves (`--auto`). A newer auto note
  replaces the older open auto notes, so a stale automatic note never wins over a fresh one.
- **Claim once:** claiming runs under the store lock, so two sessions starting at the same moment cannot both take
  the same handoff.
- **Safety:** secrets and invisible characters are refused; text that reads like an order is flagged. The automatic
  handoff from the hooks masks a secret in a request as `[REDACTED]` (and says how many) instead of dropping it. The brief says
  that a handoff is waiting, but does not show its text, so starting a session does not use it up.
- **Storage:** one JSON file per handoff in `<store>/handoffs/`, sealed when the store is encrypted.
- **Agents:** the MCP tool `stashpad_handoff` (action `list`, `claim` or `leave`). Notes an agent leaves are `auto`.

### The automatic handoff from the hooks

Before compaction and at the end of a session, the hooks leave an `auto` handoff with the last three requests, the
files written, the git branch and the files that are not committed yet (up to 10, then a count). When a session never
reaches its end (it crashed, was killed, or the window was closed before the hook ran), the next session start leaves
a note that says so, built from that session's transcript, so the work is treated as unfinished. A session that was
active in the last 6 hours does not count yet (it may just be open in another window). The note is written once per
such session and is added beside the other open `auto` handoffs; it never expires them. The transcript and folder named in a session file
are used only when the transcript lies under `~/.claude` or `~/.codex` (or next to the transcript the hook was given)
and the folder is inside the project, because the store, and so the session file, may be committed.

`git status` runs with the repository's `core.fsmonitor` switched off (a repository's config cannot make Stashpad
start a program), without taking the index lock, from an absolute path to git, and with a 2 second limit; without git
the note simply has no branch or file list. The branch is read from `.git/HEAD`. A handoff can carry a branch by
hand too: `stashpad handoff leave --text "…" --branch feature/login`. When the open handoff was left on another
branch than the one checked out, the brief says so.

The idea follows ai-memory's typed handoffs (akitaonrails/ai-memory, MIT); Stashpad's version is its own and smaller.

## Feedback and lint

```bash
stashpad feedback db-choice --signal stale --note "we may have moved to Postgres"
stashpad feedback port-choice --signal wrong --note "it is 8080"   # also asks for the memory to end
stashpad lint
```

`helpful`, `stale` or `wrong` is logged in `feedback.jsonl` (sealed when encrypted). The latest signal per memory
counts. `wrong` also queues an ending request, which a person accepts like any other. Agents use `stashpad_feedback`.

`stashpad lint` lists what deserves a look, by rules only: memories marked stale or wrong, agent memories nobody
confirmed for 180 days, memories that end within 14 days, broken supersede links, text that reads like an order,
handoffs that passed their expiry unread, pinned memories that are no longer current (`pin-ended`), and pins whose
memory file is gone (`pin-missing`). Each pin rule names the fix, `stashpad unpin <id>`. Memories anchored to files
that changed or are gone (`anchor-changed`, `anchor-gone`, fix: `stashpad confirm <id>`), and agent memories that
nothing showed to an agent for 90 days (`never-shown`, see `stashpad shown`). It changes nothing.

## Expiry

`stashpad save … --expires YYYY-MM-DD` gives a memory an end date from the start ("code freeze until the release").
After that date it is no longer current, but it stays in the store with its history.

## With ReversePort

[ReversePort](https://github.com/laaielichter/reverseport) uses Stashpad when it is installed (it finds it through
`STASHPAD_BIN` or `stashpad` on `PATH`):

- `re_case init` searches Stashpad for what earlier sessions learned about the same target, and lists open handoffs
  without taking them.
- `re_case remember` proposes the case's decisions, observed claims and limitations to the review queue (source type
  `agent`), and leaves an `auto` handoff that says where the case stands: phase, open unknowns, last decision and the
  next step.

The next session runs `stashpad brief`, sees that a handoff is waiting, and takes it with `stashpad handoff claim`.
