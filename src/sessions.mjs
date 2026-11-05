// Per-session state for the hooks. One small JSON file per agent session in <store>/.sessions/:
//   given    memory ids the prompt hook already put in this session's context, so it does not paste
//            them again on every matching prompt. Cleared after compaction, when that context is gone.
//   last     what the prompt hook gave last, so "stashpad feedback --last" works without an id.
//   ended_at set by the session-end hook; a session without it did not end cleanly.
// Session ids and memory ids only, never prompt text. The folder keeps its own .gitignore, files are
// sealed when the store is encrypted, and files untouched for 7 days are removed on the next write.
// Nothing here may fail a hook: callers catch, and a store that does not exist yet gets no files.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { writeAtomic } from "./fsx.mjs";
import { openText, sealFor } from "./vault.mjs";

export const SESSIONS = ".sessions";
export const KEEP_DAYS = 7;
const PREFIX = "session-";
const SAFE = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_GIVEN = 500;

export const sessionsDir = (dir) => join(dir, SESSIONS);

// A file name part from the agent's session id. The id comes from the agent app; anything that is
// not a plain name is hashed, so it can never point outside the folder.
export function sessionKey(id) {
  if (typeof id !== "string" || id === "") return null;
  return SAFE.test(id) ? id : createHash("sha256").update(id).digest("hex").slice(0, 32);
}

const pathOf = (dir, key) => join(sessionsDir(dir), `${PREFIX}${key}.json`);

// Creates the folder (refusing a link in its place) with a .gitignore that keeps all of it out of git.
export function ensureSessionsDir(dir) {
  const folder = sessionsDir(dir);
  if (existsSync(folder) && !lstatSync(folder).isDirectory()) throw new Error(`${folder} is not a folder`);
  mkdirSync(folder, { recursive: true });
  const ignore = join(folder, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "# Stashpad hook state, local to this computer\n*\n");
  return folder;
}

function parse(dir, path) {
  try {
    if (!lstatSync(path).isFile()) return null;
    const data = JSON.parse(openText(dir, readFileSync(path, "utf8")));
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

export function readSession(dir, id) {
  const key = sessionKey(id);
  if (!key || !existsSync(pathOf(dir, key))) return null;
  return parse(dir, pathOf(dir, key));
}

// Every readable session file of this store, newest change first.
export function listSessions(dir) {
  const folder = sessionsDir(dir);
  if (!existsSync(folder)) return [];
  const out = [];
  for (const name of readdirSync(folder)) {
    if (!name.startsWith(PREFIX) || !name.endsWith(".json")) continue;
    const data = parse(dir, join(folder, name));
    if (data) out.push(data);
  }
  return out.sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
}

export function pruneSessions(dir, now = new Date()) {
  const folder = sessionsDir(dir);
  if (!existsSync(folder)) return 0;
  const cutoff = now.getTime() - KEEP_DAYS * 86400000;
  let removed = 0;
  for (const name of readdirSync(folder)) {
    if (!name.startsWith(PREFIX) || !name.endsWith(".json")) continue;
    const path = join(folder, name);
    try {
      if (statSync(path).mtimeMs < cutoff) {
        rmSync(path, { force: true });
        removed += 1;
      }
    } catch {
      // gone already
    }
  }
  return removed;
}

function blank(key, now) {
  return { session: key, started_at: now.toISOString(), updated_at: now.toISOString(), prompts: 0, given: [], last: null, ended_at: null };
}

// Reads, changes and writes one session file. Returns the new state, or null when there is no
// store or no usable session id. The change function gets a copy it may edit.
export function updateSession(dir, id, change, now = new Date()) {
  const key = sessionKey(id);
  if (!key || !existsSync(dir)) return null;
  ensureSessionsDir(dir);
  const state = { ...blank(key, now), ...(readSession(dir, id) ?? {}) };
  if (!Array.isArray(state.given)) state.given = [];
  change(state);
  state.given = [...new Set(state.given.filter((g) => typeof g === "string"))].slice(-MAX_GIVEN);
  state.updated_at = now.toISOString();
  writeAtomic(pathOf(dir, key), sealFor(dir, `${JSON.stringify(state, null, 2)}\n`));
  pruneSessions(dir, now);
  return state;
}

// Memory ids this session already has from the prompt hook.
export function givenIds(dir, id) {
  const state = readSession(dir, id);
  return Array.isArray(state?.given) ? state.given : [];
}

// What the prompt hook gave last in this store, over all sessions: { session, at, ids } or null.
export function lastGiven(dir) {
  for (const state of listSessions(dir).sort((a, b) => String(b.last?.at ?? "").localeCompare(String(a.last?.at ?? "")))) {
    if (Array.isArray(state.last?.ids) && state.last.ids.length > 0) return { session: state.session, at: state.last.at, ids: state.last.ids };
  }
  return null;
}
