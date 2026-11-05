import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.mjs";
import { buildBrief } from "../src/brief.mjs";
import { decisionBody, decisionId, decisionLine, parseDecision } from "../src/decisions.mjs";
import { handleMessage } from "../src/mcp.mjs";
import { parseMemory } from "../src/memory-format.mjs";
import { recall } from "../src/recall.mjs";
import { readMemory, saveMemory } from "../src/store.mjs";

const fresh = () => join(mkdtempSync(join(tmpdir(), "stashpad-decide-")), "s");

async function cli(...args) {
  const out = [];
  const err = [];
  const code = await run(args, { stdout: (s) => out.push(s), stderr: (s) => err.push(s), env: {}, cwd: tmpdir(), readStdin: async () => "" });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("the decision layout round-trips", () => {
  const body = decisionBody({ choice: "We use Postgres for the main database.", why: "several workers write at the same time", rejected: ["SQLite, MongoDB"], by: "the team" });
  assert.equal(body, "We use Postgres for the main database.\nWhy: several workers write at the same time\nRejected: SQLite, MongoDB\nDecided by: the team");
  assert.deepEqual(parseDecision(body), { choice: "We use Postgres for the main database.", why: "several workers write at the same time", rejected: ["SQLite", "MongoDB"], by: "the team" });
  assert.equal(decisionLine(body), "We use Postgres for the main database. (rejected: SQLite, MongoDB; why: several workers write at the same time)");
  assert.equal(parseDecision("Just a plain decision text."), null);
  assert.throws(() => decisionBody({ choice: "x", why: "two\nlines" }), /one line/);
  assert.equal(decisionId("We use Postgres, not SQLite!"), "decision-we-use-postgres-not-sqlite");
  assert.equal(decisionId("Ship on Friday", (id) => id === "decision-ship-on-friday"), "decision-ship-on-friday-2");
});

test("stashpad decide saves a decision memory with the fixed layout", async () => {
  const dir = fresh();
  const r = await cli("decide", "We use Postgres for the main database", "--why", "several workers write at the same time", "--rejected", "SQLite", "--rejected", "MongoDB", "--dir", dir);
  assert.equal(r.code, 0, r.err);
  const { meta, body } = parseMemory(readMemory(dir, "decision-we-use-postgres-for-the-main").text);
  assert.equal(meta.kind, "decision");
  assert.equal(meta.source_type, "user");
  assert.match(body, /^We use Postgres for the main database\nWhy: several workers write at the same time\nRejected: SQLite, MongoDB$/);
  assert.equal((await cli("decide", "We use Postgres for the main database", "--why", "again", "--dir", dir)).code, 0);
  readMemory(dir, "decision-we-use-postgres-for-the-main-2");
  assert.equal((await cli("decide", "No reason given", "--dir", dir)).code, 2);
  const agent = await cli("decide", "Tabs for indentation", "--why", "the linter wants them", "--id", "indent-style", "--source-type", "agent", "--source-ref", "lint config", "--dir", dir);
  assert.match(agent.out, /Queued indent-style for review/);
});

test("recall shows why and what lost, and a why question puts decisions first", () => {
  const dir = fresh();
  saveMemory(dir, { id: "db-choice", kind: "decision", text: decisionBody({ choice: "We use Postgres for the main database.", why: "several workers write at once", rejected: "SQLite" }), sourceType: "user", sourceRef: "t" });
  saveMemory(dir, { id: "db-host", kind: "fact", text: "The postgres server for the main database runs on the staging host.", sourceType: "user", sourceRef: "t" });
  assert.deepEqual(recall(dir, "move the reporting jobs over to sqlite").hits, ["db-choice"], "naming a rejected option is enough");
  const proposal = recall(dir, "switch the main database to sqlite");
  assert.match(proposal.text, /db-choice: We use Postgres for the main database\. \(rejected: SQLite; why: several workers write at once\)/);
  const why = recall(dir, "why did we pick postgres for the reporting service");
  assert.equal(why.hits[0], "db-choice", "the decision comes first");
  assert.deepEqual(recall(dir, "did we pick postgres for the reporting service").hits, [], "without a why word one shared word is not enough");
  assert.match(buildBrief(dir).text, /\[decision\] db-choice: We use Postgres for the main database\. \(rejected: SQLite; why:/);
});

test("stashpad_save takes why and rejected for a decision, and refuses them for other kinds", () => {
  const dir = fresh();
  saveMemory(dir, { id: "seed", kind: "fact", text: "A first note so the store exists.", sourceType: "user", sourceRef: "t" });
  const call = (args) => handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "stashpad_save", arguments: args } }, { dir }).result;
  const ok = call({ id: "queue-choice", kind: "decision", text: "Jobs run through the Redis queue.", source_ref: "planning notes", why: "retries come for free", rejected: ["cron", "a database table"] });
  assert.ok(!ok.isError, ok.content[0].text);
  assert.match(readFileSync(join(dir, "pending", "queue-choice.md"), "utf8"), /Jobs run through the Redis queue\.\nWhy: retries come for free\nRejected: cron, a database table/);
  const bad = call({ id: "not-a-decision", kind: "fact", text: "Something factual about the queue.", source_ref: "x", why: "because" });
  assert.equal(bad.isError, true);
});
