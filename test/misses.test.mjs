import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.mjs";
import { handleMessage } from "../src/mcp.mjs";
import { addSynonyms, missReport } from "../src/misses.mjs";
import { saveMemory, searchMemories } from "../src/store.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fresh = () => join(mkdtempSync(join(tmpdir(), "stashpad-miss-")), "s");
const io = (out) => ({ stdout: (s) => out.push(s), stderr: () => {}, env: {}, cwd: root, readStdin: async () => "" });

test("missed searches are logged by word, with close words, and a synonym fixes them", async () => {
  const dir = fresh();
  saveMemory(dir, { id: "db", kind: "decision", text: "The project database is Postgres 16.", sourceType: "user", sourceRef: "t" });
  const out = [];
  await run(["search", "postgresql", "--dir", dir], io(out));
  await run(["search", "postgresql setup", "--dir", dir], io(out));
  handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "stashpad_search", arguments: { query: "postgresql" } } }, { dir });
  const [top] = missReport(dir);
  assert.equal(top.term, "postgresql");
  assert.equal(top.count, 3);
  assert.ok(top.close.includes("postgre") || top.close.some((w) => w.startsWith("postgre")), JSON.stringify(top));
  assert.ok(!readFileSync(join(dir, "misses.jsonl"), "utf8").includes("setup postgresql"), "only words are kept, not the query");
  addSynonyms(dir, ["postgresql", "postgres"]);
  assert.equal(searchMemories(dir, "postgresql").results[0].id, "db");
  const lines = [];
  assert.equal(await run(["misses", "--dir", dir], io(lines)), 0);
  assert.match(lines.join("\n"), /3x  postgresql/);
});

test("synonym add needs at least two words", async () => {
  const out = [];
  const err = [];
  const code = await run(["synonym", "add", "solo", "--dir", fresh()], { ...io(out), stderr: (s) => err.push(s) });
  assert.equal(code, 1);
});
