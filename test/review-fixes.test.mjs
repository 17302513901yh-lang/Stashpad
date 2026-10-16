import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { handleMessage, serveMcp } from "../src/mcp.mjs";
import { findSecrets } from "../src/security.mjs";
import {
  acceptPending,
  filePath,
  listMemories,
  queueForget,
  readMemory,
  rejectPending,
  saveMemory,
  searchMemories,
  todayIso,
} from "../src/store.mjs";
import { parseMemory } from "../src/memory-format.mjs";

const fresh = () => mkdtempSync(join(tmpdir(), "stashpad-review-"));

test("a JSON value that is not an object gets an error reply, and the server keeps answering", async () => {
  const dir = fresh();
  const input = new PassThrough();
  const output = new PassThrough();
  const replies = [];
  output.on("data", (chunk) => replies.push(...chunk.toString("utf8").split("\n").filter(Boolean)));
  const done = serveMcp({ dir, input, output });
  input.end('null\n[1,2]\n{"jsonrpc":"2.0","id":7,"method":"ping"}\n');
  await done;
  const parsed = replies.map((line) => JSON.parse(line));
  assert.equal(parsed[0].error.code, -32600);
  assert.equal(parsed[1].error.code, -32600);
  assert.deepEqual(parsed[2], { jsonrpc: "2.0", id: 7, result: {} });
});

test("a limit that is not a whole number gets the default instead of no results", () => {
  const dir = fresh();
  saveMemory(dir, { id: "pref-dark", kind: "preference", text: "Dark theme everywhere.", sourceType: "user", sourceRef: "chat" }, "2026-10-01");
  const reply = handleMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "stashpad_search", arguments: { query: "dark", limit: "ten" } } },
    { dir },
  );
  const body = JSON.parse(reply.result.content[0].text);
  assert.equal(body.results[0].id, "pref-dark");
});

test("secret formats the scanner used to miss are now refused", () => {
  const samples = [
    "DB_PASSWORD=hunter2hunter2",
    "client_secret: abcdef123456",
    "MY_API_KEY=abcd1234efgh5678",
    "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG",
    "key AIzaSyA1234567890abcdefghijklmnopqrstu",
    "sk_live_abcdefghijklmnop1234",
    "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
    "-----BEGIN ENCRYPTED PRIVATE KEY-----",
    "-----BEGIN PGP PRIVATE KEY BLOCK-----",
  ];
  for (const sample of samples) {
    assert.ok(findSecrets(sample).length > 0, `should detect: ${sample}`);
  }
});

test("ordinary sentences are not flagged as secrets", () => {
  const plain = [
    "A secret scanner blocks API keys before they are saved.",
    "Retrieval returns at most a fixed token budget per call.",
    "The project stores its index in SQLite with full text search.",
  ];
  for (const sentence of plain) {
    assert.deepEqual(findSecrets(sentence), [], sentence);
  }
});

test("an ending request whose reason holds a secret is refused and nothing is queued", () => {
  const dir = fresh();
  saveMemory(dir, { id: "deploy-note", kind: "fact", text: "Deploys run on Fridays.", sourceType: "user", sourceRef: "chat" }, "2026-10-01");
  assert.throws(
    () => queueForget(dir, "deploy-note", "old note had DB_PASSWORD=hunter2hunter2", "agent request", "agent"),
    /looks like a secret/,
  );
  assert.equal(existsSync(join(dir, "pending")), false);
});

test("a memory that has not started yet cannot be ended", () => {
  const dir = fresh();
  saveMemory(dir, { id: "future-plan", kind: "decision", text: "Launch in spring.", sourceType: "user", sourceRef: "chat", validFrom: "2099-03-01" }, "2026-10-01");
  assert.throws(() => queueForget(dir, "future-plan", "not needed", "agent request", "agent"), /has not started yet/);
});

test("the forget- prefix is reserved for ending requests", () => {
  const dir = fresh();
  assert.throws(
    () => saveMemory(dir, { id: "forget-plan", kind: "fact", text: "A fact.", sourceType: "user", sourceRef: "chat" }, "2026-10-01"),
    /reserved for ending requests/,
  );
});

test("rejecting a second write with the same id keeps the first rejection", () => {
  const dir = fresh();
  saveMemory(dir, { id: "dup-one", kind: "fact", text: "First proposal.", sourceType: "agent", sourceRef: "a" }, "2026-10-01");
  rejectPending(dir, "dup-one", "first reason");
  saveMemory(dir, { id: "dup-one", kind: "fact", text: "Second proposal.", sourceType: "agent", sourceRef: "b" }, "2026-10-02");
  rejectPending(dir, "dup-one", "second reason");
  const rejected = readdirSync(join(dir, "rejected")).sort();
  assert.deepEqual(rejected, ["dup-one-2.md", "dup-one.md"]);
});

test("a memory that starts later does not hide the one it replaces until it starts", () => {
  const dir = fresh();
  saveMemory(dir, { id: "office-addr", kind: "fact", text: "The office is on Main Street.", sourceType: "user", sourceRef: "chat", validFrom: "2026-01-01" }, "2026-01-01");
  saveMemory(dir, { id: "office-addr-v2", kind: "fact", text: "The office moves to Canal Street.", sourceType: "user", sourceRef: "chat", validFrom: "2099-01-01", supersedes: "office-addr" }, "2026-10-01");
  const today = todayIso();
  const now = searchMemories(dir, "office", { today });
  assert.deepEqual(now.results.map((r) => r.id), ["office-addr"]);
  assert.deepEqual(searchMemories(dir, "Main Street", { today }).results.map((r) => r.id), ["office-addr"]);
  assert.deepEqual(listMemories(dir, { today }).rows.map((r) => r.id), ["office-addr"]);
});

test("a symbolic link in the store is listed as skipped, not read", () => {
  const dir = fresh();
  saveMemory(dir, { id: "real-one", kind: "fact", text: "A real fact about maps.", sourceType: "user", sourceRef: "chat" }, "2026-10-01");
  try {
    symlinkSync(filePath(dir, "real-one"), filePath(dir, "linked-one"));
  } catch {
    return; // symbolic links need extra rights on some systems
  }
  const { rows, skipped } = listMemories(dir);
  assert.deepEqual(rows.map((r) => r.id), ["real-one"]);
  assert.ok(skipped.some((s) => s.file === "linked-one.md" && /symbolic link/.test(s.reason)));
});

test("accepting a proposal sets last_confirmed_at to the day it was accepted", () => {
  const dir = fresh();
  saveMemory(dir, { id: "agent-fact", kind: "fact", text: "The team meets on Monday.", sourceType: "agent", sourceRef: "meeting note" }, "2026-10-01");
  acceptPending(dir, "agent-fact");
  const { meta } = parseMemory(readMemory(dir, "agent-fact").text);
  assert.equal(meta.created_at, "2026-10-01");
  assert.equal(meta.last_confirmed_at, todayIso());
});

test("stashpad_recent lists the newest written memory first", () => {
  const dir = fresh();
  saveMemory(dir, { id: "older-note", kind: "fact", text: "Older note.", sourceType: "user", sourceRef: "chat" }, "2026-10-01");
  saveMemory(dir, { id: "newer-note", kind: "fact", text: "Newer note.", sourceType: "user", sourceRef: "chat" }, "2026-10-05");
  const reply = handleMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "stashpad_recent", arguments: {} } },
    { dir },
  );
  const body = JSON.parse(reply.result.content[0].text);
  assert.equal(body.memories[0].id, "newer-note");
});
