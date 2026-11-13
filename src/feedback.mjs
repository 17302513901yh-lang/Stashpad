// Feedback and lint: small, rule-based upkeep. No language model is called.
// feedback: an agent or person says a memory was helpful, stale or wrong. It is logged; "wrong" also queues an ending
//           request, which a person accepts or rejects like any other.
// lint:     what deserves a look: memories marked stale or wrong, agent memories nobody confirmed for a long time,
//           memories that expire soon, broken supersede links, instruction-like text, and open handoffs past expiry.
// Ideas from ai-memory's memory_feedback and lint (MIT, akitaonrails), rebuilt for Stashpad's review model.
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { StoreError } from "./errors.mjs";
import { withStoreLock } from "./lock.mjs";
import { keyFor, openLine, readData, sealLine } from "./vault.mjs";
import { findInstructionLikeText, findSecrets } from "./security.mjs";
import { isReservedWindowsId } from "./memory-format.mjs";
import { isCurrent, queueForget, readEntries, readMemory, staleMemories, todayIso } from "./store.mjs";
import { listHandoffs } from "./handoff.mjs";
import { readPins } from "./pins.mjs";
import { lastShown } from "./shown.mjs";
import { anchorContext, checkAnchors, projectRoot, readAnchorsFile } from "./anchors.mjs";

export const SIGNALS = ["helpful", "stale", "wrong"];
const FEEDBACK = "feedback.jsonl";

export function giveFeedback(dir, id, { signal, note = null, by = null } = {}) {
  if (!SIGNALS.includes(signal)) throw new StoreError(`signal must be one of ${SIGNALS.join(", ")}.`);
  readMemory(dir, id); // throws a clear error when the memory does not exist
  if (note !== null && (/[\r\n]/.test(note) || note.length > 300)) throw new StoreError("note must be one line of at most 300 characters.");
  // A note is free text that is written to the store, so it gets the same
  // secret check as memories, handoff text and ending/reject reasons. Do it
  // before the lock and the append: with --signal wrong the ending request
  // would refuse the note anyway, but the feedback line would already exist.
  if (note !== null) {
    const secrets = findSecrets(note);
    if (secrets.length > 0) throw new StoreError(`feedback not saved: the note looks like a secret (${secrets.join(", ")}). Remove it. Notes must not hold keys or passwords.`);
  }
  withStoreLock(dir, () => {
    keyFor(dir);
    appendFileSync(join(dir, FEEDBACK), `${sealLine(dir, JSON.stringify({ at: new Date().toISOString(), id, signal, note, by }))}\n`);
  });
  let queued = null;
  if (signal === "wrong") {
    try {
      queued = queueForget(dir, id, `marked wrong${note ? `: ${note}` : ""}`, by ? `feedback from ${by}` : "feedback", "agent");
    } catch (error) {
      queued = { error: error.message };
    }
  }
  return { id, signal, recorded: true, ...(queued ? { forget_request: queued } : {}) };
}

export function readFeedback(dir) {
  const path = join(dir, FEEDBACK);
  if (!existsSync(path)) return [];
  return readData(dir, path)
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(openLine(dir, l));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const addDays = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export function lint(dir, { today = todayIso(), staleDays = 180, soonDays = 14, unusedDays = 90, now = new Date(), cwd = process.cwd() } = {}) {
  const findings = [];
  const add = (rule, id, message) => findings.push({ rule, id, message });
  const { entries } = readEntries(dir);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const current = entries.filter((e) => isCurrent(e.meta, today));

  // Latest feedback per memory decides; a later "helpful" clears an earlier "stale".
  const latest = new Map();
  for (const f of readFeedback(dir)) latest.set(f.id, f);
  for (const [id, f] of latest) {
    const entry = byId.get(id);
    if (!entry || !isCurrent(entry.meta, today)) continue;
    if (f.signal === "stale") add("marked-stale", id, `marked stale${f.note ? ` (${f.note})` : ""}: confirm it, supersede it or end it.`);
    if (f.signal === "wrong") add("marked-wrong", id, `marked wrong${f.note ? ` (${f.note})` : ""}: an ending request waits in review.`);
  }
  for (const s of staleMemories(dir, { days: staleDays, today })) add("unconfirmed", s.id ?? s, `agent memory not confirmed for ${staleDays}+ days: stashpad confirm ${s.id ?? s}, or end it.`);
  const soon = addDays(today, soonDays);
  for (const e of current) {
    if (e.meta.valid_to !== null && e.meta.valid_to <= soon) add("expires-soon", e.id, `ends on ${e.meta.valid_to}.`);
    if (findInstructionLikeText(e.body)) add("reads-like-instruction", e.id, "the text reads like an order; it stays data, but a person should check it.");
  }
  for (const e of entries) {
    if (isReservedWindowsId(e.id)) add("id-not-portable", e.id, "Windows reserves this name for a device, so the store cannot be checked out there: save a new id with --supersedes and end this one.");
    if (e.meta.supersedes && !byId.has(e.meta.supersedes)) add("broken-link", e.id, `supersedes ${e.meta.supersedes}, which is not in the store.`);
    if (e.meta.superseded_by && !byId.has(e.meta.superseded_by)) add("broken-link", e.id, `superseded_by ${e.meta.superseded_by}, which is not in the store.`);
  }
  // A pin that no longer reaches the agent still takes one of the pin slots, so say so.
  let pins = [];
  try {
    pins = readPins(dir);
  } catch {
    // pins are optional here, as handoffs are below
  }
  for (const id of pins) {
    const entry = byId.get(id);
    if (!entry) add("pin-missing", id, `pinned, but no memory file has this id: stashpad unpin ${id}.`);
    else if (!isCurrent(entry.meta, today)) add("pin-ended", id, `pinned, but no longer current, so the brief skips it: stashpad unpin ${id}.`);
  }
  // Agent memories nothing has shown for 90 days: maybe no longer useful. Only once the log has run that long.
  const shownLog = lastShown(dir);
  const quiet = addDays(today, -unusedDays);
  if (shownLog.since !== null && shownLog.since <= quiet) {
    const pinned = new Set(pins);
    for (const e of current) {
      // Confirming it is how a person says "keep it", so a recent confirmation counts as use.
      if (e.meta.source_type === "user" || pinned.has(e.id) || e.meta.created_at > quiet || e.meta.last_confirmed_at > quiet) continue;
      const last = shownLog.last[e.id];
      if (!last || last < quiet) add("never-shown", e.id, `not shown to an agent for ${unusedDays}+ days${last ? ` (last ${last})` : ""}: keep it (stashpad confirm ${e.id}), or end it (stashpad forget ${e.id} --reason "unused").`);
    }
  }
  // Memories anchored to files that changed, moved or are gone since a person last confirmed them.
  try {
    const { anchors } = readAnchorsFile(dir);
    const root = projectRoot(dir, cwd);
    const context = anchorContext(root);
    for (const e of current) {
      if (!anchors[e.id]) continue;
      const status = checkAnchors(dir, e.id, { root, anchors, context });
      if (status.gone) add("anchor-gone", e.id, `every file it is about is gone (${status.files.map((f) => f.path).join(", ")}): end it with stashpad forget ${e.id}, or anchor it again.`);
      else if (status.changed) {
        const what = status.files.filter((f) => f.state !== "same").map((f) => (f.to ? `${f.path} -> ${f.to}` : `${f.path} ${f.state}`)).join(", ");
        add("anchor-changed", e.id, `files changed since it was saved (${what}): check it, then stashpad confirm ${e.id} (re-anchors), or supersede it.`);
      }
    }
  } catch (error) {
    add("anchors-unreadable", "anchors.json", error.message);
  }
  try {
    for (const h of listHandoffs(dir, { all: true, now }).handoffs) if (h.unread_past_expiry) add("handoff-expired", h.id, "handoff passed its expiry unread; the work it describes may still be open.");
  } catch {
    // handoffs are optional
  }
  return { findings, counts: Object.fromEntries([...new Set(findings.map((f) => f.rule))].map((r) => [r, findings.filter((f) => f.rule === r).length])), checked: entries.length, current: current.length };
}
