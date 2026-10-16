import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLicense, portFile, PortError } from "../scripts/port-lib.mjs";

const NOTICES = [
  "# Third-party notices",
  "",
  "**Status: no third-party code has been included yet.**",
  "",
  "| Project | Source URL | Commit | License | Copyright holder | Stashpad files derived from it |",
  "|---|---|---|---|---|---|",
  "| _(none yet)_ | | | | | |",
  "",
].join("\n");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "stashpad-port-"));
  mkdirSync(join(root, "third_party", "licenses"), { recursive: true });
  writeFileSync(join(root, "THIRD_PARTY_NOTICES.md"), NOTICES);
  const upstream = mkdtempSync(join(tmpdir(), "stashpad-upstream-"));
  const source = join(upstream, "validity.py");
  const license = join(upstream, "LICENSE");
  writeFileSync(source, "# Copyright 2025 Example\n\ndef valid(x):\n    return x\n");
  writeFileSync(license, "Apache License 2.0 (test copy)\n");
  return { root, source, license };
}

function base(f, overrides = {}) {
  return {
    root: f.root,
    project: "example",
    sourceUrl: "https://github.com/example/example",
    commit: "1a2b3c4d",
    license: "Apache-2.0",
    copyright: "Copyright 2025 Example",
    upstreamPath: "src/validity.py",
    sourceFile: f.source,
    dest: "example/validity.mjs",
    licenseFile: f.license,
    modifiedNote: "ported to JavaScript, names kept",
    today: "2026-10-16",
    ...overrides,
  };
}

test("copyleft and unclear licenses are refused", () => {
  for (const license of ["AGPL-3.0", "GPL-3.0-only", "LGPL-2.1", "SSPL-1.0", "BUSL-1.1", "", "Custom"]) {
    assert.throws(() => checkLicense(license), PortError, `should refuse ${license}`);
  }
  assert.equal(checkLicense("MIT"), "MIT");
  assert.equal(checkLicense(" BSD-3-Clause "), "BSD-3-Clause");
});

test("a refused license reads and writes nothing", () => {
  const f = fixture();
  assert.throws(() => portFile(base(f, { license: "AGPL-3.0", dest: "example/nope.mjs" })), /AGPL|copyleft/);
  assert.equal(existsSync(join(f.root, "third_party", "example", "nope.mjs")), false);
  assert.equal(readFileSync(join(f.root, "THIRD_PARTY_NOTICES.md"), "utf8"), NOTICES);
});

test("an allowed file gets a provenance header, its license text, a notice row and a log line", () => {
  const f = fixture();
  const result = portFile(base(f));
  const ported = readFileSync(join(f.root, "third_party", "example", "validity.mjs"), "utf8");
  assert.match(ported, /^\/\/ Ported from example \(https:\/\/github.com\/example\/example\) at commit 1a2b3c4d\./);
  assert.match(ported, /Original file: src\/validity\.py\. License: Apache-2\.0/);
  assert.match(ported, /Modified for Stashpad: ported to JavaScript/);
  assert.match(ported, /# Copyright 2025 Example/);
  assert.equal(result.licenseText, "third_party/licenses/example-Apache-2.0.txt");
  assert.equal(existsSync(join(f.root, "third_party", "licenses", "example-Apache-2.0.txt")), true);

  const notices = readFileSync(join(f.root, "THIRD_PARTY_NOTICES.md"), "utf8");
  assert.doesNotMatch(notices, /none yet/);
  assert.match(notices, /third-party code is included/);
  assert.match(notices, /\| example \| https:\/\/github.com\/example\/example \| 1a2b3c4d \| Apache-2.0 \| Copyright 2025 Example \| `example\/validity.mjs` \|/);

  const log = readFileSync(join(f.root, "third_party", "provenance.jsonl"), "utf8").trim();
  assert.deepEqual(JSON.parse(log), {
    project: "example",
    source_url: "https://github.com/example/example",
    commit: "1a2b3c4d",
    license: "Apache-2.0",
    upstream_path: "src/validity.py",
    dest: "example/validity.mjs",
    date: "2026-10-16",
  });
});

test("a second file from the same project is added to the same notice row", () => {
  const f = fixture();
  portFile(base(f));
  portFile(base(f, { dest: "example/second.mjs", upstreamPath: "src/second.py" }));
  const notices = readFileSync(join(f.root, "THIRD_PARTY_NOTICES.md"), "utf8");
  const rows = notices.split("\n").filter((line) => line.startsWith("| example |"));
  assert.equal(rows.length, 1);
  assert.match(rows[0], /`example\/validity\.mjs`, `example\/second\.mjs`/);
});

test("paths that leave third_party/ are refused", () => {
  const f = fixture();
  for (const dest of ["../escape.mjs", "/etc/x.mjs", "C:\\x.mjs", "example/../../x.mjs"]) {
    assert.throws(() => portFile(base(f, { dest })), /must be a relative path/, dest);
  }
});

test("bad project names, non-https URLs and bad commits are refused", () => {
  const f = fixture();
  assert.throws(() => portFile(base(f, { project: "Bad Name" })), /lowercase slug/);
  assert.throws(() => portFile(base(f, { sourceUrl: "http://example.com/x" })), /https/);
  assert.throws(() => portFile(base(f, { commit: "main" })), /hex hash/);
});

test("a file is never overwritten", () => {
  const f = fixture();
  portFile(base(f));
  assert.throws(() => portFile(base(f)), /already exists/);
});

test("missing provenance fields are refused and named", () => {
  const f = fixture();
  assert.throws(() => portFile(base(f, { copyright: "" })), /missing copyright/);
});
