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
import { findInstructionLikeText } from "./security.mjs";
import { isCurrent, queueForget, readEntries, readMemory, staleMemories, todayIso } from "./store.mjs";
import { listHandoffs } from "./handoff.mjs";

export const SIGNALS = ["helpful", "stale", "wrong"];
const FEEDBACK = "feedback.jsonl";

export function giveFeedback(dir, id, { signal, note = null, by = null } = {}) {
  if (!SIGNALS.includes(signal)) throw new StoreError(`signal must be one of ${SIGNALS.join(", ")}.`);
  readMemory(dir, id); // throws a clear error when the memory does not exist
  if (note !== null && (/[\r\n]/.test(note) || note.length > 300)) throw new StoreError("note must be one line of at most 300 characters.");
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

export function lint(dir, { today = todayIso(), staleDays = 180, soonDays = 14, now = new Date() } = {}) {
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
    if (e.meta.supersedes && !byId.has(e.meta.supersedes)) add("broken-link", e.id, `supersedes ${e.meta.supersedes}, which is not in the store.`);
    if (e.meta.superseded_by && !byId.has(e.meta.superseded_by)) add("broken-link", e.id, `superseded_by ${e.meta.superseded_by}, which is not in the store.`);
  }
  try {
    for (const h of listHandoffs(dir, { all: true, now }).handoffs) if (h.unread_past_expiry) add("handoff-expired", h.id, "handoff passed its expiry unread; the work it describes may still be open.");
  } catch {
    // handoffs are optional
  }
  return { findings, counts: Object.fromEntries([...new Set(findings.map((f) => f.rule))].map((r) => [r, findings.filter((f) => f.rule === r).length])), checked: entries.length, current: current.length };
}
