// File anchors: a memory can name the files (or folders) it is about, and Stashpad remembers what
// they looked like when the memory was saved or last confirmed. Recall, the brief and lint then say
// "file changed since saved", follow a file that moved, and skip a memory whose files are all gone.
//
// Store-level file, like pins.json, so memory files keep their fixed format:
//   <store>/anchors.json = { "anchors":   { "<memory id>": { "src/db.ts": "<hash>", "docs/": "<hash>" } },
//                            "requested": { "<waiting id>": ["src/db.ts"] } }
// A file's hash is its git blob id (sha1 of "blob <size>\0<bytes>") over LF line endings, so it is the
// same on every system and matches git for text files, with or without git installed. A folder's hash
// covers the sorted list of its files and their hashes, so an added file counts as a change too.
// Hashes are always computed here, never taken from an agent. An agent can only ask for paths; they
// are read when a person accepts the memory, not when it is queued.
//
// Stored paths are untrusted (the file can be edited, or come from a cloned repository): relative to
// the project only, no "..", no drive letters or UNC paths, no device names, nothing under .git, and
// the real path (links resolved) must stay inside the project. Only regular files of at most 5 MB and
// folders are read. No git command is run.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { StoreError } from "./errors.mjs";
import { writeAtomic } from "./fsx.mjs";
import { withStoreLock } from "./lock.mjs";
import { gitRoot } from "./locate.mjs";
import { prepareForWrite } from "./safety.mjs";
import { keyFor, openText, sealFor } from "./vault.mjs";

export const ANCHORS_FILE = "anchors.json";
export const MAX_ANCHORS = 20;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_SCAN_FILES = 2000;
const SKIP = new Set([".git", "node_modules", ".stashpad", ".snapshots"]);
const DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

// The folder anchored paths are relative to: the folder that holds .stashpad/memories, else the git
// root of the current folder, else the current folder.
export function projectRoot(dir, cwd = process.cwd()) {
  const store = resolve(dir);
  if (basename(store) === "memories" && basename(dirname(store)) === ".stashpad") return dirname(dirname(store));
  return gitRoot(cwd) ?? resolve(cwd);
}

// A clean project-relative path with forward slashes ("src/db.ts", or "docs/" for a folder), or null.
export function cleanPath(path) {
  if (typeof path !== "string") return null;
  const raw = path.replace(/\\/g, "/");
  if (raw === "" || raw.length > 300 || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || raw.startsWith("~")) return null;
  const folder = raw.endsWith("/");
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0) return null;
  if (parts.some((p) => p === ".." || DEVICE.test(p) || /[<>:"|?*]/.test(p))) return null;
  if (parts[0] === ".git") return null;
  return parts.join("/") + (folder ? "/" : "");
}

// A path a person typed on the command line: relative to where they are, or absolute inside the project.
export function pathFromUser(root, cwd, path) {
  if (typeof path !== "string" || path.trim() === "") throw new StoreError("an empty path cannot be anchored.");
  const abs = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const rel = relative(resolve(root), abs);
  if (rel === "" ) throw new StoreError("the project folder itself cannot be anchored; name a file or a folder in it.");
  const clean = cleanPath(rel.split(sep).join("/") + (/[\\/]$/.test(path) ? "/" : ""));
  if (clean === null) throw new StoreError(`"${path}" is outside the project (${root}) or not a usable path.`);
  return clean;
}

export function blobHash(buffer) {
  // Text gets LF line endings, so a Windows checkout hashes the same; binary files are left as they are.
  const binary = buffer.subarray(0, 8000).includes(0);
  const bytes = binary ? buffer : Buffer.from(buffer.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function realRoot(root) {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

// Where a stored path points: { abs, kind: "file" | "folder" } or { missing } or { refused: reason }.
export function locate(root, path) {
  const clean = cleanPath(path);
  if (clean === null || clean !== path) return { refused: "not a clean project-relative path" };
  const abs = join(root, ...clean.split("/").filter(Boolean));
  if (!existsSync(abs)) {
    try {
      lstatSync(abs);
      return { refused: "a link that points nowhere" };
    } catch {
      return { missing: true };
    }
  }
  let real;
  try {
    real = realpathSync(abs);
  } catch {
    return { missing: true };
  }
  const top = realRoot(root);
  if (real !== top && !real.startsWith(top.endsWith(sep) ? top : top + sep)) return { refused: "points outside the project" };
  const info = statSync(real);
  if (info.isFile()) {
    if (info.size > MAX_FILE_BYTES) return { refused: `larger than ${MAX_FILE_BYTES / 1024 / 1024} MB` };
    return { abs: real, kind: "file" };
  }
  if (info.isDirectory()) return { abs: real, kind: "folder" };
  return { refused: "not a regular file or folder" };
}

// Regular files under a folder (links and skipped folders left out), as paths relative to it.
function walk(folder, limit, { strict = true } = {}) {
  const files = [];
  const stack = [""];
  while (stack.length > 0) {
    const rel = stack.pop();
    let entries;
    try {
      entries = readdirSync(join(folder, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) stack.push(child);
      } else if (entry.isFile()) {
        if (files.length >= limit) {
          if (strict) throw new StoreError(`more than ${limit} files in that folder; anchor a smaller folder or single files.`);
          return { files, complete: false };
        }
        files.push(child);
      }
    }
  }
  return { files: files.sort(), complete: true };
}

function fileHash(abs) {
  return blobHash(readFileSync(abs));
}

function folderHash(abs) {
  const { files } = walk(abs, MAX_SCAN_FILES);
  const lines = files.map((f) => {
    const path = join(abs, ...f.split("/"));
    const size = statSync(path).size;
    return `${f}:${size > MAX_FILE_BYTES ? `large-${size}` : fileHash(path)}`;
  });
  return `dir:${createHash("sha1").update(lines.join("\n")).digest("hex")}`;
}

// The hash of a stored path as it is now: { hash, kind } or { missing } or { refused }.
export function hashNow(root, path) {
  const where = locate(root, path);
  if (!where.abs) return where;
  if (where.kind === "folder") {
    if (!path.endsWith("/")) return { hash: "folder", kind: "folder" };
    return { hash: folderHash(where.abs), kind: "folder" };
  }
  if (path.endsWith("/")) return { hash: "file", kind: "file" };
  return { hash: fileHash(where.abs), kind: "file" };
}

// Hashes for paths that are about to be anchored. Throws with a clear message for a path that cannot be.
export function hashPaths(root, paths) {
  if (paths.length > MAX_ANCHORS) throw new StoreError(`at most ${MAX_ANCHORS} files or folders per memory.`);
  const out = {};
  for (const given of paths) {
    let path = cleanPath(given);
    if (path === null) throw new StoreError(`"${given}" is not a usable project path (relative, inside the project, no "..").`);
    const where = locate(root, path);
    if (where.refused) throw new StoreError(`"${path}" cannot be anchored: ${where.refused}.`);
    if (where.missing) throw new StoreError(`"${path}" does not exist in ${root}.`);
    if (where.kind === "folder" && !path.endsWith("/")) path += "/";
    if (where.kind === "file" && path.endsWith("/")) path = path.slice(0, -1);
    out[path] = hashNow(root, path).hash;
  }
  return out;
}

export function readAnchorsFile(dir) {
  const path = join(dir, ANCHORS_FILE);
  const empty = { anchors: {}, requested: {} };
  if (!existsSync(path)) return empty;
  if (!lstatSync(path).isFile()) throw new StoreError(`${path} must be a normal file, not a link.`);
  let data;
  try {
    data = JSON.parse(openText(dir, readFileSync(path, "utf8")));
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw new StoreError(`${path} cannot be read (not valid JSON). Fix it, or restore it from a snapshot.`);
  }
  const anchors = {};
  for (const [id, files] of Object.entries(data?.anchors ?? {})) {
    if (!files || typeof files !== "object" || Array.isArray(files)) continue;
    const kept = Object.entries(files).filter(([p, h]) => typeof h === "string" && cleanPath(p) === p).slice(0, MAX_ANCHORS);
    if (kept.length) anchors[id] = Object.fromEntries(kept);
  }
  const requested = {};
  for (const [id, list] of Object.entries(data?.requested ?? {})) {
    if (Array.isArray(list)) requested[id] = list.filter((p) => cleanPath(p) === p).slice(0, MAX_ANCHORS);
  }
  return { anchors, requested };
}

// Anchors of every memory, or {} when the file is missing or unreadable (recall must never fail on it).
export function readAnchors(dir) {
  try {
    return readAnchorsFile(dir).anchors;
  } catch {
    return {};
  }
}

function writeAnchorsFile(dir, data) {
  const clean = { anchors: data.anchors, requested: data.requested };
  writeAtomic(join(dir, ANCHORS_FILE), sealFor(dir, `${JSON.stringify(clean, null, 2)}\n`));
}

// Replaces the anchors of one memory with these path -> hash pairs (a person, or accept).
export function setAnchors(dir, id, hashes) {
  return withStoreLock(dir, () => {
    keyFor(dir);
    prepareForWrite(dir);
    const data = readAnchorsFile(dir);
    if (Object.keys(hashes).length === 0) delete data.anchors[id];
    else data.anchors[id] = hashes;
    writeAnchorsFile(dir, data);
    return { id, files: Object.keys(hashes) };
  });
}

// Adds files to a memory's anchors (keeps the ones it has).
export function addAnchors(dir, id, root, paths) {
  return withStoreLock(dir, () => {
    const current = readAnchorsFile(dir).anchors[id] ?? {};
    const added = hashPaths(root, paths);
    const next = { ...current, ...added };
    if (Object.keys(next).length > MAX_ANCHORS) throw new StoreError(`at most ${MAX_ANCHORS} files or folders per memory.`);
    setAnchors(dir, id, next);
    return { id, added: Object.keys(added), files: Object.keys(next) };
  });
}

export function removeAnchors(dir, id, paths = null) {
  return withStoreLock(dir, () => {
    const current = readAnchorsFile(dir).anchors[id] ?? {};
    const drop = paths === null ? Object.keys(current) : paths.map((p) => cleanPath(p)).filter(Boolean);
    const next = Object.fromEntries(Object.entries(current).filter(([p]) => !drop.includes(p) && !drop.includes(`${p}/`) && !drop.includes(p.replace(/\/$/, ""))));
    setAnchors(dir, id, next);
    return { id, removed: Object.keys(current).filter((p) => !(p in next)), files: Object.keys(next) };
  });
}

// An agent asks for paths with a queued memory. Only the paths are kept; nothing is read until a
// person accepts the memory.
export function requestAnchors(dir, id, paths) {
  const clean = checkRequested(paths);
  if (clean.length === 0) return [];
  return withStoreLock(dir, () => {
    keyFor(dir);
    prepareForWrite(dir);
    const data = readAnchorsFile(dir);
    data.requested[id] = clean;
    writeAnchorsFile(dir, data);
    return clean;
  });
}

export function checkRequested(paths) {
  if (!Array.isArray(paths)) throw new StoreError("files must be a list of project paths.");
  if (paths.length > MAX_ANCHORS) throw new StoreError(`at most ${MAX_ANCHORS} files or folders per memory.`);
  return [...new Set(paths.map((p) => {
    const clean = cleanPath(String(p));
    if (clean === null) throw new StoreError(`"${p}" is not a usable project path (relative, inside the project, no "..").`);
    return clean;
  }))];
}

export function requestedFor(dir, id) {
  try {
    return readAnchorsFile(dir).requested[id] ?? [];
  } catch {
    return [];
  }
}

// On accept: hash the requested paths that exist and are allowed, and anchor them. On reject: drop them.
// Called under the store lock. Never throws: a file that cannot be read is simply not anchored.
export function settleRequested(dir, id, accepted, root = projectRoot(dir)) {
  try {
    const data = readAnchorsFile(dir);
    const paths = data.requested[id];
    if (!paths) return [];
    delete data.requested[id];
    const done = [];
    if (accepted) {
      const hashes = {};
      for (const path of paths) {
        try {
          Object.assign(hashes, hashPaths(root, [path]));
          done.push(path);
        } catch {
          // missing or refused: left out
        }
      }
      if (Object.keys(hashes).length) data.anchors[id] = { ...(data.anchors[id] ?? {}), ...hashes };
    }
    writeAnchorsFile(dir, data);
    return done;
  } catch {
    return [];
  }
}

// A cache of the project's files for one round of checks, so a moved file is looked for only once.
export function anchorContext(root) {
  let files = null;
  const hashes = new Map();
  return {
    root,
    files() {
      if (files === null) files = walk(root, MAX_SCAN_FILES, { strict: false }).files;
      return files;
    },
    hashOf(rel) {
      if (!hashes.has(rel)) {
        const where = locate(root, rel);
        hashes.set(rel, where.kind === "file" ? fileHash(where.abs) : null);
      }
      return hashes.get(rel);
    },
  };
}

// The state of each anchored path: same, changed, moved (same content elsewhere), moved-changed (the
// only file with that name elsewhere, other content), gone, or refused.
export function checkAnchors(dir, id, { root = projectRoot(dir), anchors = readAnchors(dir), context = anchorContext(root) } = {}) {
  const files = anchors[id];
  if (!files) return null;
  const out = [];
  for (const [path, hash] of Object.entries(files)) {
    let now;
    try {
      now = hashNow(root, path);
    } catch {
      now = { refused: "cannot be read" };
    }
    if (now.refused) out.push({ path, state: "refused", reason: now.refused });
    else if (now.hash === hash) out.push({ path, state: "same" });
    else if (!now.missing) out.push({ path, state: "changed" });
    else if (path.endsWith("/")) out.push({ path, state: "gone" });
    else {
      const name = path.split("/").at(-1);
      const candidates = context.files().filter((f) => f !== path);
      const same = candidates.find((f) => f.split("/").at(-1) === name && context.hashOf(f) === hash) ?? candidates.find((f) => context.hashOf(f) === hash);
      const named = candidates.filter((f) => f.split("/").at(-1) === name);
      if (same) out.push({ path, state: "moved", to: same });
      else if (named.length === 1) out.push({ path, state: "moved-changed", to: named[0] });
      else out.push({ path, state: "gone" });
    }
  }
  const settled = out.every((f) => f.state === "same");
  return { id, files: out, changed: !settled, gone: out.length > 0 && out.every((f) => f.state === "gone") };
}

// A short note for recall and the brief, or "" when nothing changed.
export function anchorNote(status) {
  if (!status || !status.changed) return "";
  const parts = [];
  const list = (state) => status.files.filter((f) => f.state === state);
  if (list("changed").length) parts.push(`changed since saved: ${list("changed").map((f) => f.path).join(", ")}`);
  for (const f of list("moved")) parts.push(`moved: ${f.path} -> ${f.to}`);
  for (const f of list("moved-changed")) parts.push(`moved and changed: ${f.path} -> ${f.to}`);
  if (list("gone").length) parts.push(`gone: ${list("gone").map((f) => f.path).join(", ")}`);
  if (list("refused").length) parts.push(`not checked: ${list("refused").map((f) => f.path).join(", ")}`);
  return ` (${parts.join("; ")})`;
}

// A person confirmed the memory: anchor it to the files as they are now, following moves; gone files
// are dropped. Returns what changed.
export function reanchor(dir, id, root = projectRoot(dir)) {
  return withStoreLock(dir, () => {
    const status = checkAnchors(dir, id, { root, anchors: readAnchorsFile(dir).anchors });
    if (!status) return null;
    const next = {};
    const dropped = [];
    for (const f of status.files) {
      const path = f.to ?? f.path;
      if (f.state === "gone" || f.state === "refused") {
        dropped.push(f.path);
        continue;
      }
      Object.assign(next, hashPaths(root, [path]));
    }
    setAnchors(dir, id, next);
    return { id, files: Object.keys(next), dropped, updated: status.files.filter((f) => f.state !== "same" && f.state !== "gone" && f.state !== "refused").map((f) => f.path) };
  });
}
