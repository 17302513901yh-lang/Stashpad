import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LOCK_FILE, withStoreLock } from "../src/lock.mjs";
import { saveMemory, StoreError } from "../src/store.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fresh = () => join(mkdtempSync(join(tmpdir(), "stashpad-lock-")), "s");

function writer(dir, prefix, count) {
  const code = `
    import { saveMemory } from ${JSON.stringify(pathToFileURL(join(root, "src", "store.mjs")).href)};
    for (let i = 0; i < ${count}; i += 1) {
      saveMemory(${JSON.stringify(dir)}, { id: "${prefix}-" + i, kind: "fact", text: "Parallel note ${prefix} number " + i + " about topic " + i, sourceType: "user", sourceRef: "lock test" });
    }`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(err))));
  });
}

test("several processes can write at the same time without losing a memory", async () => {
  const dir = fresh();
  mkdirSync(dir, { recursive: true });
  await Promise.all([writer(dir, "a", 15), writer(dir, "b", 15), writer(dir, "c", 15)]);
  const files = readdirSync(dir).filter((n) => n.endsWith(".md"));
  assert.equal(files.length, 45);
  assert.equal(existsSync(join(dir, LOCK_FILE)), false);
});

test("a lock left by a process that is gone is broken", () => {
  const dir = fresh();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ pid: 999999999, at: Date.now(), token: "old" }));
  saveMemory(dir, { id: "after", kind: "fact", text: "Saved after a stale lock was found.", sourceType: "user", sourceRef: "t" });
  assert.equal(existsSync(join(dir, LOCK_FILE)), false);
});

test("a lock held by a live process makes a write wait, then fail with a clear message", () => {
  const dir = fresh();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ pid: process.pid, at: Date.now(), token: "someone-else" }));
  process.env.STASHPAD_LOCK_WAIT_MS = "200";
  try {
    assert.throws(
      () => saveMemory(dir, { id: "blocked", kind: "fact", text: "This write should wait for the lock.", sourceType: "user", sourceRef: "t" }),
      (error) => error instanceof StoreError && /busy/.test(error.message),
    );
    assert.equal(existsSync(join(dir, LOCK_FILE)), true, "someone else's lock is left alone");
  } finally {
    delete process.env.STASHPAD_LOCK_WAIT_MS;
  }
});

test("the lock is re-entrant inside one process", () => {
  const dir = fresh();
  const result = withStoreLock(dir, () => withStoreLock(dir, () => 42));
  assert.equal(result, 42);
  assert.equal(existsSync(join(dir, LOCK_FILE)), false);
});

test("a lock file that was just created but not yet written is not broken", () => {
  const dir = fresh();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, LOCK_FILE), ""); // another process between create and write
  process.env.STASHPAD_LOCK_WAIT_MS = "150";
  try {
    assert.throws(() => saveMemory(dir, { id: "x", kind: "fact", text: "Must wait for the half-written lock.", sourceType: "user", sourceRef: "t" }), /busy/);
    assert.equal(existsSync(join(dir, LOCK_FILE)), true);
  } finally {
    delete process.env.STASHPAD_LOCK_WAIT_MS;
  }
});

test("many processes at once still lose nothing (stress)", async () => {
  const dir = fresh();
  mkdirSync(dir, { recursive: true });
  await Promise.all(["d", "e", "f", "g", "h", "i"].map((p) => writer(dir, p, 10)));
  assert.equal(readdirSync(dir).filter((n) => n.endsWith(".md")).length, 60);
  assert.equal(readdirSync(dir).some((n) => n.endsWith(".tmp") || n.endsWith(".break")), false);
});
