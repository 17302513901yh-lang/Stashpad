import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.mjs";
import { importMemories, parseImport } from "../src/importer.mjs";
import { listPending, searchMemories } from "../src/store.mjs";

const fresh = () => mkdtempSync(join(tmpdir(), "stashpad-import-"));

test("JSON Lines: good lines are parsed, a broken line is reported with its number", () => {
  const content = [
    '{"id":"a-fact","kind":"fact","text":"First imported fact."}',
    "not json at all",
    '{"id":"b-fact","kind":"decision","text":"Second imported fact."}',
  ].join("\n");
  const { items, errors } = parseImport(content, "jsonl");
  assert.equal(items.length, 2);
  assert.deepEqual(errors, [{ line: 2, reason: "not valid JSON" }]);
});

test("plain text: each paragraph becomes one fact with a stable id", () => {
  const content = "The first paragraph is a fact.\n\nThe second paragraph is another fact.\n";
  const a = parseImport(content, "text").items;
  const b = parseImport(content, "text").items;
  assert.equal(a.length, 2);
  assert.deepEqual(a.map((i) => i.id), b.map((i) => i.id));
  assert.match(a[0].id, /^import-[0-9a-f]{10}$/);
});

test("imported memories wait for review and are not searchable", () => {
  const dir = fresh();
  const content = '{"id":"imp-one","kind":"fact","text":"Imported claim about widgets."}';
  const result = importMemories(dir, content, { format: "jsonl", sourceRef: "export file" });
  assert.deepEqual(result.queued, ["imp-one"]);
  assert.equal(listPending(dir).rows[0].source_type, "tool");
  assert.equal(existsSync(join(dir, "imp-one.md")), false);
  assert.equal(searchMemories(dir, "widgets").results.length, 0);
});

test("an import with a secret in it skips that item and queues the rest", () => {
  const dir = fresh();
  const content = [
    '{"id":"clean-one","kind":"fact","text":"A harmless fact about lists."}',
    '{"id":"leaky-one","kind":"fact","text":"Key sk-abcdefghijklmnopqrstuvwxyz123456 is here."}',
  ].join("\n");
  const result = importMemories(dir, content, { format: "jsonl", sourceRef: "export file" });
  assert.deepEqual(result.queued, ["clean-one"]);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /looks like a secret/);
});

test("CLI: import reads a file and reports how many are queued", async () => {
  const dir = fresh();
  const file = join(dir, "export.txt");
  writeFileSync(file, "Paragraph one, a fact.\n\nParagraph two, another fact.\n");
  const out = [];
  const io = { stdout: (s) => out.push(s), stderr: () => {}, env: {}, cwd: dir, readStdin: async () => "" };
  assert.equal(await run(["import", file, "--dir", join(dir, "store")], io), 0);
  assert.match(out[0], /Queued 2 memories for review/);
  assert.equal(listPending(join(dir, "store")).rows.length, 2);
});
