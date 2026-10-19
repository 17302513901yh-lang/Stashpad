// One writer at a time per store. The command line, the MCP server and the review page can run at
// the same time; without a lock two writes could interleave (for example two supersedes of the same
// memory). Idea from the MCP reference memory server (lock file made with O_EXCL, stale lock broken
// when its process is gone or it is too old); this is a fresh implementation, not a copy.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { StoreError } from "./errors.mjs";

export const LOCK_FILE = ".stashpad.lock";
const STALE_MS = 30_000;
const WAIT_MS = 5_000; // STASHPAD_LOCK_WAIT_MS overrides it (used by tests)
const held = new Map(); // resolved dir -> { token, depth }
const pause = new Int32Array(new SharedArrayBuffer(4));

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// Windows reports a file that another process is just deleting or holding open with these codes.
const BUSY = new Set(["EEXIST", "EPERM", "EACCES", "EBUSY", "ENOENT"]);
const HALF_WRITTEN_MS = 2_000;

// Returns the lock's token when it is stale, or null when it is held (or cannot be judged yet).
function staleToken(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null; // gone, or busy on Windows: just try again
  }
  try {
    const data = JSON.parse(text);
    // The store is a local folder, so the process that holds the lock runs on this computer.
    return Date.now() - Number(data.at) > STALE_MS || !processAlive(data.pid) ? String(data.token) : null;
  } catch {
    // Just created and not written yet, or left half-written by a crash: only old ones are stale.
    try {
      return Date.now() - statSync(path).mtimeMs > HALF_WRITTEN_MS ? "" : null;
    } catch {
      return null;
    }
  }
}

function tokenOf(path) {
  try {
    return String(JSON.parse(readFileSync(path, "utf8")).token);
  } catch {
    return "";
  }
}

// Removes a stale lock. A second guard file makes sure two processes never both decide a lock is
// stale and then one of them removes the fresh lock the other has just made.
function breakStale(path, token) {
  const guard = `${path}.break`;
  try {
    closeSync(openSync(guard, "wx"));
  } catch {
    try {
      if (Date.now() - statSync(guard).mtimeMs > HALF_WRITTEN_MS * 2) rmSync(guard, { force: true });
    } catch {
      // someone else is breaking it right now
    }
    return;
  }
  try {
    if (staleToken(path) !== null && tokenOf(path) === token) rmSync(path, { force: true });
  } finally {
    rmSync(guard, { force: true });
  }
}

function tryCreate(path, token) {
  let fd;
  try {
    fd = openSync(path, "wx");
  } catch (error) {
    if (BUSY.has(error.code)) return false;
    throw error;
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token }));
  } finally {
    closeSync(fd);
  }
  return true;
}

export function withStoreLock(dir, fn) {
  const key = resolve(dir);
  const mine = held.get(key);
  if (mine) {
    mine.depth += 1;
    try {
      return fn();
    } finally {
      mine.depth -= 1;
    }
  }

  mkdirSync(key, { recursive: true });
  const path = join(key, LOCK_FILE);
  const token = randomUUID();
  const deadline = Date.now() + (Number(process.env.STASHPAD_LOCK_WAIT_MS) > 0 ? Number(process.env.STASHPAD_LOCK_WAIT_MS) : WAIT_MS);
  while (!tryCreate(path, token)) {
    const stale = staleToken(path);
    if (stale !== null) breakStale(path, stale);
    if (Date.now() > deadline) {
      throw new StoreError(
        `the store is busy: another Stashpad process is writing (${path}). Try again. If no other process runs, delete that file.`,
      );
    }
    Atomics.wait(pause, 0, 0, 25);
  }

  held.set(key, { token, depth: 1 });
  try {
    return fn();
  } finally {
    held.delete(key);
    try {
      if (existsSync(path) && JSON.parse(readFileSync(path, "utf8")).token === token) rmSync(path, { force: true });
    } catch {
      // someone else already removed or replaced it; leave theirs alone
    }
  }
}
