# Decision: no vector search for now

Status: decided, to be revisited when a real case needs it.

## Why

- The eval harness (`stashpad eval`) finds the expected memory first for all 13 queries on the fixed set, with word matching alone.
- The grep baseline scores the same on that set, so the fixed set does not show a gap that vectors would close.
- Vectors need an embedding model. Stashpad has no runtime dependencies, and a model would break that rule and the offline default.

## Revisit when

- Real use shows queries that fail because the words differ (synonyms, other languages), and a case is recorded in the eval set.
- An embedding model can run locally without adding a runtime dependency, or a user opts in to one.

Until then, any vector feature must show a better score in `stashpad eval` than word matching before it is turned on.
