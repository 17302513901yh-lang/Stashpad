// File-based store for Stashpad memories. No index: every read goes to the files.
// Layout in one folder:
//   <id>.md      memories in the store (list and search read only these)
//   pending/     writes from agents, tools and the web, waiting for a person to accept
//   rejected/    pending writes a person rejected, kept for review
//   audit.jsonl  one line per change: saved, queued, accepted, rejected
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  REQUIRED_KEYS,
  TRUST_BY_SOURCE,
  isValidId,
  parseMemory,
  validateMemory,
} from "./memory-format.mjs";
import { bm25Rank } from "./search.mjs";

export class StoreError extends Error {}

const PENDING = "pending";
const REJECTED = "rejected";
const AUDIT = "audit.jsonl";

export function todayIso(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function filePath(dir, id) {
  return join(dir, `${id}.md`);
}

function renderMemory(meta, body) {
  const lines = ["---"];
  for (const key of REQUIRED_KEYS) {
    const value = meta[key];
    lines.push(`${key}: ${value === null ? "null" : value}`);
  }
  lines.push("---", body, "");
  return lines.join("\n");
}

function appendAudit(dir, entry) {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, AUDIT), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

// Last `limit` audit entries, oldest first.
export function readAudit(dir, limit = 50) {
  const path = join(dir, AUDIT);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "");
  return lines.slice(-limit).map((line) => JSON.parse(line));
}

// Builds and checks a new memory without writing anything.
function buildMemory(input, today) {
  const { id, kind, text, sourceType, sourceRef, validFrom, supersedes = null } = input;

  if (!isValidId(id)) {
    throw new StoreError(
      `invalid id "${id}". Use lowercase letters, digits and hyphens, for example "db-choice".`,
    );
  }
  if (/[\r\n]/.test(sourceRef)) {
    throw new StoreError("source-ref must be one line of text");
  }

  const meta = {
    id,
    kind,
    created_at: today,
    valid_from: validFrom ?? today,
    valid_to: null,
    supersedes,
    superseded_by: null,
    source_type: sourceType,
    source_ref: sourceRef.trim(),
    trust: TRUST_BY_SOURCE[sourceType],
    last_confirmed_at: today,
  };
  const body = text.trim();

  const { errors } = validateMemory(renderMemory(meta, body), id);
  if (errors.length > 0) {
    throw new StoreError(`not saved, fix these first:\n- ${errors.join("\n- ")}`);
  }
  return { meta, body };
}

// Writes a memory into the store. Never overwrites. If it supersedes another memory,
// that one gets valid_to and superseded_by. Everything is checked before anything is written.
function commitMemory(dir, meta, body) {
  const { id, supersedes } = meta;

  let old = null;
  if (supersedes !== null) {
    const { text: oldText } = readMemory(dir, supersedes);
    const oldCheck = validateMemory(oldText, supersedes);
    if (oldCheck.errors.length > 0) {
      throw new StoreError(`"${supersedes}" has a problem, fix it first:\n- ${oldCheck.errors.join("\n- ")}`);
    }
    if (oldCheck.meta.valid_to !== null) {
      throw new StoreError(
        `"${supersedes}" already ended on ${oldCheck.meta.valid_to}. Supersede the memory that replaced it instead.`,
      );
    }
    if (meta.valid_from < oldCheck.meta.valid_from) {
      throw new StoreError(
        `valid_from ${meta.valid_from} is before "${supersedes}" started (${oldCheck.meta.valid_from}).`,
      );
    }
    old = { meta: oldCheck.meta, body: parseMemory(oldText).body };
  }

  mkdirSync(dir, { recursive: true });
  const path = filePath(dir, id);
  if (existsSync(path)) {
    throw new StoreError(
      `memory "${id}" already exists. Pick a new id. A changed fact gets a new memory, not an edit.`,
    );
  }
  writeFileSync(path, renderMemory(meta, body), { flag: "wx" });

  if (old !== null) {
    try {
      const ended = { ...old.meta, valid_to: meta.valid_from, superseded_by: id };
      writeFileSync(filePath(dir, supersedes), renderMemory(ended, old.body));
    } catch (error) {
      rmSync(path, { force: true });
      throw error;
    }
  }

  appendAudit(dir, {
    action: "saved",
    id,
    source_type: meta.source_type,
    source_ref: meta.source_ref,
    supersedes,
  });
  return path;
}

// Writes a memory that an agent, tool or web page proposed. It waits in pending/.
function queueForReview(dir, meta, body) {
  const { id } = meta;
  if (existsSync(filePath(dir, id))) {
    throw new StoreError(`memory "${id}" already exists. Pick a new id.`);
  }
  const folder = join(dir, PENDING);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${id}.md`);
  if (existsSync(path)) {
    throw new StoreError(`"${id}" is already waiting for review. Accept or reject it first with "stashpad review".`);
  }
  writeFileSync(path, renderMemory(meta, body), { flag: "wx" });
  appendAudit(dir, { action: "queued", id, source_type: meta.source_type, source_ref: meta.source_ref });
  return path;
}

// User memories go straight into the store. Anything from an agent, tool or the web is queued.
export function saveMemory(dir, input, today = todayIso()) {
  const { meta, body } = buildMemory(input, today);
  if (meta.source_type !== "user") {
    return { status: "queued", path: queueForReview(dir, meta, body) };
  }
  return { status: "saved", path: commitMemory(dir, meta, body) };
}

function pendingPath(dir, id) {
  if (!isValidId(id)) {
    throw new StoreError(`invalid id "${id}". Ids use lowercase letters, digits and hyphens.`);
  }
  const path = join(dir, PENDING, `${id}.md`);
  if (!existsSync(path)) {
    throw new StoreError(`nothing waiting for review under "${id}". Run "stashpad review" to see what is queued.`);
  }
  return path;
}

// Waiting writes, newest name order. Files that break the format go to skipped.
export function listPending(dir) {
  const rows = [];
  const skipped = [];
  const folder = join(dir, PENDING);
  if (!existsSync(folder)) return { rows, skipped };

  for (const name of readdirSync(folder).filter((n) => n.endsWith(".md")).sort()) {
    const id = name.slice(0, -".md".length);
    const text = readFileSync(join(folder, name), "utf8");
    const { meta, errors } = validateMemory(text, id);
    if (errors.length > 0) {
      skipped.push({ file: name, reason: errors[0] });
      continue;
    }
    rows.push({
      id,
      kind: meta.kind,
      source_type: meta.source_type,
      source_ref: meta.source_ref,
      supersedes: meta.supersedes,
      summary: parseMemory(text).body.split("\n")[0],
    });
  }
  return { rows, skipped };
}

// Moves a waiting write into the store. If the store check fails, it stays in pending/.
export function acceptPending(dir, id) {
  const path = pendingPath(dir, id);
  const text = readFileSync(path, "utf8");
  const { meta, errors } = validateMemory(text, id);
  if (errors.length > 0) {
    throw new StoreError(`"${id}" cannot be accepted, fix it first:\n- ${errors.join("\n- ")}`);
  }
  const written = commitMemory(dir, meta, parseMemory(text).body);
  rmSync(path);
  appendAudit(dir, { action: "accepted", id, source_type: meta.source_type, source_ref: meta.source_ref });
  return written;
}

// Moves a waiting write to rejected/. It never reaches the store, and the reason is logged.
export function rejectPending(dir, id, reason = null) {
  const from = pendingPath(dir, id);
  const folder = join(dir, REJECTED);
  mkdirSync(folder, { recursive: true });
  const to = join(folder, `${id}.md`);
  renameSync(from, to);
  appendAudit(dir, { action: "rejected", id, reason });
  return to;
}

// The full chain of memories a memory belongs to, oldest first.
export function historyOf(dir, id) {
  const load = (memId) => parseMemory(readMemory(dir, memId).text).meta;
  const start = load(id);

  const before = [];
  const seen = new Set([id]);
  let cursor = start;
  let brokenLink = null;
  while (cursor.supersedes !== null && !seen.has(cursor.supersedes)) {
    seen.add(cursor.supersedes);
    try {
      cursor = load(cursor.supersedes);
    } catch {
      brokenLink = cursor.supersedes;
      break;
    }
    before.unshift(cursor);
  }

  const after = [];
  cursor = start;
  while (cursor.superseded_by !== null && !seen.has(cursor.superseded_by)) {
    seen.add(cursor.superseded_by);
    try {
      cursor = load(cursor.superseded_by);
    } catch {
      brokenLink = cursor.superseded_by;
      break;
    }
    after.push(cursor);
  }

  const chain = [...before, start, ...after].map((meta) => ({
    id: meta.id,
    valid_from: meta.valid_from,
    valid_to: meta.valid_to,
    source_ref: meta.source_ref,
    trust: meta.trust,
    current: meta.valid_to === null,
    requested: meta.id === id,
  }));
  return { chain, brokenLink };
}

export function readMemory(dir, id) {
  if (!isValidId(id)) {
    throw new StoreError(`invalid id "${id}". Ids use lowercase letters, digits and hyphens.`);
  }
  const path = filePath(dir, id);
  if (!existsSync(path)) {
    throw new StoreError(`no memory named "${id}" in ${dir}. Run "stashpad list --all" to see what exists.`);
  }
  return { path, text: readFileSync(path, "utf8") };
}

// Reads every valid memory in the store folder. Files that break the format go to skipped.
function readAll(dir) {
  const entries = [];
  const skipped = [];
  if (!existsSync(dir)) return { entries, skipped };

  const names = readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
  for (const name of names) {
    const id = name.slice(0, -".md".length);
    const text = readFileSync(join(dir, name), "utf8");
    const { errors } = validateMemory(text, id);
    if (errors.length > 0) {
      skipped.push({ file: name, reason: errors[0] });
      continue;
    }
    const { meta, body } = parseMemory(text);
    entries.push({ id, meta, body });
  }
  return { entries, skipped };
}

function summarize(entry) {
  return {
    id: entry.id,
    kind: entry.meta.kind,
    valid_from: entry.meta.valid_from,
    valid_to: entry.meta.valid_to,
    trust: entry.meta.trust,
    summary: entry.body.split("\n")[0],
  };
}

// Current memories only, unless includeEnded is true.
export function listMemories(dir, { includeEnded = false } = {}) {
  const { entries, skipped } = readAll(dir);
  const rows = entries
    .filter((entry) => includeEnded || entry.meta.valid_to === null)
    .map(summarize);
  return { rows, skipped };
}

// Ranks memories against the query. total is how many memories were searched.
export function searchMemories(dir, query, { includeEnded = false, limit = 10 } = {}) {
  const { entries, skipped } = readAll(dir);
  const searched = entries.filter((entry) => includeEnded || entry.meta.valid_to === null);
  const docs = searched.map((entry) => ({
    id: entry.id,
    text: `${entry.id.replace(/-/g, " ")} ${entry.body}`,
  }));
  const byId = new Map(searched.map((entry) => [entry.id, entry]));

  const ranked = bm25Rank(docs, query).slice(0, limit);
  const results = ranked.map((hit) => ({
    ...summarize(byId.get(hit.id)),
    score: Math.round(hit.score * 100) / 100,
  }));
  return { total: searched.length, results, skipped };
}
