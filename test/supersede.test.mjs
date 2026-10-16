import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.mjs";
import { historyOf, saveMemory, searchMemories } from "../src/store.mjs";

function harness() {
  const out = [];
  const err = [];
  const io = {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    env: {},
    cwd: tmpdir(),
    readStdin: async () => "",
  };
  return { io, out, err };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "stashpad-supersede-"));
  saveMemory(dir, {
    id: "db-choice-v1",
    kind: "decision",
    text: "The project keeps its data in plain JSON files.",
    sourceType: "user",
    sourceRef: "test statement",
  }, "2026-09-01");
  saveMemory(dir, {
    id: "db-choice-v2",
    kind: "decision",
    text: "The project keeps its data in SQLite with Markdown as source of truth.",
    sourceType: "user",
    sourceRef: "test statement, later",
    supersedes: "db-choice-v1",
  }, "2026-10-01");
  return dir;
}

function field(text, key) {
  return new RegExp(`^${key}: (.*)$`, "m").exec(text)[1];
}

test("superseding ends the old memory and links both ways", () => {
  const dir = setup();
  const old = readFileSync(join(dir, "db-choice-v1.md"), "utf8");
  const current = readFileSync(join(dir, "db-choice-v2.md"), "utf8");
  assert.equal(field(old, "valid_to"), "2026-10-01");
  assert.equal(field(old, "superseded_by"), "db-choice-v2");
  assert.equal(field(current, "supersedes"), "db-choice-v1");
  assert.equal(field(current, "valid_to"), "null");
});

test("after a change, search finds only the new fact", () => {
  const dir = setup();
  assert.equal(searchMemories(dir, "JSON").results.length, 0);
  const hit = searchMemories(dir, "SQLite").results[0];
  assert.equal(hit.id, "db-choice-v2");
  assert.equal(searchMemories(dir, "JSON", { includeEnded: true }).results[0].id, "db-choice-v1");
});

test("history shows the chain oldest first with sources and dates", () => {
  const dir = setup();
  const { chain, brokenLink } = historyOf(dir, "db-choice-v2");
  assert.equal(brokenLink, null);
  assert.deepEqual(chain.map((c) => c.id), ["db-choice-v1", "db-choice-v2"]);
  assert.equal(chain[0].valid_to, "2026-10-01");
  assert.equal(chain[1].current, true);
  assert.equal(chain[1].requested, true);
  assert.equal(chain[1].source_ref, "test statement, later");
});

test("history from the old memory shows the same chain", () => {
  const dir = setup();
  const { chain } = historyOf(dir, "db-choice-v1");
  assert.equal(chain.find((c) => c.requested).id, "db-choice-v1");
  assert.equal(chain.length, 2);
});

test("a missing link in the chain is reported, not hidden", () => {
  const dir = setup();
  saveMemory(dir, {
    id: "db-choice-v3",
    kind: "decision",
    text: "Something newer.",
    sourceType: "user",
    sourceRef: "test",
    supersedes: "db-choice-v2",
  }, "2026-10-05");
  // Remove the middle file to break the chain.
  rmSync(join(dir, "db-choice-v2.md"));
  const { chain, brokenLink } = historyOf(dir, "db-choice-v3");
  assert.equal(brokenLink, "db-choice-v2");
  assert.deepEqual(chain.map((c) => c.id), ["db-choice-v3"]);
});

test("cannot supersede a memory that already ended", () => {
  const dir = setup();
  assert.throws(
    () =>
      saveMemory(dir, {
        id: "db-choice-v3",
        kind: "decision",
        text: "Again.",
        sourceType: "user",
        sourceRef: "test",
        supersedes: "db-choice-v1",
      }, "2026-10-05"),
    /already ended on 2026-10-01/,
  );
  assert.equal(existsSync(join(dir, "db-choice-v3.md")), false);
});

test("a failed supersede leaves the old memory unchanged", () => {
  const dir = setup();
  const before = readFileSync(join(dir, "db-choice-v2.md"), "utf8");
  assert.throws(() =>
    saveMemory(dir, {
      id: "db-choice-v2",
      kind: "decision",
      text: "Duplicate id.",
      sourceType: "user",
      sourceRef: "test",
      supersedes: "db-choice-v1",
    }, "2026-10-06"),
  );
  assert.equal(readFileSync(join(dir, "db-choice-v2.md"), "utf8"), before);
});

test("a memory cannot supersede itself", () => {
  const dir = setup();
  assert.throws(
    () =>
      saveMemory(dir, {
        id: "db-choice-v2",
        kind: "decision",
        text: "Self.",
        sourceType: "user",
        sourceRef: "test",
        supersedes: "db-choice-v2",
      }, "2026-10-07"),
    /cannot supersede itself|already exists/,
  );
});

test("the new valid_from cannot be before the old memory started", () => {
  const dir = setup();
  assert.throws(
    () =>
      saveMemory(dir, {
        id: "db-choice-v3",
        kind: "decision",
        text: "Too early.",
        sourceType: "user",
        sourceRef: "test",
        supersedes: "db-choice-v2",
        validFrom: "2026-09-15",
      }, "2026-10-08"),
    /is before "db-choice-v2" started/,
  );
});

test("CLI: save --supersedes and history work end to end", async () => {
  const dir = setup();
  const save = harness();
  assert.equal(
    await run(
      ["save", "db-choice-v3", "--dir", dir, "--kind", "decision", "--source-type", "user",
        "--source-ref", "cli test", "--text", "Back to files.", "--supersedes", "db-choice-v2"],
      save.io,
    ),
    0,
  );

  const hist = harness();
  assert.equal(await run(["history", "db-choice-v3", "--dir", dir, "--json"], hist.io), 0);
  const { chain } = JSON.parse(hist.out[0]);
  assert.deepEqual(chain.map((c) => c.id), ["db-choice-v1", "db-choice-v2", "db-choice-v3"]);
});
