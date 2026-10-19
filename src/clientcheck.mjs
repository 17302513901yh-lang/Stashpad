// "stashpad doctor --client": starts the MCP server the way an agent app does (the exact command
// that "stashpad setup" prints, a fresh process, a small environment, another working folder) and
// talks to it: initialize, then tools/list. This catches the usual "server does not connect"
// causes before the user has to dig through an app's logs.
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { binPath, launcher } from "./setup.mjs";

const TIMEOUT_MS = 15_000;

// Is a plain "node" on PATH, and is it new enough? Configs and hooks that say just "node" depend on it.
export function checkPathNode(env = process.env) {
  const result = spawnSync("node", ["--version"], { env, encoding: "utf8", shell: process.platform === "win32" });
  if (result.error || result.status !== 0) {
    return { ok: false, detail: '"node" is not found on PATH', fix: 'Use the full path that "stashpad setup" prints, or add Node 20+ to PATH.' };
  }
  const version = result.stdout.trim();
  const major = Number(version.replace(/^v/, "").split(".")[0]);
  return major >= 20
    ? { ok: true, detail: `"node" on PATH is ${version}` }
    : { ok: false, detail: `"node" on PATH is ${version}, too old`, fix: 'Install Node 20+, or use the full path that "stashpad setup" prints.' };
}

// Runs the server and checks it answers. Resolves to { ok, ms, tools, detail, fix, stderr }.
export function checkClientLaunch({ dir = null, bin = binPath(), nodePath = process.execPath, env = process.env } = {}) {
  const run = launcher(bin, nodePath);
  const childEnv = { PATH: env.PATH ?? "", SystemRoot: env.SystemRoot, HOME: env.HOME, USERPROFILE: env.USERPROFILE, APPDATA: env.APPDATA };
  if (dir) childEnv.STASHPAD_DIR = dir;
  if (env.STASHPAD_PASSPHRASE) childEnv.STASHPAD_PASSPHRASE = env.STASHPAD_PASSPHRASE;
  if (env.STASHPAD_KEY_FILE) childEnv.STASHPAD_KEY_FILE = env.STASHPAD_KEY_FILE;
  for (const key of Object.keys(childEnv)) if (childEnv[key] === undefined) delete childEnv[key];

  const started = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(run.command, run.args, { cwd: tmpdir(), env: childEnv, stdio: ["pipe", "pipe", "pipe"], shell: run.command === "npx" && process.platform === "win32" });
    } catch (error) {
      resolve({ ok: false, ms: 0, tools: 0, detail: `could not start: ${error.message}`, fix: "Check that the command in the settings exists." });
      return;
    }
    let out = "";
    let err = "";
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve({ ...result, ms: Date.now() - started, stderr: err.trim().slice(0, 800) });
    };
    const timer = setTimeout(
      () => finish({ ok: false, tools: 0, detail: `no answer within ${TIMEOUT_MS / 1000} seconds`, fix: "The server started but did not answer. Run the command by hand to see why." }),
      TIMEOUT_MS,
    );
    child.on("error", (error) =>
      finish({ ok: false, tools: 0, detail: `could not start "${run.command}": ${error.code ?? error.message}`, fix: 'The command in the settings is not found. Use "stashpad setup" to print the right one.' }),
    );
    child.on("exit", (code) => {
      if (!done) finish({ ok: false, tools: 0, detail: `the server stopped (exit code ${code})`, fix: "See the error output below." });
    });
    child.stderr.on("data", (d) => (err += d));
    child.stdout.on("data", (d) => {
      out += d;
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          finish({ ok: false, tools: 0, detail: "the server printed something that is not MCP", fix: "Nothing but MCP messages may go to standard output." });
          return;
        }
        if (msg.id === 2 && msg.result?.tools) finish({ ok: true, tools: msg.result.tools.length, detail: `answered with ${msg.result.tools.length} tools` });
        if (msg.error) finish({ ok: false, tools: 0, detail: `the server answered with an error: ${msg.error.message}`, fix: "See the error output below." });
      }
      out = out.slice(out.lastIndexOf("\n") + 1);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "stashpad-doctor", version: "1" } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  });
}
