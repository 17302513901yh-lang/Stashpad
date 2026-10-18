// One writer at a time per store. The command line, the MCP server and the review page can run at
// the same time; without a lock two writes could interleave (for example two supersedes of the same
// memory). Idea from the MCP reference memory server (lock file made with O_EXCL, stale lock broken
// when its process is gone or it is too old); this is a fresh implementation, not a copy.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
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

function isStale(path) {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    // The store is a local folder, so the process that holds the lock runs on this computer.
    return Date.now() - Number(data.at) > STALE_MS || !processAlive(data.pid);
  } catch {
    return true; // half-written or unreadable lock: treat as stale
  }
}

function tryCreate(path, token) {
  try {
    const fd = openSync(path, "wx");
    writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token }));
    closeSync(fd);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
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
    if (isStale(path)) {
      rmSync(path, { force: true });
      continue;
    }
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
