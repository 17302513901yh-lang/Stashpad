// Keeps a copy of the raw source of a memory inside the store, so the short memory can be checked against it.
// Files are named by their hash, so the same content is stored once. The copy is never changed by Stashpad.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { StoreError } from "./store.mjs";

const MAX_BYTES = 5 * 1024 * 1024;

// Copies the file into <store>/sources/ and returns its path relative to the store.
export function archiveSource(dir, file) {
  if (!existsSync(file)) throw new StoreError(`source file not found: ${file}`);
  const info = lstatSync(file);
  if (info.isSymbolicLink()) throw new StoreError("refusing a symbolic link as a source. Pass the file itself.");
  if (!info.isFile()) throw new StoreError(`source must be a file: ${file}`);
  if (info.size > MAX_BYTES) {
    throw new StoreError("source file is larger than 5 MB. Save a summary and keep the file where it is.");
  }

  const bytes = readFileSync(file);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const name = `${hash.slice(0, 12)}-${basename(file).replace(/[^A-Za-z0-9._-]/g, "_")}`;
  const folder = join(dir, "sources");
  mkdirSync(folder, { recursive: true });
  const target = join(folder, name);
  if (!existsSync(target)) writeFileSync(target, bytes, { flag: "wx" });
  return `sources/${name}`;
}
