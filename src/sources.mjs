// Keeps a copy of the raw source of a memory inside the store, so the short memory can be checked against it.
// Files are named by their hash, so the same content is stored once. The copy is never changed by Stashpad.
import { createHash, createHmac } from "node:crypto";
import { keyFor, sealFor } from "./vault.mjs";
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
  const key = keyFor(dir);
  // In an encrypted store the name must not reveal the file name or a plain hash of its content.
  const name =
    key === null
      ? `${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}-${basename(file).replace(/[^A-Za-z0-9._-]/g, "_")}`
      : `${createHmac("sha256", key).update(bytes).digest("hex").slice(0, 16)}.sealed`;
  const folder = join(dir, "sources");
  mkdirSync(folder, { recursive: true });
  const target = join(folder, name);
  if (!existsSync(target)) writeFileSync(target, sealFor(dir, bytes, key), { flag: "wx" });
  return `sources/${name}`;
}
