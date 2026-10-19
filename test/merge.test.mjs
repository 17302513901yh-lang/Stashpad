import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.mjs";
import { findDuplicates, listMemories, mergeMemories, readMemory, saveMemory, StoreError } from "../src/store.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fresh = () => join(mkdtempSync(join(tmpdir(), "stashpad-merge-")), "s");
const put = (dir, id, text, kind = "fact") => saveMemory(dir, { id, kind, text, sourceType: "user", sourceRef: "t" });

test("near-duplicates are found, merged, and the ended ones keep their history", async () => {
  const dir = fresh();
  put(dir, "port-a", "The development server listens on port 8080 locally.");
  put(dir, "port-b", "The local development server listens on port 8080.");
  put(dir, "other", "Deploys happen every Tuesday afternoon.");
  put(dir, "port-c", "The development server listens on port 8080 locally.", "decision");
  const pairs = findDuplicates(dir);
  assert.deepEqual(pairs.map((p) => [p.a, p.b]), [["port-a", "port-b"]], "same kind only");
  const done = mergeMemories(dir, "port-a", ["port-b"]);
  assert.deepEqual(done.ended, ["port-b"]);
  assert.deepEqual(listMemories(dir).rows.map((r) => r.id).sort(), ["other", "port-a", "port-c"]);
  assert.match(readMemory(dir, "port-b").text, /valid_to: \d{4}-/);
  assert.match(readFileSync(join(dir, "audit.jsonl"), "utf8"), /"merged"/);
  assert.throws(() => mergeMemories(dir, "port-a", ["port-b"]), StoreError);
  assert.throws(() => mergeMemories(dir, "port-a", ["port-a"]), /itself/);
  const out = [];
  const io = { stdout: (s) => out.push(s), stderr: () => {}, env: {}, cwd: root, readStdin: async () => "" };
  assert.equal(await run(["duplicates", "--dir", dir], io), 0);
  assert.match(out.join("\n"), /No near-duplicates/);
});
