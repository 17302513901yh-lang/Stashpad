import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.mjs";
import { handleMessage } from "../src/mcp.mjs";
import { buildBrief } from "../src/brief.mjs";
import { aboutEntity } from "../src/entities.mjs";
import { runDoctor } from "../src/doctor.mjs";
import { decryptStore, encryptStore } from "../src/encrypt.mjs";
import { createSnapshot, listSnapshots, restoreSnapshot } from "../src/safety.mjs";
import { archiveSource } from "../src/sources.mjs";
import { acceptPending, readAudit, readMemory, saveMemory, searchMemories, StoreError } from "../src/store.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PASS = "correct horse battery staple";
const SECRET_WORD = "Zanzibarquokka";

function allFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...allFiles(path));
    else out.push(path);
  }
  return out;
}

function store() {
  const dir = join(mkdtempSync(join(tmpdir(), "stashpad-enc-")), "s");
  saveMemory(dir, { id: "plan", kind: "decision", text: `The ${SECRET_WORD} project runs on Postgres.`, sourceType: "user", sourceRef: "t" });
  saveMemory(dir, { id: "idea", kind: "fact", text: `An agent noted ${SECRET_WORD} ships in spring.`, sourceType: "agent", sourceRef: "log" });
  createSnapshot(dir, "before");
  return dir;
}

let saved;
beforeEach(() => {
  saved = { p: process.env.STASHPAD_PASSPHRASE, k: process.env.STASHPAD_KEY_FILE };
  process.env.STASHPAD_PASSPHRASE = PASS;
  delete process.env.STASHPAD_KEY_FILE;
});
afterEach(() => {
  if (saved.p === undefined) delete process.env.STASHPAD_PASSPHRASE;
  else process.env.STASHPAD_PASSPHRASE = saved.p;
  if (saved.k !== undefined) process.env.STASHPAD_KEY_FILE = saved.k;
});

test("after encrypt no file holds the text, snapshots and audit log included", () => {
  const dir = store();
  const done = encryptStore(dir);
  assert.ok(done.files >= 4);
  for (const file of allFiles(dir)) {
    assert.ok(!readFileSync(file, "utf8").includes(SECRET_WORD), `plain text left in ${file}`);
  }
  assert.ok(!readFileSync(join(dir, "audit.jsonl"), "utf8").includes("plan"));
});

test("search, get, brief, about, review and the MCP tools work on an encrypted store", () => {
  const dir = store();
  encryptStore(dir);
  assert.deepEqual(searchMemories(dir, SECRET_WORD).results.map((r) => r.id), ["plan"]);
  assert.match(readMemory(dir, "plan").text, /Postgres/);
  assert.match(buildBrief(dir).text, /plan/);
  assert.equal(aboutEntity(dir, "Postgres").found, true);
  acceptPending(dir, "idea");
  assert.equal(searchMemories(dir, "spring").results[0].id, "idea");
  const reply = handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "stashpad_get", arguments: { id: "plan" } } }, { dir });
  assert.match(reply.result.content[0].text, /Postgres/);
  assert.ok(readAudit(dir).some((e) => e.action === "accepted"));
  for (const file of allFiles(dir)) assert.ok(!readFileSync(file, "utf8").includes("spring"), `plain text in ${file}`);
});

test("new writes, supersede, snapshots and restore stay sealed", () => {
  const dir = store();
  encryptStore(dir);
  saveMemory(dir, { id: "plan-v2", kind: "decision", text: "The project moved to SQLite for Quokkaville.", sourceType: "user", sourceRef: "t", supersedes: "plan" });
  const snap = createSnapshot(dir, "after");
  saveMemory(dir, { id: "later", kind: "fact", text: "A later note about Quokkaville builds.", sourceType: "user", sourceRef: "t" });
  restoreSnapshot(dir, snap.name);
  assert.deepEqual(searchMemories(dir, "Quokkaville").results.map((r) => r.id), ["plan-v2"]);
  for (const file of allFiles(dir)) assert.ok(!readFileSync(file, "utf8").includes("Quokkaville"), `plain text in ${file}`);
  assert.ok(listSnapshots(dir).length >= 3);
});

test("a missing or wrong passphrase gives one clear error", async () => {
  const dir = store();
  encryptStore(dir);
  delete process.env.STASHPAD_PASSPHRASE;
  assert.throws(() => searchMemories(dir, "Postgres"), /encrypted\. Set STASHPAD_PASSPHRASE/);
  process.env.STASHPAD_PASSPHRASE = "a wrong passphrase here";
  assert.throws(() => searchMemories(dir, "Postgres"), /wrong passphrase/);
  const err = [];
  const io = { stdout: () => {}, stderr: (s) => err.push(s), env: process.env, cwd: root, readStdin: async () => "" };
  assert.equal(await run(["search", "Postgres", "--dir", dir], io), 1);
  assert.match(err.join("\n"), /wrong passphrase/);
  assert.equal(runDoctor(dir).checks.find((c) => c.name === "encryption").status, "fail");
});

test("decrypt gives back the same plain files", () => {
  const dir = store();
  const before = readFileSync(join(dir, "plan.md"), "utf8");
  encryptStore(dir);
  assert.notEqual(readFileSync(join(dir, "plan.md"), "utf8"), before);
  decryptStore(dir);
  assert.equal(readFileSync(join(dir, "plan.md"), "utf8"), before);
  delete process.env.STASHPAD_PASSPHRASE;
  assert.equal(searchMemories(dir, SECRET_WORD).results[0].id, "plan");
  assert.match(readFileSync(join(dir, "audit.jsonl"), "utf8"), /"saved"/);
});

test("a run that stopped halfway is finished by running encrypt again", () => {
  const dir = store();
  encryptStore(dir);
  // simulate a half-done run: one file back to plain
  decryptStore(dir);
  encryptStore(dir);
  const plainCopy = readFileSync(join(dir, ".snapshots", listSnapshots(dir)[0], "plan.md"), "utf8");
  assert.ok(plainCopy.startsWith("STASHPAD-SEALED-1:"));
  writeFileSync(join(dir, "loose.md"), readMemory(dir, "plan").text.replace("id: plan", "id: loose"));
  assert.equal(runDoctor(dir).checks.find((c) => c.name === "encryption").status, "warn");
  const again = encryptStore(dir);
  assert.equal(again.resumed, true);
  assert.equal(runDoctor(dir).checks.find((c) => c.name === "encryption").status, "ok");
});

test("a short passphrase is refused and a key file works", () => {
  const dir = store();
  process.env.STASHPAD_PASSPHRASE = "short";
  assert.throws(() => encryptStore(dir), StoreError);
  delete process.env.STASHPAD_PASSPHRASE;
  const keyFile = join(mkdtempSync(join(tmpdir(), "stashpad-key-")), "key.txt");
  writeFileSync(keyFile, `${PASS}\n`);
  process.env.STASHPAD_KEY_FILE = keyFile;
  encryptStore(dir);
  assert.equal(searchMemories(dir, SECRET_WORD).results[0].id, "plan");
  delete process.env.STASHPAD_KEY_FILE;
});

test("a raw source copy is sealed and its name hides the file name", () => {
  const dir = store();
  encryptStore(dir);
  const src = join(mkdtempSync(join(tmpdir(), "stashpad-src-")), "meeting-notes-quokka.txt");
  writeFileSync(src, `Notes about ${SECRET_WORD}.`);
  const rel = archiveSource(dir, src);
  assert.match(rel, /^sources\/[0-9a-f]{16}\.sealed$/);
  assert.ok(!readFileSync(join(dir, rel), "utf8").includes(SECRET_WORD));
});

test("restoring a snapshot taken before encryption keeps the store encrypted and readable", () => {
  const dir = store();
  const [early] = listSnapshots(dir);
  encryptStore(dir);
  restoreSnapshot(dir, early);
  assert.equal(searchMemories(dir, SECRET_WORD).results[0].id, "plan");
  for (const file of allFiles(dir)) assert.ok(!readFileSync(file, "utf8").includes(SECRET_WORD), `plain text in ${file}`);
});

// Fixes from an independent review.
import { rmSync, existsSync } from "node:fs";
import { migrateStore } from "../src/safety.mjs";
import { rejectPending } from "../src/store.mjs";

test("review 1: a deleted or broken marker is put back by migrate; encrypt never makes a new key over sealed files", () => {
  const dir = store();
  encryptStore(dir);
  writeFileSync(join(dir, ".stashpad-store.json"), "{broken");
  assert.equal(runDoctor(dir).healthy, false);
  rmSync(join(dir, ".stashpad-store.json"));
  assert.throws(() => encryptStore(dir), /already holds sealed files/);
  const fixed = migrateStore(dir);
  assert.match(fixed.steps[0], /put the marker back/);
  assert.equal(searchMemories(dir, SECRET_WORD).results[0].id, "plan");
});

test("review 1b: without the marker and its backup, the newest snapshot's marker is used", () => {
  const dir = store();
  encryptStore(dir);
  createSnapshot(dir, "with-marker");
  rmSync(join(dir, ".stashpad-store.json"));
  rmSync(join(dir, ".stashpad-store.backup.json"));
  migrateStore(dir);
  assert.equal(searchMemories(dir, SECRET_WORD).results[0].id, "plan");
});

test("review 2: restore refuses while the marker is missing, and says what to do", () => {
  const dir = store();
  encryptStore(dir);
  const [snap] = listSnapshots(dir);
  rmSync(join(dir, ".stashpad-store.json"));
  assert.throws(() => restoreSnapshot(dir, snap), /migrate/);
  assert.ok(!readFileSync(join(dir, "audit.jsonl"), "utf8").split("\n").some((l) => l.startsWith("{")), "no plain audit line");
});

test("review 3: a write without the passphrase changes nothing", () => {
  const dir = store();
  encryptStore(dir);
  delete process.env.STASHPAD_PASSPHRASE;
  assert.throws(() => rejectPending(dir, "idea", "no"), /encrypted/);
  assert.ok(existsSync(join(dir, "pending", "idea.md")));
  assert.ok(!existsSync(join(dir, "rejected")));
});

test("review 4: doctor counts plain files in snapshots too", () => {
  const dir = store();
  encryptStore(dir);
  const [snap] = listSnapshots(dir);
  writeFileSync(join(dir, ".snapshots", snap, "plain.md"), "---\nid: plain\n---\nplain text");
  assert.equal(runDoctor(dir).checks.find((c) => c.name === "encryption").status, "warn");
});

test("review 5 and 6: a damaged or cut-short sealed value is refused with a clear error", () => {
  const dir = store();
  encryptStore(dir);
  const file = join(dir, "plan.md");
  const sealed = readFileSync(file, "utf8");
  const raw = Buffer.from(sealed.slice("STASHPAD-SEALED-1:".length), "base64");
  writeFileSync(file, `STASHPAD-SEALED-1:${raw.subarray(0, 16).toString("base64")}`);
  assert.throws(() => readMemory(dir, "plan"), StoreError);
  writeFileSync(file, "STASHPAD-SEALED-1:");
  assert.throws(() => readMemory(dir, "plan"), StoreError);
});

test("review 7: doctor reports sealed files without encryption settings instead of crashing", () => {
  const dir = store();
  encryptStore(dir);
  writeFileSync(join(dir, ".stashpad-store.json"), JSON.stringify({ format: 1 }));
  const check = runDoctor(dir).checks.find((c) => c.name === "encryption");
  assert.equal(check.status, "fail");
  assert.match(check.fix, /migrate|backup/);
});

test("review 7b: a marker that lost its encryption settings is fixed by migrate from the backup", () => {
  const dir = store();
  encryptStore(dir);
  writeFileSync(join(dir, ".stashpad-store.json"), JSON.stringify({ format: 1 }));
  assert.match(runDoctor(dir).checks.find((c) => c.name === "encryption").fix, /backup/);
  migrateStore(dir);
  assert.equal(searchMemories(dir, SECRET_WORD).results[0].id, "plan");
});
