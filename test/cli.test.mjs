import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.mjs";
import { todayIso } from "../src/store.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const examples = join(root, "examples", "memories");

function harness(stdin = "") {
  const out = [];
  const err = [];
  const io = {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    env: {},
    cwd: root,
    readStdin: async () => stdin,
  };
  return { io, out, err };
}

function freshDir() {
  return mkdtempSync(join(tmpdir(), "stashpad-test-"));
}

const saveArgs = (dir, id, extra = []) => [
  "save", id,
  "--dir", dir,
  "--kind", "fact",
  "--source-type", "user",
  "--source-ref", "test statement",
  "--text", "The test project uses Node 20.",
  ...extra,
];

test("save then get returns the memory with derived trust and today's date", async () => {
  const dir = freshDir();
  const save = harness();
  assert.equal(await run(saveArgs(dir, "node-version"), save.io), 0);

  const get = harness();
  assert.equal(await run(["get", "node-version", "--dir", dir], get.io), 0);
  const text = get.out.join("\n");
  assert.match(text, /^id: node-version$/m);
  assert.match(text, /^trust: user-stated$/m);
  assert.match(text, new RegExp(`^created_at: ${todayIso()}$`, "m"));
  assert.match(text, /The test project uses Node 20\./);
});

test("an agent-written memory gets agent-inferred trust", async () => {
  const dir = freshDir();
  const { io } = harness();
  const args = saveArgs(dir, "agent-guess", ["--source-type", "agent"]);
  assert.equal(await run(args, io), 0);
  // Agent writes wait in pending/ until a person accepts them.
  const text = readFileSync(join(dir, "pending", "agent-guess.md"), "utf8");
  assert.match(text, /^trust: agent-inferred$/m);
});

test("an existing memory is never overwritten", async () => {
  const dir = freshDir();
  assert.equal(await run(saveArgs(dir, "same-id"), harness().io), 0);
  const second = harness();
  assert.equal(await run(saveArgs(dir, "same-id"), second.io), 1);
  assert.match(second.err.join("\n"), /already exists/);
});

test("a path-like id is refused", async () => {
  const dir = freshDir();
  const { io, err } = harness();
  assert.equal(await run(saveArgs(dir, "../escape"), io), 1);
  assert.match(err.join("\n"), /invalid id/);
  assert.equal(existsSync(join(dir, "..", "escape.md")), false);
});

test("missing --source-ref is a usage error", async () => {
  const dir = freshDir();
  const { io, err } = harness();
  const args = ["save", "no-source", "--dir", dir, "--kind", "fact", "--source-type", "user", "--text", "x"];
  assert.equal(await run(args, io), 2);
  assert.match(err.join("\n"), /--source-ref/);
});

test("text from standard input with --text -", async () => {
  const dir = freshDir();
  const { io } = harness("Read from stdin.\n");
  const args = saveArgs(dir, "from-stdin");
  args[args.indexOf("The test project uses Node 20.")] = "-";
  assert.equal(await run(args, io), 0);
  assert.match(readFileSync(join(dir, "from-stdin.md"), "utf8"), /Read from stdin\./);
});

test("list shows current memories, --all also shows ended ones", async () => {
  const dir = freshDir();
  cpSync(examples, dir, { recursive: true });

  const current = harness();
  assert.equal(await run(["list", "--dir", dir], current.io), 0);
  const currentText = current.out.join("\n");
  assert.match(currentText, /db-choice-v2/);
  assert.doesNotMatch(currentText, /db-choice-v1/);

  const all = harness();
  assert.equal(await run(["list", "--all", "--dir", dir], all.io), 0);
  assert.match(all.out.join("\n"), /db-choice-v1.*ended 2026-10-01/);
});

test("list --json prints a parseable array", async () => {
  const dir = freshDir();
  cpSync(examples, dir, { recursive: true });
  const { io, out } = harness();
  assert.equal(await run(["list", "--json", "--dir", dir], io), 0);
  const rows = JSON.parse(out[0]);
  assert.ok(Array.isArray(rows));
  assert.ok(rows.some((r) => r.id === "prefs-answer-length"));
});

test("get of an unknown id points to list", async () => {
  const dir = freshDir();
  const { io, err } = harness();
  assert.equal(await run(["get", "nothing-here", "--dir", dir], io), 1);
  assert.match(err.join("\n"), /stashpad list --all/);
});

test("unknown command is a usage error", async () => {
  const { io, err } = harness();
  assert.equal(await run(["explode"], io), 2);
  assert.match(err.join("\n"), /Unknown command/);
});

test("--help prints usage and exits 0", async () => {
  const { io, out } = harness();
  assert.equal(await run(["--help"], io), 0);
  assert.match(out.join("\n"), /Usage:/);
});

test("an id over the limit is refused before anything is written", async () => {
  const dir = freshDir();
  const id = "x".repeat(65);
  const { io, err } = harness();
  assert.equal(await run(saveArgs(dir, id), io), 1);
  assert.match(err.join("\n"), /at most 64 characters/);
  assert.equal(existsSync(join(dir, `${id}.md`)), false);
});

test("an id at the limit can be saved and forgotten", async () => {
  const dir = freshDir();
  const id = "x".repeat(64);
  assert.equal(await run(saveArgs(dir, id), harness().io), 0);
  assert.ok(existsSync(join(dir, `${id}.md`)));

  const forget = harness();
  assert.equal(await run(["forget", id, "--dir", dir, "--reason", "test"], forget.io), 0);
  assert.ok(existsSync(join(dir, "pending", `forget-${id}.json`)));
});

test("a memory stored with a longer id still lists, gets and searches", async () => {
  const dir = freshDir();
  const id = "x".repeat(80);
  writeFileSync(join(dir, `${id}.md`), `---
id: ${id}
kind: fact
created_at: 2026-09-10
valid_from: 2026-09-10
valid_to: null
supersedes: null
superseded_by: null
source_type: user
source_ref: legacy statement
trust: user-stated
last_confirmed_at: 2026-09-10
---
Legacy memory text.
`);

  const list = harness();
  assert.equal(await run(["list", "--dir", dir], list.io), 0);
  assert.match(list.out.join("\n"), new RegExp(id));

  const get = harness();
  assert.equal(await run(["get", id, "--dir", dir], get.io), 0);
  assert.match(get.out.join("\n"), /Legacy memory text/);

  const search = harness();
  assert.equal(await run(["search", "Legacy", "--dir", dir], search.io), 0);
  assert.match(search.out.join("\n"), new RegExp(id));
});

test("a legacy long-id memory can be forgotten and its ending request accepted", async () => {
  const dir = freshDir();
  const id = "x".repeat(80);
  assert.equal(await run(saveArgs(dir, "legacy"), harness().io), 0);
  const path = join(dir, `${id}.md`);
  renameSync(join(dir, "legacy.md"), path);
  writeFileSync(path, readFileSync(path, "utf8").replace("id: legacy\n", `id: ${id}\n`));

  const forget = harness();
  assert.equal(await run(["forget", id, "--dir", dir, "--reason", "outdated"], forget.io), 0, forget.err.join("\n"));
  const pending = join(dir, "pending", `forget-${id}.json`);
  assert.ok(existsSync(pending));
  const accept = harness();
  assert.equal(await run(["accept", `forget-${id}`, "--dir", dir], accept.io), 0, accept.err.join("\n"));
  assert.equal(existsSync(pending), false);
  assert.match(readFileSync(path, "utf8"), new RegExp(`^valid_to: ${todayIso()}$`, "m"));
});

for (const action of ["accept", "reject"]) {
  test(`a legacy long-id proposal can be ${action}ed`, async () => {
    const dir = freshDir();
    const id = "x".repeat(80);
    assert.equal(await run(saveArgs(dir, "legacy", ["--source-type", "agent"]), harness().io), 0);
    const pending = join(dir, "pending", `${id}.md`);
    renameSync(join(dir, "pending", "legacy.md"), pending);
    writeFileSync(pending, readFileSync(pending, "utf8").replace("id: legacy\n", `id: ${id}\n`));

    const result = harness();
    assert.equal(await run([action, id, "--dir", dir], result.io), 0, result.err.join("\n"));
    assert.equal(existsSync(pending), false);
    const destination = action === "accept" ? join(dir, `${id}.md`) : join(dir, "rejected", `${id}.md`);
    assert.ok(existsSync(destination));
    assert.match(readFileSync(destination, "utf8"), new RegExp(`^id: ${id}$`, "m"));
  });
}

test("shown --since refuses a day that does not exist (#60)", async () => {
  const dir = freshDir();
  for (const day of ["2026-13-45", "2026-02-30"]) {
    const { io, err } = harness();
    assert.equal(await run(["shown", "--since", day, "--dir", dir], io), 2);
    assert.match(err.join("\n"), new RegExp(`--since must be a date like 2026-10-01, not "${day}"`));
  }
  assert.equal(await run(["shown", "--since", "2026-02-28", "--dir", dir], harness().io), 0);
  assert.equal(await run(["shown", "--today", "--dir", dir], harness().io), 0);
});

test("one-id commands refuse a second id before changing anything (#69)", async () => {
  const dir = freshDir();
  assert.equal(await run(saveArgs(dir, "n1", ["--source-type", "agent"]), harness().io), 0);
  for (const command of ["accept", "reject", "get", "history", "pin", "unpin", "confirm", "forget", "restore"]) {
    const h = harness();
    assert.equal(await run([command, "n1", "n2", "--dir", dir], h.io), 2, `${command} must be a usage error`);
    assert.match(h.err.join("\n"), new RegExp(`${command} takes one id, but got 2: n1, n2\. Run it once for each id\.`));
  }
  // Nothing was accepted: the refusal happens before the switch, so the note stays pending.
  assert.equal(existsSync(join(dir, "pending", "n1.md")), true);
  assert.equal(existsSync(join(dir, "n1.md")), false);
  assert.equal(await run(["accept", "n1", "--dir", dir], harness().io), 0, "one id still works");
  assert.equal(existsSync(join(dir, "n1.md")), true);

  // Commands that legitimately take several words are untouched.
  const many = freshDir();
  for (const id of ["keep-id", "other-a", "other-b"]) {
    assert.equal(await run(saveArgs(many, id, ["--text", `A distinct note about ${id}.`]), harness().io), 0);
  }
  const merged = harness();
  assert.equal(await run(["merge", "keep-id", "other-a", "other-b", "--dir", many], merged.io), 0, "merge still takes several ids");
  assert.match(merged.out.join("\n"), /other-a, other-b/);
  const search = harness();
  assert.equal(await run(["search", "test", "project", "--dir", many], search.io), 0, "search still takes several words");
});
