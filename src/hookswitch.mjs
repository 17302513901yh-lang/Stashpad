// "stashpad hooks off|on": pause the hooks for one project without uninstalling anything. The list
// lives in the config folder of this computer (~/.stashpad/hooks-off.json, or $STASHPAD_CONFIG_DIR),
// never in the repository, so a commit cannot switch someone's hooks on or off. While paused the hook
// commands print nothing and write nothing; the command line and the MCP server keep working.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeAtomic } from "./fsx.mjs";
import { configDir } from "./locate.mjs";

export const HOOKS_OFF_FILE = "hooks-off.json";

function readList(env) {
  const path = join(configDir(env), HOOKS_OFF_FILE);
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(data.off) ? data.off.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

export function hooksPaused(dir, env = process.env) {
  return readList(env).includes(resolve(dir));
}

export function setHooksPaused(dir, off, env = process.env) {
  const key = resolve(dir);
  const list = readList(env).filter((p) => p !== key);
  if (off) list.push(key);
  const folder = configDir(env);
  mkdirSync(folder, { recursive: true });
  writeAtomic(join(folder, HOOKS_OFF_FILE), `${JSON.stringify({ off: list.sort() }, null, 2)}\n`);
  return { store: key, hooks: off ? "off" : "on", file: join(folder, HOOKS_OFF_FILE) };
}
