// Searches that found nothing. Word search misses rewordings ("postgresql" vs "postgres"); the log
// shows which words people and agents use that the memories do not, and suggests synonyms for them.
// Only the meaningful words of a query are kept, never the whole query, and the log is sealed in an
// encrypted store. Logging never fails a search.
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./fsx.mjs";
import { withStoreLock } from "./lock.mjs";
import { keyTerms, tokenize, stem } from "./search.mjs";
import { isCurrent, readEntries, todayIso } from "./store.mjs";
import { loadStoreSynonyms } from "./synonyms.mjs";
import { keyFor, openLine, sealLine } from "./vault.mjs";
import { StoreError } from "./errors.mjs";

export const MISSES_FILE = "misses.jsonl";
const MAX_BYTES = 200 * 1024;
const KEEP_LINES = 500;

export function logMiss(dir, query) {
  try {
    if (!existsSync(dir)) return;
    const terms = [...new Set(keyTerms(String(query)))].slice(0, 8);
    if (terms.length === 0) return;
    const path = join(dir, MISSES_FILE);
    appendFileSync(path, `${sealLine(dir, JSON.stringify({ at: new Date().toISOString().slice(0, 10), terms }))}\n`);
    if (statSync(path).size > MAX_BYTES) {
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      writeAtomic(path, `${lines.slice(-KEEP_LINES).join("\n")}\n`);
    }
  } catch {
    // a miss that cannot be logged is not worth an error
  }
}

function distance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

// The most missed words, with words from the memories that look close (typos, longer or shorter forms).
export function missReport(dir, { top = 15 } = {}) {
  const path = join(dir, MISSES_FILE);
  if (!existsSync(path)) return [];
  const counts = new Map();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      for (const term of JSON.parse(openLine(dir, line)).terms ?? []) counts.set(term, (counts.get(term) ?? 0) + 1);
    } catch (error) {
      if (error instanceof StoreError) throw error;
    }
  }
  const vocab = new Set();
  for (const entry of readEntries(dir).entries) {
    if (!isCurrent(entry.meta, todayIso())) continue;
    for (const word of tokenize(`${entry.id.replace(/-/g, " ")} ${entry.body}`)) if (word.length >= 3) vocab.add(stem(word));
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, top)
    .map(([term, count]) => {
      const close = [...vocab]
        .filter((w) => w !== term && w.length >= 4 && (distance(term, w) <= 2 || (Math.min(term.length, w.length) >= 5 && (term.startsWith(w) || w.startsWith(term)))))
        .slice(0, 3);
      return { term, count, close };
    });
}

// Adds one synonym group to <store>/synonyms.json (a person only, from the command line).
export function addSynonyms(dir, words) {
  const group = [...new Set(words.map((w) => String(w).trim().toLowerCase()).filter(Boolean))];
  if (group.length < 2 || group.length > 20) throw new StoreError("a synonym group needs 2 to 20 words.");
  return withStoreLock(dir, () => {
    keyFor(dir);
    const path = join(dir, "synonyms.json");
    const { groups } = loadStoreSynonyms(dir);
    const next = [...groups, group];
    writeAtomic(path, `${JSON.stringify({ groups: next }, null, 2)}\n`);
    return { groups: next.length };
  });
}
