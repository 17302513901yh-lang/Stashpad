// Per-prompt recall: given what the user just asked, find the few memories that clearly match and
// return a short block, or nothing. Used by the prompt hook, so it must be fast, small and quiet:
// a weak match adds noise to every prompt, so only clear matches are returned.
import { DATA_LABEL } from "./security.mjs";
import { searchMemories } from "./store.mjs";
import { keyTerms } from "./search.mjs";

export const DEFAULT_RECALL_CHARS = 700;

function oneLine(text, max) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

// A match is clear when it shares at least two meaningful words with the prompt (synonyms count
// only as a bonus), or one rare-looking word when the prompt itself is very short.
export function recall(dir, prompt, { limit = 3, maxChars = DEFAULT_RECALL_CHARS, exclude = [] } = {}) {
  const text = String(prompt ?? "").slice(0, 4000);
  const terms = new Set(keyTerms(text));
  if (terms.size === 0) return { text: "", hits: [] };
  const { results } = searchMemories(dir, text, { limit: 10, explain: true });
  const skip = new Set(exclude);
  const hits = results
    .filter((r) => !skip.has(r.id))
    .filter((r) => {
      const exact = r.matched.filter((m) => !m.endsWith("(synonym)") && m.length >= 4);
      return exact.length >= 2 || (terms.size <= 2 && exact.length >= 1);
    })
    .slice(0, limit);
  if (hits.length === 0) return { text: "", hits: [] };
  const lines = [`${DATA_LABEL}`, "Stashpad memories that match this request:"];
  let used = lines.join("\n").length;
  const shown = [];
  for (const hit of hits) {
    const line = `- [${hit.kind}] ${hit.id}: ${oneLine(hit.summary, 220)}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
    shown.push(hit.id);
  }
  return { text: shown.length ? lines.join("\n") : "", hits: shown };
}
