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

export function exportMarkdown(dir, { includeEnded = false, today = todayIso() } = {}) {
  const { entries, skipped } = readEntries(dir);
  const current = entries.filter((entry) => isCurrent(entry.meta, today));
  const ended = includeEnded ? entries.filter((entry) => !isCurrent(entry.meta, today)) : [];
  const section = (entry, heading = "##") => {
    const { id, body, meta } = entry;
    const validTo = meta.valid_to ?? "current";
    return `${heading} ${id}\n- Kind: ${meta.kind}\n- Valid from: ${meta.valid_from}\n- Valid to: ${validTo}\n- Source: ${meta.source_type}: ${meta.source_ref}\n\n${body}`;
  };
  const parts = ["# Stashpad export", ...current.map((entry) => section(entry))];
  if (ended.length > 0) parts.push(`## Ended memories\n\n${ended.map((entry) => section(entry, "###")).join("\n\n")}`);
  return { text: `${parts.join("\n\n")}\n`, count: current.length + ended.length, skipped };
}
