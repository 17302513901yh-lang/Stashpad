import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateDocuments, validateMemory } from "../src/memory-format.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const examples = join(root, "examples", "memories");

const valid = `---
id: prefs-answer-length
kind: preference
created_at: 2026-09-10
valid_from: 2026-09-10
valid_to: null
supersedes: null
superseded_by: null
source_type: user
source_ref: example, user statement
trust: user-stated
last_confirmed_at: 2026-09-10
---
Prefers short answers.
`;

const check = (text, name = "prefs-answer-length") => validateMemory(text, name).errors;

test("example memory folder is valid", () => {
  const files = readdirSync(examples)
    .filter((name) => name.endsWith(".md"))
    .map((name) => ({ name, text: readFileSync(join(examples, name), "utf8") }));
  assert.ok(files.length >= 3);
  assert.deepEqual(validateDocuments(files), []);
});

test("a correct memory has no errors", () => {
  assert.deepEqual(check(valid), []);
});

test("a missing key is reported", () => {
  const text = valid.replace("trust: user-stated\n", "");
  assert.ok(check(text).includes("missing key: trust"));
});

test("an unknown key is rejected", () => {
  const text = valid.replace("last_confirmed_at: 2026-09-10\n", "last_confirmed_at: 2026-09-10\ncolor: blue\n");
  assert.ok(check(text).includes("unknown key: color"));
});

test("an agent cannot claim user-stated trust", () => {
  const text = valid.replace("source_type: user", "source_type: agent");
  assert.ok(check(text).some((e) => e.startsWith("trust must be")));
});

test("an impossible date is reported", () => {
  const text = valid.replace("valid_from: 2026-09-10", "valid_from: 2026-02-30");
  assert.ok(check(text).some((e) => e.startsWith("valid_from must be")));
});

test("valid_to before valid_from is reported", () => {
  const text = valid.replace("valid_to: null", "valid_to: 2026-01-01");
  assert.ok(check(text).includes("valid_to must not be before valid_from"));
});

test("the id must match the file name", () => {
  assert.ok(check(valid, "other-name").some((e) => e.startsWith('id "prefs-answer-length" must match')));
});

test("an empty body is reported", () => {
  const text = valid.replace("Prefers short answers.\n", "");
  assert.ok(check(text).includes("body must contain the memory text"));
});

test("superseded_by needs a valid_to date", () => {
  const text = valid.replace("superseded_by: null", "superseded_by: other-memory");
  assert.ok(check(text).includes("superseded_by is set, so valid_to must be a date"));
});

test("a reference to an unknown memory is reported", () => {
  const text = valid.replace("superseded_by: null", "superseded_by: missing-one").replace(
    "valid_to: null",
    "valid_to: 2026-10-01",
  );
  const problems = validateDocuments([{ name: "prefs-answer-length.md", text }]);
  assert.ok(problems.some((p) => p.message.includes('unknown id "missing-one"')));
});
