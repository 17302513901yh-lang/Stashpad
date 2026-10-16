// Benchmark: pure JavaScript BM25 (no index) versus SQLite FTS5 (node:sqlite, Node 22.13+).
// Synthetic, seeded data so runs are repeatable. Prints a table and one BENCH-RESULT line for CI.
// Usage: node scripts/bench-search.mjs
import { bm25Rank } from "../src/search.mjs";

const SIZES = [100, 1000, 5000];
const QUERY_COUNT = 20;
const RUNS = 3;
const VOCAB_SIZE = 2000;
const WORDS_PER_DOC = 40;

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

// Skewed pick: low indexes (frequent words) are chosen more often, like real text.
function pickTerm(random, vocabulary) {
  return vocabulary[Math.floor(vocabulary.length * random() ** 2)];
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function buildCorpus(size, random) {
  const vocabulary = Array.from({ length: VOCAB_SIZE }, (_, i) => `term${i.toString(36)}`);
  const docs = Array.from({ length: size }, (_, i) => ({
    id: `doc-${i}`,
    text: Array.from({ length: WORDS_PER_DOC }, () => pickTerm(random, vocabulary)).join(" "),
  }));
  const queries = Array.from({ length: QUERY_COUNT }, () =>
    Array.from({ length: 2 + Math.floor(random() * 2) }, () => pickTerm(random, vocabulary)),
  );
  return { docs, queries };
}

function timeMs(fn) {
  const start = performance.now();
  const result = fn();
  return { ms: performance.now() - start, result };
}

async function loadSqlite() {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    return DatabaseSync;
  } catch {
    return null;
  }
}

function benchPureJs(docs, queries) {
  const perQuery = [];
  for (let run = 0; run < RUNS; run++) {
    for (const terms of queries) {
      perQuery.push(timeMs(() => bm25Rank(docs, terms.join(" "))).ms);
    }
  }
  return { queryMedianMs: median(perQuery), buildMs: 0 };
}

function benchSqlite(DatabaseSync, docs, queries) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE memories USING fts5(id, body)");
  const insert = db.prepare("INSERT INTO memories(id, body) VALUES (?, ?)");
  const build = timeMs(() => {
    db.exec("BEGIN");
    for (const doc of docs) insert.run(doc.id, doc.text);
    db.exec("COMMIT");
  });

  const search = db.prepare("SELECT id FROM memories WHERE memories MATCH ? ORDER BY rank LIMIT 10");
  const perQuery = [];
  for (let run = 0; run < RUNS; run++) {
    for (const terms of queries) {
      const match = terms.join(" OR ");
      perQuery.push(timeMs(() => search.all(match)).ms);
    }
  }
  db.close();
  return { queryMedianMs: median(perQuery), buildMs: build.ms };
}

const DatabaseSync = await loadSqlite();
const rows = [];

for (const size of SIZES) {
  const { docs, queries } = buildCorpus(size, seededRandom(42 + size));
  const pure = benchPureJs(docs, queries);
  const sqlite = DatabaseSync ? benchSqlite(DatabaseSync, docs, queries) : null;
  rows.push({
    notes: size,
    pureJsQueryMs: round(pure.queryMedianMs),
    sqliteBuildMs: sqlite ? round(sqlite.buildMs) : null,
    sqliteQueryMs: sqlite ? round(sqlite.queryMedianMs) : null,
  });
}

function round(n) {
  return Math.round(n * 100) / 100;
}

console.log(`Node ${process.version} on ${process.platform}/${process.arch}`);
console.log(`SQLite FTS5: ${DatabaseSync ? "available" : "not available on this Node version"}`);
console.log("notes | pure JS query ms (median) | SQLite build ms | SQLite query ms (median)");
for (const row of rows) {
  console.log(
    `${row.notes} | ${row.pureJsQueryMs} | ${row.sqliteBuildMs ?? "n/a"} | ${row.sqliteQueryMs ?? "n/a"}`,
  );
}
console.log(
  `BENCH-RESULT ${JSON.stringify({ node: process.version, platform: process.platform, sqlite: Boolean(DatabaseSync), rows })}`,
);
