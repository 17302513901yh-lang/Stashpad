// Minimal build: checks the required legal files exist, then copies src to dist.
// Works the same on Windows, macOS and Linux (Node 20+, no dependencies).
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const required = [
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  join("third_party", "licenses"),
  join("src", "index.mjs"),
];

const missing = required.filter((p) => !existsSync(join(root, p)));
if (missing.length > 0) {
  console.error("Build stopped. Missing required files: " + missing.join(", "));
  process.exit(1);
}

const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(join(root, "src"), dist, { recursive: true });

console.log("Build OK: src copied to dist");
