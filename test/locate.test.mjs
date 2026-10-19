import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gitRoot, locateStore } from "../src/locate.mjs";
import { runHook } from "../src/hooks.mjs";
import { pinMemory } from "../src/pins.mjs";
import { saveMemory } from "../src/store.mjs";
import { run } from "../src/cli.mjs";

function project() {
  const root = mkdtempSync(join(tmpdir(), "stashpad-loc-"));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  // a worktree elsewhere, the way git makes one
  const wt = mkdtempSync(join(tmpdir(), "stashpad-wt-"));
  mkdirSync(join(root, ".git", "worktrees", "feature"), { recursive: true });
  writeFileSync(join(wt, ".git"), `gitdir: ${join(root, ".git", "worktrees", "feature")}\n`);
  mkdirSync(join(wt, "src"));
  return { root, wt };
}

test("a subfolder and a git worktree use the store of the main checkout", () => {
  const { root, wt } = project();
  const env = {};
  const store = join(root, ".stashpad", "memories");
  assert.equal(locateStore({ cwd: join(root, "src", "deep"), env }).dir, store);
  assert.equal(locateStore({ cwd: join(wt, "src"), env }).dir, store);
  assert.equal(gitRoot(wt), root);
});

test("an existing .stashpad folder nearer than the git root wins; explicit settings win over all", () => {
  const { root } = project();
  const pkg = join(root, "packages", "api");
  mkdirSync(join(pkg, ".stashpad", "memories"), { recursive: true });
  assert.equal(locateStore({ cwd: join(pkg), env: {} }).dir, join(pkg, ".stashpad", "memories"));
  assert.equal(locateStore({ cwd: pkg, env: { STASHPAD_DIR: "/x/y" } }).dir, resolve("/x/y"));
  assert.equal(locateStore({ cwd: pkg, env: { STASHPAD_DIR: "/x/y" }, explicit: "/a/b" }).dir, resolve("/a/b"));
  assert.equal(locateStore({ cwd: pkg, env: { STASHPAD_GLOBAL_DIR: "/g" }, global: true }).dir, resolve("/g"));
});

test("outside any project the current folder is used, and the CLI says why", async () => {
  const lone = mkdtempSync(join(tmpdir(), "stashpad-lone-"));
  const out = [];
  const io = { stdout: (s) => out.push(s), stderr: () => {}, env: {}, cwd: lone, readStdin: async () => "" };
  await run(["where"], io);
  assert.equal(out[0], join(lone, ".stashpad", "memories"));
  assert.match(out[1], /no project found|git project root/);
});

test("hooks add the global store: its pinned rules at start and its matches per prompt", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "stashpad-p-")), "s");
  const global = join(mkdtempSync(join(tmpdir(), "stashpad-g-")), "s");
  saveMemory(dir, { id: "db", kind: "decision", text: "This project uses Postgres for the database.", sourceType: "user", sourceRef: "t" });
  saveMemory(global, { id: "lang", kind: "preference", text: "Answer in Dutch with short sentences.", sourceType: "user", sourceRef: "t" });
  saveMemory(global, { id: "commits", kind: "preference", text: "Commit messages in English, imperative mood, no session links.", sourceType: "user", sourceRef: "t" });
  pinMemory(global, "lang");
  const start = runHook(dir, "session-start", {}, { globalDir: global });
  assert.match(start, /db:/);
  assert.match(start, /Global store \(all projects\):[\s\S]*lang: Answer in Dutch/);
  const prompt = runHook(dir, "prompt", { prompt: "write the commit messages for these changes" }, { globalDir: global });
  assert.match(prompt, /commits/);
  assert.equal(runHook(dir, "session-start", {}, { globalDir: "/no/such/global" }).includes("Global store"), false);
});
