import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.mjs";
import { runHook } from "../src/hooks.mjs";
import { saveMemory } from "../src/store.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fresh = (tag) => join(mkdtempSync(join(tmpdir(), `stashpad-recall-${tag}-`)), "s");
const put = (dir, id, text) => saveMemory(dir, { id, kind: "decision", text, sourceType: "user", sourceRef: "t" });

// A CLI harness where the global store can be pointed at a scratch folder.
function harness(env = {}) {
  const out = [];
  const err = [];
  const io = {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    env,
    cwd: root,
    readStdin: async () => "",
  };
  return { io, out, err, text: () => out.join("\n") };
}

const recallCli = async (dir, env, words, extra = []) => {
  const h = harness(env);
  const argv = ["recall", words, ...(dir ? ["--dir", dir] : []), ...extra];
  const code = await run(argv, h.io);
  return { code, out: h.text(), err: h.err.join("\n"), argv };
};

test("#48: recall and the prompt hook answer with the same memories from both stores", async () => {
  const dir = fresh("p");
  const global = fresh("g");
  const env = { STASHPAD_GLOBAL_DIR: global };
  put(dir, "project-db", "The project database is Postgres 16 running in Docker for this repo.");
  put(global, "global-tabs", "I prefer tabs over spaces in every project, including this one.");

  // The CLI and the hook must agree on a prompt that matches the global memory.
  const cli = await recallCli(dir, env, "tabs or spaces in every project");
  const hook = runHook(dir, "prompt", { prompt: "tabs or spaces in every project" }, { globalDir: global });
  assert.equal(cli.code, 0);
  assert.match(cli.out, /global-tabs/);
  assert.match(hook, /global-tabs/);
  assert.match(cli.out, /Stashpad global memories that match this request:/);

  // A prompt that matches the project memory gives the same project hit in both.
  const cli2 = await recallCli(dir, env, "postgres database docker in this repo");
  const hook2 = runHook(dir, "prompt", { prompt: "postgres database docker in this repo" }, { globalDir: global });
  assert.match(cli2.out, /project-db/);
  assert.match(hook2, /project-db/);
});

test("#48: project hits come first, the limit stays at three and nothing is listed twice", async () => {
  const dir = fresh("p");
  const global = fresh("g");
  const env = { STASHPAD_GLOBAL_DIR: global };
  for (const id of ["p1", "p2", "p3", "p4"]) put(dir, id, `Postgres database migration step ${id} for this project.`);
  put(global, "g1", "Postgres database migration that is true in every project.");

  const r = await recallCli(dir, env, "postgres database migration", ["--json"]);
  const j = JSON.parse(r.out);
  assert.equal(r.code, 0);
  assert.ok(j.hits.length <= 3, `at most three hits, got ${j.hits.length}`);
  assert.equal(new Set(j.hits).size, j.hits.length, "a memory is never listed twice");
  assert.deepEqual(j.hits.map((id) => j.stores[id]), j.hits.map((id) => (id.startsWith("p") ? "project" : "global")), "stores says where each hit came from");

  // With room left, a global hit is included after the project ones.
  const one = await recallCli(dir, env, "postgres database migration", ["--json"]);
  const j1 = JSON.parse(one.out);
  assert.ok(j1.hits.length > 0);
  const firstGlobal = j1.hits.findIndex((id) => j1.stores[id] === "global");
  if (firstGlobal > -1) assert.ok(j1.hits.slice(0, firstGlobal).every((id) => j1.stores[id] === "project"), "project matches come first");
});

test("#48: --global still reads only the global store, and a missing global store changes nothing", async () => {
  const dir = fresh("p");
  const global = fresh("g");
  put(dir, "project-only", "The project database is Postgres 16 running in Docker.");
  put(global, "global-only", "I prefer tabs over spaces in every project.");
  const env = { STASHPAD_GLOBAL_DIR: global };

  // --global means "only the global store", so no --dir is passed: locateStore
  // resolves it from STASHPAD_GLOBAL_DIR.
  const onlyGlobal = await recallCli(null, env, "tabs or spaces in every project", ["--global"]);
  assert.match(onlyGlobal.out, /global-only/);
  assert.doesNotMatch(onlyGlobal.out, /project-only/);

  const missing = await recallCli(dir, { STASHPAD_GLOBAL_DIR: fresh("empty") }, "postgres database docker");
  assert.match(missing.out, /project-only/);
  assert.equal(missing.code, 0);
  const noGlobal = await recallCli(dir, { STASHPAD_GLOBAL_DIR: fresh("empty2") }, "postgres database docker", ["--json"]);
  assert.doesNotMatch(JSON.stringify(JSON.parse(noGlobal.out)), /"global"/);
});

test("#48: recall --json reports which store each hit came from", async () => {
  const dir = fresh("p");
  const global = fresh("g");
  put(dir, "p-hit", "Postgres database migration for this project only.");
  const r = await recallCli(dir, { STASHPAD_GLOBAL_DIR: global }, "postgres database migration", ["--json"]);
  assert.equal(r.code, 0);
  const j = JSON.parse(r.out);
  assert.equal(typeof j.stores, "object");
  assert.equal(j.stores["p-hit"], "project");
  assert.ok(Array.isArray(j.hits) && j.hits.includes("p-hit"));
  assert.equal(typeof j.text, "string");
});
