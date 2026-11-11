import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isValidId, isReservedWindowsId } from "../src/memory-format.mjs";
import { saveMemory, listMemories, readMemory } from "../src/store.mjs";
import { lint } from "../src/feedback.mjs";
import { importMemories } from "../src/importer.mjs";
import { run } from "../src/cli.mjs";
import { handleMessage } from "../src/mcp.mjs";

const fresh = () => mkdtempSync(join(tmpdir(), "stashpad-win-"));
const input = (id) => ({ id, kind: "fact", text: "A note that must survive a move to Windows.", sourceType: "user", sourceRef: "chat" });
const RESERVED = ["con", "prn", "aux", "nul", "com1", "com9", "lpt1", "lpt9"];

test("Windows device names are not portable memory ids", () => {
  for (const id of RESERVED) {
    assert.equal(isReservedWindowsId(id), true, id);
    assert.equal(isValidId(id), false, id);
  }
  assert.equal(isReservedWindowsId("CON"), true, "the match is case-insensitive");
  for (const id of ["con-notes", "nul-check", "com10", "lpt0", "aux-file"]) {
    assert.equal(isReservedWindowsId(id), false, id);
    assert.equal(isValidId(id), true, id);
  }
  assert.equal(isValidId("../escape"), false, "the old id rule still holds");
});

test("save refuses a reserved id with the reason, and still accepts near misses", () => {
  const dir = fresh();
  assert.throws(() => saveMemory(dir, input("con"), "2026-01-01"), /Windows reserves this name for a device/);
  assert.equal(existsSync(join(dir, "con.md")), false);
  for (const id of ["con-notes", "nul-check", "com10"]) saveMemory(dir, input(id), "2026-01-01");
  assert.equal(listMemories(dir).rows.length, 3);
});

test("CLI save, an import line and the MCP tool all refuse a reserved id", async () => {
  const dir = fresh();
  const err = [];
  const io = { stdout: () => {}, stderr: (s) => err.push(s), env: {}, cwd: dir, readStdin: async () => "" };
  const argv = ["save", "con", "--kind", "fact", "--source-type", "user", "--source-ref", "chat", "--text", "A note.", "--dir", dir];
  assert.equal(await run(argv, io), 1);
  assert.match(err.join("\n"), /Windows reserves this name for a device/);
  assert.equal(existsSync(join(dir, "con.md")), false);

  const res = importMemories(dir, [
    '{"id":"nul","kind":"fact","text":"A short note about the build."}',
    '{"id":"ok-note","kind":"fact","text":"Another note about the build ports."}',
  ].join("\n"), { format: "jsonl", sourceRef: "export file" });
  assert.deepEqual(res.queued, ["ok-note"]);
  assert.equal(res.skipped.length, 1);
  assert.equal(res.skipped[0].id, "nul");
  assert.match(res.skipped[0].reason, /Windows reserves this name for a device/);

  const reply = handleMessage({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "stashpad_save", arguments: { id: "aux", kind: "fact", text: "A note.", source_ref: "chat" } },
  }, { dir }).result;
  assert.match(JSON.stringify(reply), /Windows reserves this name for a device/);
});

test("an existing reserved-id memory still loads and lists, and lint says how to fix it", () => {
  const dir = fresh();
  saveMemory(dir, input("con-notes"), "2026-01-01");
  const original = readFileSync(join(dir, "con-notes.md"), "utf8");
  writeFileSync(join(dir, "con.md"), original.replace(/^id: con-notes$/m, "id: con"));
  rmSync(join(dir, "con-notes.md"));

  assert.match(readMemory(dir, "con").text, /^id: con$/m);
  assert.ok(listMemories(dir).rows.some((r) => r.id === "con"), "the old store is still readable");
  const hit = lint(dir, { cwd: dir }).findings.find((f) => f.rule === "id-not-portable" && f.id === "con");
  assert.ok(hit, "lint reports the reserved id");
  assert.match(hit.message, /--supersedes/);
});
