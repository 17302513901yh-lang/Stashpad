// What Stashpad put in front of an agent: a local log of memory ids and sizes, never the text.
// The hooks, the MCP read tools and the read commands append one line per output to
// <store>/.sessions/shown.jsonl ({ at, session, event, ids, chars }); a person reads it with
// "stashpad shown". The log is capped like misses.jsonl, sealed in an encrypted store and kept out of
// git with the rest of .sessions/. A small summary (last-shown.json: the day each memory was last
// shown, and since when that is tracked) outlives the cap, so lint can name memories nobody used.
// Logging never fails the command that shows something.
import { appendFileSync, existsSync, lstatSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./fsx.mjs";
import { ensureSessionsDir, sessionKey, sessionsDir } from "./sessions.mjs";
import { openLine, openText, sealFor, sealLine } from "./vault.mjs";
import { StoreError } from "./errors.mjs";

export const SHOWN_FILE = "shown.jsonl";
export const LAST_SHOWN_FILE = "last-shown.json";
const MAX_BYTES = 200 * 1024;
const KEEP_LINES = 1000;

const day = (now) => now.toISOString().slice(0, 10);

function readSummary(dir) {
  const path = join(sessionsDir(dir), LAST_SHOWN_FILE);
  if (!existsSync(path) || !lstatSync(path).isFile()) return { since: null, last: {}, count: {} };
  try {
    const data = JSON.parse(openText(dir, readFileSync(path, "utf8")));
    return { since: typeof data.since === "string" ? data.since : null, last: data.last ?? {}, count: data.count ?? {} };
  } catch (error) {
    if (error instanceof StoreError) throw error;
    return { since: null, last: {}, count: {} };
  }
}

export function logShown(dir, { event, ids = [], chars = 0, session = null, now = new Date() }) {
  try {
    if (!existsSync(dir)) return;
    const folder = ensureSessionsDir(dir);
    const unique = [...new Set(ids.filter((id) => typeof id === "string"))].slice(0, 100);
    const entry = { at: now.toISOString(), session: sessionKey(session), event: String(event).slice(0, 40), ids: unique, chars: Number(chars) || 0 };
    const path = join(folder, SHOWN_FILE);
    appendFileSync(path, `${sealLine(dir, JSON.stringify(entry))}\n`);
    if (statSync(path).size > MAX_BYTES) {
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      writeAtomic(path, `${lines.slice(-KEEP_LINES).join("\n")}\n`);
    }
    const summary = readSummary(dir);
    summary.since ??= day(now);
    for (const id of unique) {
      summary.last[id] = day(now);
      summary.count[id] = (summary.count[id] ?? 0) + 1;
    }
    writeAtomic(join(folder, LAST_SHOWN_FILE), sealFor(dir, `${JSON.stringify(summary)}\n`));
  } catch {
    // a log line that cannot be written is not worth an error
  }
}

// Log entries, oldest first, optionally only from one day on or for one session.
export function readShown(dir, { since = null, session = null } = {}) {
  const path = join(sessionsDir(dir), SHOWN_FILE);
  if (!existsSync(path)) return [];
  const key = session === null ? null : sessionKey(session);
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(openLine(dir, line));
      if (since && String(entry.at).slice(0, 10) < since) continue;
      if (key && entry.session !== key && !String(entry.session ?? "").startsWith(String(session))) continue;
      out.push(entry);
    } catch (error) {
      if (error instanceof StoreError) throw error;
    }
  }
  return out;
}

// The day each memory was last shown, and since when the log runs (null when it never ran).
export function lastShown(dir) {
  try {
    return readSummary(dir);
  } catch {
    return { since: null, last: {}, count: {} };
  }
}

export function shownReport(dir, options = {}) {
  const entries = readShown(dir, options);
  const sessions = new Map();
  const counts = new Map();
  for (const e of entries) {
    const key = e.session ?? "(no session)";
    const s = sessions.get(key) ?? { session: key, events: 0, chars: 0, ids: new Set(), first: e.at, last: e.at };
    s.events += 1;
    s.chars += e.chars;
    s.last = e.at;
    for (const id of e.ids) {
      s.ids.add(id);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    sessions.set(key, s);
  }
  return {
    entries,
    sessions: [...sessions.values()].map((s) => ({ ...s, ids: [...s.ids] })),
    most_shown: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10).map(([id, times]) => ({ id, times })),
    total_chars: entries.reduce((n, e) => n + e.chars, 0),
  };
}

export function clearShown(dir) {
  let removed = 0;
  for (const name of [SHOWN_FILE, LAST_SHOWN_FILE]) {
    const path = join(sessionsDir(dir), name);
    if (existsSync(path)) {
      rmSync(path, { force: true });
      removed += 1;
    }
  }
  return removed;
}
