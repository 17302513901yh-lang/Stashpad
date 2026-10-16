// File-based store for Stashpad memories. No index: every read goes to the files.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  REQUIRED_KEYS,
  TRUST_BY_SOURCE,
  isValidId,
  parseMemory,
  validateMemory,
} from "./memory-format.mjs";

export class StoreError extends Error {}

export function todayIso(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function filePath(dir, id) {
  return join(dir, `${id}.md`);
}

function renderMemory(meta, body) {
  const lines = ["---"];
  for (const key of REQUIRED_KEYS) {
    const value = meta[key];
    lines.push(`${key}: ${value === null ? "null" : value}`);
  }
  lines.push("---", body, "");
  return lines.join("\n");
}

// Writes a new memory file. Never overwrites: a changed fact needs a new id.
export function saveMemory(dir, input, today = todayIso()) {
  const { id, kind, text, sourceType, sourceRef, validFrom } = input;

  if (!isValidId(id)) {
    throw new StoreError(
      `invalid id "${id}". Use lowercase letters, digits and hyphens, for example "db-choice".`,
    );
  }
  if (/[\r\n]/.test(sourceRef)) {
    throw new StoreError("source-ref must be one line of text");
  }

  const meta = {
    id,
    kind,
    created_at: today,
    valid_from: validFrom ?? today,
    valid_to: null,
    supersedes: null,
    superseded_by: null,
    source_type: sourceType,
    source_ref: sourceRef.trim(),
    trust: TRUST_BY_SOURCE[sourceType],
    last_confirmed_at: today,
  };
  const content = renderMemory(meta, text.trim());

  const { errors } = validateMemory(content, id);
  if (errors.length > 0) {
    throw new StoreError(`not saved, fix these first:\n- ${errors.join("\n- ")}`);
  }

  mkdirSync(dir, { recursive: true });
  const path = filePath(dir, id);
  if (existsSync(path)) {
    throw new StoreError(
      `memory "${id}" already exists. Pick a new id. A changed fact gets a new memory, not an edit.`,
    );
  }
  writeFileSync(path, content, { flag: "wx" });
  return path;
}

export function readMemory(dir, id) {
  if (!isValidId(id)) {
    throw new StoreError(`invalid id "${id}". Ids use lowercase letters, digits and hyphens.`);
  }
  const path = filePath(dir, id);
  if (!existsSync(path)) {
    throw new StoreError(`no memory named "${id}" in ${dir}. Run "stashpad list --all" to see what exists.`);
  }
  return { path, text: readFileSync(path, "utf8") };
}

// Returns valid memories as rows. Files that break the format are listed in skipped.
export function listMemories(dir, { includeEnded = false } = {}) {
  const rows = [];
  const skipped = [];
  if (!existsSync(dir)) return { rows, skipped };

  const names = readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
  for (const name of names) {
    const id = name.slice(0, -".md".length);
    const text = readFileSync(join(dir, name), "utf8");
    const { errors } = validateMemory(text, id);
    if (errors.length > 0) {
      skipped.push({ file: name, reason: errors[0] });
      continue;
    }
    const { meta, body } = parseMemory(text);
    if (!includeEnded && meta.valid_to !== null) continue;
    rows.push({
      id,
      kind: meta.kind,
      valid_from: meta.valid_from,
      valid_to: meta.valid_to,
      trust: meta.trust,
      summary: body.split("\n")[0],
    });
  }
  return { rows, skipped };
}
