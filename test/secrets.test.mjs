import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimHandoff, listHandoffs } from "../src/handoff.mjs";
import { runHook } from "../src/hooks.mjs";
import { findSecrets, isSecretName, localSecretValues, redactSecrets, resetLocalSecrets } from "../src/security.mjs";
import { saveMemory } from "../src/store.mjs";

const fresh = () => join(mkdtempSync(join(tmpdir(), "stashpad-secret-")), "s");
// Fake values, put together at run time so no file in the repository holds a key-shaped string.
const fake = (...parts) => parts.join("");
const AZ = "abcdefghijklmnopqrstuvwxyz";

test("more provider key shapes are refused", () => {
  const samples = {
    "Anthropic API key": fake("sk-", "ant-api03-", AZ),
    "Stripe restricted key": fake("rk_", "live_", "ABCDEFGHIJKLMNOP1234"),
    "Stripe webhook secret": fake("whsec_", AZ),
    "GitLab token": fake("glpat-", "ABCDEFGHIJKLMNOPQRST12"),
    "npm token": fake("npm_", AZ, "0123456789"),
    "Hugging Face token": fake("hf_", AZ, "ABCDE"),
    "Google OAuth access token": fake("ya29", ".", "a0AfH6SMB", AZ),
    "SendGrid API key": fake("SG", ".", "abcdefghijklmnopqr", ".", AZ),
    "Slack webhook URL": fake("https://hooks", ".slack.com/services/", "T0123ABC/B0456DEF/", AZ),
    "connection string with a password": "redis://default:" + "hunter22hunter" + "@cache.internal:6379",
    "password on a command line": "mysql -u root -p" + "S3cretPass db",
    "password in a sentence": "for the record my password is " + "Tr0ub4dor&3x",
  };
  for (const [name, sample] of Object.entries(samples)) {
    assert.ok(findSecrets(`note: ${sample} here`).includes(name), `${name}: ${findSecrets(sample)}`);
  }
  assert.ok(findSecrets("curl -u bob:" + "pa55word https://example.org").includes("password on a command line"));
  assert.ok(findSecrets("start it with --password=" + "Sup3rSecret").length > 0);
});

test("ordinary text about passwords, ports and placeholders is not flagged", () => {
  for (const plain of [
    "The password is required on the sign-up form.",
    "Our password is stored as a bcrypt hash, never in plain text.",
    "docker run -p8080:80 app starts the web server.",
    "mysql -p asks for the password interactively.",
    "Pass it as --password $DB_PASS from the environment.",
    "Use --password <your-password> in the example.",
    "Fork_live_updates is a feature flag name.",
  ]) {
    assert.deepEqual(findSecrets(plain), [], plain);
  }
});

test("values this computer holds in secret-named variables are refused, without being stored or shown", () => {
  const value = fake("zq8", "-local-", "value-77Kx");
  process.env.STASHPAD_TEST_SERVICE_TOKEN = value;
  process.env.STASHPAD_TEST_AUTHOR_NAME = "Somebody Example";
  resetLocalSecrets();
  try {
    const dir = fresh();
    assert.throws(
      () => saveMemory(dir, { id: "leak", kind: "fact", text: `Call the service with ${value} as the header.`, sourceType: "user", sourceRef: "t" }),
      (error) => /STASHPAD_TEST_SERVICE_TOKEN/.test(error.message) && !error.message.includes(value),
    );
    saveMemory(dir, { id: "ok", kind: "fact", text: "Somebody Example reviews the release notes.", sourceType: "user", sourceRef: "t" });
    assert.ok(!readdirSync(dir).includes("leak.md"));
  } finally {
    delete process.env.STASHPAD_TEST_SERVICE_TOKEN;
    delete process.env.STASHPAD_TEST_AUTHOR_NAME;
    resetLocalSecrets();
  }
  assert.equal(isSecretName("GITHUB_TOKEN"), true);
  assert.equal(isSecretName("DB_PASSWORD"), true);
  assert.equal(isSecretName("GIT_AUTHOR_NAME"), false);
  assert.equal(isSecretName("AWS_ACCESS_KEY_ID"), false);
  assert.equal(isSecretName("SSH_AUTH_SOCK"), false);
});

test("the project's .env files count, .env.example does not, and paths and plain words are skipped", () => {
  const cwd = mkdtempSync(join(tmpdir(), "stashpad-envfile-"));
  writeFileSync(join(cwd, ".env"), ["# local", "export API_KEY=" + fake("live", "-value-", "9f8e7d6c"), 'DB_PASSWORD="' + fake("quoted ", "pass phrase") + '"', "NODE_ENV=production", "CACHE_DIR=/var/cache/app", "PORT=3000"].join("\n"));
  writeFileSync(join(cwd, ".env.example"), "STRIPE_SECRET=" + fake("example", "-not-real-1234") + "\n");
  const values = localSecretValues({ env: {}, cwd }).map((v) => v.label);
  assert.deepEqual(values.sort(), [".env API_KEY", ".env DB_PASSWORD"]);
  resetLocalSecrets();
});

test("the automatic handoff masks a secret and keeps the request", () => {
  const dir = fresh();
  saveMemory(dir, { id: "a", kind: "fact", text: "The store exists for this test.", sourceType: "user", sourceRef: "t" });
  const secret = fake("sk-", "abcdefghijklmnopqrstuvwxyz123456");
  const file = join(mkdtempSync(join(tmpdir(), "stashpad-tr-")), "t.jsonl");
  writeFileSync(file, `${JSON.stringify({ type: "user", message: { role: "user", content: `Deploy the API with key ${secret} to staging` } })}\n`);
  runHook(dir, "session-end", { transcript_path: file });
  const stored = JSON.stringify(listHandoffs(dir, { all: true }));
  assert.ok(!stored.includes(secret));
  const taken = claimHandoff(dir);
  assert.match(taken.text, /Deploy the API with key \[REDACTED\] to staging/);
  assert.match(taken.text, /1 secret\(s\) masked/);
  const raw = readdirSync(join(dir, "handoffs")).map((n) => readFileSync(join(dir, "handoffs", n), "utf8")).join("");
  assert.match(raw, /"redacted": 1/);
  const r = redactSecrets("DB_PASSWORD=hunter2hunter2 and Bearer abcdefghijklmnop1234");
  assert.equal(r.text, "DB_PASSWORD=[REDACTED] and Bearer [REDACTED]");
  assert.equal(r.count, 2);
  assert.deepEqual(findSecrets(r.text), [], "a masked text passes the check");
});
