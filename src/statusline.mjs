// "stashpad status-line": one short line for an agent app's status bar, for example
//   Stashpad · 42 memories · 3 to review · handoff open
// The review count is the point: it keeps what waits for a person in front of the person. It reads
// the app's status JSON on standard input (Claude Code sends the working folder), only counts files,
// and never fails: on any problem it prints just "Stashpad".
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { listHandoffs } from "./handoff.mjs";
import { hooksPaused } from "./hookswitch.mjs";
import { locateStore } from "./locate.mjs";

function count(folder, keep) {
  try {
    return readdirSync(folder).filter(keep).length;
  } catch {
    return 0;
  }
}

export function statusLine({ input = {}, cwd = process.cwd(), env = process.env, explicit = undefined, global = false } = {}) {
  try {
    const where = typeof input.workspace?.current_dir === "string" ? input.workspace.current_dir : typeof input.cwd === "string" ? input.cwd : cwd;
    const { dir } = locateStore({ cwd: where, env, explicit, global });
    if (!existsSync(dir)) return "Stashpad · no store here";
    const parts = ["Stashpad"];
    const memories = count(dir, (n) => n.endsWith(".md"));
    parts.push(`${memories} ${memories === 1 ? "memory" : "memories"}`);
    const waiting = count(join(dir, "pending"), (n) => n.endsWith(".md") || (n.startsWith("forget-") && n.endsWith(".json")));
    if (waiting > 0) parts.push(`${waiting} to review`);
    try {
      const open = listHandoffs(dir).handoffs.length;
      if (open > 0) parts.push(open === 1 ? "handoff open" : `${open} handoffs open`);
    } catch {
      // an encrypted store without its passphrase: the handoffs cannot be read here
    }
    if (hooksPaused(dir, env)) parts.push("hooks off");
    return parts.join(" · ");
  } catch {
    return "Stashpad";
  }
}
