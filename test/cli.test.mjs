import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, existsSync } from "node:fs";
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
