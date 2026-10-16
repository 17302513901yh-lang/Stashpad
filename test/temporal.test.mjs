import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyTemporalInvalidation } from "../third_party/graphiti/temporal.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const memory = (id, valid_from, valid_to = null) => ({ id, valid_from, valid_to });

test("a newer fact that starts later ends the older one at its start", () => {
  const older = memory("old", "2026-01-01");
  const newer = memory("new", "2026-06-01");
  const invalidated = applyTemporalInvalidation(newer, [older]);
  assert.deepEqual(invalidated.map((m) => m.id), ["old"]);
  assert.equal(older.valid_to, "2026-06-01");
  assert.equal(newer.valid_to, null);
});

test("a candidate that starts later ends the newer fact instead", () => {
  const later = memory("later", "2026-09-01");
  const newer = memory("new", "2026-06-01");
  const invalidated = applyTemporalInvalidation(newer, [later]);
  assert.deepEqual(invalidated, []);
  assert.equal(newer.valid_to, "2026-09-01");
  assert.equal(later.valid_to, null);
});

test("with several later candidates, the earliest one ends the newer fact", () => {
  const far = memory("far", "2026-09-01");
  const near = memory("near", "2026-08-01");
  const newer = memory("new", "2026-06-01");
  applyTemporalInvalidation(newer, [far, near]);
  assert.equal(newer.valid_to, "2026-08-01");
});

test("an older fact that already ended before the newer one starts is left alone", () => {
  const ended = memory("ended", "2026-01-01", "2026-03-01");
  const newer = memory("new", "2026-06-01");
  assert.deepEqual(applyTemporalInvalidation(newer, [ended]), []);
  assert.equal(ended.valid_to, "2026-03-01");
});

test("a newer fact that already has an end date still ends an earlier fact that overlaps it", () => {
  const older = memory("old", "2026-01-01");
  const newer = memory("new", "2026-06-01", "2026-07-01");
  const invalidated = applyTemporalInvalidation(newer, [older]);
  assert.deepEqual(invalidated.map((m) => m.id), ["old"]);
  assert.equal(newer.valid_to, "2026-07-01");
});

test("facts without a start date are not compared", () => {
  const undated = memory("undated", null);
  const newer = memory("new", "2026-06-01");
  assert.deepEqual(applyTemporalInvalidation(newer, [undated]), []);
  assert.equal(undated.valid_to, null);
});

test("text that is not a date is refused", () => {
  const newer = memory("new", "last tuesday");
  assert.throws(() => applyTemporalInvalidation(newer, [memory("old", "2026-01-01")]), /not a date/);
});

test("the ported file keeps the Apache-2.0 notice and records what changed", () => {
  const text = readFileSync(join(here, "..", "third_party", "graphiti", "temporal.mjs"), "utf8");
  assert.match(text, /Ported from graphiti \(https:\/\/github\.com\/getzep\/graphiti\) at commit d50741d1/);
  assert.match(text, /Licensed under the Apache License, Version 2\.0/);
  assert.match(text, /Copyright 2024, Zep Software, Inc\./);
  assert.match(text, /Original file sha256: [0-9a-f]{64}/);
});
