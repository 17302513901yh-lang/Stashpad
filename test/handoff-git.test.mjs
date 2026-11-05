import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBrief } from "../src/brief.mjs";
import { gitBinary, gitStatus, currentBranch } from "../src/git.mjs";
import { claimHandoff, createHandoff, listHandoffs } from "../src/handoff.mjs";
import { runHook } from "../src/hooks.mjs";
import { saveMemory } from "../src/store.mjs";

const hasGit = gitBinary() !== null;
const fresh = () => join(mkdtempSync(join(tmpdir(), "stashpad-hg-")), "s");

function repo() {
  const root = mkdtempSync(join(tmpdir(), "stashpad-repo-"));
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: root, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "app.js"), "console.log(1);\n");
  git("add", "app.js");
  git("commit", "-q", "-m", "first");
  git("checkout", "-q", "-b", "feature/login");
  writeFileSync(join(root, "app.js"), "console.log(2);\n");
  writeFileSync(join(root, "login.js"), "export {};\n");
  return { root, git };
}

function transcript(lines) {
  const file = join(mkdtempSync(join(tmpdir(), "stashpad-tr-")), "t.jsonl");
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

const ask = (text) => ({ type: "user", message: { role: "user", content: text } });

test("git is only found by an absolute path", () => {
  assert.equal(gitBinary({ PATH: ["relative/bin", ".", ""].join(process.platform === "win32" ? ";" : ":") }), null);
});

test("the automatic handoff names the branch and the uncommitted files", { skip: !hasGit && "git is not installed" }, () => {
  const { root } = repo();
  const dir = fresh();
  assert.equal(currentBranch(root), "feature/login");
  const status = gitStatus(root);
  assert.deepEqual(status.files.sort(), ["app.js", "login.js"]);
  runHook(dir, "pre-compact", { transcript_path: transcript([ask("Add the login form")]), cwd: root, trigger: "manual" });
  const [open] = listHandoffs(dir).handoffs;
  assert.equal(open.branch, "feature/login");
  const taken = claimHandoff(dir);
  assert.match(taken.text, /Branch: feature\/login/);
  assert.match(taken.text, /Uncommitted: (app\.js, login\.js|login\.js, app\.js)/);
});

test("a repository's fsmonitor setting cannot make the hook run a program", { skip: (process.platform === "win32" || !hasGit) && "needs git and a POSIX shell" }, () => {
  const { root, git } = repo();
  const marker = join(root, "ran.txt");
  const script = join(root, "monitor.sh");
  writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\n`);
  chmodSync(script, 0o755);
  git("config", "core.fsmonitor", script);
  assert.ok(gitStatus(root));
  assert.equal(existsSync(marker), false);
});

test("a session that never reached its end leaves a note at the next start, once", () => {
  const dir = fresh();
  saveMemory(dir, { id: "a", kind: "fact", text: "The store exists for this test.", sourceType: "user", sourceRef: "t" });
  const file = transcript([ask("Refactor the payment module into two files")]);
  runHook(dir, "session-start", { session_id: "s1", source: "startup", transcript_path: file });
  runHook(dir, "prompt", { session_id: "s1", prompt: "Refactor the payment module", transcript_path: file });
  // s1 crashes: no session-end. s2 starts.
  const start = runHook(dir, "session-start", { session_id: "s2", source: "startup" });
  assert.match(start, /Open handoff/);
  const taken = claimHandoff(dir);
  assert.match(taken.text, /previous session .* did not end cleanly/);
  assert.match(taken.text, /Refactor the payment module into two files/);
  runHook(dir, "session-start", { session_id: "s3", source: "startup" });
  assert.equal(listHandoffs(dir).handoffs.length, 0, "only once");

  // A session that ended cleanly leaves no such note.
  runHook(dir, "prompt", { session_id: "s4", prompt: "anything", transcript_path: file });
  runHook(dir, "session-end", { session_id: "s4", transcript_path: file });
  claimHandoff(dir); // the normal end-of-session note
  runHook(dir, "session-start", { session_id: "s5", source: "startup" });
  assert.equal(listHandoffs(dir).handoffs.length, 0);
  // The same session resuming is not "another" session.
  runHook(dir, "prompt", { session_id: "s6", prompt: "anything", transcript_path: file });
  runHook(dir, "session-start", { session_id: "s6", source: "resume" });
  assert.equal(listHandoffs(dir).handoffs.length, 0);
});

test("the brief says when the handoff was left on another branch", { skip: !hasGit && "git is not installed" }, () => {
  const { root, git } = repo();
  git("stash", "-u", "-q");
  git("checkout", "-q", "main");
  const dir = fresh();
  createHandoff(dir, { text: "Login form half done; next: validation.", branch: "feature/login" });
  assert.match(buildBrief(dir, { cwd: root }).text, /left on branch feature\/login; you are on main/);
  assert.throws(() => createHandoff(dir, { text: "x is a fine note", branch: "bad name" }), /branch/);
});

test("handoff leave --branch from the command line", async () => {
  const { run } = await import("../src/cli.mjs");
  const dir = fresh();
  const out = [];
  const io = { stdout: (s) => out.push(s), stderr: () => {}, env: {}, cwd: tmpdir(), readStdin: async () => "" };
  assert.equal(await run(["handoff", "leave", "--text", "Parser done; next: the lexer tests.", "--branch", "parser-work", "--dir", dir], io), 0);
  assert.equal(await run(["handoff", "list", "--dir", dir], io), 0);
  assert.match(out.join("\n"), /manual on parser-work/);
});
