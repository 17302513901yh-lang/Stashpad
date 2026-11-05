import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.mjs";
import {
  acceptPending,
  listPending,
  mergeMemories,
  queueForget,
  readAudit,
  rejectPending,
  saveMemory,
  searchMemories,
} from "../src/store.mjs";

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

function fresh() {
  return mkdtempSync(join(tmpdir(), "stashpad-review-"));
}

const agentNote = (dir, id = "agent-note", extra = {}) =>
  saveMemory(dir, {
    id,
    kind: "fact",
    text: "The example project uses Node 22.",
    sourceType: "agent",
    sourceRef: "agent inference from the repo",
    ...extra,
  }, "2026-10-10");

test("a user memory goes straight into the store", () => {
  const dir = fresh();
  const result = saveMemory(dir, {
    id: "user-fact",
    kind: "fact",
    text: "Example uses SQLite.",
    sourceType: "user",
    sourceRef: "statement",
  }, "2026-10-10");
  assert.equal(result.status, "saved");
  assert.equal(searchMemories(dir, "SQLite").results[0].id, "user-fact");
});

test("an agent memory waits in pending and is not searchable", () => {
  const dir = fresh();
  const result = agentNote(dir);
  assert.equal(result.status, "queued");
  assert.equal(existsSync(join(dir, "agent-note.md")), false);
  assert.equal(searchMemories(dir, "Node").results.length, 0);
  assert.equal(listPending(dir).rows[0].id, "agent-note");
});

test("accepting moves the waiting memory into the store and logs it", () => {
  const dir = fresh();
  agentNote(dir);
  acceptPending(dir, "agent-note");
  assert.equal(existsSync(join(dir, "pending", "agent-note.md")), false);
  assert.equal(searchMemories(dir, "Node").results[0].id, "agent-note");
  const text = readFileSync(join(dir, "agent-note.md"), "utf8");
  assert.match(text, /^trust: agent-inferred$/m);
  const actions = readAudit(dir).map((e) => e.action);
  assert.deepEqual(actions, ["queued", "saved", "accepted"]);
});

test("rejecting keeps the write for the record and never adds it to the store", () => {
  const dir = fresh();
  agentNote(dir, "bad-claim");
  rejectPending(dir, "bad-claim", "not supported by the repo");
  assert.equal(existsSync(join(dir, "pending", "bad-claim.md")), false);
  assert.equal(existsSync(join(dir, "rejected", "bad-claim.md")), true);
  assert.equal(existsSync(join(dir, "bad-claim.md")), false);
  assert.equal(searchMemories(dir, "Node").results.length, 0);
  const last = readAudit(dir).at(-1);
  assert.equal(last.action, "rejected");
  assert.equal(last.reason, "not supported by the repo");
});

test("an accepted replacement ends the memory it replaces", () => {
  const dir = fresh();
  saveMemory(dir, {
    id: "db-old",
    kind: "decision",
    text: "Data lives in JSON files.",
    sourceType: "user",
    sourceRef: "statement",
  }, "2026-09-01");
  agentNote(dir, "db-new", {
    kind: "decision",
    text: "Data lives in SQLite.",
    supersedes: "db-old",
    validFrom: "2026-10-01",
  });
  acceptPending(dir, "db-new");
  assert.match(readFileSync(join(dir, "db-old.md"), "utf8"), /^valid_to: 2026-10-01$/m);
  assert.equal(searchMemories(dir, "SQLite").results[0].id, "db-new");
  assert.equal(searchMemories(dir, "JSON").results.length, 0);
});

test("a waiting memory that fails the store check stays in pending", () => {
  const dir = fresh();
  agentNote(dir, "orphan", { supersedes: "does-not-exist" });
  assert.throws(() => acceptPending(dir, "orphan"), /no memory named "does-not-exist"/);
  assert.equal(existsSync(join(dir, "pending", "orphan.md")), true);
  assert.equal(existsSync(join(dir, "orphan.md")), false);
});

test("the same id cannot wait twice, and an existing store id cannot be queued", () => {
  const dir = fresh();
  agentNote(dir);
  assert.throws(() => agentNote(dir), /already waiting for review/);

  saveMemory(dir, {
    id: "taken",
    kind: "fact",
    text: "Already in the store.",
    sourceType: "user",
    sourceRef: "statement",
  }, "2026-10-10");
  assert.throws(() => agentNote(dir, "taken"), /already exists/);
});

test("accepting or rejecting an unknown id is a clear error", () => {
  const dir = fresh();
  assert.throws(() => acceptPending(dir, "nothing"), /nothing waiting for review/);
  assert.throws(() => rejectPending(dir, "../escape"), /invalid id/);
});

test("CLI: agent save reports queued, review lists it, accept stores it", async () => {
  const dir = fresh();
  const save = harness();
  assert.equal(
    await run(
      ["save", "cli-agent", "--dir", dir, "--kind", "fact", "--source-type", "agent",
        "--source-ref", "cli test", "--text", "Proposed by an agent."],
      save.io,
    ),
    0,
  );
  assert.match(save.out[0], /Queued cli-agent for review/);

  const review = harness();
  assert.equal(await run(["review", "--dir", dir], review.io), 0);
  assert.match(review.out[0], /cli-agent/);

  const accept = harness();
  assert.equal(await run(["accept", "cli-agent", "--dir", dir], accept.io), 0);
  assert.match(accept.out[0], /Accepted cli-agent/);

  const audit = harness();
  assert.equal(await run(["audit", "--dir", dir], audit.io), 0);
  assert.match(audit.out.join("\n"), /accepted\s+cli-agent/);
});

test("CLI: reject needs an id and records the reason", async () => {
  const dir = fresh();
  const missing = harness();
  assert.equal(await run(["reject", "--dir", dir], missing.io), 2);

  agentNote(dir, "cli-bad");
  const reject = harness();
  assert.equal(
    await run(["reject", "cli-bad", "--reason", "wrong project", "--dir", dir], reject.io),
    0,
  );
  assert.equal(readAudit(dir).at(-1).reason, "wrong project");
});

test("CLI: audit accepts a larger limit and keeps JSON output", async () => {
  const dir = fresh();
  for (let i = 0; i < 55; i += 1) {
    saveMemory(dir, {
      id: `entry-${i}`,
      kind: "fact",
      text: `Audit entry ${i}.`,
      sourceType: "user",
      sourceRef: "test",
    });
  }

  const expanded = harness();
  assert.equal(await run(["audit", "--limit", "200", "--json", "--dir", dir], expanded.io), 0);
  const expandedRows = JSON.parse(expanded.out[0]);
  assert.equal(expandedRows.length, 55);
  assert.equal(expandedRows[0].id, "entry-0");

  const defaultLimit = harness();
  assert.equal(await run(["audit", "--json", "--dir", dir], defaultLimit.io), 0);
  const defaultRows = JSON.parse(defaultLimit.out[0]);
  assert.equal(defaultRows.length, 50);
  assert.equal(defaultRows[0].id, "entry-5");
});

test("CLI: audit filters related memory events before applying the limit", async () => {
  const dir = fresh();
  const put = (id) => saveMemory(dir, {
    id,
    kind: "fact",
    text: `Memory ${id}.`,
    sourceType: "user",
    sourceRef: "test",
  });

  put("db-choice");
  queueForget(dir, "db-choice", "outdated");
  put("kept-choice");
  mergeMemories(dir, "kept-choice", ["db-choice"]);
  for (let i = 0; i < 4; i += 1) put(`unrelated-${i}`);

  const byEndedId = harness();
  assert.equal(await run(["audit", "db-choice", "--limit", "2", "--json", "--dir", dir], byEndedId.io), 0);
  const endedRows = JSON.parse(byEndedId.out[0]);
  assert.deepEqual(endedRows.map((entry) => entry.action), ["queued", "merged"]);
  assert.equal(endedRows[0].id, "forget-db-choice");
  assert.equal(endedRows[1].target, "kept-choice");

  const byKeepId = harness();
  assert.equal(await run(["audit", "kept-choice", "--json", "--dir", dir], byKeepId.io), 0);
  const keptRows = JSON.parse(byKeepId.out[0]);
  assert.deepEqual(keptRows.map((entry) => entry.id), ["kept-choice", "db-choice"]);
  assert.equal(keptRows[1].target, "kept-choice");

  const noEntries = harness();
  assert.equal(await run(["audit", "not-in-the-log", "--json", "--dir", dir], noEntries.io), 0);
  assert.deepEqual(JSON.parse(noEntries.out[0]), []);
});

test("CLI: audit rejects invalid limits and extra ids", async () => {
  for (const limit of ["0", "10001", "1.5", "1.0", "1e3", "nope"]) {
    const result = harness();
    assert.equal(await run(["audit", "--limit", limit], result.io), 2, limit);
    assert.match(result.err.join("\n"), /1 to 10000/);
  }

  const extra = harness();
  assert.equal(await run(["audit", "first", "second"], extra.io), 2);
  assert.match(extra.err.join("\n"), /at most one memory id/);
});
