# Security policy

## Supported versions

Security fixes go into the latest published version on npm. Update with `npm install -g stashpad@latest` before reporting.

## Reporting a vulnerability

Use **Report a vulnerability** in the repository's **Security** tab to send a private report. Do not open a public issue for a vulnerability, and do not include real memories, passphrases or keys in the report.

Useful to include: the Stashpad version (`stashpad --version`), operating system, agent app, what an attacker can do, and the steps to reproduce.

## What Stashpad defends against

- Text in memories or tool results that tries to give an agent orders: everything returned is labelled as data, agent writes wait for a person, instruction-like text is flagged.
- Secrets in memories: keys, tokens, JWTs and passwords in connection strings are refused at write time.
- Invisible characters that hide text: refused.
- Two processes writing at once: a store lock.
- Files read by someone who gets the disk: optional encryption at rest (AES-256-GCM, scrypt).

## What it does not defend against

- A malicious program already running as your user (it can read the files and the passphrase variable).
- An agent that ignores the data label. Stashpad lowers the risk; the agent and its permission settings still decide what runs.
- File names (memory ids) and dates in an encrypted store; these stay readable.
