# Changelog

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
