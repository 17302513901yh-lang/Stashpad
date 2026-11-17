import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.mjs";

// Synthetic test-only input, never an actual store or account credential.
const PASS = "synthetic CLI encryption test passphrase";
const TEXT = "The synthetic project uses copper widgets.";

function harness(cwd, env = {}) {
  const out = [], err = [];
  return {
    out, err,
    io: { cwd, env, stdout: (s) => out.push(s), stderr: (s) => err.push(s), readStdin: async () => "" },
  };
}

// Exercise injected io.env independently of ambient credentials, without reading
// or changing the parent environment. The child only receives synthetic input.
function isolatedList(cwd, env = {}, ambient = {}, args = []) {
  const cli = new URL("../src/cli.mjs", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { readFileSync } from "node:fs";
    import { run } from ${JSON.stringify(cli)};
    const { cwd, env, args } = JSON.parse(readFileSync(0, "utf8"));
    const out = [], err = [];
    const code = await run(["list", "--dir", cwd, ...args], {
      cwd, env, stdout: (s) => out.push(s), stderr: (s) => err.push(s),
      readStdin: async () => "",
    });
    process.stdout.write(JSON.stringify({ code, out, err }));
  `], { env: ambient, input: JSON.stringify({ cwd, env, args }), encoding: "utf8", timeout: 30000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

// Include paths and bytes so a no-op cannot silently add or remove a file.
function files(dir, prefix = "") {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const name = join(prefix, entry.name), path = join(dir, entry.name);
    return entry.isDirectory() ? files(path, name) : [[name, readFileSync(path)]];
  });
}

async function store(t, sealed = false) {
  const dir = mkdtempSync(join(tmpdir(), "stashpad-encrypt-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const h = harness(dir);
  assert.equal(await run(["save", "sample", "--dir", dir, "--kind", "fact", "--source-type", "user", "--source-ref", "synthetic test statement", "--text", TEXT], h.io), 0);
  if (sealed) {
    const enc = harness(dir, { STASHPAD_PASSPHRASE: PASS });
    assert.equal(await run(["encrypt", "--dir", dir], enc.io), 0);
  }
  return dir;
}

function memory(dir) { return readFileSync(join(dir, "sample.md"), "utf8"); }

test("encrypt without a passphrase fails without changing the plain store", async (t) => {
  const dir = await store(t), before = files(dir), h = harness(dir);
  assert.equal(await run(["encrypt", "--dir", dir], h.io), 1);
  assert.match(h.err.join("\n"), /STASHPAD_PASSPHRASE.*STASHPAD_KEY_FILE/);
  assert.deepEqual(h.out, []);
  assert.ok(memory(dir).includes(TEXT));
  assert.deepEqual(files(dir), before);
});

test("encrypt with an io.env passphrase seals the memory and explains recovery", async (t) => {
  const dir = await store(t), h = harness(dir, { STASHPAD_PASSPHRASE: PASS });
  assert.equal(await run(["encrypt", "--dir", dir], h.io), 0);
  assert.deepEqual(h.err, []);
  assert.match(h.out.join("\n"), /Encrypted the store \(\d+ files sealed, snapshots included\)/);
  assert.match(h.out.join("\n"), /Keep the passphrase safe/);
  assert.match(memory(dir), /^STASHPAD-SEALED-1:/);
  assert.ok(!memory(dir).includes(TEXT));
});

test("list without the passphrase refuses a sealed store", async (t) => {
  const dir = await store(t, true), missing = isolatedList(dir);
  assert.equal(missing.code, 1);
  assert.match(missing.err.join("\n"), /this store is encrypted/);
  assert.deepEqual(missing.out, []);
});

test("list reads a sealed store with an io.env passphrase", async (t) => {
  const dir = await store(t, true);
  const supplied = isolatedList(dir, { STASHPAD_PASSPHRASE: PASS });
  assert.equal(supplied.code, 0);
  assert.deepEqual(supplied.err, []);
  assert.ok(supplied.out.join("\n").includes(TEXT));
});

test("decrypt without --yes preserves all sealed store files", async (t) => {
  const dir = await store(t, true), before = files(dir), h = harness(dir, { STASHPAD_PASSPHRASE: PASS });
  assert.equal(await run(["decrypt", "--dir", dir], h.io), 0);
  assert.deepEqual(h.err, []);
  assert.match(h.out.join("\n"), /Nothing changed\. Run again with --yes/);
  assert.deepEqual(files(dir), before);
  assert.match(memory(dir), /^STASHPAD-SEALED-1:/);
});

test("decrypt --yes restores plain memory and list needs no passphrase", async (t) => {
  const dir = await store(t), plain = memory(dir);
  assert.equal(await run(["encrypt", "--dir", dir], harness(dir, { STASHPAD_PASSPHRASE: PASS }).io), 0);
  const h = harness(dir, { STASHPAD_PASSPHRASE: PASS });
  assert.equal(await run(["decrypt", "--yes", "--dir", dir], h.io), 0);
  assert.deepEqual(h.err, []);
  assert.match(h.out.join("\n"), /Decrypted the store \(\d+ files are plain text again\)/);
  assert.equal(memory(dir), plain);
  const listed = harness(dir);
  assert.equal(await run(["list", "--dir", dir], listed.io), 0);
  assert.deepEqual(listed.err, []);
  assert.ok(listed.out.join("\n").includes(TEXT));
});

test("decrypt --yes with the wrong passphrase fails without changing any file", async (t) => {
  const dir = await store(t, true), before = files(dir), h = harness(dir, { STASHPAD_PASSPHRASE: "different synthetic test passphrase" });
  assert.equal(await run(["decrypt", "--yes", "--dir", dir], h.io), 1);
  assert.match(h.err.join("\n"), /wrong passphrase/);
  assert.deepEqual(h.out, []);
  assert.deepEqual(files(dir), before);
});


test("list uses io.env rather than an ambient passphrase and does not mutate files", async (t) => {
  const dir = await store(t, true), before = files(dir);
  const ambient = { STASHPAD_PASSPHRASE: PASS };
  for (const env of [{}, { STASHPAD_PASSPHRASE: "wrong synthetic passphrase" }]) {
    const result = isolatedList(dir, env, ambient);
    assert.equal(result.code, 1);
    assert.deepEqual(result.out, []);
    assert.match(result.err.join("\n"), env.STASHPAD_PASSPHRASE ? /wrong passphrase/ : /this store is encrypted/);
    assert.deepEqual(files(dir), before);
  }
  const correct = isolatedList(dir, { STASHPAD_PASSPHRASE: PASS },
    { STASHPAD_PASSPHRASE: "unrelated synthetic ambient passphrase" }, ["--json", "--kind", "fact"]);
  assert.equal(correct.code, 0);
  assert.deepEqual(correct.err, []);
  assert.equal(JSON.parse(correct.out.join(""))[0].summary, TEXT);
  assert.deepEqual(files(dir), before);
});

test("list accepts an io.env key file without changing the sealed store", async (t) => {
  const dir = await store(t, true), before = files(dir);
  const keyDir = mkdtempSync(join(tmpdir(), "stashpad-synthetic-key-"));
  t.after(() => rmSync(keyDir, { recursive: true, force: true }));
  const key = join(keyDir, "synthetic-key.txt");
  writeFileSync(key, PASS + "\n");
  const result = isolatedList(dir, { STASHPAD_KEY_FILE: key });
  assert.equal(result.code, 0);
  assert.deepEqual(result.err, []);
  assert.ok(result.out.join("\n").includes(TEXT));
  assert.deepEqual(files(dir), before);
});

test("listMemories keeps its ambient default but honors an explicit environment", async (t) => {
  const dir = await store(t, true), before = files(dir);
  const storeModule = new URL("../src/store.mjs", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    import { listMemories } from ${JSON.stringify(storeModule)};
    const { dir, pass, text } = JSON.parse(readFileSync(0, "utf8"));
    assert.equal(listMemories(dir).rows[0].summary, text);
    assert.throws(() => listMemories(dir, { env: {} }), /this store is encrypted/);
    assert.throws(() => listMemories(dir, { env: { STASHPAD_PASSPHRASE: "wrong synthetic passphrase" } }), /wrong passphrase/);
    const options = { env: { STASHPAD_PASSPHRASE: pass }, kinds: ["fact"] };
    assert.equal(listMemories(dir, options).rows[0].summary, text);
    assert.deepEqual(listMemories(dir, { ...options, kinds: ["task"] }).rows, []);
  `], {
    env: { STASHPAD_PASSPHRASE: PASS }, encoding: "utf8", timeout: 30000,
    input: JSON.stringify({ dir, pass: PASS, text: TEXT }),
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(files(dir), before);
});
