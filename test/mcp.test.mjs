import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { TOOLS, handleMessage, serveMcp } from "../src/mcp.mjs";
import { acceptPending, listPending, readAudit, saveMemory } from "../src/store.mjs";

const fresh = () => mkdtempSync(join(tmpdir(), "stashpad-mcp-"));

function seeded() {
  const dir = fresh();
  saveMemory(dir, {
    id: "db-choice",
    kind: "decision",
    text: "The example project stores its data in SQLite.",
    sourceType: "user",
    sourceRef: "statement",
  }, "2026-10-01");
  return dir;
}

const call = (dir, name, args = {}) =>
  handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { dir })
    .result;

test("initialize names the server and echoes the protocol version", () => {
  const reply = handleMessage(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { dir: fresh() },
  );
  assert.equal(reply.result.serverInfo.name, "stashpad");
  assert.equal(reply.result.protocolVersion, "2025-06-18");
  assert.deepEqual(reply.result.capabilities, { tools: {} });
});

test("notifications get no reply and unknown requests get an error", () => {
  assert.equal(handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, { dir: fresh() }), null);
  const reply = handleMessage({ jsonrpc: "2.0", id: 7, method: "nope" }, { dir: fresh() });
  assert.equal(reply.error.code, -32601);
  assert.equal(reply.id, 7);
});

test("exactly eight tools, with the names the plan defines", () => {
  const reply = handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { dir: fresh() });
  assert.deepEqual(
    reply.result.tools.map((t) => t.name),
    ["stashpad_search", "stashpad_get", "stashpad_recent", "stashpad_save", "stashpad_about", "stashpad_forget", "stashpad_handoff", "stashpad_feedback"],
  );
  assert.equal(TOOLS.length, 8);
});

test("search returns data-labelled results", () => {
  const dir = seeded();
  const result = call(dir, "stashpad_search", { query: "SQLite" });
  const body = JSON.parse(result.content[0].text);
  assert.match(body.label, /^stored-data:/);
  assert.equal(body.results[0].id, "db-choice");
});

test("get returns the memory with its source", () => {
  const dir = seeded();
  const body = JSON.parse(call(dir, "stashpad_get", { id: "db-choice" }).content[0].text);
  assert.equal(body.trust, "user-stated");
  assert.match(body.body, /SQLite/);
});

test("recent lists current memories", () => {
  const dir = seeded();
  const body = JSON.parse(call(dir, "stashpad_recent", { limit: 5 }).content[0].text);
  assert.equal(body.memories[0].id, "db-choice");
});

test("save from an agent is only a proposal, even if it claims to be the user", () => {
  const dir = seeded();
  const result = call(dir, "stashpad_save", {
    id: "agent-claim",
    kind: "fact",
    text: "The example uses Node 22.",
    source_ref: "agent inference",
    source_type: "user",
  });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /not stored until a person accepts it/);
  assert.equal(existsSync(join(dir, "agent-claim.md")), false);
  assert.equal(listPending(dir).rows[0].source_type, "agent");
});

test("forget asks for an end date, and the memory is kept after acceptance", () => {
  const dir = seeded();
  const asked = call(dir, "stashpad_forget", { id: "db-choice", reason: "outdated" });
  assert.match(asked.content[0].text, /A person must accept/);
  assert.equal(listPending(dir).rows[0].kind, "forget");

  acceptPending(dir, "forget-db-choice");
  const text = readFileSync(join(dir, "db-choice.md"), "utf8");
  assert.match(text, /^valid_to: \d{4}-\d{2}-\d{2}$/m);
  assert.equal(existsSync(join(dir, "db-choice.md")), true);
  assert.equal(readAudit(dir).at(-1).action, "forgotten");
});

test("bad arguments give a plain error the agent can act on", () => {
  const dir = seeded();
  const result = call(dir, "stashpad_save", { id: "x" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /needs: kind, text, source_ref/);
});

test("an unknown tool is an error that lists the real tools", () => {
  const result = call(seeded(), "stashpad_delete_everything", {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Use one of: stashpad_search/);
});

test("a store problem comes back as a tool error, not a crash", () => {
  const result = call(seeded(), "stashpad_get", { id: "../etc" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /invalid id/);
});

test("stdio: messages in, replies out, bad JSON gets a parse error", async () => {
  const dir = seeded();
  const input = new PassThrough();
  const chunks = [];
  const output = { write: (s) => chunks.push(s) };
  const done = serveMcp({ dir, input, output });

  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
  input.write("this is not json\n");
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  input.end();
  await done;

  const replies = chunks.map((c) => JSON.parse(c));
  assert.equal(replies.length, 2);
  assert.deepEqual(replies[0].result, {});
  assert.equal(replies[1].error.code, -32700);
});
