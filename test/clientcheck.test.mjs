import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkClientLaunch, checkPathNode } from "../src/clientcheck.mjs";
import { run } from "../src/cli.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the server starts like an agent app starts it and lists its tools", async () => {
  const result = await checkClientLaunch({ dir: join(mkdtempSync(join(tmpdir(), "stashpad-cc-")), "s") });
  assert.equal(result.ok, true, result.detail + result.stderr);
  assert.ok(result.tools >= 6);
});

test("a wrong command gives a clear reason instead of a hang", async () => {
  const result = await checkClientLaunch({ nodePath: join(tmpdir(), "no-such-node-binary") });
  assert.equal(result.ok, false);
  assert.match(result.detail, /could not start|stopped/);
});

test("a server that crashes on start is reported with its error output", async () => {
  const result = await checkClientLaunch({ bin: join(root, "package.json") });
  assert.equal(result.ok, false);
});

test("node on PATH is checked", () => {
  assert.equal(checkPathNode().ok, true);
  assert.equal(checkPathNode({ PATH: "" }).ok, false);
});

test("doctor --client reports the client start", async () => {
  const out = [];
  const io = { stdout: (s) => out.push(s), stderr: () => {}, env: process.env, cwd: root, readStdin: async () => "" };
  assert.equal(await run(["doctor", "--client", "--dir", join(mkdtempSync(join(tmpdir(), "stashpad-cc-")), "s")], io), 0);
  assert.match(out.join("\n"), /client start: the server answered/);
});
