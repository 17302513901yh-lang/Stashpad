// "stashpad encrypt" and "stashpad decrypt": convert a whole store, snapshots included.
// Each file is rewritten on its own with a temp file and a rename, and reading accepts both forms,
// so a run that stops halfway can simply be started again.
import { existsSync, lstatSync, readdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { StoreError } from "./errors.mjs";
import { writeAtomic } from "./fsx.mjs";
import { withStoreLock } from "./lock.mjs";
import { MARKER, SNAPSHOTS, assertWritable, hasSealedFiles, readStoreFormat, writeMarker } from "./safety.mjs";
import { STORE_FORMAT } from "./version.mjs";
import {
  encryptionOf,
  keyFor,
  newEncryption,
  openLineWith,
  openWith,
  passphraseFromEnv,
  sealLineWith,
  sealWith,
} from "./vault.mjs";


const isFile = (path) => existsSync(path) && lstatSync(path).isFile();
const isDir = (path) => existsSync(path) && lstatSync(path).isDirectory();

// Every data file of one store root (the store itself or one snapshot folder).
function dataFiles(root) {
  const files = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (name.endsWith(".md") && isFile(path)) files.push({ path, kind: "file" });
    if ((name === "audit.jsonl" || name === "feedback.jsonl") && isFile(path)) files.push({ path, kind: "lines" });
  }
  for (const sub of ["pending", "rejected", "sources", "handoffs"]) {
    const folder = join(root, sub);
    if (!isDir(folder)) continue;
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      if (isFile(path) && !name.endsWith(".tmp")) files.push({ path, kind: "file" });
    }
  }
  return files;
}

function allRoots(dir) {
  const roots = [dir];
  const snaps = join(dir, SNAPSHOTS);
  if (isDir(snaps)) for (const name of readdirSync(snaps)) if (isDir(join(snaps, name))) roots.push(join(snaps, name));
  return roots;
}

function convert(dir, key, toSealed) {
  let changed = 0;
  for (const root of allRoots(dir)) {
    for (const { path, kind } of dataFiles(root)) {
      if (kind === "lines") {
        const lines = readFileSync(path, "utf8").split("\n");
        const next = lines.map((line) => {
          if (line.trim() === "") return line;
          const plain = openLineWith(key, line);
          return toSealed ? sealLineWith(key, plain) : plain;
        });
        const needs = lines.some((line) => line.trim() !== "" && line.startsWith("SEALED1:") !== toSealed);
        if (needs) {
          writeAtomic(path, next.join("\n"));
          changed += 1;
        }
        continue;
      }
      const raw = readFileSync(path);
      const opened = openWith(key, raw);
      if (toSealed && opened === null) {
        writeAtomic(path, sealWith(key, raw));
        changed += 1;
      } else if (!toSealed && opened !== null) {
        writeAtomic(path, opened);
        changed += 1;
      }
    }
  }
  return changed;
}

export function encryptStore(dir, env = process.env) {
  if (!existsSync(dir)) throw new StoreError(`no store at ${dir}. Save a memory first, then encrypt.`);
  return withStoreLock(dir, () => {
    assertWritable(dir);
    const passphrase = passphraseFromEnv(env);
    if (!passphrase) throw new StoreError("set STASHPAD_PASSPHRASE or STASHPAD_KEY_FILE first. Keep that passphrase safe: without it the memories cannot be read.");
    const resumed = encryptionOf(dir) !== null;
    if (!resumed && hasSealedFiles(dir)) {
      throw new StoreError(
        'this store already holds sealed files, but its marker has no encryption settings. Run "stashpad migrate" to put the marker back first; a new key would make the sealed files unreadable.',
      );
    }
    if (!resumed) writeMarker(dir, readStoreFormat(dir) ?? STORE_FORMAT, { encryption: newEncryption(passphrase) });
    const key = keyFor(dir, { STASHPAD_PASSPHRASE: passphrase });
    const files = convert(dir, key, true);
    appendFileSync(join(dir, "audit.jsonl"), `${sealLineWith(key, JSON.stringify({ at: new Date().toISOString(), action: "encrypted", id: "store", reason: `${files} files sealed` }))}\n`);
    return { files, resumed };
  });
}

export function decryptStore(dir, env = process.env) {
  if (!existsSync(dir)) throw new StoreError(`no store at ${dir}.`);
  return withStoreLock(dir, () => {
    assertWritable(dir);
    if (encryptionOf(dir) === null) throw new StoreError("this store is not encrypted.");
    const key = keyFor(dir, env);
    const files = convert(dir, key, false);
    writeMarker(dir, readStoreFormat(dir) ?? STORE_FORMAT, { encryption: undefined });
    appendFileSync(join(dir, "audit.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), action: "decrypted", id: "store", reason: `${files} files opened` })}\n`);
    return { files };
  });
}

// For doctor: how many data files in the store itself are still plain in an encrypted store.
export function plainFilesInEncryptedStore(dir) {
  if (encryptionOf(dir) === null) return 0;
  let count = 0;
  for (const { path, kind } of allRoots(dir).flatMap((root) => dataFiles(root))) {
    if (kind === "lines") {
      if (readFileSync(path, "utf8").split("\n").some((l) => l.trim() !== "" && !l.startsWith("SEALED1:"))) count += 1;
    } else if (!readFileSync(path).subarray(0, 18).toString("utf8").startsWith("STASHPAD-SEALED-1:")) count += 1;
  }
  return count;
}

export { MARKER };
