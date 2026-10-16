import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.mjs";
import { bm25Rank, tokenize } from "../src/search.mjs";
import { saveMemory } from "../src/store.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const examples = join(root, "examples", "memories");

// 20 test memories on distinct topics. Each query below should rank its expected memory first.
const NOTES = [
  ["ui-theme-dark", "The user prefers a dark color theme in all tools."],
  ["db-sqlite", "The project stores its index in SQLite with full text search."],
  ["db-markdown", "Markdown files are the source of truth for every memory."],
  ["deploy-npm", "Packages are published to npm under the stashpad name."],
  ["deploy-registry", "The server is listed in the official MCP registry after release."],
  ["lang-node", "The tool is written in Node 20 without runtime dependencies."],
  ["lang-python", "An older prototype was written in Python with Chroma."],
  ["security-stdio", "The MCP server runs over stdio and opens no network port."],
  ["security-secrets", "A secret scanner blocks API keys before they are saved."],
  ["review-pending", "Agent writes land in a pending folder until a person accepts them."],
  ["eval-harness", "An evaluation command reruns the benchmark on the user's own data."],
  ["eval-models", "Every published score records the model and the seed used."],
  ["port-licenses", "Code under AGPL licenses must never be copied into the project."],
  ["port-attribution", "Ported files keep the original copyright header and a modified note."],
  ["agent-skill", "A SKILL.md file teaches agents how to use the tool."],
  ["agent-guide", "AGENTS.md gives a short summary of commands for coding agents."],
  ["user-language", "The user wants answers in simple Dutch."],
  ["user-editor", "The example project uses a video editor called Example Studio."],
  ["token-budget", "Retrieval returns at most a fixed token budget per call."],
  ["token-profile", "A small profile of a few hundred tokens is always loaded first."],
];

const QUERIES = [
  ["dark theme", "ui-theme-dark"],
  ["sqlite index", "db-sqlite"],
  ["published npm name", "deploy-npm"],
  ["secret scanner API keys", "security-secrets"],
  ["pending accept", "review-pending"],
  ["stdio network port", "security-stdio"],
  ["AGPL copied", "port-licenses"],
  ["SKILL.md", "agent-skill"],
  ["Python prototype", "lang-python"],
  ["Dutch", "user-language"],
  ["token budget", "token-budget"],
  ["model seed score", "eval-models"],
  ["Node", "lang-node"],
];

function freshDirWithNotes() {
  const dir = mkdtempSync(join(tmpdir(), "stashpad-search-"));
  for (const [id, body] of NOTES) {
    saveMemory(dir, {
      id,
      kind: "fact",
      text: body,
      sourceType: "user",
      sourceRef: "search test fixture",
    }, "2026-10-01");
  }
  return dir;
}

function harness() {
  const out = [];
  const err = [];
  const io = {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    env: {},
    cwd: root,
    readStdin: async () => "",
  };
  return { io, out, err };
}

test("tokenize splits on non-letters, lowercases and drops one-letter words", () => {
  assert.deepEqual(tokenize("A Dark-theme, in SQLite!"), ["dark", "theme", "in", "sqlite"]);
});

test("the expected memory ranks first for each query in the set of 20", async () => {
  const dir = freshDirWithNotes();
  for (const [query, expected] of QUERIES) {
    const { io, out } = harness();
    assert.equal(await run(["search", query, "--dir", dir, "--json"], io), 0);
    const results = JSON.parse(out[0]);
    assert.ok(results.length > 0, `no results for "${query}"`);
    assert.equal(results[0].id, expected, `query "${query}" ranked ${results[0].id} first`);
  }
});

test("a word that matches nothing reports 0 of N searched", async () => {
  const dir = freshDirWithNotes();
  const { io, out } = harness();
  assert.equal(await run(["search", "zebra", "--dir", dir], io), 0);
  assert.match(out[0], /^0 of 20 searched: no matches for "zebra"/);
});

test("an empty query is a usage error", async () => {
  const dir = freshDirWithNotes();
  const { io, err } = harness();
  assert.equal(await run(["search", "--dir", dir], io), 2);
  assert.match(err.join("\n"), /search needs words/);
});

test("--limit caps the number of results", async () => {
  const dir = freshDirWithNotes();
  const { io, out } = harness();
  assert.equal(await run(["search", "token", "--limit", "1", "--json", "--dir", dir], io), 0);
  assert.equal(JSON.parse(out[0]).length, 1);
});

test("an invalid --limit is a usage error", async () => {
  const dir = freshDirWithNotes();
  const { io, err } = harness();
  assert.equal(await run(["search", "token", "--limit", "0", "--dir", dir], io), 2);
  assert.match(err.join("\n"), /--limit must be/);
});

test("ended memories are hidden unless --all is given", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stashpad-ended-"));
  cpSync(examples, dir, { recursive: true });

  const hidden = harness();
  assert.equal(await run(["search", "JSON", "--json", "--dir", dir], hidden.io), 0);
  assert.deepEqual(JSON.parse(hidden.out[0]), []);

  const shown = harness();
  assert.equal(await run(["search", "JSON", "--all", "--json", "--dir", dir], shown.io), 0);
  assert.equal(JSON.parse(shown.out[0])[0].id, "db-choice-v1");
});

test("bm25Rank gives no results for a query without matching terms", () => {
  assert.deepEqual(bm25Rank([{ id: "a", text: "hello world" }], "zebra"), []);
  assert.deepEqual(bm25Rank([{ id: "a", text: "hello world" }], "!!"), []);
});
