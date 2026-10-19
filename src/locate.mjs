// Which store a command uses. Agents start in different folders (a subfolder, a git worktree, the
// project root), and a store that depends on the exact starting folder splits memory into many
// empty stores. So the store belongs to the project, found from where the command runs:
//   1. --dir                                    (explicit)
//   2. STASHPAD_DIR                             (explicit)
//   3. the nearest folder above with .stashpad/memories in it
//   4. the git project root (for a git worktree: the main checkout, so all worktrees share it)
//   5. the current folder                       (no project found)
// The global store (--global) holds what is true in every project: STASHPAD_GLOBAL_DIR, or
// ~/.stashpad/global.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, isAbsolute } from "node:path";

const STORE = join(".stashpad", "memories");

function isDir(path) {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

// The main checkout of a git project, or null. Handles a worktree, whose .git is a file that points
// to <main>/.git/worktrees/<name>.
export function gitRoot(start) {
  let current = resolve(start);
  for (;;) {
    const marker = join(current, ".git");
    if (existsSync(marker)) {
      if (isDir(marker)) return current;
      try {
        const line = readFileSync(marker, "utf8").trim();
        const match = /^gitdir:\s*(.+)$/m.exec(line);
        if (match) {
          const gitdir = isAbsolute(match[1]) ? match[1] : resolve(current, match[1]);
          const parts = gitdir.split(/[\\/]+/);
          const at = parts.lastIndexOf("worktrees");
          if (at > 0 && parts[at - 1] === ".git") return dirname(resolve(gitdir, "..", ".."));
        }
      } catch {
        // unreadable .git file: treat this folder as the root
      }
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function nearestStore(start) {
  let current = resolve(start);
  const home = resolve(homedir());
  for (;;) {
    // The home folder's own .stashpad belongs to the global store, not to a project.
    if (current !== home && isDir(join(current, STORE))) return join(current, STORE);
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function globalStore(env = process.env) {
  return env.STASHPAD_GLOBAL_DIR ? resolve(env.STASHPAD_GLOBAL_DIR) : join(homedir(), ".stashpad", "global");
}

export function locateStore({ cwd = process.cwd(), env = process.env, explicit = undefined, global = false } = {}) {
  if (explicit !== undefined) return { dir: resolve(cwd, explicit), how: "--dir" };
  if (global) return { dir: globalStore(env), how: env.STASHPAD_GLOBAL_DIR ? "STASHPAD_GLOBAL_DIR" : "global store in the home folder" };
  if (env.STASHPAD_DIR) return { dir: resolve(cwd, env.STASHPAD_DIR), how: "STASHPAD_DIR" };
  const near = nearestStore(cwd);
  if (near) return { dir: near, how: "nearest .stashpad folder above" };
  const root = gitRoot(cwd);
  if (root) return { dir: join(root, STORE), how: "git project root" };
  return { dir: join(resolve(cwd), STORE), how: "current folder (no project found)" };
}
