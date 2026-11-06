// Per-prompt recall: given what the user just asked, find the few memories that clearly match and
// return a short block, or nothing. Used by the prompt hook, so it must be fast, small and quiet:
// a weak match adds noise to every prompt, so only clear matches are returned.
import { DATA_LABEL } from "./security.mjs";
import { readMemory, searchMemories } from "./store.mjs";
import { parseMemory } from "./memory-format.mjs";
import { WHY_QUESTION, decisionLine, parseDecision } from "./decisions.mjs";
import { keyTerms } from "./search.mjs";
import { anchorContext, anchorNote, checkAnchors, projectRoot, readAnchors } from "./anchors.mjs";

export const DEFAULT_RECALL_CHARS = 700;

function oneLine(text, max) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

// A request that names an option a decision rejected ("switch to SQLite") should see that decision,
// even on one shared word: that is the moment an agent is about to undo it.
function namesRejected(dir, hit, exact) {
  if (hit.kind !== "decision" || exact.length === 0) return false;
  try {
    const lost = new Set(keyTerms((parseDecision(parseMemory(readMemory(dir, hit.id).text).body)?.rejected ?? []).join(" ")));
    return exact.some((term) => lost.has(term));
  } catch {
    return false;
  }
}

// A decision with its reason and the options that lost, when it follows the decision layout.
function decisionSummary(dir, hit) {
  try {
    return decisionLine(parseMemory(readMemory(dir, hit.id).text).body) ?? hit.summary;
  } catch {
    return hit.summary;
  }
}

function safeCheck(dir, id, anchors, context) {
  try {
    return checkAnchors(dir, id, { root: context.root, anchors, context });
  } catch {
    return null;
  }
}

// A match is clear when it shares at least two meaningful words with the prompt (synonyms count
// only as a bonus), or one rare-looking word when the prompt itself is very short.
// anchorMoves: false (the hooks) skips the search for moved files; lint and `stashpad anchors` do it.
export function recall(dir, prompt, { limit = 3, maxChars = DEFAULT_RECALL_CHARS, exclude = [], cwd = process.cwd(), anchorMoves = true } = {}) {
  const text = String(prompt ?? "").slice(0, 4000);
  const terms = new Set(keyTerms(text));
  if (terms.size === 0) return { text: "", hits: [] };
  const { results } = searchMemories(dir, text, { limit: 10, explain: true });
  const skip = new Set(exclude);
  // A "why" question (why, decided, chose, convention, policy...) is answered by decisions: they come
  // first, and one shared word is enough for them.
  const why = WHY_QUESTION.test(text);
  const hits = results
    .filter((r) => !skip.has(r.id))
    .filter((r) => {
      const exact = r.matched.filter((m) => !m.endsWith("(synonym)") && m.length >= 4);
      return exact.length >= 2 || (terms.size <= 2 && exact.length >= 1) || (why && r.kind === "decision" && exact.length >= 1) || namesRejected(dir, r, exact);
    })
    .sort((a, b) => (why ? (b.kind === "decision") - (a.kind === "decision") : 0))
    .slice(0, limit);
  if (hits.length === 0) return { text: "", hits: [] };
  // Memories anchored to files say when those files changed; one whose files are all gone is skipped.
  const anchors = readAnchors(dir);
  const context = Object.keys(anchors).length ? anchorContext(projectRoot(dir, cwd), { moves: anchorMoves }) : null;
  const lines = [`${DATA_LABEL}`, "Stashpad memories that match this request:"];
  let used = lines.join("\n").length;
  const shown = [];
  let gone = 0;
  for (const hit of hits) {
    const status = context && anchors[hit.id] ? safeCheck(dir, hit.id, anchors, context) : null;
    if (status?.gone) {
      gone += 1;
      continue;
    }
    const line = `- [${hit.kind}] ${hit.id}: ${oneLine(hit.kind === "decision" ? decisionSummary(dir, hit) : hit.summary, 220)}${anchorNote(status)}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
    shown.push(hit.id);
  }
  if (gone > 0 && shown.length > 0) lines.push(`${gone} more skipped: the files ${gone === 1 ? "it is" : "they are"} about are gone (stashpad anchors).`);
  return { text: shown.length ? lines.join("\n") : "", hits: shown };
}
