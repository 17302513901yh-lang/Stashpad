import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.mjs";
import { listPending, saveMemory } from "../src/store.mjs";

const fresh = () => mkdtempSync(join(tmpdir(), "stashpad-gaps-"));

function harness() {
  const out = [];
  const err = [];
  const io = { stdout: (s) => out.push(s), stderr: (s) => err.push(s), env: {}, cwd: tmpdir(), readStdin: async () => "" };
  return { io, out, err };
}

test("review shows a waiting memory that may conflict with a current one, and whether accepting it ends that one", () => {
  const dir = fresh();
  saveMemory(dir, { id: "office-addr", kind: "fact", text: "The office is on Main Street.", sourceType: "user", sourceRef: "chat" }, "2026-01-01");
  saveMemory(dir, { id: "office-move", kind: "fact", text: "The office moves to Canal Street.", sourceType: "agent", sourceRef: "meeting note" });
  const row = listPending(dir).rows.find((r) => r.id === "office-move");
  assert.deepEqual(row.conflicts, [{ id: "office-addr", would_end: true }]);
});

test("a memory of another kind, or with only one shared word, is not a conflict", () => {
  const dir = fresh();
  saveMemory(dir, { id: "office-addr", kind: "fact", text: "The office is on Main Street.", sourceType: "user", sourceRef: "chat" }, "2026-01-01");
  saveMemory(dir, { id: "office-task", kind: "task", text: "The office moves to Canal Street.", sourceType: "agent", sourceRef: "note" });
  saveMemory(dir, { id: "unrelated", kind: "fact", text: "Lunch is at noon.", sourceType: "agent", sourceRef: "note" });
  const rows = Object.fromEntries(listPending(dir).rows.map((r) => [r.id, r.conflicts]));
  assert.deepEqual(rows["office-task"], []);
  assert.deepEqual(rows.unrelated, []);
});

test("save keeps the raw source in the store and links it from source_ref", async () => {
  const dir = fresh();
  const source = join(dir, "meeting.txt");
  writeFileSync(source, "Long raw meeting notes. The launch is in spring.\n");
  const store = join(dir, "store");
  assert.equal(await run(["save", "launch-date", "--kind", "fact", "--source-type", "user", "--text", "Launch is in spring.", "--source-file", source, "--dir", store], harness().io), 0);

  const archived = readdirSync(join(store, "sources"));
  assert.equal(archived.length, 1);
  assert.match(archived[0], /^[0-9a-f]{12}-meeting\.txt$/);
  assert.equal(readFileSync(join(store, "sources", archived[0]), "utf8"), readFileSync(source, "utf8"));

  const shown = harness();
  assert.equal(await run(["get", "launch-date", "--json", "--dir", store], shown.io), 0);
  assert.match(JSON.parse(shown.out[0]).source_ref, new RegExp(`raw: sources/${archived[0]}`));

  const listed = harness();
  assert.equal(await run(["list", "--json", "--dir", store], listed.io), 0);
  assert.deepEqual(JSON.parse(listed.out[0]).map((r) => r.id), ["launch-date"]);
});

test("the same raw source saved twice is stored once", async () => {
  const dir = fresh();
  const source = join(dir, "notes.txt");
  writeFileSync(source, "Same content.\n");
  const store = join(dir, "store");
  for (const id of ["first-fact", "second-fact"]) {
    assert.equal(await run(["save", id, "--kind", "fact", "--source-type", "user", "--text", `Fact ${id}.`, "--source-file", source, "--dir", store], harness().io), 0);
  }
  assert.equal(readdirSync(join(store, "sources")).length, 1);
});

test("a source that is a folder, or a missing file, is refused", async () => {
  const dir = fresh();
  const store = join(dir, "store");
  const { io, err } = harness();
  assert.equal(await run(["save", "bad-source", "--kind", "fact", "--source-type", "user", "--text", "A fact.", "--source-file", dir, "--dir", store], io), 1);
  assert.match(err.join("\n"), /must be a file/);
  const missing = harness();
  assert.equal(await run(["save", "bad-source", "--kind", "fact", "--source-type", "user", "--text", "A fact.", "--source-file", join(dir, "nope.txt"), "--dir", store], missing.io), 1);
  assert.match(missing.err.join("\n"), /not found/);
});

test("export writes current memories as JSON Lines, and --all adds ended ones", async () => {
  const dir = fresh();
  const store = join(dir, "store");
  saveMemory(store, { id: "fact-old", kind: "fact", text: "Old fact about trains.", sourceType: "user", sourceRef: "chat" }, "2026-01-01");
  saveMemory(store, { id: "fact-new", kind: "fact", text: "New fact about trains.", sourceType: "user", sourceRef: "chat", supersedes: "fact-old" }, "2026-05-01");

  const current = harness();
  assert.equal(await run(["export", "--dir", store], current.io), 0);
  const currentIds = current.out[0].split("\n").map((line) => JSON.parse(line).id);
  assert.deepEqual(currentIds, ["fact-new"]);

  const all = harness();
  assert.equal(await run(["export", "--all", "--dir", store], all.io), 0);
  const allLines = all.out[0].split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(allLines.map((l) => l.id).sort(), ["fact-new", "fact-old"]);
  assert.equal(allLines.find((l) => l.id === "fact-old").valid_to, "2026-05-01");
});

test("export to a file refuses to overwrite it", async () => {
  const dir = fresh();
  const store = join(dir, "store");
  saveMemory(store, { id: "one-fact", kind: "fact", text: "A fact.", sourceType: "user", sourceRef: "chat" }, "2026-01-01");
  const target = join(dir, "backup.jsonl");
  assert.equal(await run(["export", "--out", target, "--dir", store], harness().io), 0);
  assert.equal(existsSync(target), true);
  const again = harness();
  assert.equal(await run(["export", "--out", target, "--dir", store], again.io), 1);
  assert.match(again.err.join("\n"), /refusing to overwrite/);
});

test("export then import: current facts come back as queued, ended ones are skipped", async () => {
  const dir = fresh();
  const store = join(dir, "store");
  saveMemory(store, { id: "fact-old", kind: "fact", text: "Old fact about trains.", sourceType: "user", sourceRef: "chat" }, "2026-01-01");
  saveMemory(store, { id: "fact-new", kind: "fact", text: "New fact about trains.", sourceType: "user", sourceRef: "chat", supersedes: "fact-old" }, "2026-05-01");
  const backup = join(dir, "backup.jsonl");
  assert.equal(await run(["export", "--all", "--out", backup, "--dir", store], harness().io), 0);

  const other = join(dir, "other");
  const imported = harness();
  assert.equal(await run(["import", backup, "--dir", other], imported.io), 0);
  assert.match(imported.out[0], /Queued 1 memories/);
  assert.match(imported.err.join("\n"), /fact-old: already ended in the export/);
  assert.deepEqual(listPending(other).rows.map((r) => r.id), ["fact-new"]);
});
