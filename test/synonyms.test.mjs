import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveMemory, searchMemories } from "../src/store.mjs";
import { loadStoreSynonyms } from "../src/synonyms.mjs";
import { runDoctor } from "../src/doctor.mjs";

const fresh = () => join(mkdtempSync(join(tmpdir(), "stashpad-syn-")), "s");
const put = (dir, id, text) => saveMemory(dir, { id, kind: "fact", text, sourceType: "user", sourceRef: "t" });

test("a built-in synonym finds a note, and an exact word still ranks first", () => {
  const dir = fresh();
  put(dir, "exact", "The wachtwoord policy is reviewed every year.");
  put(dir, "other", "The password manager is shared by the team.");
  const ids = searchMemories(dir, "wachtwoord").results.map((r) => r.id);
  assert.deepEqual(ids, ["exact", "other"]);
});

test("German and French built-in synonyms find an English note (#4)", () => {
  const dir = fresh();
  put(dir, "pw", "The password manager is shared by the team.");
  put(dir, "db", "The database holds the production records.");
  put(dir, "err", "An error stopped the nightly build.");
  put(dir, "mem", "Keep a short memory of the decision.");
  // German
  assert.ok(searchMemories(dir, "Passwort").results.some((r) => r.id === "pw"));
  assert.ok(searchMemories(dir, "Datenbank").results.some((r) => r.id === "db"));
  assert.ok(searchMemories(dir, "Fehler").results.some((r) => r.id === "err"));
  // French
  assert.ok(searchMemories(dir, "erreur").results.some((r) => r.id === "err"));
  // Accents are folded by tokenize: "mémoire" and bare "memoire" both work.
  assert.ok(searchMemories(dir, "mémoire").results.some((r) => r.id === "mem"));
  assert.ok(searchMemories(dir, "memoire").results.some((r) => r.id === "mem"));
  // An unrelated word must not match through a synonym.
  assert.equal(searchMemories(dir, "zebra").results.length, 0);
});

test("a common French/Dutch word is not turned into a synonym by a phrase (#4)", () => {
  const dir = fresh();
  put(dir, "pw", "The password manager is shared by the team.");
  // "mot de passe" is three words; if it were added as one group member, "de"
  // would become a synonym of "password" and match this note. It must not.
  assert.equal(searchMemories(dir, "de").results.length, 0);
  assert.equal(searchMemories(dir, "mot").results.length, 0);
});

test("the store can add its own groups in synonyms.json", () => {
  const dir = fresh();
  put(dir, "ship", "Production uses blue green rollout every Tuesday.");
  assert.equal(searchMemories(dir, "deployment").results.length, 0);
  writeFileSync(join(dir, "synonyms.json"), JSON.stringify({ groups: [["deployment", "rollout"]] }));
  assert.deepEqual(searchMemories(dir, "deployment").results.map((r) => r.id), ["ship"]);
});

test("a broken synonyms file is ignored and reported by doctor", () => {
  const dir = fresh();
  put(dir, "a", "The project uses Node 20 for builds.");
  writeFileSync(join(dir, "synonyms.json"), "{not json");
  assert.equal(searchMemories(dir, "node").results.length, 1);
  assert.ok(loadStoreSynonyms(dir).problem);
  const check = runDoctor(dir).checks.find((c) => c.name === "synonyms");
  assert.equal(check.status, "warn");
});

test("synonyms do not make absent questions match", () => {
  const dir = fresh();
  put(dir, "a", "The project uses Node 20 for builds.");
  assert.equal(searchMemories(dir, "zebra").results.length, 0);
});
