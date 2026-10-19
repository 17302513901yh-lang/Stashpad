# Use Stashpad with any AI agent

Stashpad does not depend on one model or one company. There are three ways in; use whichever your agent supports. They all read and write the same plain files.

1. **Plain commands.** Any agent that can run a shell command can use `stashpad search`, `stashpad save`, `stashpad brief` and `stashpad handover`. See `AGENT-GUIDE.md`.
2. **MCP (open standard).** Any MCP client can start `stashpad mcp` over stdio and gets eight tools. Run `stashpad setup` (or `stashpad setup codex`, `vscode`, `claude-code`) to print the settings. Stashpad prints them and never edits your client's files.
3. **A file the agent already reads.** `stashpad sync-agents AGENTS.md` puts a short brief between markers in `AGENTS.md`, which many agents read at the start. Run it again to refresh. Text outside the markers is not touched. That file then holds copies of your memories, so do not commit it if they are private.

## Claude Code (optional extra)

The repository is also a Claude Code plugin: hooks that print the brief at the start and after compaction, add matching memories to each prompt and leave a handoff before compaction (see `docs/HOOKS.md`), the MCP server, a skill and two commands (`/memory`, `/handover`). It is a thin layer over the commands above; nothing in the core needs it.

## Why the contract is frozen

Agents depend on tool names and arguments. `docs/tool-contract.json` records them, and a test fails if they change by accident. See `docs/UPDATING.md`.
