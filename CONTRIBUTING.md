# Contributing to Stashpad

Thanks for helping. Small fixes and big ideas are both welcome.

## Ways to help

- Report a bug or ask a question (use the issue forms, or Discussions for questions).
- Pick an issue labeled `good first issue`.
- Try Stashpad with your agent (Codex, Cursor, Gemini CLI, Cline, ...) and tell us what broke or what was missing.
- Improve the docs or add an example.

## Set up

```bash
git clone https://github.com/laaielichter/stashpad.git
cd stashpad
npm test          # Node 20 or newer; there are no dependencies to install
node bin/stashpad.mjs doctor --client
```

## Rules of the codebase

- No runtime dependencies. Node's standard library only.
- Memory files keep their fixed frontmatter (see `docs/FORMAT.md`); new data goes in store-level files.
- Everything returned to an agent is labelled as data. Agent writes wait for a person.
- Third-party code only with a permissive license, recorded in `THIRD_PARTY_NOTICES.md`.
- The agent tool contract is frozen (`docs/tool-contract.json`); change it only on purpose.
- Tests run on Linux, macOS and Windows with Node 20 and 22. Mind paths and line endings.

## Pull requests

1. Open an issue first for anything bigger than a small fix, so we can agree on the approach.
2. Keep each pull request to one change.
3. Add or update tests and docs.
4. Describe what changed and why.

## Be kind

We follow the [Code of Conduct](CODE_OF_CONDUCT.md). Be patient and specific; we will do the same.
