import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.mjs";
import { lint } from "../src/feedback.mjs";
import { runHook } from "../src/hooks.mjs";
import { handleMessage } from "../src/mcp.mjs";
import { sessionsDir } from "../src/sessions.mjs";
import { lastShown, logShown, readShown } from "../src/shown.mjs";
import { acceptPending, saveMemory } from "../src/store.mjs";

const fresh = () => join(mkdtempSync(join(tmpdir(), "stashpad-shown-")), "s");
const put = (dir, id, text) => saveMemory(dir, { id, kind: "decision", text, sourceType: "user", sourceRef: "t" });

function harness() {
  const out = [];
  return { out, io: { stdout: (s) => out.push(s), stderr: () => {}, env: {}, cwd: tmpdir(), readStdin: async () => "" } };
}

test("the hooks log what they showed: ids and sizes, never the text", () => {
  const dir = fresh();
  put(dir, "db", "The project database is Postgres 16 running in Docker.");
  const start = runHook(dir, "session-start", { session_id: "sess-1", source: "startup" });
  const prompt = runHook(dir, "prompt", { session_id: "sess-1", prompt: "postgres database private plan" });
  runHook(dir, "prompt", { session_id: "sess-1", prompt: "nothing that matches" });
  const entries = readShown(dir);
  assert.deepEqual(entries.map((e) => e.event), ["session-start", "prompt"], "a prompt with nothing shown is not logged");
  assert.deepEqual(entries[1].ids, ["db"]);
  assert.equal(entries[0].chars, start.length);
  assert.equal(entries[1].chars, prompt.length);
  assert.equal(entries[1].session, "sess-1");
  const raw = readFileSync(join(sessionsDir(dir), "shown.jsonl"), "utf8");
  assert.ok(!raw.includes("Postgres 16") && !raw.includes("private plan"), "no memory or prompt text");
  assert.ok(lastShown(dir).last.db);
});

test("MCP reads and the read commands are logged too; stashpad shown reports and clears", async () => {
  const dir = fresh();
  put(dir, "db", "The project database is Postgres 16 running in Docker.");
  handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "stashpad_search", arguments: { query: "postgres" } } }, { dir });
  handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "stashpad_get", arguments: { id: "db" } } }, { dir });
  await run(["get", "db", "--dir", dir], harness().io);
  runHook(dir, "prompt", { session_id: "abcdef123456", prompt: "postgres database" });
  assert.deepEqual(readShown(dir).map((e) => e.event), ["mcp search", "mcp get", "cli get", "prompt"]);

  let h = harness();
  assert.equal(await run(["shown", "--dir", dir], h.io), 0);
  const text = h.out.join("\n");
  assert.match(text, /prompt\s+1 memories\s+\d+ chars\s+db\s+\(session abcdef12\)/);
  assert.match(text, /Most shown: db 4x/);
  h = harness();
  assert.equal(await run(["shown", "--session", "abcdef123456", "--json", "--dir", dir], h.io), 0);
  assert.equal(JSON.parse(h.out[0]).entries.length, 1);
  h = harness();
  assert.equal(await run(["shown", "--clear", "--dir", dir], h.io), 0);
  assert.equal(existsSync(join(sessionsDir(dir), "shown.jsonl")), false);
  assert.equal(await run(["shown", "--since", "yesterday", "--dir", dir], harness().io), 2);
});

test("lint names agent memories nothing showed for 90 days, once the log has run that long", () => {
  const dir = fresh();
  for (const id of ["unused-note", "used-note"]) {
    saveMemory(dir, { id, kind: "fact", text: `An agent note called ${id} about the release checklist.`, sourceType: "agent", sourceRef: "t" }, "2026-01-01");
    acceptPending(dir, id);
  }
  put(dir, "mine", "A person's own note about the release checklist steps.");
  const later = "2027-06-01";
  assert.equal(lint(dir, { today: later }).findings.filter((f) => f.rule === "never-shown").length, 0, "no log yet: no guess");
  logShown(dir, { event: "prompt", ids: [], now: new Date("2026-11-01T10:00:00Z") });
  logShown(dir, { event: "prompt", ids: ["used-note"], now: new Date("2027-05-20T10:00:00Z") });
  const flagged = lint(dir, { today: later }).findings.filter((f) => f.rule === "never-shown").map((f) => f.id);
  assert.deepEqual(flagged, ["unused-note"], "user memories and recently shown ones are left alone");
});

test("the log is sealed with an encrypted store", async () => {
  const { encryptStore } = await import("../src/encrypt.mjs");
  const dir = fresh();
  put(dir, "db", "The project database is Postgres 16 running in Docker.");
  runHook(dir, "prompt", { session_id: "s1", prompt: "postgres database" });
  process.env.STASHPAD_PASSPHRASE = "a long enough passphrase";
  try {
    encryptStore(dir);
    assert.ok(readFileSync(join(sessionsDir(dir), "shown.jsonl"), "utf8").startsWith("SEALED1:"));
    assert.ok(readFileSync(join(sessionsDir(dir), "last-shown.json"), "utf8").startsWith("STASHPAD-SEALED-1:"));
    assert.deepEqual(readShown(dir)[0].ids, ["db"]);
  } finally {
    delete process.env.STASHPAD_PASSPHRASE;
  }
});
