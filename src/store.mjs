// File-based store for Stashpad memories. No index: every read goes to the files.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// Writes a new memory file. Never overwrites a memory. A changed fact is a new memory
// that supersedes the old one: the old one gets valid_to and superseded_by.
export function saveMemory(dir, input, today = todayIso()) {
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
  const content = renderMemory(meta, text.trim());

  const { errors } = validateMemory(content, id);
  if (errors.length > 0) {
    throw new StoreError(`not saved, fix these first:\n- ${errors.join("\n- ")}`);
  }

  // Check everything before writing anything.
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
  writeFileSync(path, content, { flag: "wx" });

  if (old !== null) {
    try {
      const ended = { ...old.meta, valid_to: meta.valid_from, superseded_by: id };
      writeFileSync(filePath(dir, supersedes), renderMemory(ended, old.body));
    } catch (error) {
      rmSync(path, { force: true });
      throw error;
    }
  }
  return path;
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

// Reads every valid memory in the folder. Files that break the format go to skipped.
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
