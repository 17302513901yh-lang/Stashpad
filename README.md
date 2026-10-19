<h1 align="center">Stashpad</h1>
<p align="center"><b>Local memory for any AI coding agent: an MCP server and CLI that keep plain Markdown notes with sources, a review queue and search.</b></p>
<p align="center">
  <a href="https://github.com/laaielichter/stashpad/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/laaielichter/stashpad/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/stashpad"><img alt="npm" src="https://img.shields.io/npm/v/stashpad"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>
<p align="center">
  <img src="https://raw.githubusercontent.com/laaielichter/stashpad/main/docs/demo/demo.svg" alt="Stashpad in a terminal: a person saves and pins a decision, an agent's note waits for review, recall finds both for a request, and the brief brings the pinned rule back after compaction" width="760">
</p>

Works with Claude Code, Codex, Cursor, VS Code, Gemini CLI and any other MCP client, or with no MCP at all (plain commands and an `AGENTS.md` block). No model, no cloud, no dependencies: Node 20 or newer.

## Quickstart

```bash
npm install -g stashpad
stashpad setup                  # prints the MCP settings for your agent app (generic, claude-code, vscode, codex)
stashpad doctor --client        # starts the server the way your agent app does and checks it answers
```

Expected: `client start: the server answered with 8 tools in ... ms` and `Nothing is broken.`

Claude Code users can install the plugin instead, which also adds the hooks below: `/plugin marketplace add laaielichter/stashpad`, then `/plugin install stashpad@stashpad` (or `stashpad@reverseport` from the [ReversePort marketplace](#sister-tools)).

## Why Stashpad?

- **Your agent stops forgetting after compaction.** Pinned rules and the latest handoff come back at the start of every session and right after `/compact`.
- **Rules you set stay in front of the agent.** `stashpad pin` keeps the few rules that matter in every brief; each prompt gets only the memories that clearly match it.
- **Nothing ends up in memory behind your back.** Agent, tool and web notes wait for a person; near-copies, secrets and hidden text are refused.
- **You can read, fix and keep it.** Memories are Markdown files with a source and dates, in your project, in git if you want. Old facts are ended, never overwritten.
- **It keeps working.** One store per project (worktrees share it), a lock for parallel writers, snapshots before changes, `doctor` that says what to fix.

## How it compares

| | Stashpad | mem0 (open source) | MCP reference memory server | `CLAUDE.md` / `AGENTS.md` by hand |
|---|---|---|---|---|
| Needs | Node 20 | an LLM and an embedding/vector store | Node | nothing |
| Storage | Markdown files, one per memory | vector store (+ history DB) | one JSON Lines graph file | one Markdown file |
| What gets saved | what a person writes, or an agent proposes and a person accepts | facts an LLM extracts from conversations | what the agent writes | what you write |
| Search | words (BM25) + synonyms; misses some rewordings | semantic (embeddings) | substring match | the agent reads all of it |
| Old facts | ended with dates and a supersede chain | updated or deleted | edited in place | edited by hand |
| Survives compaction | brief + pins + handoff via hooks | depends on the client | depends on the client | yes (always loaded) |
| Safety | review queue, secret and hidden-text checks, data label, optional encryption | depends on setup | none built in | none |
| License | MIT | Apache-2.0 | MIT / Apache-2.0 | – |

What Stashpad does **not** do: semantic search (word search finds about 2 of 3 reworded questions in our eval), automatic extraction of memories from chats (by design), sync between computers (use git), or a shared server for a team.

## Start and end of a session

```bash
stashpad brief                  # short summary: pinned rules, newest memories, open handoff
stashpad recall "add a postgres migration"    # the few memories that clearly match a request
stashpad handoff leave --text "Half done: auth. Next: tests."   # a note the next session reads once
stashpad sync-agents AGENTS.md  # put the brief in a file agents already read (no MCP needed)
```

With the Claude Code plugin these run as hooks: at session start and after compaction, on each prompt, and before compaction (an automatic handoff). See [docs/HOOKS.md](docs/HOOKS.md). Agents: read [AGENT-GUIDE.md](AGENT-GUIDE.md).

## Develop

Requires Node 20 or newer. No other dependencies.

```bash
npm test                 # run the tests
npm run build            # build dist/
node bin/stashpad.mjs --help
```

Memories live in `.stashpad/memories` of the project: the nearest folder above that has one, else the git root, so subfolders and git worktrees share one store. `stashpad where` shows which store a folder uses and why. Set `STASHPAD_DIR` or pass `--dir` to choose yourself. What is true in every project (your language, your commit style) goes in the global store: add `--global` (or `-g`).

## Use it

```bash
stashpad save db-choice --kind decision --source-type user --source-ref "statement in chat" --text "We keep data in SQLite."
stashpad search "sqlite" --json
stashpad save db-choice-v2 --kind decision --source-type user --source-ref "later statement" --text "We keep data in Postgres." --supersedes db-choice
stashpad history db-choice-v2
stashpad search database --kind decision --as-of 2026-03-01 --explain   # what was decided on that day, and why it matched
stashpad entities                  # names, tools and files the memories talk about
stashpad about Postgres            # every memory about it, and what is mentioned with it
stashpad confirm db-choice-v2      # still true; doctor flags agent memories nobody confirmed for 180 days
stashpad handoff leave --text "Half done: auth. Next: tests."   # a note the next session reads once
stashpad handoff claim             # take it (a person's notes first); listing never takes one
stashpad feedback db-choice --signal stale   # helpful, stale or wrong; wrong also asks for it to end
stashpad lint                      # what deserves a look; changes nothing
```

The command line, the MCP server and the review page can run at the same time: every write takes a short lock on the store.

Writes from agents, tools and the web wait in review:

```bash
stashpad review
stashpad accept <id>
stashpad reject <id> --reason "not verified"
stashpad audit
```

## Use it from an MCP client

`stashpad setup` prints the right block for your client, with the full path to Node (a bare `node` is the most common reason a server does not connect). It looks like this:

```json
{
  "mcpServers": {
    "stashpad": {
      "command": "/full/path/to/node",
      "args": ["/full/path/to/stashpad/bin/stashpad.mjs", "mcp"]
    }
  }
}
```

Eight tools: `stashpad_search`, `stashpad_get`, `stashpad_recent`, `stashpad_about`, `stashpad_save`, `stashpad_forget`, `stashpad_handoff`, `stashpad_feedback`.

## Check it, import into it

```bash
stashpad eval                          # 40 notes, 33 queries (English and Dutch), safety checks; no language model is called. Paraphrased questions are measured too (about 2 of 3 found): word search misses some rewordings, and that is reported openly.
stashpad import notes.jsonl            # queue memories from an export; they wait for review
stashpad export --out memories.jsonl   # back up current memories as JSON Lines (--all adds ended ones)
stashpad save <id> --kind fact --source-type user --source-file notes.txt --text "..."   # keeps a copy of the raw source
```

`stashpad review` also shows when a waiting memory may conflict with a current one, and whether accepting it would end that one.

## Review in a page

```bash
stashpad ui            # opens http://127.0.0.1:4317/ to review, search and read the audit log
stashpad ui --open     # the same, and opens the page in your browser
```

Only this computer can reach the page. It is a small local page with no outside resources. See [the decision](docs/decisions/ui.md).

Imports come in as JSON Lines (`id`, `kind`, `text`, optional `valid_from`, `source_ref`) or as plain text, one fact per paragraph.

## Principles

- Plain files first. The files are the source of truth.
- Nothing from an agent, tool or web page is stored until a person accepts it.
- Secrets are refused at write time (keys, tokens, JWTs, Bearer tokens, passwords in connection strings).
- Invisible characters are refused, and look-alike or split-up words cannot hide an instruction or a secret.
- Instruction-like text (English and Dutch) is flagged for the reviewer.
- A gatekeeper refuses agent notes that are too short or near-copies of an existing or waiting memory, and logs the refusal in the audit log. Notes a person writes are never blocked.
- Limits: 4000 characters per memory, 200 writes waiting for review.
- Recalled text is labelled as data, not instructions.

## Docs

- [Search words and synonyms](docs/FORMAT.md#search-words-and-synonyms)
- [Handoffs, feedback, lint, expiry and ReversePort](docs/HANDOFFS.md)
- [Hooks: survive compaction, pinned rules, recall per prompt](docs/HOOKS.md)
- [Optional encryption](docs/ENCRYPTION.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Changelog](CHANGELOG.md)
- [Use with any agent](docs/ANY-AGENT.md)
- [Updating safely: snapshots, restore, migrate](docs/UPDATING.md)
- [Memory file format](docs/FORMAT.md)
- [Search backend decision](docs/decisions/search-backend.md)
- [No vector search for now](docs/decisions/vectors.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md). Code is ported with `npm run port`, which refuses any license except MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause and ISC.

## FAQ

**Does Stashpad send anything anywhere?** No. It makes no network calls, calls no model and has no telemetry. The review page listens only on this computer.

**Where are my memories?** In `.stashpad/memories` of your project (`stashpad where` tells you). They are Markdown files you can open, edit and commit.

**Can an agent write whatever it wants into memory?** No. Agent writes wait for a person (`stashpad review` or `stashpad ui`). Secrets, invisible characters and near-copies are refused, and everything recalled is labelled as data, not instructions.

**My MCP client says the server failed.** Run `stashpad doctor --client`. It starts the server the way an agent app does and tells you what to fix.

## Sister tools

From the same author; local, open source, each with its own MCP server.

- [**ReversePort**](https://github.com/laaielichter/reverseport): reverse engineer apps, games, binaries and websites and port them between Godot, Unity, Unreal, three.js
  and languages. `re_case remember` proposes a proof case's findings to Stashpad's review queue
  ([how](docs/HANDOFFS.md)).
- [**agentdisk**](https://github.com/laaielichter/agentdisk): the disk report for coding agents. Finds the worktrees, checkpoints and dependency folders agents leave
  behind and cleans up only what is safe, with undo.

In Claude Code you can get all three from one marketplace: `/plugin marketplace add laaielichter/reverseport`,
then `/plugin install reverseport@reverseport`, `stashpad@reverseport` or `agentdisk@reverseport`.

## Contributing and community

Ideas, bug reports and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md), the [good first issues](https://github.com/laaielichter/stashpad/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) and [Discussions](https://github.com/laaielichter/stashpad/discussions). Security problems: [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
