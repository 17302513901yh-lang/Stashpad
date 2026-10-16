# Stashpad

Local memory for AI agents. Memories are plain Markdown files you can read, edit in review and diff.
Every memory has a source, dates and a trust level. Old facts are ended, not overwritten.

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

## Principles

- Plain files first. The files are the source of truth.
- Nothing from an agent, tool or web page is stored until a person accepts it.
- Secrets are refused at write time.
- Recalled text is labelled as data, not instructions.

## Docs

- [Memory file format](docs/FORMAT.md)
- [Search backend decision](docs/decisions/search-backend.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## License

MIT. See [LICENSE](LICENSE).
