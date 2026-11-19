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

test("a usage error is two lines: the message and a pointer to --help (#71)", async () => {
  for (const [args, message] of [
    [["serch", "postgres"], /Unknown command "serch"/],
    [["frobnicate"], /Unknown command "frobnicate"/],
    [["feedback", "x", "--signal", "bad"], /signal must be one of/],
    [["forget", "db-choice"], /forget needs --reason/],
  ]) {
    const { io, err } = harness();
    assert.equal(await run(args, io), 2, `${args.join(" ")}: exit 2`);
    const lines = err.join("\n").split("\n");
    assert.equal(lines.length, 2, `${args.join(" ")}: message + one pointer line, not the whole help`);
    assert.match(lines[0], message, `${args.join(" ")}: the useful message`);
    assert.match(lines[1], /Run "stashpad --help" for all commands\./, `${args.join(" ")}: where the help is`);
    assert.doesNotMatch(err.join("\n"), /^Usage:/m, `${args.join(" ")}: no full help`);
  }
});

test("a typo suggests the closest command, an unrelated word does not (#71)", async () => {
  for (const [typo, expected] of [["serch", "search"], ["reveiw", "review"], ["snapshott", "snapshot"]]) {
    const { io, err } = harness();
    assert.equal(await run([typo], io), 2);
    assert.match(err.join("\n"), new RegExp(`Did you mean "${expected}"\\?`), `${typo}: suggests ${expected}`);
  }
  for (const word of ["frobnicate", "explode"]) {
    const { io, err } = harness();
    assert.equal(await run([word], io), 2);
    assert.doesNotMatch(err.join("\n"), /Did you mean/, `${word}: no suggestion when nothing is close`);
  }
});

test("--help and no command still print the full help (#71)", async () => {
  const help = harness();
  assert.equal(await run(["--help"], help.io), 0);
  assert.match(help.out.join("\n"), /^Usage:/m);
  assert.ok(help.out.join("\n").split("\n").length > 50, "the full help, not a pointer");
  const none = harness();
  assert.equal(await run([], none.io), 2);
  assert.match(none.err.join("\n"), /^Usage:/m);
  assert.ok(none.err.join("\n").split("\n").length > 50, "no command still prints the full help");
});

test("the suggestion list stays in step with the command switch (#71)", async () => {
  const { COMMANDS } = await import("../src/cli.mjs");
  const source = readFileSync(join(root, "src", "cli.mjs"), "utf8");
  const cases = [...source.matchAll(/^\s+case "([a-z-]+)":/gm)].map((m) => m[1]);
  assert.deepEqual(cases, COMMANDS, "every switch case is in COMMANDS, in the same order");
});

test("a wrong option value is a usage error, a store problem stays 1", async () => {
  const dir = freshDir();
  const cases = [
    [["feedback", "db-choice", "--signal", "bad", "--dir", dir], /signal must be one of/],
    [["handoff", "leave", "--text", "hi", "--expires-days", "abc", "--dir", dir], /expires-days must be a whole number/],
    [["list", "--kind", "bogus", "--dir", dir], /unknown kind/],
    [["search", "x", "--source-type", "bogus", "--dir", dir], /unknown source type/],
  ];
  for (const [args, message] of cases) {
    const { io, err } = harness();
    assert.equal(await run(args, io), 2, args.join(" "));
    assert.match(err.join("\n"), message);
  }
  const missing = harness();
  assert.equal(await run(["get", "nothing-here", "--dir", dir], missing.io), 1);
});

test("number options accept plain digits only, not what Number() coerces", async () => {
  const dir = freshDir();
  const cases = [
    [["ui", "--port", "", "--dir", dir], /--port must be a whole number/],
    [["ui", "--port", "1e1", "--dir", dir], /--port must be a whole number/],
    [["search", "x", "--limit", "0x5", "--dir", dir], /--limit must be a whole number/],
    [["entities", "--limit", " 3 ", "--dir", dir], /--limit must be a whole number/],
    [["brief", "--max-chars", "1e3", "--dir", dir], /--max-chars must be a whole number/],
    [["handoff", "leave", "--text", "hi", "--expires-days", "1e1", "--dir", dir], /expires-days must be a whole number/],
  ];
  for (const [args, message] of cases) {
    const { io, err } = harness();
    assert.equal(await run(args, io), 2, args.join(" "));
    assert.match(err.join("\n"), message);
  }
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

// #75 (part 1): accept, reject, confirm, pin, unpin and merge used to ignore
// --json and print a sentence instead. Each must now print one JSON object.
test("write commands print one JSON object with --json (#75)", async () => {
  const dir = freshDir();
  const runJson = async (args) => {
    const h = harness();
    assert.equal(await run([...args, "--json"], h.io), 0, `${args.join(" ")}: ${h.err.join("\n")}`);
    assert.equal(h.out.length, 1, `${args.join(" ")} prints one line on stdout`);
    return JSON.parse(h.out[0]);
  };

  // Two agent-written memories wait in pending/ until a person decides.
  assert.equal(await run(saveArgs(dir, "note-a", ["--source-type", "agent", "--text", "The build runs on Windows with Node 22."]), harness().io), 0);
  assert.equal(await run(saveArgs(dir, "note-b", ["--source-type", "agent", "--text", "Tests use the built-in node test runner."]), harness().io), 0);
  const accepted = await runJson(["accept", "note-a", "--dir", dir]);
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.id, "note-a");
  assert.ok(accepted.path);
  const rejected = await runJson(["reject", "note-b", "--dir", dir, "--reason", "old"]);
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.id, "note-b");
  assert.ok(rejected.path);

  assert.equal(await run(saveArgs(dir, "db-choice", ["--text", "We use PostgreSQL for the shared board."]), harness().io), 0);
  assert.equal(await run(saveArgs(dir, "cli-style", ["--text", "The command line prints one short line per answer."]), harness().io), 0);
  const confirmed = await runJson(["confirm", "db-choice", "--dir", dir]);
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.id, "db-choice");
  assert.equal(typeof confirmed.changed, "boolean"); // false when it was confirmed earlier today
  const pinned = await runJson(["pin", "db-choice", "--dir", dir]);
  assert.equal(pinned.status, "pinned");
  assert.equal(pinned.changed, true);
  assert.equal(pinned.count, 1);
  const unpinned = await runJson(["unpin", "db-choice", "--dir", dir]);
  assert.equal(unpinned.status, "unpinned");
  assert.equal(unpinned.changed, true);
  assert.equal(unpinned.count, 0);
  const merged = await runJson(["merge", "db-choice", "cli-style", "--dir", dir]);
  assert.equal(merged.status, "merged");
  assert.equal(merged.keep, "db-choice");
  assert.deepEqual(merged.ended, ["cli-style"]);

  // Without --json the sentences are unchanged.
  const plain = harness();
  assert.equal(await run(["pin", "db-choice", "--dir", dir], plain.io), 0);
  assert.match(plain.out.join("\n"), /^Pinned db-choice \(1 pinned\)\.$/m);
});

// #75 (part 2): the other write commands used to ignore --json and print a
// sentence (or two, for restore without --yes). Each must now print exactly
// one JSON object on stdout, with warnings still on stderr (#104 continues).
test("the remaining write commands print one JSON object with --json (#75)", async () => {
  const runJson = async (args, code = 0) => {
    const h = harness();
    assert.equal(await run([...args, "--json"], h.io), code,
      `${args.join(" ")}: ${h.err.join("\n")}`);
    assert.equal(h.out.length, 1, `${args.join(" ")} prints one line on stdout`);
    return { value: JSON.parse(h.out[0]), out: h.out, err: h.err };
  };

  // forget: an ending request is queued for a person to accept.
  const dir = freshDir();
  assert.equal(await run(saveArgs(dir, "old-fact"), harness().io), 0);
  const forgot = await runJson(["forget", "old-fact", "--dir", dir, "--reason", "outdated"]);
  assert.deepEqual(forgot.value, { status: "queued", id: "forget-old-fact", target: "old-fact" });
  // Without --json the sentence is unchanged (fresh store: only one request per id).
  const forgetPlainDir = freshDir();
  assert.equal(await run(saveArgs(forgetPlainDir, "old-fact"), harness().io), 0);
  const forgotPlain = harness();
  assert.equal(await run(["forget", "old-fact", "--dir", forgetPlainDir, "--reason", "outdated"], forgotPlain.io), 0);
  assert.match(forgotPlain.out.join("\n"), /^Asked for old-fact to end\. Accept it with: stashpad accept forget-old-fact$/);

  // handover: saved directly for a user note.
  const hand = await runJson(["handover", "--dir", dir, "--text", "Auth work is half done; next add tests."]);
  assert.equal(hand.value.status, "saved");
  assert.match(hand.value.id, /^handover-/);
  assert.ok(hand.value.path);

  // synonym add: a new group, then the same group (duplicate, no write).
  const syn = await runJson(["synonym", "add", "k8s", "kubernetes", "--dir", dir]);
  assert.deepEqual(syn.value, { status: "added", groups: 1 });
  const synDup = await runJson(["synonym", "add", "Kubernetes", "k8s", "--dir", dir]);
  assert.deepEqual(synDup.value, { status: "duplicate", groups: 1 });
  const synPlain = harness();
  assert.equal(await run(["synonym", "add", "pr", "pull-request", "--dir", dir], synPlain.io), 0);
  assert.match(synPlain.out.join("\n"), /^Added\. 2 synonym group\(s\) in this store\.$/);

  // snapshot and restore (dry-run first, then --yes).
  const snap = await runJson(["snapshot", "--dir", dir, "--label", "Before test"]);
  assert.equal(snap.value.status, "created");
  assert.match(snap.value.name, /-before-test$/);
  assert.equal(typeof snap.value.files, "number");
  const name = snap.value.name;
  const dry = await runJson(["restore", name, "--dir", dir]);
  assert.deepEqual(dry.value, { status: "dry-run", name });
  const restored = await runJson(["restore", name, "--dir", dir, "--yes"]);
  assert.equal(restored.value.status, "restored");
  assert.equal(restored.value.name, name);
  assert.equal(typeof restored.value.files, "number");
  assert.ok(restored.value.undo);
  const snapPlain = harness();
  assert.equal(await run(["snapshot", "--dir", dir, "--label", "Plain"], snapPlain.io), 0);
  assert.match(snapPlain.out.join("\n"), /^Snapshot .* files\)\. Put it back with:/);

  // import: one queued fact, two skipped (an ended item and a bad line).
  // The skipped warnings stay on stderr; stdout still has exactly one object.
  const file = join(dir, "export.jsonl");
  writeFileSync(file, [
    '{"id":"imp-a","kind":"fact","text":"An imported fact."}',
    '{"id":"imp-b","kind":"fact","text":"Ended.","valid_to":"2020-01-01"}',
    "not-json",
  ].join("\n"));
  const imp = await runJson(["import", file, "--dir", dir, "--format", "jsonl"]);
  assert.equal(imp.value.status, "queued");
  assert.equal(imp.value.queued, 1);
  assert.equal(imp.value.file, file);
  assert.equal(imp.value.skipped.length, 2);
  assert.ok(imp.value.skipped.every((s) => typeof s.id === "string" && typeof s.reason === "string"));
  assert.equal(imp.err.filter((l) => l.startsWith("skipped ")).length, 2);
  // Plain import into a fresh store (a second import of imp-a into `dir` would
  // be skipped as a duplicate, which is correct but not what this asserts).
  const impPlain = harness();
  assert.equal(await run(["import", file, "--dir", freshDir(), "--format", "jsonl"], impPlain.io), 0);
  assert.match(impPlain.out.join("\n"), /^Queued 1 memories for review from /);
});
