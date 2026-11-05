import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.mjs";
import { runHook } from "../src/hooks.mjs";
import { readFeedback } from "../src/feedback.mjs";
import { lastGiven, pruneSessions, readSession, sessionKey, sessionsDir, updateSession } from "../src/sessions.mjs";
import { saveMemory } from "../src/store.mjs";

const fresh = () => join(mkdtempSync(join(tmpdir(), "stashpad-sess-")), "s");
const put = (dir, id, text) => saveMemory(dir, { id, kind: "decision", text, sourceType: "user", sourceRef: "t" });

function harness() {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s), env: {}, cwd: tmpdir(), readStdin: async () => "" } };
}

test("the prompt hook gives a memory once per session, and again after compaction", () => {
  const dir = fresh();
  put(dir, "db", "The project database is Postgres 16 running in Docker.");
  const ask = { session_id: "abc-123", prompt: "add a postgres database migration" };
  assert.match(runHook(dir, "prompt", ask), /db: The project database/);
  assert.equal(runHook(dir, "prompt", ask), "", "not pasted again in the same session");
  assert.match(runHook(dir, "prompt", { ...ask, session_id: "other" }), /db:/, "another session gets it");
  runHook(dir, "session-start", { session_id: "abc-123", source: "compact" });
  assert.match(runHook(dir, "prompt", ask), /db:/, "after compaction the context no longer holds it");
  runHook(dir, "session-start", { session_id: "abc-123", source: "resume" });
  assert.equal(runHook(dir, "prompt", ask), "", "a resumed session still has it");
  assert.match(runHook(dir, "prompt", { prompt: ask.prompt }), /db:/, "without a session id nothing is remembered");
});

test("session files hold ids only, stay out of git and are pruned after a week", () => {
  const dir = fresh();
  put(dir, "db", "The project database is Postgres 16 running in Docker.");
  runHook(dir, "prompt", { session_id: "s1", prompt: "postgres database secret plan details" });
  const folder = sessionsDir(dir);
  assert.equal(readFileSync(join(folder, ".gitignore"), "utf8").trim().split("\n").at(-1), "*");
  const raw = readFileSync(join(folder, "session-s1.json"), "utf8");
  assert.ok(!raw.includes("secret plan"), "no prompt text is kept");
  assert.deepEqual(readSession(dir, "s1").given, ["db"]);
  const old = new Date(Date.now() - 8 * 86400000);
  utimesSync(join(folder, "session-s1.json"), old, old);
  assert.equal(pruneSessions(dir), 1);
  assert.equal(existsSync(join(folder, "session-s1.json")), false);
});

test("odd session ids are hashed, and no store means no files", () => {
  assert.equal(sessionKey("abc_DEF-1"), "abc_DEF-1");
  assert.match(sessionKey("../../etc/passwd"), /^[a-f0-9]{32}$/);
  assert.equal(sessionKey(""), null);
  const missing = join(mkdtempSync(join(tmpdir(), "stashpad-sess-")), "nothing");
  assert.equal(updateSession(missing, "s1", () => {}), null);
  assert.equal(runHook(missing, "prompt", { session_id: "s1", prompt: "postgres database" }), "");
  assert.equal(existsSync(missing), false);
  const dir = fresh();
  put(dir, "a", "Something to make the store exist here.");
  updateSession(dir, "../escape", () => {});
  assert.deepEqual(readdirSync(sessionsDir(dir)).filter((n) => n.endsWith(".json")).length, 1);
});

test("feedback --last uses the memory the prompt hook gave last, and asks when it gave several", async () => {
  const dir = fresh();
  put(dir, "db", "The project database is Postgres 16 running in Docker.");
  put(dir, "db-backup", "The Postgres database is backed up nightly to the NAS.");
  let h = harness();
  assert.equal(await run(["feedback", "--last", "--signal", "stale", "--dir", dir], h.io), 1);
  assert.match(h.out.join("\n"), /has not given any memory/);

  runHook(dir, "prompt", { session_id: "s1", prompt: "postgres database backup docker" });
  assert.equal(lastGiven(dir).ids.length, 2);
  h = harness();
  assert.equal(await run(["feedback", "--last", "--signal", "wrong", "--dir", dir], h.io), 1, "several: no guess");
  assert.match(h.out.join("\n"), /db, db-backup|db-backup, db/);
  assert.equal(readFeedback(dir).length, 0);

  put(dir, "port", "The dev server listens on port 8787 locally.");
  runHook(dir, "prompt", { session_id: "s2", prompt: "which port does the dev server use" });
  assert.deepEqual(lastGiven(dir).ids, ["port"]);
  h = harness();
  assert.equal(await run(["feedback", "--last", "--dir", dir], h.io), 0);
  assert.match(h.out.join("\n"), /port/);
  h = harness();
  assert.equal(await run(["feedback", "--last", "--signal", "helpful", "--dir", dir], h.io), 0);
  assert.equal(readFeedback(dir).at(-1).id, "port");
  h = harness();
  assert.equal(await run(["feedback", "port", "--last", "--signal", "helpful", "--dir", dir], h.io), 2);
});

test("session files are sealed with an encrypted store, and a missing passphrase does not break recall", async () => {
  const { encryptStore } = await import("../src/encrypt.mjs");
  const dir = fresh();
  put(dir, "db", "The project database is Postgres 16 running in Docker.");
  runHook(dir, "prompt", { session_id: "s1", prompt: "postgres database migration" });
  process.env.STASHPAD_PASSPHRASE = "a long enough passphrase";
  try {
    encryptStore(dir);
    assert.ok(readFileSync(join(sessionsDir(dir), "session-s1.json"), "utf8").startsWith("STASHPAD-SEALED-1:"));
    assert.deepEqual(readSession(dir, "s1").given, ["db"]);
    assert.equal(runHook(dir, "prompt", { session_id: "s1", prompt: "postgres database migration" }), "");
  } finally {
    delete process.env.STASHPAD_PASSPHRASE;
  }
});
