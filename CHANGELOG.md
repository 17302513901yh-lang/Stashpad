# Changelog

## Unreleased

- **Feedback notes and handoff cancel reasons are checked for secrets:** both are free text that is written to the store, but they skipped the `findSecrets()` guard used everywhere else. A note or reason holding a key or token is now refused before anything is written (so `feedback.jsonl` stays untouched even with `--signal wrong`, and a refused cancel leaves the handoff open). Notes and reasons without secrets work as before. Thanks to @17302513901yh-lang! (#34)

- **`stashpad shown --since` refuses a day that does not exist:** `2026-13-45` and `2026-02-30` now fail with a clear message and exit code 2, the same check `search` and `list` already use. Thanks to @17302513901yh-lang! (#60, #61)

- **camelCase names are searchable by their plain words:** `getUserProfile` is now tokenised as get / user / profile (and kept whole), so "user profile" finds it. Acronyms such as `parseHTTPResponse` split too, while ordinary title-case words stay whole. Thanks to @17302513901yh-lang! (#44, #62)

## 0.4.0

Local memory upgrades (file anchors, decisions with their reasons, once-per-session recall, fenced output, stronger secret checks) and a round of fixes from contributors. The tool contract changed: `stashpad_save` takes the optional arguments `files`, `why` and `rejected`; existing calls work as before.

- **Id length limit:** ids are limited to 64 characters, so the `forget-` request file still fits. `save`, `forget` and the MCP save/forget tools refuse a longer id with a clear message before writing anything, while memories already stored with a longer id still list, search, get and load. Thanks to @Daiyuanranfeng! (#42, #54)
- **Impossible dates are refused in the `search` and `list` filters:** `--as-of`, `--since` and `--until` (and the MCP `as_of`) reject a day that does not exist, like `2026-13-45` or `2026-02-30`, and a `--since` later than `--until` is named in the error instead of returning an empty result. Thanks to @bfs2021! (#46, #52)
- **Missed searches are counted for `stashpad search --json` too**, so `stashpad misses` sees the searches agents make on the command line (#20).
- **`stashpad import --format` works as documented** (`jsonl` or `text`) (#21).
- **Search ignores accents on Latin letters:** `cafe` finds `café` and the other way round. Accents in other writing systems still count (#26).
- **`stashpad audit <id> --limit N`:** the audit log of one memory, including the request that ended it and merges into it, and up to 10,000 entries instead of the last 50 (#27).
- **The handoff reads Codex CLI sessions:** patches sent through a shell or function call, and user messages stored only as events, now show up in the summary before compaction (#28).
- **`stashpad export --format markdown`:** one readable Markdown file, current memories first and ended ones in their own section with `--all` (#29).
- **Recall once per session:** the prompt hook no longer pastes the same memories into every prompt of a long session. After compaction or `/clear` they can be given again. Session files hold ids only, stay out of git and are removed after 7 days.
- **File anchors:** a memory can name the files or folders it is about (`stashpad save … --files`, `stashpad anchor <id> <path>`, `files` in `stashpad_save`). Recall, the brief and `stashpad_get` say when those files changed since the memory was saved, follow a file that moved, and skip a memory whose files are all gone. `stashpad anchors --changed` lists them, lint reports `anchor-changed` and `anchor-gone`, and `stashpad confirm <id>` re-anchors. Anchors live in `anchors.json` next to the memories; memory files do not change. An agent's files are read only when a person accepts its memory. Paths stay inside the project (no `..`, no links out). The tool contract changed: `stashpad_save` has an optional `files` argument.
- **Fenced output:** the brief, recall and handoffs come inside one `<stashpad-data>` block, and stored text that holds tags like `</system-reminder>`, `<system>` or `<instructions>` (also in full-width letters) is defused (`<` becomes `‹`) everywhere an agent reads it, MCP results included. Such text is also flagged at write time, so review shows it.
- **`stashpad shown`:** a local log of what Stashpad put in front of agents (hooks, MCP reads, `brief`/`recall`/`search`/`get`): time, event, session, memory ids and characters, never text. Capped, sealed when encrypted, kept out of git, `--clear` empties it. Lint gets `never-shown` for agent memories nothing showed for 90 days.
- **Wider secret checks:** more provider key shapes (Anthropic, Stripe restricted keys and webhook secrets, GitLab, npm, Hugging Face, Google OAuth, SendGrid, Slack and Discord webhooks, Azure storage keys), passwords on command lines (`--password=`, `mysql -p…`, `curl -u user:pass`) and in sentences ("my password is …"). Text holding the value of a secret-named environment variable or a project `.env` entry is refused too; the values are compared in memory and never written anywhere. The automatic handoff now masks a secret as `[REDACTED]` instead of dropping the whole request.
- **Richer automatic handoff:** the note before compaction and at session end names the git branch and the uncommitted files. When the last session never reached its end (crash, kill, closed window), the next session start leaves a note that says so, built from its transcript. `stashpad handoff leave --branch`, and the brief says when the open handoff was left on another branch. `git status` runs with `core.fsmonitor` off, no index lock, from an absolute path and with a 2 second limit.
- **`stashpad decide "<choice>" --why "…" [--rejected "A, B"]`:** a decision memory with a fixed body layout (the choice, `Why:`, `Rejected:`, `Decided by:`). Recall and the brief show why it was chosen and what lost; a request that names a rejected option ("move it to SQLite") gets the decision, and a prompt that asks why (or about a decision, convention or policy) puts decisions first. `stashpad_save` takes optional `why` and `rejected` for decisions; the tool contract changed.
- **`stashpad hooks off|on`:** pause the hooks for one project; the setting lives in `~/.stashpad` (or `$STASHPAD_CONFIG_DIR`), never in the repository. **`stashpad status-line`** prints `Stashpad · 42 memories · 3 to review · handoff open` for Claude Code's status bar (`stashpad setup claude-code --status-line` prints the setting). **`stashpad doctor`** says whether the hooks are wired (the Claude Code plugin, or hook entries in `.claude`, `.codex` or `.cursor` settings) and whether they are paused.
- **`stashpad feedback --last`:** feedback on the memory the prompt hook gave last, without looking up its id; when it gave several, they are listed and you pick one.
- **`stashpad import` keeps the first line of a file saved with a byte order mark** (UTF-8 BOM, also with CRLF endings) (#36, fixes #32).
- **Claiming a handoff by id reports the right number of handoffs still open** (#38, fixes #33).
- **Fixes from review:** secret checks no longer refuse ordinary settings (only names ending in KEY, TOKEN, SECRET, PASSWORD and the like count, values must look secret, matches are whole tokens) and a branch name never costs the automatic handoff; `search`, `list`, `about` and the anchor listings are defused; anchor checks from hooks read at most 50 MB, skip build and dependency folders, cache hashes and leave the move search to lint and `stashpad anchors`; a second open window is not an unclean end, and that note no longer expires the session-end handoff; anchors use a worktree's own files and are refused in the global store; paths in session files are trusted only under `~/.claude`/`~/.codex` and inside the project; `git status` runs without `GIT_*` variables (the docs now say filter drivers can still run); more harness tags are defused (`command-name`, `local-command-stdout`, `task-notification`, `thinking`, `function_calls` …); one unreadable or refused file no longer breaks a memory's anchors; the shown log is cut by bytes and forgets deleted ids.
- **Windows device names are no longer valid ids:** `con`, `prn`, `aux`, `nul`, `com1`–`com9` and `lpt1`–`lpt9` are refused by `save`, `decide`, `import` and the MCP tools with the reason, so a store stays portable. An existing memory with such an id still loads and lists, and `stashpad lint` reports it with the new `id-not-portable` code. Thanks to @17302513901yh-lang! (#45, #55)
- **UI listen errors are actionable:** an occupied or disallowed port prints a one-line message with `--port N` and `--port 0` alternatives, instead of a stack trace or file-permission hint. Thanks to @Daiyuanranfeng! (#43, #57)

### Thanks

- @jay23606 for logging JSON search misses (#20), accent-insensitive search (#26), audit filters (#27), the Codex handoff (#28) and the Markdown export (#29).
- @bfs2021 for the import `--format` fix (#21), the import BOM fix (#36) and the real-date filters (#52).
- @sunxiuguo for the handoff count fix and its careful tests (#38), a first contribution. Welcome!
- @Daiyuanranfeng for the id length limit (#42, #54).

## 0.3.0

Built from a count of the problems people report most with agent memory tools (installs that fail, context lost after compaction, rules the agent stops following, a separate empty store per folder).

- **Installs that connect.** `stashpad setup` prints the full path to Node instead of a bare `node`. `stashpad doctor --client` starts the server the way an agent app does and says what to fix.
- **Survives compaction.** New hooks for Claude Code (and any agent with hooks): the brief comes back right after compaction, and an automatic handoff records the last requests and files written before compaction and at session end.
- **Pinned rules.** `stashpad pin <id>`: the few rules every session must see come first in every brief. Only a person pins.
- **Recall per prompt.** `stashpad recall` and the prompt hook add the up to 3 memories that clearly match a request, or nothing.
- **One store per project.** The store is found from the project: the nearest `.stashpad` above, else the git root; git worktrees share the main one. `stashpad where` says which and why. **Note:** run from a subfolder, 0.2 used a store in that subfolder; 0.3 uses the project's. Move notes with `stashpad export` / `import` if needed.
- **Global store.** `--global` for what is true in every project; its pinned rules and matches are added by the hooks.
- **Smaller fixes.** Search in Chinese, Japanese and Korean (character bigrams). Missed searches are logged by word with synonym suggestions (`stashpad misses`, `stashpad synonym add`). `stashpad duplicates` and `stashpad merge` for near-copies. The brief and doctor warn before the review queue is full.
- **Repository.** Contributing guide, code of conduct, security policy, issue forms, a release workflow and a real terminal demo in the README.
- **`stashpad lint` reports pins that no longer work:** `pin-ended` for a pinned memory that is no longer current, and `pin-missing` for a pin without a memory file, each with the fix (#18).
- **The tool count can't go stale:** the `AGENTS.md` block from `sync-agents` takes it from the server's tool list, the skill lists `stashpad_about`, and a test checks that every tool is in the skill (#19).

### Thanks
- @jay23606 for the pin lint rules (#18).
- @harshitNegi0001 for the tool count and the skill check (#19).

## 0.2.2

- **Handoffs.** `stashpad handoff leave / list / claim / cancel`: a note for the next session that is read exactly once, with expiry. Agents use `stashpad_handoff`.
- **Feedback and lint.** `stashpad feedback <id> --signal helpful|stale|wrong` and `stashpad lint` (rules only, changes nothing). Agents use `stashpad_feedback`.
- **Expiry.** `stashpad save ... --expires YYYY-MM-DD`.
- **ReversePort.** ReversePort finds earlier findings and open handoffs in Stashpad when both are installed.
- **Windows.** File writes retry when Windows briefly holds a file; the store lock never breaks a lock that was just created, and two processes can no longer both remove a stale lock.
- MCP Registry listing as `io.github.laaielichter/stashpad`.

## 0.2.1

- Published under the plain name `stashpad`. 0.2.0 went out by mistake as `@laaielichter/stashpad` and was withdrawn.

## 0.2.0

First public release.

- **Any agent.** Plain commands, an MCP server with six tools, and an `AGENTS.md` block (`stashpad sync-agents`). `stashpad setup` prints the settings for Claude Code, VS Code, Codex and other MCP clients. Also a Claude Code plugin (session hook, skill, `/memory`, `/handover`).
- **Session start and end.** `stashpad brief` (short, newest handover first) and `stashpad handover`.
- **Search.** Filters (`--kind`, `--source-type`, `--as-of`, `--since`, `--until`), `--explain`, built-in English and Dutch synonyms plus a per-store `synonyms.json`.
- **Entities.** `stashpad entities` and `stashpad about <name>`: names, tools and files the memories mention, found by rule.
- **Safer writes.** A gatekeeper refuses short and near-copy agent notes; a save names memories it may replace; invisible characters, Dutch orders, JWTs, Bearer tokens and passwords in connection strings are caught; size and queue limits.
- **Safe updates.** Store format marker with backup, snapshots (daily automatic, manual), `restore`, `migrate --dry-run`, protection against older versions writing newer stores, a frozen tool contract.
- **Concurrency.** A store lock lets the command line, the MCP server and the review page write at the same time.
- **Upkeep.** `stashpad confirm`, and `stashpad doctor` with a built-in self-test, stale and hand-edited memory checks.
- **Optional encryption.** `stashpad encrypt` / `decrypt`: AES-256-GCM with a scrypt key, snapshots and audit log included. Off by default.
- **Eval.** 40 memories, 33 queries in English and Dutch, safety checks, an honest paraphrase metric.

## 0.1.0

Plain Markdown memories with sources, dates and trust; review queue; BM25 search; supersede chains; secret scanning; MCP server; review page; import and export.
