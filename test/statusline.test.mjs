import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.mjs";
import { findHookWiring, runDoctor } from "../src/doctor.mjs";
import { createHandoff } from "../src/handoff.mjs";
import { hooksPaused } from "../src/hookswitch.mjs";
import { statusLine } from "../src/statusline.mjs";
import { saveMemory } from "../src/store.mjs";

// A project with its store, and a separate config folder standing in for ~/.stashpad.
function project() {
  const root = mkdtempSync(join(tmpdir(), "stashpad-status-"));
  const dir = join(root, ".stashpad", "memories");
  mkdirSync(dir, { recursive: true });
  const config = mkdtempSync(join(tmpdir(), "stashpad-config-"));
  return { root, dir, env: { STASHPAD_CONFIG_DIR: config, STASHPAD_GLOBAL_DIR: join(config, "global") }, config };
}

async function cli(cwd, env, args, stdin = "") {
  const out = [];
  const err = [];
  const io = { stdout: (s) => out.push(s), stderr: (s) => err.push(s), env, cwd, stdinIsTTY: false, readStdin: async () => stdin };
  const code = await run(args, io);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("the status line counts memories, waiting reviews and open handoffs, and never fails", async () => {
  const { root, dir, env } = project();
  assert.equal(statusLine({ cwd: mkdtempSync(join(tmpdir(), "stashpad-empty-")), env: {} }), "Stashpad · no store here");
  saveMemory(dir, { id: "a", kind: "fact", text: "The build runs on Node 22 in CI.", sourceType: "user", sourceRef: "t" });
  saveMemory(dir, { id: "b", kind: "fact", text: "An agent thinks the tests run in parallel.", sourceType: "agent", sourceRef: "t" });
  createHandoff(dir, { text: "Half done; next: the tests." });
  assert.equal(statusLine({ cwd: root, env }), "Stashpad · 1 memory · 1 to review · handoff open");
  const r = await cli(tmpdir(), env, ["status-line"], JSON.stringify({ session_id: "x", workspace: { current_dir: join(root, "sub") } }));
  assert.equal(r.code, 0);
  assert.equal(r.out, "Stashpad · 1 memory · 1 to review · handoff open");
  assert.equal((await cli(root, env, ["status-line"], "not json")).out, "Stashpad · 1 memory · 1 to review · handoff open");
});

test("hooks off pauses the hooks for one project, stored outside the repository", async () => {
  const { root, dir, env, config } = project();
  saveMemory(dir, { id: "db", kind: "fact", text: "The project database is Postgres 16 running in Docker.", sourceType: "user", sourceRef: "t" });
  const event = JSON.stringify({ session_id: "s1", prompt: "postgres database docker", cwd: root });
  assert.match((await cli(root, env, ["hook", "prompt"], event)).out, /db:/);
  assert.equal((await cli(root, env, ["hooks", "off"])).code, 0);
  assert.ok(existsSync(join(config, "hooks-off.json")));
  assert.equal(existsSync(join(root, "hooks-off.json")) || existsSync(join(dir, "hooks-off.json")), false);
  assert.equal(hooksPaused(dir, env), true);
  const quiet = await cli(root, env, ["hook", "prompt"], JSON.stringify({ session_id: "s2", prompt: "postgres database docker", cwd: root }));
  assert.equal(quiet.out, "");
  assert.equal((await cli(root, env, ["hook", "session-start"], JSON.stringify({ session_id: "s2" }))).out, "");
  assert.match(statusLine({ cwd: root, env }), /hooks off$/);
  assert.match((await cli(root, env, ["hooks"])).out, /Hooks are off/);
  assert.equal((await cli(root, env, ["search", "postgres"])).code, 0, "the command line keeps working");
  await cli(root, env, ["hooks", "on"]);
  assert.match((await cli(root, env, ["hook", "prompt"], JSON.stringify({ session_id: "s3", prompt: "postgres database docker", cwd: root }))).out, /db:/);
  assert.equal((await cli(root, env, ["hooks", "maybe"])).code, 2);
});

test("doctor says whether hooks are wired, and when they are off", () => {
  const { root, dir, env } = project();
  const home = mkdtempSync(join(tmpdir(), "stashpad-home-"));
  assert.deepEqual(findHookWiring({ cwd: root, home }), []);
  let check = runDoctor(dir, { cwd: root, home, env }).checks.find((c) => c.name === "hooks");
  assert.equal(check.status, "ok");
  assert.match(check.fix, /plugin/);

  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "stashpad@stashpad": true } }));
  mkdirSync(join(root, ".codex"), { recursive: true });
  writeFileSync(join(root, ".codex", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ command: "/usr/bin/node /opt/stashpad/bin/stashpad.mjs hook session-start" }] } }));
  const found = findHookWiring({ cwd: root, home });
  assert.ok(found.some((f) => /Claude Code plugin/.test(f)));
  assert.ok(found.includes("hooks in .codex/hooks.json"));
  check = runDoctor(dir, { cwd: root, home, env }).checks.find((c) => c.name === "hooks");
  assert.match(check.detail, /^wired: /);

  return cli(root, env, ["hooks", "off"]).then(() => {
    check = runDoctor(dir, { cwd: root, home, env }).checks.find((c) => c.name === "hooks");
    assert.equal(check.status, "warn");
    assert.match(check.fix, /stashpad hooks on/);
  });
});

test("setup prints the Claude Code status line setting", async () => {
  const r = await cli(tmpdir(), {}, ["setup", "claude-code", "--status-line"]);
  assert.equal(r.code, 0);
  const json = JSON.parse(r.out.slice(r.out.indexOf("{"), r.out.lastIndexOf("}") + 1));
  assert.equal(json.statusLine.type, "command");
  assert.match(json.statusLine.command, /stashpad\.mjs"? status-line$/);
  assert.equal((await cli(tmpdir(), {}, ["setup", "codex", "--status-line"])).code, 2);
});
