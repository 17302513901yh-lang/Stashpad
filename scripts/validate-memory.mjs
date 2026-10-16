// Checks every memory file (*.md) in a folder. Exit code 1 if anything is wrong.
// Usage: node scripts/validate-memory.mjs [folder]
// Default folder: examples/memories
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateDocuments } from "../src/memory-format.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const folder = process.argv[2] ?? join(root, "examples", "memories");

const files = readdirSync(folder)
  .filter((name) => name.endsWith(".md"))
  .map((name) => ({ name, text: readFileSync(join(folder, name), "utf8") }));

if (files.length === 0) {
  console.error(`No memory files (*.md) found in ${folder}. Check the folder path.`);
  process.exit(1);
}

const problems = validateDocuments(files);
if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`${problem.file}: ${problem.message}`);
  }
  console.error(`${problems.length} problem(s) found. Fix them and run the check again.`);
  process.exit(1);
}

console.log(`OK: ${files.length} memory file(s) valid in ${folder}`);
