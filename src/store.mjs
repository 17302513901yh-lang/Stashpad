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
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import {
  KINDS,
  REQUIRED_KEYS,
  TRUST_BY_SOURCE,
  isValidId,
  parseMemory,
  validateMemory,
} from "./memory-format.mjs";
import { bm25Rank, keyTerms } from "./search.mjs";
import { synonymMapFor } from "./synonyms.mjs";
import { applyTemporalInvalidation } from "../third_party/graphiti/temporal.mjs";
import { MAX_TEXT_CHARS, MAX_WAITING, findHiddenCharacters, findInstructionLikeText, findSecrets } from "./security.mjs";
import { lstatSync } from "node:fs";

import { StoreError } from "./errors.mjs";
import { withStoreLock } from "./lock.mjs";
import { gateReason, relatedTo } from "./gate.mjs";
import { autoSnapshot, prepareForWrite } from "./safety.mjs";

export { StoreError };

// Refuses to read or write through a symbolic link: a link could point outside the store.
function assertSafeFile(path) {
  if (isSymlink(path)) {
    throw new StoreError(`refusing to use a symbolic link in the store: ${path}`);
  }
}

function isSymlink(path) {
  return existsSync(path) && lstatSync(path).isSymbolicLink();
}

// Replaces a file in one step, so the old content stays whole if the new one cannot be written.
function writeAtomic(path, content) {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, content, { flag: "wx" });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

// A rejected write keeps its file name. If that name is taken, a number is added, so no earlier rejection is overwritten.
function uniquePath(folder, name) {
  const dot = name.lastIndexOf(".");
  const stem = name.slice(0, dot);
  const ext = name.slice(dot);
  let candidate = join(folder, name);
  for (let n = 2; existsSync(candidate); n += 1) {
    candidate = join(folder, `${stem}-${n}${ext}`);
  }
  return candidate;
}

// Current means in force on the given day: started on or before it, and not ended on or before it.
export function isCurrent(meta, today = todayIso()) {
  return meta.valid_from <= today && (meta.valid_to === null || meta.valid_to > today);
}

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
  if (id.startsWith("forget-")) {
    throw new StoreError(`invalid id "${id}". The prefix "forget-" is reserved for ending requests. Pick another id.`);
  }
  if (/[\r\n]/.test(sourceRef)) {
    throw new StoreError("source-ref must be one line of text");
  }
  if (typeof text !== "string" || text.trim() === "") {
    throw new StoreError("not saved: the memory text is empty.");
  }
  if (text.length > MAX_TEXT_CHARS) {
    throw new StoreError(
      `not saved: the text is ${text.length} characters; the limit is ${MAX_TEXT_CHARS}. Split it into separate memories.`,
    );
  }
  if (findHiddenCharacters(`${text}\n${sourceRef}`).length > 0) {
    throw new StoreError("not saved: the text holds invisible characters (zero-width or direction controls). Remove them.");
  }
  const secrets = findSecrets(`${text}\n${sourceRef}`);
  if (secrets.length > 0) {
    throw new StoreError(
      `not saved: this looks like a secret (${secrets.join(", ")}). Remove it. Memories must not hold keys or passwords.`,
    );
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
  assertSafeFile(path);
  if (existsSync(path)) {
    throw new StoreError(
      `memory "${id}" already exists. Pick a new id. A changed fact gets a new memory, not an edit.`,
    );
  }
  // Ending the old memory edits a file in place, so take the daily snapshot first.
  if (old !== null) autoSnapshot(dir);
  writeFileSync(path, renderMemory(meta, body), { flag: "wx" });

  if (old !== null) {
    try {
      const ended = { ...old.meta, valid_to: meta.valid_from, superseded_by: id };
      writeAtomic(filePath(dir, supersedes), renderMemory(ended, old.body));
    } catch (error) {
      rmSync(path, { force: true });
      throw error;
    }
  }

  appendAudit(dir, {
    action: "saved",
    id,
    hash: contentHash(body),
    source_type: meta.source_type,
    source_ref: meta.source_ref,
    supersedes,
  });
  return path;
}

// Bodies of current memories and waiting writes, for the duplicate check.
function comparableBodies(dir, pendingFolder, ownId) {
  const today = todayIso();
  const list = readAll(dir)
    .entries.filter((entry) => isCurrent(entry.meta, today))
    .map((entry) => ({ id: entry.id, body: entry.body }));
  for (const name of readdirSync(pendingFolder)) {
    if (!name.endsWith(".md")) continue;
    try {
      list.push({ id: name.slice(0, -3), body: parseMemory(readFileSync(join(pendingFolder, name), "utf8")).body });
    } catch {
      // an unreadable waiting file is reported by review, not here
    }
  }
  return list.filter((item) => item.id !== ownId);
}

// Writes a memory that an agent, tool or web page proposed. It waits in pending/.
function queueForReview(dir, meta, body) {
  const { id } = meta;
  if (existsSync(filePath(dir, id))) {
    throw new StoreError(`memory "${id}" already exists. Pick a new id.`);
  }
  const folder = join(dir, PENDING);
  mkdirSync(folder, { recursive: true });
  const refused = gateReason(body, comparableBodies(dir, folder, id));
  if (refused !== null) {
    appendAudit(dir, { action: "refused", id, source_type: meta.source_type, source_ref: meta.source_ref, reason: refused });
    throw new StoreError(`not queued: ${refused}`);
  }
  if (readdirSync(folder).length >= MAX_WAITING) {
    throw new StoreError(
      `not queued: ${MAX_WAITING} writes are already waiting for review. Accept or reject some first ("stashpad review").`,
    );
  }
  const path = join(folder, `${id}.md`);
  assertSafeFile(path);
  if (existsSync(path)) {
    throw new StoreError(`"${id}" is already waiting for review. Accept or reject it first with "stashpad review".`);
  }
  writeFileSync(path, renderMemory(meta, body), { flag: "wx" });
  appendAudit(dir, { action: "queued", id, hash: contentHash(body), source_type: meta.source_type, source_ref: meta.source_ref });
  return path;
}

// User memories go straight into the store. Anything from an agent, tool or the web is queued.
function saveMemoryUnlocked(dir, input, today = todayIso()) {
  const { meta, body } = buildMemory(input, today);
  prepareForWrite(dir);
  // Current memories of the same kind that look related: the new one may replace one of them.
  const today2 = todayIso();
  const related =
    meta.supersedes === null
      ? relatedTo(
          body,
          readAll(dir)
            .entries.filter((e) => e.id !== meta.id && e.meta.kind === meta.kind && isCurrent(e.meta, today2))
            .map((e) => ({ id: e.id, body: e.body })),
        )
      : [];
  if (meta.source_type !== "user") {
    return { status: "queued", path: queueForReview(dir, meta, body), maybe_replaces: related };
  }
  return { status: "saved", path: commitMemory(dir, meta, body), maybe_replaces: related };
}

// Path of a waiting write. A memory is <id>.md, an ending request is forget-<id>.json.
function pendingPath(dir, id) {
  const isForget = id.startsWith("forget-");
  const target = isForget ? id.slice("forget-".length) : id;
  if (!isValidId(target)) {
    throw new StoreError(`invalid id "${id}". Ids use lowercase letters, digits and hyphens.`);
  }
  const path = join(dir, PENDING, isForget ? `${id}.json` : `${id}.md`);
  if (!existsSync(path)) {
    throw new StoreError(`nothing waiting for review under "${id}". Run "stashpad review" to see what is queued.`);
  }
  return path;
}

// A request from an agent to end a memory. Nothing is deleted. The memory stays, with an end date.
function queueForgetUnlocked(dir, target, reason, sourceRef = "agent request", sourceType = "agent") {
  if (!isValidId(target)) {
    throw new StoreError(`invalid id "${target}". Ids use lowercase letters, digits and hyphens.`);
  }
  const { text } = readMemory(dir, target);
  const { meta: targetMeta } = parseMemory(text);
  if (targetMeta.valid_to !== null) {
    throw new StoreError(`"${target}" has already ended, so there is nothing to forget.`);
  }
  if (targetMeta.valid_from > todayIso()) {
    throw new StoreError(`"${target}" has not started yet (it starts ${targetMeta.valid_from}), so there is nothing to end yet.`);
  }
  const secrets = findSecrets(`${reason}\n${sourceRef}`);
  if (secrets.length > 0) {
    throw new StoreError(
      `not requested: the reason looks like a secret (${secrets.join(", ")}). Remove it. Reasons must not hold keys or passwords.`,
    );
  }
  prepareForWrite(dir);
  const folder = join(dir, PENDING);
  mkdirSync(folder, { recursive: true });
  const id = `forget-${target}`;
  const path = join(folder, `${id}.json`);
  assertSafeFile(path);
  if (existsSync(path)) {
    throw new StoreError(`an ending request for "${target}" is already waiting for review.`);
  }
  const request = { action: "forget", target, reason, source_type: sourceType, source_ref: sourceRef };
  writeFileSync(path, `${JSON.stringify(request, null, 2)}\n`, { flag: "wx" });
  appendAudit(dir, { action: "queued", id, source_type: sourceType, source_ref: sourceRef, reason });
  return path;
}

function applyForget(dir, id, path) {
  const request = JSON.parse(readFileSync(path, "utf8"));
  const { text } = readMemory(dir, request.target);
  const { meta, body } = parseMemory(text);
  if (meta.valid_to !== null) {
    throw new StoreError(`"${request.target}" already ended on ${meta.valid_to}.`);
  }
  autoSnapshot(dir);
  writeAtomic(filePath(dir, request.target), renderMemory({ ...meta, valid_to: todayIso() }, body));
  rmSync(path);
  appendAudit(dir, { action: "forgotten", id, target: request.target, reason: request.reason });
}

// Short fingerprint of a memory's text, kept in the audit log, so a later change to a file by hand
// can be spotted ("stashpad doctor") without storing anything extra in the memory itself.
export function contentHash(body) {
  return createHash("sha256").update(body.trim()).digest("hex").slice(0, 16);
}

// A person says a memory is still true. Only last_confirmed_at changes.
function confirmMemoryUnlocked(dir, id, today = todayIso()) {
  const { text } = readMemory(dir, id);
  const { meta, body } = parseMemory(text);
  if (!isCurrent(meta, today)) {
    throw new StoreError(`"${id}" is not current, so it cannot be confirmed. Save a new memory instead.`);
  }
  if (meta.last_confirmed_at === today) return { id, changed: false };
  autoSnapshot(dir);
  writeAtomic(filePath(dir, id), renderMemory({ ...meta, last_confirmed_at: today }, body));
  appendAudit(dir, { action: "confirmed", id, hash: contentHash(body) });
  return { id, changed: true };
}

// Memories from agents, tools or the web that nobody confirmed for a long time. Never changed here;
// a person decides with confirm or forget.
export function staleMemories(dir, { days = 180, today = todayIso() } = {}) {
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const limit = cutoff.toISOString().slice(0, 10);
  return readAll(dir)
    .entries.filter((e) => e.meta.source_type !== "user" && isCurrent(e.meta, today) && e.meta.last_confirmed_at < limit)
    .map((e) => ({ id: e.id, last_confirmed_at: e.meta.last_confirmed_at }))
    .sort((a, b) => a.last_confirmed_at.localeCompare(b.last_confirmed_at));
}

// Every valid memory with its full text, for export. Files that break the format go to skipped.
export function readEntries(dir) {
  return readAll(dir);
}

// One waiting write in full, for the review page. Ending requests show their target and reason.
export function readPending(dir, id) {
  const path = pendingPath(dir, id);
  if (path.endsWith(".json")) {
    const request = JSON.parse(readFileSync(path, "utf8"));
    return {
      id,
      kind: "forget",
      source_type: request.source_type,
      source_ref: request.source_ref,
      valid_from: null,
      supersedes: null,
      target: request.target,
      text: `Beëindigen van "${request.target}". Reden: ${request.reason}`,
      conflicts: [],
      flagged: findInstructionLikeText(request.reason),
    };
  }
  assertSafeFile(path);
  const text = readFileSync(path, "utf8");
  const { meta, errors } = validateMemory(text, id);
  if (errors.length > 0) throw new StoreError(`"${id}" has a problem: ${errors[0]}`);
  const { body } = parseMemory(text);
  return {
    id,
    kind: meta.kind,
    source_type: meta.source_type,
    source_ref: meta.source_ref,
    valid_from: meta.valid_from,
    supersedes: meta.supersedes,
    text: body,
    conflicts: findConflicts(dir, meta, body),
    flagged: findInstructionLikeText(body),
  };
}

// Current memories of the same kind that share at least two meaningful words with this one.
// Each is marked with whether accepting this memory would end it (same rule as the Graphiti port).
function findConflicts(dir, meta, body) {
  const today = todayIso();
  const mine = new Set(keyTerms(body));
  const { entries } = readAll(dir);
  const candidates = entries.filter(
    (entry) =>
      entry.id !== meta.id &&
      isCurrent(entry.meta, today) &&
      entry.meta.kind === meta.kind &&
      keyTerms(entry.body).filter((term) => mine.has(term)).length >= 2,
  );
  if (candidates.length === 0) return [];

  const copies = candidates.map((entry) => ({
    id: entry.id,
    valid_from: entry.meta.valid_from,
    valid_to: entry.meta.valid_to,
  }));
  const ended = new Set(
    applyTemporalInvalidation({ id: meta.id, valid_from: meta.valid_from, valid_to: null }, copies).map((c) => c.id),
  );
  return candidates.map((entry) => ({ id: entry.id, would_end: ended.has(entry.id) }));
}

// Waiting writes, newest name order. Files that break the format go to skipped.
export function listPending(dir) {
  const rows = [];
  const skipped = [];
  const folder = join(dir, PENDING);
  if (!existsSync(folder)) return { rows, skipped };

  for (const name of readdirSync(folder).filter((n) => n.endsWith(".md")).sort()) {
    const id = name.slice(0, -".md".length);
    if (isSymlink(join(folder, name))) {
      skipped.push({ file: name, reason: "symbolic link: not read" });
      continue;
    }
    const text = readFileSync(join(folder, name), "utf8");
    const { meta, errors } = validateMemory(text, id);
    if (errors.length > 0) {
      skipped.push({ file: name, reason: errors[0] });
      continue;
    }
    const body = parseMemory(text).body;
    rows.push({
      id,
      kind: meta.kind,
      source_type: meta.source_type,
      source_ref: meta.source_ref,
      supersedes: meta.supersedes,
      summary: body.split("\n")[0],
      flagged: findInstructionLikeText(body),
      conflicts: findConflicts(dir, meta, body),
    });
  }
  for (const name of readdirSync(folder).filter((n) => n.startsWith("forget-") && n.endsWith(".json")).sort()) {
    try {
      const request = JSON.parse(readFileSync(join(folder, name), "utf8"));
      rows.push({
        id: name.slice(0, -".json".length),
        kind: "forget",
        source_type: request.source_type,
        source_ref: request.source_ref,
        supersedes: null,
        summary: `end "${request.target}": ${request.reason}`,
        flagged: findInstructionLikeText(request.reason),
        conflicts: [],
      });
    } catch {
      skipped.push({ file: name, reason: "cannot read this ending request" });
    }
  }
  return { rows, skipped };
}

// Accepts a waiting write (or ending request). If the store check fails, it stays in pending/.
function acceptPendingUnlocked(dir, id) {
  const path = pendingPath(dir, id);
  prepareForWrite(dir);
  if (path.endsWith(".json")) {
    applyForget(dir, id, path);
    return path;
  }
  assertSafeFile(path);
  const text = readFileSync(path, "utf8");
  const { meta, errors } = validateMemory(text, id);
  if (errors.length > 0) {
    throw new StoreError(`"${id}" cannot be accepted, fix it first:\n- ${errors.join("\n- ")}`);
  }
  // The date a person confirmed it is the day of acceptance, not the day the agent proposed it.
  const written = commitMemory(dir, { ...meta, last_confirmed_at: todayIso() }, parseMemory(text).body);
  rmSync(path);
  appendAudit(dir, { action: "accepted", id, source_type: meta.source_type, source_ref: meta.source_ref });
  return written;
}

// Moves a waiting write to rejected/. It never reaches the store, and the reason is logged.
function rejectPendingUnlocked(dir, id, reason = null) {
  const from = pendingPath(dir, id);
  if (reason !== null && findSecrets(reason).length > 0) {
    throw new StoreError("not rejected: the reason looks like a secret. Remove it and try again.");
  }
  prepareForWrite(dir);
  const folder = join(dir, REJECTED);
  mkdirSync(folder, { recursive: true });
  const to = uniquePath(folder, basename(from));
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
    current: isCurrent(meta),
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
  assertSafeFile(path);
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
    if (isSymlink(join(dir, name))) {
      skipped.push({ file: name, reason: "symbolic link: not read" });
      continue;
    }
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
    created_at: entry.meta.created_at,
    valid_from: entry.meta.valid_from,
    valid_to: entry.meta.valid_to,
    trust: entry.meta.trust,
    summary: entry.body.split("\n")[0],
  };
}

// Current memories only, unless includeEnded is true.
export function listMemories(dir, options = {}) {
  const { entries, skipped } = readAll(dir);
  const rows = filterEntries(entries, options).map(summarize);
  return { rows, skipped };
}

// Ranks memories against the query. total is how many memories were searched.
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Filters shared by list and search. Every filter is optional; together they must all hold (AND).
//   kinds: ["decision", ...]   sourceTypes: ["user", ...]
//   asOf: "YYYY-MM-DD"  what was valid on that day (ended memories included when they were valid then)
//   since / until: "YYYY-MM-DD" on valid_from
function filterEntries(entries, { includeEnded = false, today = todayIso(), kinds = null, sourceTypes = null, asOf = null, since = null, until = null } = {}) {
  for (const [name, value] of [["as-of", asOf], ["since", since], ["until", until]]) {
    if (value !== null && value !== undefined && !DAY.test(value)) {
      throw new StoreError(`--${name} must be a date like 2026-10-01, not "${value}".`);
    }
  }
  if (kinds) {
    const bad = kinds.filter((k) => !KINDS.includes(k));
    if (bad.length > 0) throw new StoreError(`unknown kind "${bad[0]}". Use one of: ${KINDS.join(", ")}.`);
  }
  if (sourceTypes) {
    const bad = sourceTypes.filter((t) => !(t in TRUST_BY_SOURCE));
    if (bad.length > 0) throw new StoreError(`unknown source type "${bad[0]}". Use one of: ${Object.keys(TRUST_BY_SOURCE).join(", ")}.`);
  }
  const day = asOf ?? today;
  return entries.filter(
    (entry) =>
      (includeEnded || isCurrent(entry.meta, day)) &&
      (!kinds || kinds.includes(entry.meta.kind)) &&
      (!sourceTypes || sourceTypes.includes(entry.meta.source_type)) &&
      (!since || entry.meta.valid_from >= since) &&
      (!until || entry.meta.valid_from <= until),
  );
}

export function searchMemories(dir, query, options = {}) {
  const { limit = 10, explain = false } = options;
  const { entries, skipped } = readAll(dir);
  const searched = filterEntries(entries, options);
  const docs = searched.map((entry) => ({
    id: entry.id,
    text: `${entry.id.replace(/-/g, " ")} ${entry.body}`,
  }));
  const byId = new Map(searched.map((entry) => [entry.id, entry]));

  const ranked = bm25Rank(docs, query, { synonyms: synonymMapFor(dir) }).slice(0, limit);
  const results = ranked.map((hit) => ({
    ...summarize(byId.get(hit.id)),
    score: Math.round(hit.score * 100) / 100,
    ...(explain ? { matched: hit.matched, source_type: byId.get(hit.id).meta.source_type } : {}),
  }));
  return { total: searched.length, results, skipped };
}

// Public write functions: each runs while holding the store lock.
export const saveMemory = (dir, ...args) => withStoreLock(dir, () => saveMemoryUnlocked(dir, ...args));
export const queueForget = (dir, ...args) => withStoreLock(dir, () => queueForgetUnlocked(dir, ...args));
export const acceptPending = (dir, ...args) => withStoreLock(dir, () => acceptPendingUnlocked(dir, ...args));
export const confirmMemory = (dir, ...args) => withStoreLock(dir, () => confirmMemoryUnlocked(dir, ...args));
export const rejectPending = (dir, ...args) => withStoreLock(dir, () => rejectPendingUnlocked(dir, ...args));
