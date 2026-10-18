// Query expansion with groups of words that mean nearly the same. A match through a synonym counts
// half as much as an exact match, so exact words still rank first. The built-in groups are small and
// general (English and Dutch). A person can add their own in <store>/synonyms.json:
//   { "groups": [["db", "database", "datastore"], ["pr", "pull request"]] }
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stem, tokenize } from "./search.mjs";

export const SYNONYM_WEIGHT = 0.5;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_GROUPS = 500;
const MAX_GROUP_SIZE = 20;

export const BUILTIN_GROUPS = [
  ["password", "passwd", "credential", "wachtwoord", "sleutel"],
  ["database", "db", "datastore"],
  ["note", "notitie", "memory"],
  ["delete", "remove", "forget", "verwijder"],
  ["deploy", "release", "publish", "uitrollen", "uitrol", "uitgerold"],
  ["error", "bug", "failure", "fout"],
  ["theme", "color", "colour", "kleur"],
  ["language", "taal"],
  ["editor", "ide"],
  ["agent", "assistant", "assistent"],
  ["secret", "geheim"],
  ["windows", "macos", "linux", "platform", "platforms"],
];

// Words of a group, as the search sees them: lowercase and stemmed. A phrase becomes several words.
function termsOfEntry(entry) {
  return tokenize(String(entry)).map(stem);
}

// Returns Map<term, Set<term>>. A multi-word entry is kept as one group member by its words.
export function buildSynonymMap(groups) {
  const map = new Map();
  for (const group of groups) {
    const members = group.map(termsOfEntry).filter((terms) => terms.length > 0);
    for (const terms of members) {
      for (const term of terms) {
        if (!map.has(term)) map.set(term, new Set());
        for (const other of members) for (const o of other) if (o !== term) map.get(term).add(o);
      }
    }
  }
  return map;
}

// Reads <store>/synonyms.json. Returns { groups, problem }. A bad file is ignored, never fatal.
export function loadStoreSynonyms(dir) {
  const path = join(dir, "synonyms.json");
  if (!existsSync(path)) return { groups: [], problem: null };
  try {
    const info = lstatSync(path);
    if (!info.isFile()) return { groups: [], problem: "synonyms.json must be a normal file, not a link" };
    if (info.size > MAX_FILE_BYTES) return { groups: [], problem: "synonyms.json is larger than 64 KB" };
    const data = JSON.parse(readFileSync(path, "utf8"));
    const raw = Array.isArray(data?.groups) ? data.groups : null;
    if (raw === null) return { groups: [], problem: 'synonyms.json needs {"groups": [[...], ...]}' };
    const groups = raw
      .slice(0, MAX_GROUPS)
      .filter((g) => Array.isArray(g) && g.length >= 2 && g.length <= MAX_GROUP_SIZE && g.every((w) => typeof w === "string"));
    const dropped = raw.length - groups.length;
    return { groups, problem: dropped > 0 ? `${dropped} group(s) ignored (each needs 2 to ${MAX_GROUP_SIZE} words)` : null };
  } catch (error) {
    return { groups: [], problem: `synonyms.json cannot be read: ${error.message}` };
  }
}

export function synonymMapFor(dir) {
  return buildSynonymMap([...BUILTIN_GROUPS, ...loadStoreSynonyms(dir).groups]);
}
