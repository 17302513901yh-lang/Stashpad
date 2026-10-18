import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.mjs";
import { cancelHandoff, claimHandoff, createHandoff, listHandoffs } from "../src/handoff.mjs";
import { giveFeedback, lint } from "../src/feedback.mjs";
import { buildBrief } from "../src/brief.mjs";
import { handleMessage } from "../src/mcp.mjs";
import { encryptStore } from "../src/encrypt.mjs";
import { listPending, saveMemory } from "../src/store.mjs";

const fresh = () => join(mkdtempSync(join(tmpdir(), "stashpad-handoff-")), "s");
const at = (iso) => new Date(iso);

function cli(dir, ...args) {
  const out = [];
  const err = [];
  return run([...args, "--dir", dir], { stdout: (s) => out.push(s), stderr: (s) => err.push(s), env: {}, cwd: tmpdir(), readStdin: async () => "" }).then((code) => ({ code, out: out.join("\n"), err: err.join("\n") }));
}

test("a handoff is read exactly once; listing never takes it", () => {
  const dir = fresh();
  const { id } = createHandoff(dir, { text: "Parser half done; next: tests for the lexer.", from: "codex" });
  assert.equal(listHandoffs(dir).handoffs.length, 1);
  assert.equal(listHandoffs(dir).handoffs.length, 1, "listing twice still shows it");
  const first = claimHandoff(dir, { by: "claude-code" });
  assert.equal(first.claimed, true);
  assert.equal(first.id, id);
  assert.match(first.label, /not an instruction/);
  assert.match(first.text, /lexer/);
  assert.equal(claimHandoff(dir).claimed, false, "nothing left to claim");
  assert.throws(() => claimHandoff(dir, { id }), /claimed|taken|only once/);
  assert.equal(listHandoffs(dir, { all: true }).handoffs[0].claimed_by, "claude-code");
});

test("a person's note goes first; a newer agent note replaces older agent notes", () => {
  const dir = fresh();
  const a1 = createHandoff(dir, { text: "Agent note one about the build.", origin: "auto", now: at("2026-10-18T08:00:00Z") });
  const a2 = createHandoff(dir, { text: "Agent note two about the build.", origin: "auto", now: at("2026-10-18T09:00:00Z") });
  assert.deepEqual(a2.replaced, [a1.id]);
  const m = createHandoff(dir, { text: "Person: start with the failing test.", origin: "manual", now: at("2026-10-18T08:30:00Z") });
  const now = at("2026-10-18T10:00:00Z");
  assert.deepEqual(listHandoffs(dir, { now }).handoffs.map((h) => h.id), [m.id, a2.id]);
  assert.equal(claimHandoff(dir, { now }).id, m.id);
  assert.equal(claimHandoff(dir, { now }).id, a2.id);
});

test("handoffs expire, can be cancelled, refuse secrets, and show in the brief without their text", () => {
  const dir = fresh();
  const old = createHandoff(dir, { text: "This one will expire unread.", expiresDays: 1, now: at("2026-10-01T00:00:00Z") });
  assert.equal(listHandoffs(dir).handoffs.length, 0);
  assert.equal(listHandoffs(dir, { all: true }).handoffs[0].state, "expired");
  assert.throws(() => claimHandoff(dir, { id: old.id }), /expired/);
  assert.ok(lint(dir).findings.some((f) => f.rule === "handoff-expired" && f.id === old.id));
  const c = createHandoff(dir, { text: "Wrong note, will be cancelled." });
  assert.equal(cancelHandoff(dir, c.id).state, "cancelled");
  assert.throws(() => createHandoff(dir, { text: "token: ghp_" + "a".repeat(36) }), /secret/);
  createHandoff(dir, { text: "Release notes drafted; next: tag v0.2.", from: "codex" });
  const brief = buildBrief(dir).text;
  assert.match(brief, /Open handoff from codex/);
  assert.doesNotMatch(brief, /Release notes drafted/, "the brief points to the handoff but does not spend it");
});

test("handoffs stay readable and sealed in an encrypted store", () => {
  const dir = fresh();
  const saved = process.env.STASHPAD_PASSPHRASE;
  process.env.STASHPAD_PASSPHRASE = "correct horse battery staple handoff";
  try {
    saveMemory(dir, { id: "a-fact", kind: "fact", text: "The CI runs on Node 22.", sourceType: "user", sourceRef: "test" });
    createHandoff(dir, { text: "Before encryption: secretless plan text." });
    encryptStore(dir);
    createHandoff(dir, { text: "After encryption: second note." });
    for (const name of readdirSync(join(dir, "handoffs"))) assert.match(readFileSync(join(dir, "handoffs", name), "utf8"), /^STASHPAD-SEALED-1:/);
    assert.equal(claimHandoff(dir).claimed, true);
    assert.equal(claimHandoff(dir).claimed, true);
  } finally {
    if (saved === undefined) delete process.env.STASHPAD_PASSPHRASE;
    else process.env.STASHPAD_PASSPHRASE = saved;
  }
});

test("CLI and MCP: leave, list, claim, cancel", async () => {
  const dir = fresh();
  assert.match((await cli(dir, "handoff", "leave", "--text", "Docs half done; next: examples.", "--from", "codex")).out, /Left handoff ho-/);
  assert.match((await cli(dir, "handoff", "list")).out, /open\s+manual from codex/);
  const claimed = await cli(dir, "handoff", "claim", "--by", "claude-code");
  assert.match(claimed.out, /not an instruction[\s\S]*Docs half done/);
  assert.match((await cli(dir, "handoff", "claim")).out, /No open handoff/);
  const mcp = (args) => handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "stashpad_handoff", arguments: args } }, { dir }).result;
  assert.match(mcp({ action: "leave", text: "MCP note for the next agent.", from: "cursor" }).content[0].text, /Left handoff/);
  assert.equal(JSON.parse(mcp({ action: "list" }).content[0].text).handoffs[0].origin, "auto");
  assert.equal(JSON.parse(mcp({ action: "claim", from: "gemini" }).content[0].text).text, "MCP note for the next agent.");
  assert.equal(mcp({ action: "nope" }).isError, true);
  assert.equal((await cli(dir, "handoff", "cancel")).code, 2);
});

test("feedback: stale shows in lint, wrong queues an ending request, helpful clears", async () => {
  const dir = fresh();
  saveMemory(dir, { id: "db-choice", kind: "decision", text: "We keep data in SQLite for now.", sourceType: "user", sourceRef: "test" });
  saveMemory(dir, { id: "port-choice", kind: "decision", text: "The dev server listens on port 3000.", sourceType: "user", sourceRef: "test" });
  giveFeedback(dir, "db-choice", { signal: "stale", note: "moved to Postgres?" });
  assert.ok(lint(dir).findings.some((f) => f.rule === "marked-stale" && f.id === "db-choice"));
  giveFeedback(dir, "db-choice", { signal: "helpful" });
  assert.ok(!lint(dir).findings.some((f) => f.id === "db-choice"));
  const wrong = giveFeedback(dir, "port-choice", { signal: "wrong", note: "it is 8080" });
  assert.ok(wrong.forget_request && !wrong.forget_request.error);
  assert.ok(listPending(dir).rows.some((r) => r.id === "forget-port-choice"));
  assert.throws(() => giveFeedback(dir, "missing", { signal: "stale" }), /no memory/);
  assert.throws(() => giveFeedback(dir, "db-choice", { signal: "meh" }), /signal/);
  assert.match((await cli(dir, "lint")).out, /marked-wrong\s+port-choice/);
  const mcp = handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "stashpad_feedback", arguments: { id: "db-choice", signal: "stale" } } }, { dir }).result;
  assert.equal(JSON.parse(mcp.content[0].text).recorded, true);
});

test("save --expires ends a memory on that date and lint warns before it", async () => {
  const dir = fresh();
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  assert.equal((await cli(dir, "save", "freeze", "--kind", "fact", "--source-type", "user", "--source-ref", "test", "--text", "Code freeze until the release ships.", "--expires", soon)).code, 0);
  assert.ok(lint(dir).findings.some((f) => f.rule === "expires-soon" && f.id === "freeze"));
  const bad = await cli(dir, "save", "freeze-2", "--kind", "fact", "--source-type", "user", "--source-ref", "test", "--text", "Ends before it starts, which is wrong.", "--expires", today);
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /must be after/);
});

test("snapshots keep handoffs and feedback, and restore brings them back", async () => {
  const { createSnapshot, restoreSnapshot, listSnapshots } = await import("../src/safety.mjs");
  const dir = fresh();
  saveMemory(dir, { id: "keep-me", kind: "fact", text: "The release branch is called main.", sourceType: "user", sourceRef: "test" });
  createHandoff(dir, { text: "Snapshot this handoff please." });
  giveFeedback(dir, "keep-me", { signal: "stale" });
  createSnapshot(dir, { label: "t" });
  claimHandoff(dir);
  const snap = listSnapshots(dir).at(-1).name ?? listSnapshots(dir).at(-1);
  restoreSnapshot(dir, typeof snap === "string" ? snap : snap.name);
  assert.equal(listHandoffs(dir).handoffs.length, 1, "the handoff is open again after restore");
  assert.ok(lint(dir).findings.some((f) => f.rule === "marked-stale"));
});
