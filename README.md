# Stashpad

**Memory for AI agents that you can read, edit and trust.**

Stashpad keeps what an agent learns as plain Markdown files. Every memory has a source, dates and a trust level. Agents propose, a person accepts. Old facts are ended, never overwritten.

- **Plain files.** Open them in any editor, diff them, keep them in git.
- **Safe by default.** Agent and web writes wait in a review queue. Secrets are refused.
- **Nothing to install.** Node 20 or newer, no dependencies.

```bash
git clone https://github.com/laaielichter/stashpad && cd stashpad
node bin/stashpad.mjs save db-choice --kind decision --source-type user --source-ref "chat" --text "We keep data in SQLite."
node bin/stashpad.mjs search sqlite
```

Agents: read [AGENT-GUIDE.md](AGENT-GUIDE.md).

## Install and run

Requires Node 20 or newer. No other dependencies.

```bash
npm test                 # run the tests
npm run build            # build dist/
node bin/stashpad.mjs --help
```

Memories live in `./.stashpad/memories` by default. Set `STASHPAD_DIR` or pass `--dir`.

## Use it

```bash
stashpad save db-choice --kind decision --source-type user --source-ref "statement in chat" --text "We keep data in SQLite."
stashpad search "sqlite" --json
stashpad save db-choice-v2 --kind decision --source-type user --source-ref "later statement" --text "We keep data in Postgres." --supersedes db-choice
stashpad history db-choice-v2
```

Writes from agents, tools and the web wait in review:

```bash
stashpad review
stashpad accept <id>
stashpad reject <id> --reason "not verified"
stashpad audit
```

## Use it from an MCP client

```json
{
  "mcpServers": {
    "stashpad": {
      "command": "node",
      "args": ["/path/to/stashpad/bin/stashpad.mjs", "mcp", "--dir", "/path/to/your/memories"]
    }
  }
}
```

Five tools: `stashpad_search`, `stashpad_get`, `stashpad_recent`, `stashpad_save`, `stashpad_forget`.

## Check it, import into it

```bash
stashpad eval                          # fixed checks and baselines; no language model is called
stashpad import notes.jsonl            # queue memories from an export; they wait for review
stashpad export --out memories.jsonl   # back up current memories as JSON Lines (--all adds ended ones)
stashpad save <id> --kind fact --source-type user --source-file notes.txt --text "..."   # keeps a copy of the raw source
```

`stashpad review` also shows when a waiting memory may conflict with a current one, and whether accepting it would end that one.

Imports come in as JSON Lines (`id`, `kind`, `text`, optional `valid_from`, `source_ref`) or as plain text, one fact per paragraph.

## Principles

- Plain files first. The files are the source of truth.
- Nothing from an agent, tool or web page is stored until a person accepts it.
- Secrets are refused at write time.
- Recalled text is labelled as data, not instructions.

## Docs

- [Memory file format](docs/FORMAT.md)
- [Search backend decision](docs/decisions/search-backend.md)
- [No vector search for now](docs/decisions/vectors.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md). Code is ported with `npm run port`, which refuses any license except MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause and ISC.

## License

MIT. See [LICENSE](LICENSE).
