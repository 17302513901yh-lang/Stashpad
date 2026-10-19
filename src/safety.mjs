// Update safety for a store folder: a format marker, snapshots, restore, migration, and
// protection against an older Stashpad writing into a newer store. No dependencies.
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { StoreError } from "./errors.mjs";
import { writeAtomic } from "./fsx.mjs";
import { withStoreLock } from "./lock.mjs";
import { MARKER_BACKUP, SEAL_PREFIX, encryptionOf, keyFor, readData, sealLine } from "./vault.mjs";
import { validateDocuments } from "./memory-format.mjs";
import { STORE_FORMAT, VERSION } from "./version.mjs";

export const MARKER = ".stashpad-store.json";
export const SNAPSHOTS = ".snapshots";
const AUTO_KEEP = 14;
const SNAPSHOT_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-z0-9-]+$/;
const SUBFOLDERS = ["pending", "rejected", "handoffs"];

// Files in the top of a store that a snapshot keeps. Raw source copies in sources/ never change,
// so snapshots leave them out.
const isTopLevelData = (name) => name.endsWith(".md") || name === "audit.jsonl" || name === "feedback.jsonl" || name === "synonyms.json" || name === MARKER;

function isRegularFile(path) {
  return existsSync(path) && lstatSync(path).isFile();
}


function appendAudit(dir, entry) {
  appendFileSync(join(dir, "audit.jsonl"), `${sealLine(dir, JSON.stringify({ at: new Date().toISOString(), ...entry }))}\n`);
}

// The format number written in the store, or null when there is no marker (a store from before markers).
export function readStoreFormat(dir) {
  const path = join(dir, MARKER);
  if (!existsSync(path)) return null;
  if (!isRegularFile(path)) throw new StoreError(`${path} must be a normal file, not a link.`);
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (Number.isInteger(data.format) && data.format >= 1) return data.format;
  } catch {
    // falls through to the error below
  }
  throw new StoreError(
    `${path} cannot be read. Run "stashpad migrate": it puts the marker back from its backup (${MARKER_BACKUP}). Do not delete it by hand if the store is encrypted.`,
  );
}

function readJson(path) {
  try {
    if (!isRegularFile(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf8"));
    return Number.isInteger(data.format) && data.format >= 1 ? data : null;
  } catch {
    return null;
  }
}

// True when any data file in the store or its snapshots is sealed.
export function hasSealedFiles(dir) {
  const roots = [dir];
  const snaps = join(dir, SNAPSHOTS);
  if (existsSync(snaps)) for (const name of readdirSync(snaps)) roots.push(join(snaps, name));
  const sealedFile = (path) => {
    try {
      return isRegularFile(path) && readFileSync(path).subarray(0, SEAL_PREFIX.length).toString("utf8") === SEAL_PREFIX;
    } catch {
      return false;
    }
  };
  for (const root of roots) {
    if (!existsSync(root) || !lstatSync(root).isDirectory()) continue;
    for (const name of readdirSync(root)) {
      const path = join(root, name);
      if (name.endsWith(".md") && sealedFile(path)) return true;
      if (name === "audit.jsonl" && isRegularFile(path) && readFileSync(path, "utf8").includes("SEALED1:")) return true;
    }
    for (const sub of [...SUBFOLDERS, "sources"]) {
      const folder = join(root, sub);
      if (existsSync(folder) && lstatSync(folder).isDirectory()) {
        for (const name of readdirSync(folder)) if (sealedFile(join(folder, name))) return true;
      }
    }
  }
  return false;
}

// The marker is missing or broken: where a good copy can come from (its backup, else the newest snapshot).
export function markerRescue(dir) {
  const current = join(dir, MARKER);
  const sealed = hasSealedFiles(dir);
  const usable = (data) => data !== null && (Boolean(data.encryption) || !sealed);
  if (usable(readJson(current))) return null;
  const backup = readJson(join(dir, MARKER_BACKUP));
  if (usable(backup)) return { from: MARKER_BACKUP, data: backup };
  for (const name of listSnapshots(dir).reverse()) {
    const copy = readJson(join(dir, SNAPSHOTS, name, MARKER));
    if (usable(copy)) return { from: `${SNAPSHOTS}/${name}/${MARKER}`, data: copy };
  }
  return null;
}

// Keeps every other field of the marker (such as the encryption settings).
export function writeMarker(dir, format, extra = {}) {
  let current = {};
  try {
    if (isRegularFile(join(dir, MARKER))) current = JSON.parse(readFileSync(join(dir, MARKER), "utf8"));
  } catch {
    current = {};
  }
  const next = { ...current, format, written_by: `stashpad ${VERSION}`, ...extra };
  for (const [key, value] of Object.entries(next)) if (value === undefined) delete next[key];
  const text = `${JSON.stringify(next, null, 2)}\n`;
  writeAtomic(join(dir, MARKER), text);
  // A second copy: for an encrypted store the marker holds the only copy of the salt.
  writeAtomic(join(dir, MARKER_BACKUP), text);
}

function hasMemories(dir) {
  if (!existsSync(dir)) return false;
  if (readdirSync(dir).some((name) => name.endsWith(".md"))) return true;
  const pending = join(dir, "pending");
  return existsSync(pending) && readdirSync(pending).length > 0;
}

// An older Stashpad must not write into a newer store: it would not know the newer rules.
// Reading stays allowed.
export function assertWritable(dir) {
  const format = readStoreFormat(dir);
  if (format !== null && format > STORE_FORMAT) {
    throw new StoreError(
      `this store uses format ${format}, but this Stashpad (${VERSION}) writes format ${STORE_FORMAT}. ` +
        "Update Stashpad before writing, so older code cannot damage newer files. Reading still works.",
    );
  }
}

// Called before every write. A brand new store gets its marker. A store made before markers
// keeps working as format 0 until "stashpad migrate" records the format.
export function prepareForWrite(dir) {
  assertWritable(dir);
  mkdirSync(dir, { recursive: true });
  if (readStoreFormat(dir) === null && !hasMemories(dir)) writeMarker(dir, STORE_FORMAT);
}

function copyFiles(from, to, keep) {
  mkdirSync(to, { recursive: true });
  let count = 0;
  for (const name of readdirSync(from)) {
    if (!keep(name)) continue;
    const source = join(from, name);
    if (!isRegularFile(source)) continue; // links and folders are never copied
    copyFileSync(source, join(to, name));
    count += 1;
  }
  return count;
}

export function listSnapshots(dir) {
  const folder = join(dir, SNAPSHOTS);
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((name) => SNAPSHOT_NAME.test(name)).sort();
}

// Copies the memories, waiting writes, rejected writes and the audit log into <store>/.snapshots/<name>/.
function createSnapshotUnlocked(dir, label = "manual", now = new Date()) {
  if (!existsSync(dir)) throw new StoreError(`nothing to snapshot: ${dir} does not exist.`);
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const clean =
    String(label).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "manual";
  let name = `${stamp}-${clean}`;
  for (let n = 2; existsSync(join(dir, SNAPSHOTS, name)); n += 1) name = `${stamp}-${clean}-${n}`;

  const target = join(dir, SNAPSHOTS, name);
  let files = copyFiles(dir, target, isTopLevelData);
  for (const sub of SUBFOLDERS) {
    const folder = join(dir, sub);
    if (existsSync(folder) && lstatSync(folder).isDirectory()) files += copyFiles(folder, join(target, sub), () => true);
  }
  return { name, files };
}

// One automatic snapshot per day, taken before a change that edits an existing memory in place.
// Only the newest AUTO_KEEP automatic snapshots are kept. Manual ones are never removed.
export function autoSnapshot(dir, now = new Date()) {
  if (!hasMemories(dir)) return null;
  const day = now.toISOString().slice(0, 10);
  if (listSnapshots(dir).some((name) => name.startsWith(day) && /-auto(-\d+)?$/.test(name))) return null;
  const made = createSnapshot(dir, "auto", now);
  const autos = listSnapshots(dir).filter((name) => /-auto(-\d+)?$/.test(name));
  for (const old of autos.slice(0, Math.max(0, autos.length - AUTO_KEEP))) {
    rmSync(join(dir, SNAPSHOTS, old), { recursive: true, force: true });
  }
  return made;
}

// Puts a snapshot back. The current state is snapshotted first, so a restore can be undone.
function restoreSnapshotUnlocked(dir, name, now = new Date()) {
  if (!SNAPSHOT_NAME.test(name)) {
    throw new StoreError(`"${name}" is not a snapshot name. Run "stashpad snapshots" to see them.`);
  }
  const source = join(dir, SNAPSHOTS, name);
  if (!existsSync(source)) throw new StoreError(`no snapshot named "${name}". Run "stashpad snapshots" to see them.`);
  assertWritable(dir);
  keyFor(dir); // a missing or wrong passphrase stops here, before anything changes
  if (readJson(join(dir, MARKER)) === null && (existsSync(join(dir, MARKER)) || hasSealedFiles(dir) || existsSync(join(dir, MARKER_BACKUP)))) {
    throw new StoreError('the store marker is missing or broken. Run "stashpad migrate" first: it puts the marker back.');
  }

  const safety = createSnapshot(dir, "before-restore", now);
  for (const entry of readdirSync(dir)) {
    if (entry === MARKER) continue;
    if (isTopLevelData(entry) && isRegularFile(join(dir, entry))) rmSync(join(dir, entry), { force: true });
  }
  for (const sub of SUBFOLDERS) rmSync(join(dir, sub), { recursive: true, force: true });

  // The marker is never taken from a snapshot: it holds the current format and encryption settings.
  let files = copyFiles(source, dir, (name) => isTopLevelData(name) && name !== MARKER);
  for (const sub of SUBFOLDERS) {
    const folder = join(source, sub);
    if (existsSync(folder)) files += copyFiles(folder, join(dir, sub), () => true);
  }
  appendAudit(dir, { action: "restored", id: name, reason: `safety snapshot ${safety.name}` });
  return { restored: name, safety: safety.name, files };
}

// Brings a store to the current format. With dryRun nothing is written. A real run snapshots first.
function migrateStoreUnlocked(dir, { dryRun = false, now = new Date() } = {}) {
  if (!existsSync(dir)) throw new StoreError(`no store at ${dir}.`);
  const rescue = existsSync(join(dir, MARKER)) || hasSealedFiles(dir) || existsSync(join(dir, MARKER_BACKUP)) ? markerRescue(dir) : null;
  if (rescue !== null) {
    const steps = [`put the marker back from ${rescue.from}`];
    if (!dryRun) {
      writeAtomic(join(dir, MARKER), `${JSON.stringify(rescue.data, null, 2)}\n`);
      writeAtomic(join(dir, MARKER_BACKUP), `${JSON.stringify(rescue.data, null, 2)}\n`);
      appendAudit(dir, { action: "marker-restored", id: "store", reason: rescue.from });
    }
    return { from: rescue.data.format, to: STORE_FORMAT, steps, problems: [], dry_run: dryRun, snapshot: null };
  }
  if (readJson(join(dir, MARKER)) === null && existsSync(join(dir, MARKER)) && !hasSealedFiles(dir)) {
    throw new StoreError(
      `${MARKER} is broken and there is no copy of it. This store is not encrypted, so it is safe to delete that file and run "stashpad migrate" again.`,
    );
  }
  if (hasSealedFiles(dir) && !readJson(join(dir, MARKER))?.encryption) {
    throw new StoreError(
      "this store holds sealed files, but its marker and every copy of it are missing or broken. Without the marker the memories cannot be opened. Look for .stashpad-store.json in a backup of this folder.",
    );
  }
  const from = readStoreFormat(dir) ?? 0;
  if (from > STORE_FORMAT) {
    throw new StoreError(`this store uses format ${from}, newer than this Stashpad (${VERSION}). Update Stashpad first.`);
  }

  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".md") && isRegularFile(join(dir, name)))
    .map((name) => ({ name, text: readData(dir, join(dir, name)) }));
  const problems = validateDocuments(files).map((p) => `${p.file}: ${p.message}`);

  const steps = [];
  if (from < 1) steps.push("record store format 1 in .stashpad-store.json (memory files are not changed)");
  const result = { from, to: STORE_FORMAT, steps, problems, dry_run: dryRun, snapshot: null };
  if (steps.length === 0 || dryRun) return result;

  result.snapshot = createSnapshot(dir, "before-migrate", now).name;
  writeMarker(dir, STORE_FORMAT);
  appendAudit(dir, { action: "migrated", id: `format-${from}-to-${STORE_FORMAT}`, reason: `snapshot ${result.snapshot}` });
  return result;
}

// True when the store folder sits inside the Stashpad install folder, where an update may replace it.
export function isInsideInstall(dir) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const target = resolve(dir);
  return target === root || target.startsWith(root + sep);
}

export const createSnapshot = (dir, ...args) => {
  if (!existsSync(dir)) throw new StoreError(`nothing to snapshot: ${dir} does not exist.`);
  return withStoreLock(dir, () => createSnapshotUnlocked(dir, ...args));
};
export const restoreSnapshot = (dir, ...args) => withStoreLock(dir, () => restoreSnapshotUnlocked(dir, ...args));
export const migrateStore = (dir, ...args) => {
  if (!existsSync(dir)) throw new StoreError(`no store at ${dir}.`);
  return withStoreLock(dir, () => migrateStoreUnlocked(dir, ...args));
};
