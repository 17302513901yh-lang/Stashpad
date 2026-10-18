import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.mjs";
import { handleMessage } from "../src/mcp.mjs";
import { listMemories, saveMemory, searchMemories, StoreError } from "../src/store.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function store() {
  const dir = join(mkdtempSync(join(tmpdir(), "stashpad-filter-")), "s");
  const put = (id, kind, text, extra = {}) =>
    saveMemory(dir, { id, kind, text, sourceType: "user", sourceRef: "t", validFrom: "2026-01-01", ...extra }, "2026-01-01");
  put("db-v1", "decision", "The database is SQLite for the index.");
  put("db-v2", "decision", "The database is Postgres for the index.", { validFrom: "2026-06-01", supersedes: "db-v1" });
  put("db-note", "fact", "The database backups run nightly.");
  return dir;
}

test("kind filter and as-of date give the right answer for that day", () => {
  const dir = store();
  assert.deepEqual(searchMemories(dir, "database", { kinds: ["decision"], today: "2026-10-01" }).results.map((r) => r.id), ["db-v2"]);
  assert.deepEqual(searchMemories(dir, "database", { kinds: ["decision"], asOf: "2026-03-01" }).results.map((r) => r.id), ["db-v1"]);
  assert.deepEqual(listMemories(dir, { asOf: "2026-03-01" }).rows.map((r) => r.id).sort(), ["db-note", "db-v1"]);
});

test("since, until and source type filters", () => {
  const dir = store();
  assert.deepEqual(listMemories(dir, { includeEnded: true, since: "2026-05-01" }).rows.map((r) => r.id), ["db-v2"]);
  assert.equal(listMemories(dir, { includeEnded: true, until: "2026-05-01" }).rows.length, 2);
  assert.equal(listMemories(dir, { sourceTypes: ["agent"] }).rows.length, 0);
});

test("bad filter values give a clear error", () => {
  const dir = store();
  assert.throws(() => searchMemories(dir, "x", { asOf: "yesterday" }), StoreError);
  assert.throws(() => searchMemories(dir, "x", { kinds: ["idea"] }), /unknown kind/);
});

test("explain shows which words matched, including synonyms", async () => {
  const dir = store();
  const { results } = searchMemories(dir, "db backups", { explain: true });
  assert.deepEqual(results[0].matched.sort(), ["backup", "database (synonym)", "db"]);
  const out = [];
  const io = { stdout: (s) => out.push(s), stderr: () => {}, env: {}, cwd: root, readStdin: async () => "" };
  assert.equal(await run(["search", "database", "--dir", dir, "--kind", "fact", "--explain"], io), 0);
  assert.match(out.join("\n"), /matched: database/);
});

test("the MCP search tool takes kind and as_of", () => {
  const dir = store();
  const reply = handleMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "stashpad_search", arguments: { query: "database", kind: "decision", as_of: "2026-03-01" } } },
    { dir },
  );
  const data = JSON.parse(reply.result.content[0].text);
  assert.deepEqual(data.results.map((r) => r.id), ["db-v1"]);
});
