// Imports memories from a text export or JSON Lines. Every imported memory waits for review.
import { createHash } from "node:crypto";
import { StoreError, saveMemory } from "./store.mjs";

// JSON Lines: one object per line with id, kind, text, and optional valid_from and source_ref.
// Plain text: each paragraph (separated by a blank line) becomes one fact.
export function parseImport(content, format) {
  const items = [];
  const errors = [];

  if (format === "jsonl") {
    content.split("\n").forEach((line, index) => {
      if (line.trim() === "") return;
      try {
        const item = JSON.parse(line);
        items.push({
          id: String(item.id ?? ""),
          kind: String(item.kind ?? "fact"),
          text: String(item.text ?? ""),
          validFrom: item.valid_from ?? undefined,
          sourceRef: item.source_ref ?? undefined,
          validTo: item.valid_to ?? undefined,
        });
      } catch {
        errors.push({ line: index + 1, reason: "not valid JSON" });
      }
    });
    return { items, errors };
  }

  if (format === "text") {
    content
      .replace(/\r\n/g, "\n")
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => paragraph !== "")
      .forEach((paragraph) => {
        const digest = createHash("sha256").update(paragraph).digest("hex").slice(0, 10);
        items.push({ id: `import-${digest}`, kind: "fact", text: paragraph, validFrom: undefined, sourceRef: undefined });
      });
    return { items, errors };
  }

  throw new StoreError(`unknown format "${format}". Use jsonl or text.`);
}

// Every item goes through the normal save path, so it is checked and queued for review.
export function importMemories(dir, content, { format, sourceRef, today }) {
  const { items, errors } = parseImport(content, format);
  const queued = [];
  const skipped = errors.map((e) => ({ id: `line ${e.line}`, reason: e.reason }));

  for (const item of items) {
    // An ended memory from an export is history, not a current fact, so it is not imported as one.
    if (item.validTo) {
      skipped.push({ id: item.id || "(no id)", reason: "already ended in the export; only current facts are imported" });
      continue;
    }
    try {
      saveMemory(
        dir,
        {
          id: item.id,
          kind: item.kind,
          text: item.text,
          sourceType: "tool",
          sourceRef: item.sourceRef ?? sourceRef,
          validFrom: item.validFrom,
        },
        today,
      );
      queued.push(item.id);
    } catch (error) {
      skipped.push({ id: item.id || "(no id)", reason: error.message.split("\n")[0] });
    }
  }
  return { queued, skipped };
}
