import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  const jsonOut = [];
  await run(["search", "jsonmiss", "--json", "--dir", dir], io(jsonOut));
  assert.equal(jsonOut.join(""), "[]");
  assert.equal(missReport(dir).find((row) => row.term === "jsonmiss")?.count, 1);
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

test("synonym add refuses an unreadable file, duplicates and the group limit (#30)", async () => {
  const dir = fresh();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "synonyms.json");

  // A hand-edited file with a trailing comma used to be replaced by just the
  // new group. Nothing may be written now, from the function or the CLI.
  const broken = '{"groups": [["k8s","kubernetes"],["pr","pull request"]],}';
  writeFileSync(file, broken);
  assert.throws(() => addSynonyms(dir, ["a", "b"]), /synonyms.json was not changed: synonyms.json cannot be read/);
  assert.equal(readFileSync(file, "utf8"), broken, "the file is byte-for-byte untouched");
  const err = [];
  const code = await run(["synonym", "add", "a", "b", "--dir", dir], { ...io([]), stderr: (s) => err.push(s) });
  assert.equal(code, 1);
  assert.match(err.join("\n"), /synonyms.json was not changed/);
  assert.equal(readFileSync(file, "utf8"), broken, "the CLI path also leaves it alone");

  // The same words in a different order or case are the same group: no write.
  writeFileSync(file, `${JSON.stringify({ groups: [["k8s", "kubernetes"]] }, null, 2)}\n`);
  const before = readFileSync(file, "utf8");
  const dup = addSynonyms(dir, ["KUBERNETES", "K8s"]);
  assert.equal(dup.added, false);
  assert.equal(dup.duplicate, true);
  assert.equal(readFileSync(file, "utf8"), before, "a duplicate changes nothing");
  const dupOut = [];
  await run(["synonym", "add", "Kubernetes", "k8s", "--dir", dir], io(dupOut));
  assert.match(dupOut.join("\n"), /Already there/);
  assert.equal(readFileSync(file, "utf8"), before, "the CLI duplicate also changes nothing");

  // A genuinely new group still works as before.
  const added = addSynonyms(dir, ["pr", "pull request"]);
  assert.equal(added.added, true);
  assert.equal(added.groups, 2);

  // Group 501 would be written but never used by the loader, so refuse it.
  const many = Array.from({ length: 500 }, (_, i) => [`word${i}a`, `word${i}b`]);
  writeFileSync(file, `${JSON.stringify({ groups: many }, null, 2)}\n`);
  const atLimit = readFileSync(file, "utf8");
  assert.throws(() => addSynonyms(dir, ["another", "word"]), /limit of 500 groups/);
  assert.equal(readFileSync(file, "utf8"), atLimit, "the limit refusal leaves the file unchanged");
});

test("synonym add needs at least two words", async () => {
  const out = [];
  const err = [];
  const code = await run(["synonym", "add", "solo", "--dir", fresh()], { ...io(out), stderr: (s) => err.push(s) });
  assert.equal(code, 1);
});
