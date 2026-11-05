// Decisions with their reason and the options that lost. The memory format stays the same: a
// decision is a memory of kind "decision" whose body follows a fixed layout, readable by a person and
// by this code:
//
//   We use Postgres for the main database.
//   Why: several workers write at the same time.
//   Rejected: SQLite, MongoDB
//   Decided by: the team in the planning call
//
// The first line is the choice; the other lines are optional and come in this order.
import { StoreError } from "./errors.mjs";

const LABELS = { why: "Why", rejected: "Rejected", by: "Decided by" };
const MAX_CHOICE = 300;
const MAX_WHY = 600;

function oneLine(value, what, max) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (text === "") return null;
  if (/[\r\n]/.test(text)) throw new StoreError(`${what} must be one line.`);
  if (text.length > max) throw new StoreError(`${what} is ${text.length} characters; the limit is ${max}.`);
  return text;
}

// "A, B" or ["A", "B, C"] -> ["A", "B", "C"]
export function splitOptions(value) {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return [...new Set(list.flatMap((v) => String(v).split(/[,;]/)).map((v) => v.trim()).filter(Boolean))];
}

export function decisionBody({ choice, why = null, rejected = [], by = null }) {
  const first = oneLine(choice, "the choice", MAX_CHOICE);
  if (!first) throw new StoreError('a decision needs the choice, for example: stashpad decide "We use Postgres" --why "concurrent writers"');
  const reason = oneLine(why, "--why", MAX_WHY);
  const lost = splitOptions(rejected).map((o) => oneLine(o, "a rejected option", 120));
  const who = oneLine(by, "--by", 120);
  const lines = [first];
  if (reason) lines.push(`${LABELS.why}: ${reason}`);
  if (lost.length) lines.push(`${LABELS.rejected}: ${lost.join(", ")}`);
  if (who) lines.push(`${LABELS.by}: ${who}`);
  return lines.join("\n");
}

// The parts of a decision body, or null when the body does not follow the layout (any first line
// counts as the choice; the labelled lines are what makes it a structured decision).
export function parseDecision(body) {
  const lines = String(body).split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const out = { choice: lines[0], why: null, rejected: [], by: null };
  let structured = false;
  for (const line of lines.slice(1)) {
    const match = /^(Why|Rejected|Decided by):\s*(.*)$/.exec(line);
    if (!match) continue;
    structured = true;
    if (match[1] === "Why") out.why = match[2];
    if (match[1] === "Rejected") out.rejected = splitOptions(match[2]);
    if (match[1] === "Decided by") out.by = match[2];
  }
  return structured ? out : null;
}

// "We use Postgres (rejected: SQLite, MongoDB; why: concurrent writers)", or null for a body that
// does not follow the layout.
export function decisionLine(body) {
  const d = parseDecision(body);
  if (!d) return null;
  const extra = [];
  if (d.rejected.length) extra.push(`rejected: ${d.rejected.join(", ")}`);
  if (d.why) extra.push(`why: ${d.why}`);
  return extra.length ? `${d.choice} (${extra.join("; ")})` : d.choice;
}

// An id from the choice when none is given: decision-<first words>, with a number when it is taken.
export function decisionId(choice, taken = () => false) {
  const words = String(choice).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").match(/[a-z0-9]+/g) ?? [];
  const stem = `decision-${words.slice(0, 6).join("-") || "note"}`.slice(0, 60).replace(/-+$/, "");
  let id = stem;
  for (let n = 2; taken(id); n += 1) id = `${stem}-${n}`;
  return id;
}

// Prompts that ask why, or about a choice or a rule: decisions are what answers them.
export const WHY_QUESTION = /\b(?:why|reasons?|decid\w*|decision|chose|chosen|choose|choice|convention|policy|waarom|reden|besloten|besluit|gekozen|keuze)\b/i;
