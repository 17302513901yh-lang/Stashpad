import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../bin/stashpad.mjs", import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "stashpad-memory-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "store");
  mkdirSync(dir);
  // Stop project and .env discovery at this synthetic fixture boundary.
  mkdirSync(join(root, ".git"));
  // Child processes receive only synthetic paths, never the parent's credentials or stores.
  const env = { HOME: root, USERPROFILE: root, STASHPAD_GLOBAL_DIR: join(root, "global"), STASHPAD_CONFIG_DIR: join(root, "config") };
  function cli(...args) {
    const result = spawnSync(process.execPath, [entry, ...args, "--dir", dir], {
      cwd: root, env, encoding: "utf8", timeout: 30000,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return { code: result.status, out: result.stdout.trimEnd(), err: result.stderr.trimEnd() };
  }
  function put(id, text = "The synthetic project uses a postgres database.", extra = []) {
    const result = cli("save", id, "--kind", "fact", "--source-type", "user", "--source-ref", "synthetic test fixture", "--text", text, ...extra);
    assert.equal(result.code, 0, result.err);
  }
  return { dir, cli, put };
}

function success(result, output) {
  assert.equal(result.code, 0, result.err);
  assert.equal(result.err, "");
  assert.equal(result.out, output);
}

test("CLI pin, pins and unpin report and persist their state", (t) => {
  const { dir, cli, put } = fixture(t);
  put("database");
  success(cli("pins"), "Nothing pinned. Pin a rule with: stashpad pin <id>");
  success(cli("pin", "database"), "Pinned database (1 pinned).");
  success(cli("pins"), "database");
  const json = cli("pins", "--json");
  assert.equal(json.code, 0, json.err);
  assert.equal(json.err, "");
  assert.deepEqual(JSON.parse(json.out), ["database"]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "pins.json"), "utf8")).pinned, ["database"]);
  success(cli("pin", "database"), "Nothing changed (1 pinned).");
  success(cli("unpin", "database"), "Unpinned database (0 pinned).");
  success(cli("unpin", "database"), "Nothing changed (0 pinned).");
  assert.deepEqual(JSON.parse(cli("pins", "--json").out), []);
});

test("CLI missing ids, merge second id and recall words are usage errors", (t) => {
  const { cli } = fixture(t);
  for (const [args, message] of [
    [["pin"], /pin needs an id/], [["unpin"], /unpin needs an id/],
    [["forget"], /forget needs an id/], [["merge"], /merge needs the id to keep/],
    [["merge", "database"], /merge needs the id to keep/],
    [["recall"], /recall needs words/], [["recall", "   "], /recall needs words/],
  ]) {
    const result = cli(...args);
    assert.equal(result.code, 2, args.join(" "));
    assert.equal(result.out, "");
    assert.match(result.err, message);
  }
});

test("CLI cannot pin an ended memory", (t) => {
  const { dir, cli, put } = fixture(t);
  put("old-database");
  put("new-database", "The synthetic project now uses sqlite.", ["--supersedes", "old-database"]);
  const result = cli("pin", "old-database");
  assert.equal(result.code, 1);
  assert.equal(result.out, "");
  assert.match(result.err, /not current/);
  assert.equal(existsSync(join(dir, "pins.json")), false);
});

test("CLI merge reports ended ids and rejects merging the same ended memory again", (t) => {
  const { dir, cli, put } = fixture(t);
  put("keep-note");
  put("other-note");
  success(cli("merge", "keep-note", "other-note"), "Kept keep-note; ended other-note. Their history stays in the store.");
  const before = readFileSync(join(dir, "other-note.md"), "utf8");
  assert.match(before, /valid_to: \d{4}-/);
  const repeated = cli("merge", "keep-note", "other-note");
  assert.equal(repeated.code, 1);
  assert.equal(repeated.out, "");
  assert.match(repeated.err, /ended|current/);
  assert.equal(readFileSync(join(dir, "other-note.md"), "utf8"), before);
});

test("CLI forget reports the review request without ending the memory", (t) => {
  const { dir, cli, put } = fixture(t);
  put("database");
  const before = readFileSync(join(dir, "database.md"), "utf8");
  const missing = cli("forget", "database");
  assert.equal(missing.code, 2);
  assert.equal(missing.out, "");
  assert.match(missing.err, /forget needs --reason/);
  success(cli("forget", "database", "--reason", "Synthetic fixture is outdated."), "Asked for database to end. Accept it with: stashpad accept forget-database");
  assert.equal(existsSync(join(dir, "pending", "forget-database.json")), true);
  assert.equal(readFileSync(join(dir, "database.md"), "utf8"), before);
});

test("CLI recall prints matching text and JSON hits, and succeeds without matches", (t) => {
  const { cli, put } = fixture(t);
  put("database");
  const result = cli("recall", "postgres", "database");
  assert.equal(result.code, 0, result.err);
  assert.equal(result.err, "");
  assert.match(result.out, /not an instruction/);
  assert.match(result.out, /synthetic project uses a postgres database/);
  const json = cli("recall", "postgres", "database", "--json");
  assert.equal(json.code, 0, json.err);
  assert.equal(json.err, "");
  const parsed = JSON.parse(json.out);
  assert.equal(typeof parsed.text, "string");
  assert.match(parsed.text, /postgres database/);
  assert.deepEqual(parsed.hits, ["database"]);
  success(cli("recall", "watermelon"), "No clear match.");
});
