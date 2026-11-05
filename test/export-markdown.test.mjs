import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.mjs";
import { saveMemory } from "../src/store.mjs";

const fresh = () => mkdtempSync(join(tmpdir(), "stashpad-export-md-"));
function harness() {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s), env: {}, cwd: tmpdir(), readStdin: async () => "" } };
}

test("export --format markdown writes current entries first and ended entries in their own section", async () => {
  const store = join(fresh(), "store");
  saveMemory(store, { id: "old-note", kind: "fact", text: "The old train route.", sourceType: "user", sourceRef: "chat" }, "2026-01-01");
  saveMemory(store, { id: "new-note", kind: "decision", text: "Take the new train route.\nEvery weekday.", sourceType: "user", sourceRef: "planning chat", supersedes: "old-note" }, "2026-05-01");

  const current = harness();
  assert.equal(await run(["export", "--format", "markdown", "--dir", store], current.io), 0);
  assert.match(current.out[0], /^# Stashpad export\n\n## new-note/m);
  assert.match(current.out[0], /- Kind: decision\n- Valid from: 2026-05-01\n- Valid to: current\n- Source: user: planning chat\n\nTake the new train route\.\nEvery weekday\./);
  assert.doesNotMatch(current.out[0], /old-note/);

  const all = harness();
  assert.equal(await run(["export", "--format", "markdown", "--all", "--dir", store], all.io), 0);
  assert.ok(all.out[0].indexOf("## new-note") < all.out[0].indexOf("## Ended memories"));
  assert.match(all.out[0], /## Ended memories\n\n### old-note\n- Kind: fact\n- Valid from: 2026-01-01\n- Valid to: 2026-05-01\n- Source: user: chat\n\nThe old train route\./);
});
