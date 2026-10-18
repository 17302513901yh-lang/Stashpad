import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.mjs";
import { runDoctor } from "../src/doctor.mjs";
import { saveMemory } from "../src/store.mjs";
import { MARKER } from "../src/safety.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fresh = () => join(mkdtempSync(join(tmpdir(), "stashpad-doc-")), "s");
const byName = (report, name) => report.checks.find((c) => c.name === name);

test("a healthy store and a missing store both pass", () => {
  const dir = fresh();
  assert.equal(runDoctor(dir).healthy, true);
  saveMemory(dir, { id: "a", kind: "fact", text: "The project uses Node 20.", sourceType: "user", sourceRef: "t" });
  const report = runDoctor(dir);
  assert.equal(report.healthy, true);
  assert.equal(byName(report, "self-test").status, "ok");
  assert.equal(byName(report, "memories").status, "ok");
});

test("an old Node version fails with a fix", () => {
  const report = runDoctor(fresh(), { nodeVersion: "v18.19.0" });
  assert.equal(report.healthy, false);
  assert.match(byName(report, "node").fix, /Node 20/);
});

test("a broken memory file, a missing marker and a too-new format are reported", () => {
  const dir = fresh();
  saveMemory(dir, { id: "a", kind: "fact", text: "The project uses Node 20.", sourceType: "user", sourceRef: "t" });
  writeFileSync(join(dir, "broken.md"), "no frontmatter here");
  const bad = runDoctor(dir);
  assert.equal(byName(bad, "memories").status, "fail");
  assert.equal(bad.healthy, false);

  rmSync(join(dir, "broken.md"));
  rmSync(join(dir, MARKER));
  rmSync(join(dir, ".stashpad-store.backup.json"), { force: true }); // a store from before markers has neither
  assert.equal(byName(runDoctor(dir), "format").status, "warn");

  writeFileSync(join(dir, MARKER), JSON.stringify({ format: 99 }));
  assert.equal(byName(runDoctor(dir), "format").status, "fail");
});

test("the CLI prints plain words and exit codes", async () => {
  const dir = fresh();
  const out = [];
  const io = { stdout: (s) => out.push(s), stderr: () => {}, env: {}, cwd: root, readStdin: async () => "" };
  assert.equal(await run(["doctor", "--dir", dir], io), 0);
  assert.match(out.join("\n"), /Nothing is broken\./);
});

test("a file system error becomes one clear line, not a stack trace", async () => {
  const err = [];
  const io = { stdout: () => {}, stderr: (s) => err.push(s), env: {}, cwd: root, readStdin: async () => "" };
  const code = await run(["import", join(tmpdir(), "does-not-exist-stashpad.jsonl"), "--dir", fresh()], io);
  assert.equal(code, 1);
  assert.match(err.join("\n"), /not found.*stashpad doctor/);
});
