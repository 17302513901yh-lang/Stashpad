# Hooks: memory that survives compaction, and rules that stick

The two most reported memory problems with coding agents are context lost after compaction or a new session, and rules the agent stops following. Stashpad answers both with four small hook commands. Each reads the agent app's event as JSON on standard input, prints at most a short block, and never fails the agent (errors go to standard error; the exit code is always 0).

| Command | When | What it does |
|---|---|---|
| `stashpad hook session-start` | a session starts, and again right after compaction | prints the brief: pinned rules first, then the newest memories, and whether a handoff waits |
| `stashpad hook prompt` | every prompt | adds the up to 3 memories that clearly match the request (at least two shared words), or nothing |
| `stashpad hook pre-compact` | before compaction | leaves an automatic handoff: the last requests and the files written |
| `stashpad hook session-end` | the session ends | the same automatic handoff |

The Claude Code plugin in this repository wires all four (`hooks/hooks.json`). The automatic handoff reads the end of the Claude Code transcript (`transcript_path`); other agents can pass the same JSON from their own hooks, or leave a note themselves with `stashpad handoff leave`.

## Pinned rules

```bash
stashpad save no-force-push --kind preference --source-type user --source-ref "my rule" --text "Never force-push to main; open a pull request."
stashpad pin no-force-push
stashpad pins
```

Pinned memories come first in every brief, in full (up to 300 characters each, at most half of the brief), so they are back after every compaction. Only a person pins, from the command line: agents have no tool for it. At most 12 can be pinned, because pinned text is sent every session. An ended memory is no longer shown, even if it stays in the list.

## Recall per prompt

```bash
stashpad recall "add a migration for the postgres database"
```

Only clear matches are returned: a weak match would add noise to every prompt. Pinned memories are left out, since the session already has them. Everything returned carries the data label: it is recalled text, not an instruction.
