import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveMemory, acceptPending } from "../src/store.mjs";
import { lastShown, logShown } from "../src/shown.mjs";
import { lint } from "../src/feedback.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "stashpad-shown-id-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "store");
}

test("a constructor memory has numeric shown counts across summary reloads", (t) => {
  const dir = fixture(t);
  saveMemory(dir, { id: "constructor", kind: "fact", text: "The synthetic parser builds syntax trees.", sourceType: "user", sourceRef: "synthetic fixture" });
  const now = new Date("2027-05-20T10:00:00Z");
  logShown(dir, { event: "cli get", ids: ["constructor"], now });
  assert.equal(lastShown(dir).count.constructor, 1);
  logShown(dir, { event: "cli get", ids: ["constructor"], now });
  assert.equal(lastShown(dir).count.constructor, 2);
});

test("lint reports an unseen constructor memory just like other valid ids", (t) => {
  const dir = fixture(t);
  for (const id of ["constructor", "unused-note"]) {
    saveMemory(dir, { id, kind: "fact", text: id === "constructor" ? "The synthetic parser builds syntax trees." : "Synthetic deployment runs each Tuesday afternoon.", sourceType: "agent", sourceRef: "synthetic fixture" }, "2026-01-01");
    acceptPending(dir, id);
  }
  logShown(dir, { event: "prompt", ids: [], now: new Date("2026-11-01T10:00:00Z") });
  const ids = () => lint(dir, { today: "2027-06-01" }).findings.filter((f) => f.rule === "never-shown").map((f) => f.id).sort();
  assert.deepEqual(ids(), ["constructor", "unused-note"]);
  logShown(dir, { event: "prompt", ids: ["constructor"], now: new Date("2027-05-20T10:00:00Z") });
  assert.deepEqual(ids(), ["unused-note"]);
});
