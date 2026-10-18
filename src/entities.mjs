// Things the memories talk about: names, tools, files. Found with fixed rules, no model, and
// computed on each call like search, so nothing extra is stored and nothing can go stale.
// Idea from the MCP reference memory server (entities, observations, open_nodes); here an
// "observation" is simply a memory that mentions the entity, and a relation is two entities
// mentioned in the same memory.
import { DATA_LABEL } from "./security.mjs";
import { isCurrent, readEntries, todayIso } from "./store.mjs";

const FILE_EXT = "md|mjs|cjs|js|jsx|ts|tsx|py|json|jsonl|toml|ya?ml|go|rs|cs|gd|tscn|sh|sql|html|css";
const FILE = new RegExp(String.raw`(?:^|[\s(\["'])((?:[\w.-]+\/)*[\w-]+\.(?:${FILE_EXT}))(?=$|[\s),.;:!?\]"'])`, "gu");
const TICKED = /`([^`\n]{2,60})`/g;
// Common words that start sentences or are capitalized for other reasons.
const STOP = new Set(
  ("the a an this that these those it its we i he she they you our my your his her their there here then when if and or but so " +
  "every each all any some no not use do does done is are was were be been has have had will would can could should must may " +
  "de het een dit dat deze die wij we ik hij zij ze jij je jullie ons onze mijn elke elk alle als en of maar dus niet wel " +
  "monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december " +
  "maandag dinsdag woensdag donderdag vrijdag zaterdag zondag").split(" "),
);

const isNameWord = (w) => /^[\p{Lu}\d][\p{L}\d+#.-]*$/u.test(w) && /\p{L}/u.test(w) && w.length >= 2;
// "SQLite", "BM25", "MCP": capitals inside the word or digits mean a name even at a sentence start.
const isStrongName = (w) => /\p{Lu}.*\p{Lu}|\d/u.test(w.slice(1)) || /^\p{Lu}{2,}$/u.test(w);

export function extractEntities(text) {
  const found = new Map(); // key -> display name
  const add = (name) => {
    const clean = name.trim().replace(/[.,;:!?]+$/, "");
    if (clean.length < 2 || clean.length > 60) return;
    const key = clean.toLowerCase();
    if (STOP.has(key)) return;
    if (!found.has(key)) found.set(key, clean);
  };

  for (const m of text.matchAll(TICKED)) add(m[1]);
  for (const m of text.matchAll(FILE)) add(m[1]);

  const plain = text.replace(TICKED, " ");
  for (const sentence of plain.split(/(?<=[.!?])\s+|\n+/)) {
    const raw = sentence.split(/\s+/);
    const words = raw.map((w) => w.replace(/^[("'[]+|[)"'\],.;:!?]+$/g, ""));
    let run = [];
    const flush = () => {
      if (run.length > 0) add(run.join(" "));
      run = [];
    };
    words.forEach((word, index) => {
      const name = isNameWord(word) && !STOP.has(word.toLowerCase()) && (index > 0 || isStrongName(word));
      if (name && run.length < 3) run.push(word);
      else {
        flush();
        if (name) run.push(word);
      }
      // A comma or other mark ends a name: "Linux, Windows" is two names.
      if (/[,;:)\]]$/.test(raw[index])) flush();
    });
    flush();
  }
  return [...found.values()];
}

function index(dir, { today = todayIso(), includeEnded = false } = {}) {
  const { entries } = readEntries(dir);
  const byKey = new Map();
  for (const entry of entries) {
    if (!includeEnded && !isCurrent(entry.meta, today)) continue;
    const names = extractEntities(entry.body);
    const keys = names.map((n) => n.toLowerCase());
    names.forEach((name, i) => {
      const key = keys[i];
      if (!byKey.has(key)) byKey.set(key, { name, memories: [], related: new Map() });
      const item = byKey.get(key);
      item.memories.push(entry);
      for (const other of keys) if (other !== key) item.related.set(other, (item.related.get(other) ?? 0) + 1);
    });
  }
  return byKey;
}

const summary = (entry) => ({
  id: entry.id,
  kind: entry.meta.kind,
  valid_from: entry.meta.valid_from,
  trust: entry.meta.trust,
  summary: entry.body.split("\n")[0],
});

// Entities with how many memories mention them, most mentioned first.
export function listEntities(dir, { limit = 50, minCount = 1, ...options } = {}) {
  const byKey = index(dir, options);
  const rows = [...byKey.values()]
    .filter((e) => e.memories.length >= minCount)
    .map((e) => ({ name: e.name, memories: e.memories.length }))
    .sort((a, b) => b.memories - a.memories || a.name.localeCompare(b.name));
  return { total: rows.length, rows: rows.slice(0, limit) };
}

// Everything about one entity: the memories that mention it and what is mentioned with it.
export function aboutEntity(dir, name, options = {}) {
  const byKey = index(dir, options);
  const key = String(name).trim().toLowerCase();
  const item = byKey.get(key);
  if (!item) {
    const close = [...byKey.values()]
      .filter((e) => e.name.toLowerCase().includes(key) || key.includes(e.name.toLowerCase()))
      .map((e) => e.name)
      .slice(0, 5);
    return { label: DATA_LABEL, name, found: false, did_you_mean: close, memories: [], related: [] };
  }
  const related = [...item.related.entries()]
    .map(([k, count]) => ({ name: byKey.get(k).name, together: count }))
    .sort((a, b) => b.together - a.together || a.name.localeCompare(b.name))
    .slice(0, 10);
  return { label: DATA_LABEL, name: item.name, found: true, memories: item.memories.map(summary), related };
}
