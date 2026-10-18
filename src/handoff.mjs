// Handoffs: a note from one session (or agent) to the next that is read exactly once.
// Memories are what stays true; a handoff is "where I stopped and what comes next". It is a record with a state:
// open → claimed (by the first session that takes it), cancelled, or expired. Listing never claims. A note a person
// writes (manual) goes before one a tool or hook writes (auto), and a newer auto note expires the older open auto
// notes. The idea follows ai-memory's typed handoffs (MIT, akitaonrails); this is Stashpad's own small version:
// one JSON file per handoff in <store>/handoffs, sealed when the store is encrypted, written under the store lock.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { StoreError } from "./errors.mjs";
import { withStoreLock } from "./lock.mjs";
import { keyFor, readData, sealFor, sealLine } from "./vault.mjs";
import { DATA_LABEL, MAX_TEXT_CHARS, findHiddenCharacters, findInstructionLikeText, findSecrets } from "./security.mjs";
import { prepareForWrite } from "./safety.mjs";

export const HANDOFFS = "handoffs";
export const DEFAULT_EXPIRES_DAYS = 7;
const ID = /^ho-\d{8}-\d{6}-[a-f0-9]{4}$/;
const NAME = /^[A-Za-z0-9 ._-]{1,40}$/;

const folder = (dir) => join(dir, HANDOFFS);
const pathOf = (dir, id) => join(folder(dir), `${id}.json`);

function stamp(now) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
}

function write(dir, record) {
  mkdirSync(folder(dir), { recursive: true });
  const path = pathOf(dir, record.id);
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, sealFor(dir, `${JSON.stringify(record, null, 2)}\n`), { flag: "wx" });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function audit(dir, entry) {
  appendFileSync(join(dir, "audit.jsonl"), `${sealLine(dir, JSON.stringify({ at: new Date().toISOString(), ...entry }))}\n`);
}

function readAll(dir) {
  if (!existsSync(folder(dir))) return [];
  const out = [];
  for (const name of readdirSync(folder(dir))) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(readData(dir, join(folder(dir), name)));
      if (ID.test(record.id ?? "")) out.push(record);
    } catch {
      // An unreadable file is left alone; doctor and lint report it.
    }
  }
  return out;
}

/** The state as of now: an open handoff past its expiry counts as expired, even before anyone writes that down. */
export function stateOf(record, now = new Date()) {
  if (record.state === "open" && record.expires_at && record.expires_at <= now.toISOString()) return "expired";
  return record.state;
}

const view = (r, now) => ({ id: r.id, state: stateOf(r, now), unread_past_expiry: r.state === "open" && stateOf(r, now) === "expired", origin: r.origin, from: r.from ?? null, created_at: r.created_at, expires_at: r.expires_at, preview: r.text.replace(/\s+/g, " ").slice(0, 120), ...(r.claimed_by ? { claimed_by: r.claimed_by, claimed_at: r.claimed_at } : {}) });

// Manual before auto, then newest first.
const order = (a, b) => (a.origin === b.origin ? b.created_at.localeCompare(a.created_at) : a.origin === "manual" ? -1 : 1);

function checkText(text) {
  if (typeof text !== "string" || text.trim() === "") throw new StoreError("handoff not saved: the text is empty.");
  if (text.length > MAX_TEXT_CHARS) throw new StoreError(`handoff not saved: ${text.length} characters; the limit is ${MAX_TEXT_CHARS}.`);
  if (findHiddenCharacters(text).length > 0) throw new StoreError("handoff not saved: the text holds invisible characters. Remove them.");
  const secrets = findSecrets(text);
  if (secrets.length > 0) throw new StoreError(`handoff not saved: this looks like a secret (${secrets.join(", ")}). Remove it.`);
}

function checkName(name, what) {
  if (name === undefined || name === null) return null;
  if (!NAME.test(name)) throw new StoreError(`${what} must be 1 to 40 letters, digits, spaces, dots, dashes or underscores.`);
  return name;
}

export function createHandoff(dir, { text, origin = "manual", from = null, expiresDays = DEFAULT_EXPIRES_DAYS, now = new Date() }) {
  return withStoreLock(dir, () => {
    keyFor(dir);
    prepareForWrite(dir);
    checkText(text);
    if (origin !== "manual" && origin !== "auto") throw new StoreError("origin must be manual or auto.");
    if (!Number.isInteger(expiresDays) || expiresDays < 1 || expiresDays > 90) throw new StoreError("expires-days must be a whole number from 1 to 90.");
    const id = `ho-${stamp(now)}-${randomBytes(2).toString("hex")}`;
    const record = {
      id, state: "open", origin, from: checkName(from, "from"), text: text.trim(),
      created_at: now.toISOString(), expires_at: new Date(now.getTime() + expiresDays * 86400000).toISOString(),
      flagged: findInstructionLikeText(text) ? "reads like an instruction" : null,
    };
    const replaced = [];
    if (origin === "auto") {
      for (const old of readAll(dir)) {
        if (old.origin === "auto" && stateOf(old, now) === "open") {
          write(dir, { ...old, state: "expired", closed_at: now.toISOString(), closed_reason: `replaced by ${id}` });
          replaced.push(old.id);
        }
      }
    }
    write(dir, record);
    audit(dir, { action: "handoff-create", id, origin, replaced });
    return { id, state: "open", origin, expires_at: record.expires_at, replaced };
  });
}

export function listHandoffs(dir, { all = false, now = new Date() } = {}) {
  const rows = readAll(dir).sort(order).map((r) => view(r, now));
  return { label: DATA_LABEL, handoffs: all ? rows : rows.filter((r) => r.state === "open") };
}

/** Take a handoff exactly once. Without an id, the first open one (manual before auto, newest first). */
export function claimHandoff(dir, { id = null, by = null, now = new Date() } = {}) {
  return withStoreLock(dir, () => {
    keyFor(dir);
    checkName(by, "by");
    const open = readAll(dir).filter((r) => stateOf(r, now) === "open").sort(order);
    const record = id ? readAll(dir).find((r) => r.id === id) : open[0];
    if (!record && id) throw new StoreError(`no handoff "${id}". See them with: stashpad handoff list --all`);
    if (!record) return { claimed: false, reason: "No open handoff." };
    const state = stateOf(record, now);
    if (state !== "open") throw new StoreError(`handoff ${record.id} is ${state}${record.claimed_by ? ` (taken by ${record.claimed_by})` : ""}; it can be read only once.`);
    write(dir, { ...record, state: "claimed", claimed_at: now.toISOString(), claimed_by: by ?? "unnamed session" });
    audit(dir, { action: "handoff-claim", id: record.id, by: by ?? null });
    return { claimed: true, label: DATA_LABEL, id: record.id, origin: record.origin, from: record.from ?? null, created_at: record.created_at, flagged: record.flagged ?? null, text: record.text, others_open: open.length - (open.includes(record) ? 1 : 0) };
  });
}

export function cancelHandoff(dir, id, { reason = null, now = new Date() } = {}) {
  return withStoreLock(dir, () => {
    keyFor(dir);
    const record = readAll(dir).find((r) => r.id === id);
    if (!record) throw new StoreError(`no handoff "${id}". See them with: stashpad handoff list --all`);
    const state = stateOf(record, now);
    if (state !== "open") throw new StoreError(`handoff ${id} is already ${state}.`);
    write(dir, { ...record, state: "cancelled", closed_at: now.toISOString(), closed_reason: reason });
    audit(dir, { action: "handoff-cancel", id, reason });
    return { id, state: "cancelled" };
  });
}

export function openHandoffSummary(dir, now = new Date()) {
  try {
    const open = listHandoffs(dir, { now }).handoffs;
    return open.length ? { count: open.length, first: open[0] } : null;
  } catch {
    return null;
  }
}

