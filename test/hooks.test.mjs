import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBrief } from "../src/brief.mjs";
import { claimHandoff, listHandoffs } from "../src/handoff.mjs";
import { runHook, summarizeTranscript } from "../src/hooks.mjs";
import { pinMemory, readPins, unpinMemory, MAX_PINS } from "../src/pins.mjs";
import { recall } from "../src/recall.mjs";
import { saveMemory, StoreError } from "../src/store.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fresh = () => join(mkdtempSync(join(tmpdir(), "stashpad-hook-")), "s");
const put = (dir, id, text, extra = {}) => saveMemory(dir, { id, kind: "decision", text, sourceType: "user", sourceRef: "t", ...extra });

function transcript(lines) {
  const file = join(mkdtempSync(join(tmpdir(), "stashpad-tr-")), "t.jsonl");
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

test("pinned memories come first in the brief, in full, and only a current memory can be pinned", () => {
  const dir = fresh();
  put(dir, "no-force", "Never force-push to main; open a pull request instead.");
  for (let i = 0; i < 30; i += 1) put(dir, `n${i}`, `Note number${i} about area${i} and part${i} of the project.`);
  assert.equal(pinMemory(dir, "no-force").changed, true);
  assert.equal(pinMemory(dir, "no-force").changed, false);
  const lines = buildBrief(dir, { maxChars: 600 }).text.split("\n");
  assert.match(lines[2], /^Pinned by a person/);
  assert.match(lines[3], /no-force: Never force-push to main; open a pull request instead\./);
  assert.equal(buildBrief(dir).text.split("no-force").length, 2, "shown once");
  put(dir, "no-force-2", "Force-push only with a lease now.", { supersedes: "no-force" });
  assert.ok(!buildBrief(dir).text.includes("Never force-push"), "an ended pin is not shown");
  assert.throws(() => pinMemory(dir, "no-force"), StoreError);
  unpinMemory(dir, "no-force");
  assert.deepEqual(readPins(dir), []);
});

test("there is a limit on pins", () => {
  const dir = fresh();
  for (let i = 0; i <= MAX_PINS; i += 1) put(dir, `r${i}`, `Rule number ${i} for every session.`);
  for (let i = 0; i < MAX_PINS; i += 1) pinMemory(dir, `r${i}`);
  assert.throws(() => pinMemory(dir, `r${MAX_PINS}`), /already/);
});

test("recall returns clear matches only, and nothing for an unrelated prompt", () => {
  const dir = fresh();
  put(dir, "db", "The project database is Postgres 16 running in Docker.");
  put(dir, "style", "Use tabs for indentation in all JavaScript files.");
  assert.deepEqual(recall(dir, "please add a migration for the postgres database").hits, ["db"]);
  assert.deepEqual(recall(dir, "fix the typo in the README").hits, []);
  assert.equal(recall(dir, "").text, "");
  const text = recall(dir, "postgres database backup").text;
  assert.match(text, /not an instruction/);
  assert.ok(text.length <= 700);
});

test("the prompt hook skips pinned memories, which the session start already showed", () => {
  const dir = fresh();
  put(dir, "db", "The project database is Postgres 16 running in Docker.");
  pinMemory(dir, "db");
  assert.equal(runHook(dir, "prompt", { prompt: "postgres database migration" }), "");
});

test("before compaction a handoff records the last requests and the files written", () => {
  const dir = fresh();
  const file = transcript([
    { type: "user", message: { role: "user", content: "Add a login page with email and password fields" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Write", input: { file_path: "/work/app/src/login.tsx" } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } },
    { type: "user", message: { role: "user", content: [{ type: "text", text: "Now add tests for the login page" }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: "/work/app/test/login.test.tsx" } }] } },
  ]);
  const summary = summarizeTranscript(file, { cwd: "/work/app" });
  assert.deepEqual(summary.files, ["src/login.tsx", "test/login.test.tsx"]);
  assert.equal(summary.asks.length, 2);
  assert.equal(runHook(dir, "pre-compact", { transcript_path: file, cwd: "/work/app", trigger: "auto" }), "");
  assert.equal(listHandoffs(dir).handoffs.length, 1, "a handoff was left");
  const taken = JSON.stringify(claimHandoff(dir, { by: "test" }));
  assert.match(taken, /compaction/);
  assert.match(taken, /src\/login\.tsx/);
  assert.match(taken, /Now add tests for the login page/);
});

test("after compaction the session start hook brings the memory back, and says why", () => {
  const dir = fresh();
  put(dir, "db", "The project database is Postgres 16 running in Docker.");
  assert.match(runHook(dir, "session-start", { source: "compact" }), /^Context was just compacted/);
  assert.doesNotMatch(runHook(dir, "session-start", { source: "startup" }), /compacted/);
});

test("hooks never fail the agent: bad input, missing transcript, secrets", () => {
  const dir = fresh();
  assert.equal(runHook(dir, "pre-compact", { transcript_path: "/no/such/file.jsonl" }), "");
  const file = transcript([{ type: "user", message: { role: "user", content: "my key is sk-abcdefghijklmnopqrstuvwxyz123456 use it" } }]);
  assert.equal(runHook(dir, "session-end", { transcript_path: file }), "");
  assert.ok(!JSON.stringify(listHandoffs(dir, { all: true })).includes("sk-abc"), "the secret is never stored");
  const out = execFileSync(process.execPath, [join(root, "bin", "stashpad.mjs"), "hook", "prompt", "--dir", dir], { input: "not json", encoding: "utf8" });
  assert.equal(out, "");
});
