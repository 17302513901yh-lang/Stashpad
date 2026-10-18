import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.mjs";
import { acceptPending, confirmMemory, contentHash, readMemory, saveMemory, staleMemories, StoreError } from "../src/store.mjs";
import { runDoctor } from "../src/doctor.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fresh = () => join(mkdtempSync(join(tmpdir(), "stashpad-conf-")), "s");

test("confirm updates only last_confirmed_at and logs it", async () => {
  const dir = fresh();
  saveMemory(dir, { id: "a", kind: "fact", text: "The project uses Node 20 for builds.", sourceType: "user", sourceRef: "t" }, "2025-01-01");
  const before = readMemory(dir, "a").text;
  assert.equal(confirmMemory(dir, "a", "2026-10-18").changed, true);
  const after = readMemory(dir, "a").text;
  assert.equal(after.replace(/last_confirmed_at: .*/, ""), before.replace(/last_confirmed_at: .*/, ""));
  assert.match(after, /last_confirmed_at: 2026-10-18/);
  assert.equal(confirmMemory(dir, "a", "2026-10-18").changed, false);
  assert.match(readFileSync(join(dir, "audit.jsonl"), "utf8"), /"confirmed"/);

  const out = [];
  const io = { stdout: (s) => out.push(s), stderr: () => {}, env: {}, cwd: root, readStdin: async () => "" };
  assert.equal(await run(["confirm", "a", "--dir", dir], io), 0);
});

test("an ended memory cannot be confirmed", () => {
  const dir = fresh();
  saveMemory(dir, { id: "old", kind: "fact", text: "The office is on Main Street downtown.", sourceType: "user", sourceRef: "t" }, "2026-01-01");
  saveMemory(dir, { id: "new", kind: "fact", text: "The office is on Canal Street now.", sourceType: "user", sourceRef: "t", supersedes: "old" }, "2026-02-01");
  assert.throws(() => confirmMemory(dir, "old", "2026-10-01"), StoreError);
});

test("stale agent memories are listed by doctor; user memories never are", () => {
  const dir = fresh();
  saveMemory(dir, { id: "mine", kind: "fact", text: "I keep my notes in plain Markdown files.", sourceType: "user", sourceRef: "t" }, "2024-01-01");
  saveMemory(dir, { id: "guess", kind: "fact", text: "An agent thinks the build server is in Frankfurt.", sourceType: "agent", sourceRef: "log" }, "2024-01-01");
  acceptPending(dir, "guess");
  assert.deepEqual(staleMemories(dir, { today: "2026-10-18" }), []);
  assert.equal(staleMemories(dir, { today: "2099-01-01" }).map((s) => s.id).join(), "guess");
});

test("saves record a content hash in the audit log", () => {
  const dir = fresh();
  saveMemory(dir, { id: "h", kind: "fact", text: "Hashes make hand edits visible later.", sourceType: "user", sourceRef: "t" });
  assert.match(readFileSync(join(dir, "audit.jsonl"), "utf8"), new RegExp(contentHash("Hashes make hand edits visible later.")));
});

test("doctor notices a memory changed by hand", async () => {
  const { writeFileSync } = await import("node:fs");
  const dir = fresh();
  saveMemory(dir, { id: "e", kind: "fact", text: "Original text of this note stays.", sourceType: "user", sourceRef: "t" });
  const file = join(dir, "e.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("Original text", "Changed text"));
  const check = runDoctor(dir).checks.find((c) => c.name === "edited by hand");
  assert.equal(check.status, "warn");
  assert.match(check.detail, /\be\b/);
});
