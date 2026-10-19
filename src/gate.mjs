// The gatekeeper: checks for memories an agent, tool or web page proposes. Auto-capture tends to
// fill a store with near-copies and empty notes, which buries the useful ones. Memories a person
// writes themselves are never blocked here.
import { keyTerms } from "./search.mjs";

export const MIN_WORDS = 3;
export const DUPLICATE_SIMILARITY = 0.8;

export function similarity(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const term of a) if (b.has(term)) shared += 1;
  return shared / (a.size + b.size - shared);
}

// `existing` is a list of { id, body } for current memories and waiting writes.
// Returns null when the text may pass, or a short reason it was refused.
export function gateReason(body, existing) {
  const words = body.trim().split(/\s+/).filter(Boolean);
  if (words.length < MIN_WORDS) {
    return `too short to be useful (${words.length} word${words.length === 1 ? "" : "s"}; at least ${MIN_WORDS}). Say what is true and why it matters.`;
  }
  const mine = new Set(keyTerms(body));
  if (mine.size === 0) return "it holds no searchable content words.";
  for (const other of existing) {
    if (similarity(mine, new Set(keyTerms(other.body))) >= DUPLICATE_SIMILARITY) {
      return `it is almost the same as "${other.id}". Update that one with --supersedes if the fact changed.`;
    }
  }
  return null;
}

// Overlap: shared words divided by the size of the smaller note. A changed fact often keeps most of
// the shorter note's words ("the database is X" -> "the database is Y").
export const RELATED_OVERLAP = 0.6;

function overlap(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const term of a) if (b.has(term)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

// Memories that look related but are not copies: the new note may replace one of them.
// Returned best first, at most three, so an agent or reviewer can decide on a supersede.
export function relatedTo(body, existing) {
  const mine = new Set(keyTerms(body));
  return existing
    .map((other) => {
      const theirs = new Set(keyTerms(other.body));
      return { id: other.id, similarity: overlap(mine, theirs), copy: similarity(mine, theirs) >= DUPLICATE_SIMILARITY };
    })
    .filter((c) => c.similarity >= RELATED_OVERLAP && !c.copy)
    .sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id))
    .slice(0, 3)
    .map((c) => ({ id: c.id, similarity: Math.round(c.similarity * 100) / 100 }));
}
