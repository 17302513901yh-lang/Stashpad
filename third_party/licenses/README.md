# Third-party license texts

Put the full license text of every upstream project whose code is included in
Stashpad in this folder, one file per project (for example `mem0-Apache-2.0.txt`).

Each file must match an entry in `../../THIRD_PARTY_NOTICES.md`.
Files here are created by `npm run port` (see `scripts/port-file.mjs`), which refuses any license that is not MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause or ISC.
