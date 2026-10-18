import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.mjs";
import { TOOLS } from "../src/mcp.mjs";
import { contractOf } from "../src/contract.mjs";
import { VERSION } from "../src/version.mjs";
import { saveMemory, listMemories, searchMemories, StoreError } from "../src/store.mjs";
import {
  MARKER,
  autoSnapshot,
  createSnapshot,
  isInsideInstall,
  listSnapshots,
  migrateStore,
  readStoreFormat,
  restoreSnapshot,
} from "../src/safety.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fresh = () => mkdtempSync(join(tmpdir(), "stashpad-safety-"));
const save = (dir, id, text = "The project uses Node 20.", extra = {}) =>
  saveMemory(dir, { id, kind: "fact", text, sourceType: "user", sourceRef: "test", ...extra }, "2026-01-10");

function harness() {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s), env: {}, cwd: root, readStdin: async () => "" } };
}

test("a new store gets a format marker", () => {
  const dir = join(fresh(), "store");
  save(dir, "a");
  assert.equal(readStoreFormat(dir), 1);
});

test("a store made before markers stays unmarked until migrate", () => {
  const dir = fresh();
  save(dir, "old");
  rmSync(join(dir, MARKER));
  save(dir, "newer", "Another fact about builds.");
  assert.equal(readStoreFormat(dir), null);
});

test("migrate dry run changes nothing; a real run writes the marker and a snapshot", () => {
  const dir = join(fresh(), "store");
  save(dir, "a");
  // make it look like a legacy store
  rmSync(join(dir, MARKER));
  const dry = migrateStore(dir, { dryRun: true });
  assert.equal(dry.from, 0);
  assert.equal(dry.snapshot, null);
  assert.equal(readStoreFormat(dir), null);
  assert.deepEqual(listSnapshots(dir), []);

  const real = migrateStore(dir);
  assert.equal(readStoreFormat(dir), 1);
  assert.ok(real.snapshot);
  assert.equal(listSnapshots(dir).length, 1);
  assert.equal(migrateStore(dir).steps.length, 0);
});

test("a newer store format blocks writes but not reads", () => {
  const dir = join(fresh(), "store");
  save(dir, "a");
  writeFileSync(join(dir, MARKER), JSON.stringify({ format: 99 }));
  assert.throws(() => save(dir, "b"), StoreError);
  assert.equal(listMemories(dir).rows.length, 1);
  assert.equal(searchMemories(dir, "node").results.length, 1);
});

test("one automatic snapshot per day before a supersede, holding the old file", () => {
  const dir = join(fresh(), "store");
  save(dir, "db-v1", "The database is Postgres.");
  save(dir, "db-v2", "The database is MySQL now.", { supersedes: "db-v1" });
  const snaps = listSnapshots(dir);
  assert.equal(snaps.length, 1);
  assert.match(snaps[0], /-auto$/);
  const kept = readFileSync(join(dir, ".snapshots", snaps[0], "db-v1.md"), "utf8");
  assert.match(kept, /valid_to: null/);
  assert.equal(autoSnapshot(dir), null);
});

test("restore puts a snapshot back, keeps a safety snapshot and writes an audit line", () => {
  const dir = join(fresh(), "store");
  save(dir, "a");
  const snap = createSnapshot(dir, "manual");
  save(dir, "b", "Another fact about deploys.");
  const done = restoreSnapshot(dir, snap.name);
  assert.deepEqual(listMemories(dir).rows.map((r) => r.id), ["a"]);
  assert.ok(listSnapshots(dir).includes(done.safety));
  assert.match(readFileSync(join(dir, "audit.jsonl"), "utf8"), /"restored"/);
  restoreSnapshot(dir, done.safety);
  assert.deepEqual(listMemories(dir).rows.map((r) => r.id).sort(), ["a", "b"]);
});

test("bad snapshot names are rejected", () => {
  const dir = join(fresh(), "store");
  save(dir, "a");
  for (const name of ["../x", "nope", "2026-01-01T00-00-00-000Z-x/../../y"]) {
    assert.throws(() => restoreSnapshot(dir, name), StoreError);
  }
});

test("snapshots do not show up in list or search, and links are not copied", () => {
  const dir = join(fresh(), "store");
  save(dir, "a");
  mkdirSync(join(dir, "sources"));
  writeFileSync(join(dir, "sources", "raw.txt"), "raw");
  const outside = join(fresh(), "secret.md");
  writeFileSync(outside, "secret");
  try {
    symlinkSync(outside, join(dir, "link.md"));
  } catch {
    // symlinks may be unavailable; the rest of the test still holds
  }
  const snap = createSnapshot(dir, "x");
  assert.equal(listMemories(dir).rows.length, 1);
  assert.equal(searchMemories(dir, "node").results.length, 1);
  const files = readdirSync(join(dir, ".snapshots", snap.name));
  assert.ok(!files.includes("link.md"));
  assert.ok(!files.includes("sources"));
});

test("isInsideInstall spots a store inside the install folder", () => {
  assert.equal(isInsideInstall(join(root, "data")), true);
  assert.equal(isInsideInstall(fresh()), false);
});

test("the tool contract matches the golden file and the versions agree", async () => {
  const golden = JSON.parse(readFileSync(join(root, "docs", "tool-contract.json"), "utf8"));
  assert.deepEqual(contractOf(TOOLS), golden, 'tools changed. If on purpose, run "npm run contract" and note it in the changelog.');
  assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, VERSION);
});

test("CLI: snapshot, snapshots, restore needs --yes, migrate, contract, --version", async () => {
  const dir = join(fresh(), "store");
  save(dir, "a");
  let h = harness();
  assert.equal(await run(["snapshot", "--dir", dir, "--label", "Before Upgrade"], h.io), 0);
  const [name] = listSnapshots(dir);
  assert.match(name, /-before-upgrade$/);

  h = harness();
  assert.equal(await run(["snapshots", "--dir", dir, "--json"], h.io), 0);
  assert.deepEqual(JSON.parse(h.out[0]), [name]);

  h = harness();
  save(dir, "b", "Extra fact about caching.");
  assert.equal(await run(["restore", name, "--dir", dir], h.io), 0);
  assert.equal(listMemories(dir).rows.length, 2);
  assert.equal(await run(["restore", name, "--dir", dir, "--yes"], h.io), 0);
  assert.equal(listMemories(dir).rows.length, 1);

  h = harness();
  assert.equal(await run(["migrate", "--dir", dir, "--dry-run"], h.io), 0);
  assert.match(h.out.join("\n"), /Already up to date/);

  h = harness();
  assert.equal(await run(["contract", "--json"], h.io), 0);
  assert.equal(JSON.parse(h.out.join("\n")).tools.length, 5);

  h = harness();
  assert.equal(await run(["--version"], h.io), 0);
  assert.equal(h.out[0], `stashpad ${VERSION}`);
});
