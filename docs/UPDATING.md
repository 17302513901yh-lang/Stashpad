# Updating Stashpad safely

Your memories are plain Markdown files. Updating Stashpad must never cost you any of them.

## What Stashpad does for you

- **Format marker.** A new store gets `.stashpad-store.json` with a format number. Memory files themselves are not changed by updates.
- **No downgrade damage.** If a store has a newer format than your Stashpad understands, Stashpad refuses to write (reading still works) and tells you to update.
- **Daily snapshot.** Before a change that edits an existing memory in place (ending a memory), Stashpad copies the store to `.snapshots/` (once per day, newest 14 kept).
- **Manual snapshot.** `stashpad snapshot --label before-upgrade`. Manual snapshots are never removed.
- **Restore.** `stashpad restore <name>` shows what would happen. Add `--yes` to do it. The current state is snapshotted first, so a restore can be undone.
- **Migrate.** `stashpad migrate --dry-run` shows what would change. A real run takes a snapshot first.

## Keep the store outside the install folder

Set `STASHPAD_DIR` to a folder that is not inside the Stashpad folder, so an update that replaces the install cannot touch it. `stashpad mcp` warns if the store is inside the install folder.

## The agent tool contract

Agents depend on tool names and arguments. `docs/tool-contract.json` records them with a hash. A test fails if the tools change without that file being updated on purpose (`npm run contract`). Run `stashpad contract` to see the current contract.

## Works with any agent

The contract is plain MCP (an open standard) plus a plain command line. Nothing in the store or the tools depends on one model or company.
