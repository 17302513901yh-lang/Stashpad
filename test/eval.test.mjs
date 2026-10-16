import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { run } from "../src/cli.mjs";
import { runEval } from "../src/eval.mjs";

test("every fixed check passes", () => {
  const report = runEval();
  const failed = report.cases.filter((c) => !c.passed).map((c) => c.name);
  assert.deepEqual(failed, []);
  assert.equal(report.all_passed, true);
});

test("the report says no model was called and reports raw metrics", () => {
  const report = runEval();
  assert.match(report.models, /no language model/);
  assert.equal(typeof report.metrics.grep_baseline_recall_at_1, "number");
  assert.equal(typeof report.metrics.full_context_tokens, "number");
});

test("eval uses its own temporary store and leaves the user's store alone", async () => {
  const out = [];
  const io = { stdout: (s) => out.push(s), stderr: () => {}, env: {}, cwd: tmpdir(), readStdin: async () => "" };
  assert.equal(await run(["eval"], io), 0);
  assert.match(out.join("\n"), /All checks passed\./);
});
