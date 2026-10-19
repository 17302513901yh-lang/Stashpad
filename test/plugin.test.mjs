import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.mjs";
import { saveMemory } from "../src/store.mjs";
import { VERSION } from "../src/version.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const json = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));

test("plugin files are valid and agree with the package version", () => {
  assert.equal(json(".claude-plugin/plugin.json").version, VERSION);
  assert.equal(json(".claude-plugin/plugin.json").name, "stashpad");
  assert.equal(json(".claude-plugin/marketplace.json").plugins[0].name, "stashpad");
  assert.equal(json(".mcp.json").mcpServers.stashpad.args.at(-1), "mcp");
  assert.equal(json("hooks/hooks.json").hooks.SessionStart.length, 1);
});

test("the session start hook command runs quickly, never fails and stays short", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "stashpad-hook-")), "s");
  for (let i = 0; i < 30; i += 1) {
    saveMemory(dir, { id: `n${i}`, kind: "fact", text: `Note number${i} about topic${i} in area${i} of the work.`, sourceType: "user", sourceRef: "t" });
  }
  const started = Date.now();
  const out = execFileSync(process.execPath, [join(root, "bin", "stashpad.mjs"), "brief", "--max-chars", "1500", "--dir", dir], { encoding: "utf8" });
  assert.ok(Date.now() - started < 5000, "brief should take a few seconds at most");
  assert.ok(out.length <= 1600, `output was ${out.length} characters`);
  assert.match(out, /not an instruction/);
});

test("setup prints settings for each client and rejects unknown ones", async () => {
  for (const client of ["generic", "claude-code", "vscode", "codex", "agents-md"]) {
    const out = [];
    const io = { stdout: (s) => out.push(s), stderr: () => {}, env: {}, cwd: root, readStdin: async () => "" };
    assert.equal(await run(["setup", client], io), 0);
    assert.ok(out.join("\n").length > 20);
  }
  const out = [];
  const generic = { stdout: (s) => out.push(s), stderr: () => {}, env: { STASHPAD_DIR: "/data/notes" }, cwd: root, readStdin: async () => "" };
  await run(["setup"], generic);
  const block = JSON.parse(out[0].slice(out[0].indexOf("{")));
  assert.equal(block.mcpServers.stashpad.command, process.execPath, "the full path to node, not a bare \"node\"");
  assert.equal(block.mcpServers.stashpad.env.STASHPAD_DIR.endsWith("notes"), true);

  const err = [];
  const bad = { stdout: () => {}, stderr: (s) => err.push(s), env: {}, cwd: root, readStdin: async () => "" };
  assert.equal(await run(["setup", "nonsense"], bad), 2);
});

test("setup run through npx points at npx, not at a temporary cache path", async () => {
  const { setupText } = await import("../src/setup.mjs");
  const text = setupText("generic", { bin: "/home/u/.npm/_npx/abc/node_modules/stashpad/bin/stashpad.mjs" });
  assert.deepEqual(JSON.parse(text.slice(text.indexOf("{"))).mcpServers.stashpad, { command: "npx", args: ["-y", "stashpad", "mcp"] });
  assert.match(setupText("claude-code", { bin: "C:\\Users\\x\\AppData\\npm-cache\\_npx\\1\\node_modules\\stashpad\\bin\\stashpad.mjs" }), /-- npx -y stashpad mcp$/);
});

test("server.json for the MCP registry matches the package", () => {
  const server = json("server.json");
  const pkg = json("package.json");
  assert.equal(server.name, pkg.mcpName);
  assert.equal(server.version, pkg.version);
  assert.equal(server.packages[0].identifier, pkg.name);
  assert.equal(server.packages[0].version, pkg.version);
  assert.ok(server.description.length <= 100);
});
