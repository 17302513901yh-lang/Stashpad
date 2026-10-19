# Changelog

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
