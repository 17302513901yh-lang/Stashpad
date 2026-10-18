import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleMessage, TOOLS } from "../src/mcp.mjs";
import { saveMemory } from "../src/store.mjs";

const fresh = () => join(mkdtempSync(join(tmpdir(), "stashpad-rel-")), "s");

test("a save names current memories of the same kind it may replace", () => {
  const dir = fresh();
  saveMemory(dir, { id: "db-old", kind: "decision", text: "The project database engine is SQLite for local storage.", sourceType: "user", sourceRef: "t" });
  saveMemory(dir, { id: "other", kind: "fact", text: "The project database engine runs on Postgres for local storage.", sourceType: "user", sourceRef: "t" });
  const result = saveMemory(dir, { id: "db-new", kind: "decision", text: "The project database engine is Postgres from now on.", sourceType: "user", sourceRef: "t" });
  assert.deepEqual(result.maybe_replaces.map((c) => c.id), ["db-old"]);
  const explicit = saveMemory(dir, { id: "db-newer", kind: "decision", text: "The project database engine is MySQL now.", sourceType: "user", sourceRef: "t", supersedes: "db-new" });
  assert.deepEqual(explicit.maybe_replaces, []);
});

test("the MCP save reply tells the agent how to supersede", () => {
  const dir = fresh();
  saveMemory(dir, { id: "theme", kind: "preference", text: "The user prefers a dark color theme in editors.", sourceType: "user", sourceRef: "t" });
  const reply = handleMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "stashpad_save", arguments: { id: "theme-2", kind: "preference", text: "The user prefers a light color theme in editors now.", source_ref: "chat" } } },
    { dir },
  );
  assert.match(reply.result.content[0].text, /related to: theme\. .*supersedes/);
});

test("tools say which ones only read", () => {
  const readOnly = TOOLS.filter((t) => t.annotations.readOnlyHint).map((t) => t.name).sort();
  assert.deepEqual(readOnly, ["stashpad_about", "stashpad_get", "stashpad_recent", "stashpad_search"]);
});
