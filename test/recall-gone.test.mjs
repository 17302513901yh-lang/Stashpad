import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveMemory, searchMemories } from "../src/store.mjs";
import { addAnchors } from "../src/anchors.mjs";
import { run } from "../src/cli.mjs";
import { recall, recallBoth } from "../src/recall.mjs";

test("recall fills available slots after skipping memories whose files are gone", async t => {
  const root = mkdtempSync(join(tmpdir(), "stashpad-recall-gone-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".git"));
  const dir = join(root, ".stashpad", "memories");
  const texts = [
    "Invoice billing uses decimal arithmetic for totals.",
    "Invoice billing accepts payments through a weekly batch.",
    "Invoice billing creates receipts after settlement.",
    "Invoice billing archives records for monthly reporting.",
  ];
  texts.forEach((text, i) => saveMemory(dir, { id: `billing-${i}`, kind: "fact", text, sourceType: "user", sourceRef: "synthetic test" }));
  const ranked = searchMemories(dir, "invoice billing", { limit: 10 }).results.map(r => r.id);
  assert.equal(ranked.length, 4);
  assert.deepEqual(recall(dir, "invoice billing", { cwd: root }).hits, ranked.slice(0, 3));
  assert.deepEqual(recall(dir, "invoice billing", { cwd: root, limit: 1 }).hits, ranked.slice(0, 1));
  for (const id of ranked.slice(0, 3)) {
    const file = `${id}.txt`;
    writeFileSync(join(root, file), `synthetic module ${id}\n`);
    addAnchors(dir, id, root, [file]);
    rmSync(join(root, file));
  }
  assert.deepEqual(recall(dir, "invoice billing", { cwd: root }).hits, [ranked[3]]);
  assert.deepEqual(recall(dir, "invoice billing", { cwd: root, limit: 0 }), { text: "", hits: [] });
  assert.deepEqual(recall(dir, "invoice billing", { cwd: root, checkFiles: false }).hits, ranked.slice(0, 3));
  assert.deepEqual(recall(dir, "invoice billing", { cwd: root, anchorMoves: false }).hits, ranked.slice(0, 3));
  const globalDir = join(root, "global");
  saveMemory(globalDir, { id: "global-billing", kind: "fact", text: "Invoice billing uses synthetic global defaults.", sourceType: "user", sourceRef: "synthetic test" });
  const combined = recallBoth(dir, "invoice billing", { cwd: root, globalDir, limit: 1 });
  assert.deepEqual(combined.hits, [ranked[3]]);
  assert.equal(combined.stores[ranked[3]], "project");
  const out = [], err = [];
  const code = await run(["recall", "invoice billing", "--dir", dir, "--json"], {
    cwd: root, env: { HOME: root, STASHPAD_GLOBAL_DIR: globalDir, STASHPAD_CONFIG_DIR: join(root, "config") },
    stdout: value => out.push(value), stderr: value => err.push(value), readStdin: async () => "",
  });
  assert.equal(code, 0);
  assert.deepEqual(err, []);
  const response = JSON.parse(out.join("\n"));
  assert.deepEqual(response.hits, [ranked[3], "global-billing"]);
  assert.equal(response.stores[ranked[3]], "project");
  assert.equal(response.stores["global-billing"], "global");
});
