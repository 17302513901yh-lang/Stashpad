// CI helper: runs the tests and turns each failing test into one GitHub annotation with its error,
// so failures on a platform we cannot run locally (Windows) are readable from the run page.
import { spawnSync } from "node:child_process";

const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const lines = `${run.stdout}\n${run.stderr}`.split("\n");
let shown = 0;
for (let i = 0; i < lines.length && shown < 10; i += 1) {
  const m = /^\s*not ok \d+ - (.*)$/.exec(lines[i]);
  if (!m) continue;
  const detail = [];
  for (let j = i + 1; j < Math.min(lines.length, i + 40); j += 1) {
    if (/^\s*(not )?ok \d+ /.test(lines[j])) break;
    if (/error:|expected|actual|location|code:/.test(lines[j])) detail.push(lines[j].trim());
  }
  console.log(`::error::${m[1]} :: ${detail.join(" | ").slice(0, 900)}`);
  shown += 1;
}
if (shown === 0) console.log("no failing tests found in this run");
