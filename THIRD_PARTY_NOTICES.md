# Third-party notices

Stashpad itself is released under the MIT License (see `LICENSE`).

This file lists every piece of third-party code that is copied, ported or
adapted into Stashpad. Full license texts are kept in `third_party/licenses/`.

**Status: third-party code is included. Each file is listed in the table below.**

## How to add an entry

Add one row per upstream project, before the code is merged:

| Project | Source URL | Commit | License | Copyright holder | Stashpad files derived from it |
|---|---|---|---|---|---|
| graphiti | https://github.com/getzep/graphiti | d50741d1bf463cbe3859eb73914cbff1b66839e6 | Apache-2.0 | Copyright 2024, Zep Software, Inc. | `graphiti/temporal.mjs` |

Rules:

1. Only code under a license that allows reuse in an MIT project (MIT, Apache-2.0, BSD) may be included.
2. Never include code under AGPL, GPL, a source-available license, or no clear license.
3. Copy the full license text into `third_party/licenses/` (one file per project).
4. Keep the original copyright header in each copied file and add a short note that it was modified.
5. For Apache-2.0 projects, also carry over the upstream `NOTICE` content if the project has one.
6. Where a package exists, use it as a dependency instead of copying its code.
