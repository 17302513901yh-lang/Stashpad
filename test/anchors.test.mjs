import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.mjs";
import { handleMessage } from "../src/mcp.mjs";
import { buildBrief } from "../src/brief.mjs";
import { lint } from "../src/feedback.mjs";
import { recall } from "../src/recall.mjs";
import { anchorContext, blobHash, checkAnchors, cleanPath, locate, projectRoot, readAnchors, readAnchorsFile } from "../src/anchors.mjs";
import { existsSync } from "node:fs";
import { acceptPending, readMemory, rejectPending } from "../src/store.mjs";

// A project folder with its store in .stashpad/memories, so paths are relative to the project.
function project() {
  const root = mkdtempSync(join(tmpdir(), "stashpad-anchor-"));
  const dir = join(root, ".stashpad", "memories");
  mkdirSync(join(root, "src", "billing"), { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, "src", "billing", "tax.ts"), "export const VAT = 21;\n");
  writeFileSync(join(root, "src", "billing", "rates.ts"), "export const RATES = [];\n");
  return { root, dir };
}

function harness(cwd) {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s), env: {}, cwd, readStdin: async () => "" } };
}

async function cli(cwd, ...args) {
  const h = harness(cwd);
  const code = await run(args, h.io);
  return { code, out: h.out.join("\n"), err: h.err.join("\n") };
}

const mcp = (dir, name, args) => handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { dir }).result;

test("the hash is git's blob id, the same for CRLF and LF text", () => {
  const lf = Buffer.from("line one\nline two\n");
  const crlf = Buffer.from("line one\r\nline two\r\n");
  assert.equal(blobHash(lf), blobHash(crlf));
  // Known value: git hash-object of "line one\nline two\n".
  const root = mkdtempSync(join(tmpdir(), "stashpad-blob-"));
  writeFileSync(join(root, "f.txt"), lf);
  let fromGit = null;
  try {
    fromGit = execFileSync("git", ["hash-object", join(root, "f.txt")], { encoding: "utf8" }).trim();
  } catch {
    // no git here; the LF/CRLF check above still ran
  }
  if (fromGit) assert.equal(blobHash(lf), fromGit);
  const binary = Buffer.from([0, 13, 10, 1]);
  assert.notEqual(blobHash(binary), blobHash(Buffer.from([0, 10, 1])), "binary files are not changed");
});

test("stored paths are checked strictly", () => {
  for (const bad of ["/etc/passwd", "../outside.txt", "src/../../x", "C:/Windows/x", "\\\\server\\share\\x", "~/x", ".git/config", "src/nul", "a\u0000b", ""]) {
    assert.equal(cleanPath(bad), null, bad);
  }
  assert.equal(cleanPath("src\\billing\\tax.ts"), "src/billing/tax.ts");
  assert.equal(cleanPath("./src//billing/"), "src/billing/");
});

test("a link that points out of the project is never read", () => {
  const { root } = project();
  const outside = mkdtempSync(join(tmpdir(), "stashpad-outside-"));
  writeFileSync(join(outside, "secret.txt"), "not yours\n");
  symlinkSync(join(outside, "secret.txt"), join(root, "src", "link.txt"));
  assert.match(locate(root, "src/link.txt").refused, /outside the project/);
});

test("a person's save with --files is anchored; recall and the brief say when the file changed; confirm re-anchors", async () => {
  const { root, dir } = project();
  const saved = await cli(join(root, "src"), "save", "tax-rules", "--kind", "fact", "--source-type", "user", "--source-ref", "t", "--text", "The VAT rules for invoices live in the billing tax module.", "--files", "billing/tax.ts");
  assert.equal(saved.code, 0, saved.err);
  assert.equal(projectRoot(dir), root);
  assert.deepEqual(Object.keys(readAnchors(dir)["tax-rules"]), ["src/billing/tax.ts"], "stored relative to the project");
  assert.doesNotMatch(readMemory(dir, "tax-rules").text, /billing\/tax\.ts/, "the memory file keeps its format");

  assert.doesNotMatch(recall(dir, "where are the VAT invoices rules", { cwd: root }).text, /changed since/);
  writeFileSync(join(root, "src", "billing", "tax.ts"), "export const VAT = 9;\n");
  assert.match(recall(dir, "where are the VAT invoices rules", { cwd: root }).text, /tax-rules: .*\(changed since saved: src\/billing\/tax\.ts\)/);
  assert.match(buildBrief(dir, { cwd: root }).text, /changed since saved/);
  assert.equal(lint(dir, { cwd: root }).findings.find((f) => f.id === "tax-rules").rule, "anchor-changed");

  const confirmed = await cli(root, "confirm", "tax-rules");
  assert.match(confirmed.out, /Re-anchored tax-rules/);
  assert.doesNotMatch(recall(dir, "where are the VAT invoices rules", { cwd: root }).text, /changed since/);
  assert.equal(lint(dir, { cwd: root }).findings.filter((f) => f.rule.startsWith("anchor")).length, 0);
});

test("a moved file is followed, a gone file skips the memory, and lint says what to do", async () => {
  const { root, dir } = project();
  await cli(root, "save", "rates", "--kind", "fact", "--source-type", "user", "--source-ref", "t", "--text", "Exchange rates for invoices come from the rates module.", "--files", "src/billing/rates.ts");
  mkdirSync(join(root, "lib"));
  renameSync(join(root, "src", "billing", "rates.ts"), join(root, "lib", "rates.ts"));
  assert.match(recall(dir, "exchange rates invoices", { cwd: root }).text, /moved: src\/billing\/rates\.ts -> lib\/rates\.ts/);
  const listed = await cli(root, "anchors", "--changed");
  assert.match(listed.out, /moved\s+src\/billing\/rates\.ts -> lib\/rates\.ts/);

  await cli(root, "confirm", "rates");
  assert.deepEqual(Object.keys(readAnchors(dir).rates), ["lib/rates.ts"], "confirm follows the move");

  rmSync(join(root, "lib", "rates.ts"));
  assert.equal(recall(dir, "exchange rates invoices", { cwd: root }).hits.length, 0, "a memory about a gone file is skipped");
  assert.match(buildBrief(dir, { cwd: root }).text, /1 skipped because the files they are about are gone/);
  assert.equal(lint(dir, { cwd: root }).findings.find((f) => f.id === "rates").rule, "anchor-gone");
});

test("a folder anchor notices an added file", async () => {
  const { root, dir } = project();
  const r = await cli(root, "save", "billing-map", "--kind", "fact", "--source-type", "user", "--source-ref", "t", "--text", "Everything about invoices and billing lives in one folder.", "--files", "src/billing");
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(Object.keys(readAnchors(dir)["billing-map"]), ["src/billing/"]);
  assert.equal(checkAnchors(dir, "billing-map").changed, false);
  writeFileSync(join(root, "src", "billing", "refunds.ts"), "export {};\n");
  assert.equal(checkAnchors(dir, "billing-map").files[0].state, "changed");
});

test("an agent can only ask for files: they are read when a person accepts, and dropped on reject", async () => {
  const { root, dir } = project();
  await cli(root, "save", "seed", "--kind", "fact", "--source-type", "user", "--source-ref", "t", "--text", "A first note so the store exists.");
  const proposed = mcp(dir, "stashpad_save", { id: "tax-note", kind: "fact", text: "Invoice VAT is computed in the billing tax module only.", source_ref: "read the code", files: ["src/billing/tax.ts"] });
  assert.ok(!proposed.isError, proposed.content[0].text);
  assert.deepEqual(readAnchorsFile(dir).requested["tax-note"], ["src/billing/tax.ts"]);
  assert.equal(readAnchors(dir)["tax-note"], undefined, "nothing read yet");
  assert.match((await cli(root, "review")).out, /files \(read and anchored on accept\): src\/billing\/tax\.ts/);
  acceptPending(dir, "tax-note");
  assert.ok(readAnchors(dir)["tax-note"]["src/billing/tax.ts"]);
  assert.equal(readAnchorsFile(dir).requested["tax-note"], undefined);
  assert.equal(JSON.parse(mcp(dir, "stashpad_get", { id: "tax-note" }).content[0].text).files[0].state, "same");

  assert.match(mcp(dir, "stashpad_save", { id: "bad", kind: "fact", text: "This one names a path outside the project.", source_ref: "x", files: ["../../etc/passwd"] }).content[0].text, /not a usable project path/);
  mcp(dir, "stashpad_save", { id: "other-note", kind: "fact", text: "Refund rules are kept next to the billing rates.", source_ref: "x", files: ["src/billing/rates.ts"] });
  rejectPending(dir, "other-note", "not checked");
  assert.equal(readAnchorsFile(dir).requested["other-note"], undefined);
});

test("anchor, unanchor and a tampered anchors file", async () => {
  const { root, dir } = project();
  await cli(root, "save", "tax-rules", "--kind", "fact", "--source-type", "user", "--source-ref", "t", "--text", "The VAT rules for invoices live in the billing tax module.");
  assert.equal((await cli(root, "anchor", "tax-rules", "src/billing/tax.ts", "src/billing/rates.ts")).code, 0);
  assert.equal(Object.keys(readAnchors(dir)["tax-rules"]).length, 2);
  assert.equal((await cli(root, "anchor", "tax-rules", "/etc/passwd")).code, 1);
  assert.equal((await cli(root, "unanchor", "tax-rules", "src/billing/rates.ts")).code, 0);
  assert.deepEqual(Object.keys(readAnchors(dir)["tax-rules"]), ["src/billing/tax.ts"]);
  // Someone edits anchors.json to point at a file outside the project: it is ignored, never read.
  const file = join(dir, "anchors.json");
  const data = JSON.parse(readFileSync(file, "utf8"));
  data.anchors["tax-rules"]["../../../../etc/passwd"] = "0".repeat(40);
  writeFileSync(file, JSON.stringify(data));
  assert.deepEqual(Object.keys(readAnchors(dir)["tax-rules"]), ["src/billing/tax.ts"]);
  assert.equal((await cli(root, "unanchor", "tax-rules")).code, 0);
  assert.equal(readAnchors(dir)["tax-rules"], undefined);
});

test("checks read a bounded number of bytes, cache hashes, and skip build folders when looking for moves", async () => {
  const { root, dir } = project();
  await cli(root, "save", "tax", "--kind", "fact", "--source-type", "user", "--source-ref", "t", "--text", "VAT rules for invoices live in the tax module.", "--files", "src/billing/tax.ts");
  assert.equal(readAnchorsFile(dir).sizes.tax["src/billing/tax.ts"], "export const VAT = 21;\n".length, "the size is stored with the anchor");
  // Nothing may be read: the file is reported as not checked instead of read anyway.
  const capped = checkAnchors(dir, "tax", { root, context: anchorContext(root, { maxBytes: 0 }) });
  assert.equal(capped.files[0].state, "refused");
  assert.match(capped.files[0].reason, /not checked: more than 50 MB/);
  // A normal check fills the hash cache; after that an unchanged file needs no read at all.
  assert.equal(checkAnchors(dir, "tax", { root }).files[0].state, "same");
  assert.ok(existsSync(join(dir, ".sessions", "anchor-hashes.json")));
  const cached = anchorContext(root, { maxBytes: 0 });
  assert.equal(checkAnchors(dir, "tax", { root, context: cached }).files[0].state, "same");
  assert.equal(cached.bytesRead, 0);
  // Moved under a different name, the same content is found by size; inside dist/ it is not looked for.
  mkdirSync(join(root, "lib"));
  renameSync(join(root, "src", "billing", "tax.ts"), join(root, "lib", "vat.ts"));
  assert.deepEqual(checkAnchors(dir, "tax", { root }).files[0], { path: "src/billing/tax.ts", state: "moved", to: "lib/vat.ts" });
  mkdirSync(join(root, "dist"));
  renameSync(join(root, "lib", "vat.ts"), join(root, "dist", "tax.ts"));
  assert.equal(checkAnchors(dir, "tax", { root }).files[0].state, "gone");
});

test("the hooks do not look for moved files: a missing file is named, the memory is not hidden", async () => {
  const { root, dir } = project();
  await cli(root, "save", "rates", "--kind", "fact", "--source-type", "user", "--source-ref", "t", "--text", "Exchange rates for invoices come from the rates module.", "--files", "src/billing/rates.ts");
  rmSync(join(root, "src", "billing", "rates.ts"));
  const quick = recall(dir, "exchange rates invoices", { cwd: root, anchorMoves: false });
  assert.equal(quick.hits.length, 1);
  assert.match(quick.text, /missing here \(run stashpad anchors to look for a move\): src\/billing\/rates\.ts/);
  assert.equal(recall(dir, "exchange rates invoices", { cwd: root }).hits.length, 0, "a full check still finds it gone");
});

test("a read error during the move search does not lose the other anchor states; confirm drops what it cannot anchor", async () => {
  const { root, dir } = project();
  await cli(root, "save", "billing", "--kind", "fact", "--source-type", "user", "--source-ref", "t", "--text", "Billing uses the tax and rates modules together.", "--files", "src/billing/tax.ts,src/billing/rates.ts");
  mkdirSync(join(root, "lib"));
  renameSync(join(root, "src", "billing", "rates.ts"), join(root, "lib", "rates.ts"));
  const context = anchorContext(root);
  const real = context.fileHash;
  context.fileHash = (abs) => {
    if (abs.endsWith("rates.ts")) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    return real(abs);
  };
  const status = checkAnchors(dir, "billing", { root, context });
  assert.deepEqual(status.files.map((f) => f.state), ["same", "moved-changed"]);

  // Same content under a name a stored path may not have (":" cannot be in a Windows file name at all).
  if (process.platform === "win32") return;
  renameSync(join(root, "lib", "rates.ts"), join(root, "lib", "rat:es.txt"));
  assert.equal(checkAnchors(dir, "billing", { root }).files[1].state, "gone");
  const confirmed = await cli(root, "confirm", "billing");
  assert.equal(confirmed.code, 0, confirmed.err);
  assert.deepEqual(Object.keys(readAnchors(dir).billing), ["src/billing/tax.ts"]);
});

test("in a git worktree the worktree's own files count, also with the store in the main checkout", () => {
  const { root: main, dir } = project();
  mkdirSync(join(main, ".git", "worktrees", "feature"), { recursive: true });
  const tree = mkdtempSync(join(tmpdir(), "stashpad-worktree-"));
  writeFileSync(join(tree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "feature")}\n`);
  mkdirSync(join(tree, "src"));
  assert.equal(projectRoot(dir, join(tree, "src")), tree);
  assert.equal(projectRoot(dir, main), main);
  assert.equal(projectRoot(join(tree, "elsewhere"), join(tree, "src")), tree, "a store outside the project uses the worktree too");
});

test("global-store memories cannot be anchored; old anchors there are not reported as gone", async () => {
  const { root } = project();
  const global = mkdtempSync(join(tmpdir(), "stashpad-global-"));
  const h = harness(root);
  h.io.env = { STASHPAD_GLOBAL_DIR: global };
  const code = await run(["save", "g", "--global", "--kind", "fact", "--source-type", "user", "--source-ref", "t", "--text", "Tabs are never used in any of my projects.", "--files", "src/billing/tax.ts"], h.io);
  assert.equal(code, 1);
  assert.match(h.err.join("\n"), /global store cannot be anchored to files/);
  assert.equal(existsSync(join(global, "g.md")), false, "nothing is saved");
  writeFileSync(join(global, "anchors.json"), JSON.stringify({ anchors: { g: { "src/gone.ts": "0".repeat(40) } }, requested: {} }));
  assert.equal(checkAnchors(global, "g", { root, env: { STASHPAD_GLOBAL_DIR: global } }), null);
  process.env.STASHPAD_GLOBAL_DIR = global;
  try {
    const reply = mcp(global, "stashpad_save", { id: "g2", kind: "fact", text: "Tabs are never used in any project here.", source_ref: "t", files: ["src/billing/tax.ts"] });
    assert.equal(reply.isError, true);
    assert.match(reply.content[0].text, /global store cannot be anchored to files/);
  } finally {
    delete process.env.STASHPAD_GLOBAL_DIR;
  }
});
