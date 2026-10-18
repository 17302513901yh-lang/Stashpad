# Optional encryption

Off by default. A plain store is plain Markdown you can read in any editor. Turn encryption on only if the memories must not be readable by someone who gets the files (a stolen laptop, a synced folder, a backup).

## Turn it on

```bash
export STASHPAD_PASSPHRASE="a long passphrase you will not forget"   # or: export STASHPAD_KEY_FILE=~/.stashpad-key
stashpad encrypt
```

Every command, the MCP server, the review page and the session brief keep working as before, as long as the same passphrase is set. Without it, or with a wrong one, Stashpad stops with one clear message and changes nothing.

**If you lose the passphrase, the memories are gone.** There is no reset and no back door.

## What is sealed

- every memory file, waiting write, rejected write and raw source copy
- every line of the audit log
- every snapshot (they are converted too, so no plain copy stays behind)

Sealing uses AES-256-GCM from Node itself; the key comes from the passphrase with scrypt and a random salt kept in `.stashpad-store.json`. A changed or damaged sealed file is detected and refused, not silently read.

## What is not sealed

- file names, which are the memory ids (choose ids that say nothing private), and file dates
- `.stashpad-store.json` (format, salt and a check value; no key) and `synonyms.json`
- names of source copies made before encryption was turned on (new copies get a random-looking name)
- anything Stashpad prints or writes out on purpose: `export`, `brief`, `sync-agents` (AGENTS.md is plain text)

## Turn it off

```bash
stashpad decrypt --yes
```

## Safe to stop halfway

Each file is rewritten on its own, and reading accepts both sealed and plain files. If `encrypt` or `decrypt` is stopped, run it again to finish. `stashpad doctor` says when some files are still plain.

## Passphrase in a key file or the environment

A key file (`STASHPAD_KEY_FILE`) that only you can read is safer than an environment variable, which other programs of the same user can sometimes see. For an MCP client, put the variable in the client's server settings (`stashpad setup` shows where).
