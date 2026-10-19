// File writes that never leave a half-written file. A temp file is written and then renamed over
// the target. On Windows a rename fails for a moment when another process (a reader, a virus
// scanner, the search indexer) has the target open, so it is retried briefly.
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const RETRY = new Set(["EPERM", "EACCES", "EBUSY"]);
const pause = new Int32Array(new SharedArrayBuffer(4));

export function writeAtomic(path, content) {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temp, content, { flag: "wx" });
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(temp, path);
      return;
    } catch (error) {
      if (!RETRY.has(error.code) || attempt >= 20) {
        rmSync(temp, { force: true });
        throw error;
      }
      Atomics.wait(pause, 0, 0, 10 * (attempt + 1));
    }
  }
}

// A plain move (no new content), retried the same way.
export function moveFile(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      if (!RETRY.has(error.code) || attempt >= 20) throw error;
      Atomics.wait(pause, 0, 0, 10 * (attempt + 1));
    }
  }
}
