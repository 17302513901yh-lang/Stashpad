// The little Stashpad asks git about a working copy: the branch, and which files are not committed.
// The branch is read from the HEAD file, with no command. The file list needs "git status", which is
// run carefully, because a repository's own config can name programs for git to run:
//   - git is found as an absolute path in an absolute PATH folder (never "." or a relative folder),
//   - core.fsmonitor is switched off (it names a program that git status would start),
//   - GIT_OPTIONAL_LOCKS=0, so it never takes the index lock from the user's own git,
//   - a 2 second time limit, and any failure is simply "no answer".
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

let cachedGit;

export function gitBinary(env = process.env) {
  if (cachedGit !== undefined && env === process.env) return cachedGit;
  const names = process.platform === "win32" ? ["git.exe"] : ["git"];
  let found = null;
  for (const folder of String(env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!folder || !isAbsolute(folder)) continue;
    for (const name of names) {
      const candidate = join(folder, name);
      try {
        if (statSync(candidate).isFile()) {
          found = candidate;
          break;
        }
      } catch {
        // not here
      }
    }
    if (found) break;
  }
  if (env === process.env) cachedGit = found;
  return found;
}

// The .git folder of the working copy that holds `start` (for a worktree or submodule: the folder its
// .git file points to), or null.
function gitDirOf(start) {
  let current = resolve(start);
  for (;;) {
    const marker = join(current, ".git");
    if (existsSync(marker)) {
      try {
        if (statSync(marker).isDirectory()) return marker;
        const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(marker, "utf8"));
        if (match) return isAbsolute(match[1].trim()) ? match[1].trim() : resolve(current, match[1].trim());
      } catch {
        return null;
      }
      return null;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// The checked-out branch, or null (no git, detached HEAD, unreadable).
export function currentBranch(start) {
  try {
    const gitdir = gitDirOf(start);
    if (!gitdir) return null;
    const head = readFileSync(join(gitdir, "HEAD"), "utf8").trim();
    const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// { branch, files } for a working copy, or null when git is missing, fails or takes too long.
export function gitStatus(cwd, { timeout = 2000, env = process.env } = {}) {
  const git = gitBinary(env);
  if (!git || !cwd || !existsSync(cwd)) return null;
  let out;
  try {
    out = execFileSync(git, ["-c", "core.fsmonitor=", "-c", "core.untrackedCache=false", "status", "--porcelain=v1", "--branch", "--untracked-files=normal"], {
      cwd,
      timeout,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
  } catch {
    return null;
  }
  let branch = currentBranch(cwd);
  const files = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("## ")) {
      const name = line.slice(3).split("...")[0].trim();
      if (!branch && name && !name.startsWith("HEAD") && !name.startsWith("No commits yet on ")) branch = name;
      else if (!branch && name.startsWith("No commits yet on ")) branch = name.slice("No commits yet on ".length);
      continue;
    }
    if (line.length < 4) continue;
    let path = line.slice(3);
    if (path.includes(" -> ")) path = path.split(" -> ").at(-1);
    files.push(path.replace(/^"(.*)"$/, "$1"));
  }
  return { branch, files };
}
