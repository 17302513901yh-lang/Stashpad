// Export for lock-in avoidance: memories as JSON Lines, one object per line, readable without Stashpad.
import { isCurrent, readEntries, todayIso } from "./store.mjs";

// Current memories by default. With includeEnded, ended ones too (they carry valid_to).
export function exportMemories(dir, { includeEnded = false, today = todayIso() } = {}) {
  const { entries, skipped } = readEntries(dir);
  const lines = entries
    .filter((entry) => includeEnded || isCurrent(entry.meta, today))
    .map(({ id, body, meta }) =>
      JSON.stringify({
        id,
        kind: meta.kind,
        text: body,
        valid_from: meta.valid_from,
        valid_to: meta.valid_to,
        supersedes: meta.supersedes,
        superseded_by: meta.superseded_by,
        source_type: meta.source_type,
        source_ref: meta.source_ref,
        trust: meta.trust,
        created_at: meta.created_at,
        last_confirmed_at: meta.last_confirmed_at,
      }),
    );
  return { text: lines.map((line) => `${line}\n`).join(""), count: lines.length, skipped };
}
