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
//
// Hooks run on every prompt, so one round of checks reads at most MAX_CHECK_BYTES, walks no build or
// dependency folders, and does not look for moved files (lint and "stashpad anchors" do). Hashes are
// cached in <store>/.sessions/anchor-hashes.json by (real path, size, mtime), so an unchanged file is
// not read again. The cache only saves work: a wrong entry can at worst hide one change.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { StoreError } from "./errors.mjs";
import { writeAtomic } from "./fsx.mjs";
import { withStoreLock } from "./lock.mjs";
import { gitRoot } from "./locate.mjs";
import { prepareForWrite } from "./safety.mjs";
import { ensureSessionsDir, sessionsDir } from "./sessions.mjs";
import { keyFor, openText, sealFor } from "./vault.mjs";

export const ANCHORS_FILE = "anchors.json";
export const MAX_ANCHORS = 20;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_SCAN_FILES = 2000;
export const MAX_CHECK_BYTES = 50 * 1024 * 1024;
export const HASH_CACHE_FILE = "anchor-hashes.json";
const MAX_CACHE_ENTRIES = 5000;
// Folders that hold dependencies, build output or caches: never walked.
const SKIP = new Set([".git", "node_modules", ".stashpad", ".snapshots", "dist", "build", "target", "out", "coverage", ".venv", "venv", "__pycache__", ".godot", ".import", ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache", ".gradle", ".tox", ".mypy_cache", ".pytest_cache", "bower_components", "obj"]);
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

// The size (after line endings are made LF) of each file hash seen, so a stored anchor can remember
// it and a moved file is looked for among files of a fitting size only.
const knownSizes = new Map();
function rememberSize(hash, size) {
  if (knownSizes.size > 20000) knownSizes.clear();
  knownSizes.set(hash, size);
}

function hashWithSize(buffer) {
  // Text gets LF line endings, so a Windows checkout hashes the same; binary files are left as they are.
  const binary = buffer.subarray(0, 8000).includes(0);
  const bytes = binary ? buffer : Buffer.from(buffer.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
  const hash = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  rememberSize(hash, bytes.length);
  return { hash, size: bytes.length };
}

export function blobHash(buffer) {
  return hashWithSize(buffer).hash;
}

// True when a file of this size on disk can hold content of this LF size (CRLF text is larger).
const sizeFits = (raw, size) => raw === size || (raw > size && raw <= 2 * size);

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

class OverBudget extends Error {}

function fileHash(abs, context = null) {
  return context ? context.fileHash(abs) : blobHash(readFileSync(abs));
}

function folderHash(abs, context = null) {
  const { files } = walk(abs, MAX_SCAN_FILES);
  const lines = files.map((f) => {
    const path = join(abs, ...f.split("/"));
    const size = statSync(path).size;
    return `${f}:${size > MAX_FILE_BYTES ? `large-${size}` : fileHash(path, context)}`;
  });
  return `dir:${createHash("sha1").update(lines.join("\n")).digest("hex")}`;
}

// The hash of a stored path as it is now: { hash, kind } or { missing } or { refused }. With a
// context, reads count against its byte limit and use its hash cache.
export function hashNow(root, path, context = null) {
  const where = locate(root, path);
  if (!where.abs) return where;
  try {
    if (where.kind === "folder") {
      if (!path.endsWith("/")) return { hash: "folder", kind: "folder" };
      return { hash: folderHash(where.abs, context), kind: "folder" };
    }
    if (path.endsWith("/")) return { hash: "file", kind: "file" };
    return { hash: fileHash(where.abs, context), kind: "file" };
  } catch (error) {
    if (error instanceof OverBudget) return { refused: `not checked: more than ${MAX_CHECK_BYTES / 1024 / 1024} MB to read in one check` };
    throw error;
  }
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
  const empty = { anchors: {}, requested: {}, sizes: {} };
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
  // The LF size of each anchored file, so a move is looked for among files of a fitting size.
  const sizes = {};
  for (const [id, list] of Object.entries(data?.sizes ?? {})) {
    if (!anchors[id] || !list || typeof list !== "object" || Array.isArray(list)) continue;
    const kept = Object.entries(list).filter(([p, n]) => p in anchors[id] && Number.isSafeInteger(n) && n >= 0);
    if (kept.length) sizes[id] = Object.fromEntries(kept);
  }
  return { anchors, requested, sizes };
}

// Anchored file sizes per memory id, or {} (older stores have none).
export function readAnchorSizes(dir) {
  try {
    return readAnchorsFile(dir).sizes;
  } catch {
    return {};
  }
}

// Anchors of every memory, or {} when the file is missing or unreadable (recall must never fail on it).
export function readAnchors(dir) {
  try {
    return readAnchorsFile(dir).anchors;
  } catch {
    return {};
  }
}

function sizesFor(hashes, previous = {}, previousSizes = {}) {
  const out = {};
  for (const [path, hash] of Object.entries(hashes)) {
    const size = knownSizes.get(hash) ?? (previous[path] === hash ? previousSizes[path] : undefined);
    if (Number.isSafeInteger(size)) out[path] = size;
  }
  return out;
}

function writeAnchorsFile(dir, data) {
  const sizes = Object.fromEntries(Object.entries(data.sizes ?? {}).filter(([id, list]) => data.anchors[id] && Object.keys(list).length));
  const clean = { anchors: data.anchors, requested: data.requested, ...(Object.keys(sizes).length ? { sizes } : {}) };
  writeAtomic(join(dir, ANCHORS_FILE), sealFor(dir, `${JSON.stringify(clean, null, 2)}\n`));
}

// Replaces the anchors of one memory with these path -> hash pairs (a person, or accept).
export function setAnchors(dir, id, hashes) {
  return withStoreLock(dir, () => {
    keyFor(dir);
    prepareForWrite(dir);
    const data = readAnchorsFile(dir);
    const sizes = sizesFor(hashes, data.anchors[id], data.sizes[id]);
    if (Object.keys(hashes).length === 0) delete data.anchors[id];
    else data.anchors[id] = hashes;
    if (Object.keys(sizes).length) data.sizes[id] = sizes;
    else delete data.sizes[id];
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
      if (Object.keys(hashes).length) {
        data.anchors[id] = { ...(data.anchors[id] ?? {}), ...hashes };
        data.sizes[id] = { ...(data.sizes[id] ?? {}), ...sizesFor(hashes) };
      }
    }
    writeAnchorsFile(dir, data);
    return done;
  } catch {
    return [];
  }
}

// The hash cache in <store>/.sessions: { "<real path>": [size, mtimeMs, hash, lfSize] }.
function loadHashCache(dir) {
  try {
    const path = join(sessionsDir(dir), HASH_CACHE_FILE);
    if (!existsSync(path) || !lstatSync(path).isFile()) return new Map();
    const data = JSON.parse(openText(dir, readFileSync(path, "utf8")));
    const out = new Map();
    for (const [abs, entry] of Object.entries(data ?? {})) {
      if (Array.isArray(entry) && entry.length === 4 && entry.slice(0, 2).every(Number.isFinite) && /^[0-9a-f]{40}$/.test(entry[2]) && Number.isSafeInteger(entry[3])) out.set(abs, entry);
    }
    return out;
  } catch {
    return new Map();
  }
}

function saveHashCache(dir, cache) {
  try {
    if (!existsSync(dir)) return;
    const folder = ensureSessionsDir(dir);
    const entries = [...cache.entries()].slice(-MAX_CACHE_ENTRIES);
    writeAtomic(join(folder, HASH_CACHE_FILE), sealFor(dir, `${JSON.stringify(Object.fromEntries(entries))}\n`));
  } catch {
    // a cache that cannot be written only costs time
  }
}

// One round of checks: the project's file list (read once, for moves), a byte limit for everything
// read, and the hash cache of the store (attached by checkAnchors).
//   moves:    false skips the search for moved files (hooks); a missing file is then "missing"
//   maxBytes: the most this round reads from disk
export function anchorContext(root, { moves = true, maxBytes = MAX_CHECK_BYTES } = {}) {
  let files = null;
  let read = 0;
  let cache = null;
  let cacheDir = null;
  let dirty = false;
  const hashes = new Map();
  const context = {
    root,
    moves,
    attach(dir) {
      if (cacheDir !== null) return;
      cacheDir = dir;
      cache = loadHashCache(dir);
    },
    flush() {
      if (dirty && cacheDir) saveHashCache(cacheDir, cache);
      dirty = false;
    },
    get bytesRead() {
      return read;
    },
    files() {
      if (files === null) files = walk(root, MAX_SCAN_FILES, { strict: false }).files;
      return files;
    },
    // The hash of a file on disk (a real path inside the project), from the cache when its size and
    // modification time are unchanged.
    fileHash(abs) {
      const info = statSync(abs);
      const hit = cache?.get(abs);
      if (hit && hit[0] === info.size && hit[1] === info.mtimeMs) {
        rememberSize(hit[2], hit[3]);
        return hit[2];
      }
      if (read + info.size > maxBytes) throw new OverBudget();
      read += info.size;
      const { hash, size } = hashWithSize(readFileSync(abs));
      if (cache) {
        cache.delete(abs);
        cache.set(abs, [info.size, info.mtimeMs, hash, size]);
        dirty = true;
      }
      return hash;
    },
    // The hash of a project file, or null (a folder, refused, unreadable, over the limit).
    hashOf(rel) {
      if (!hashes.has(rel)) {
        let hash = null;
        try {
          const where = locate(root, rel);
          if (where.kind === "file") hash = context.fileHash(where.abs);
        } catch {
          hash = null;
        }
        hashes.set(rel, hash);
      }
      return hashes.get(rel);
    },
    // The size on disk of a project file, or -1.
    sizeOf(rel) {
      try {
        return statSync(join(root, ...rel.split("/"))).size;
      } catch {
        return -1;
      }
    },
  };
  return context;
}

// Where a missing file went: the same content elsewhere ("moved"), or the only file with its name
// ("moved-changed"), or nothing. Files with the same name are tried first; other files only when the
// stored size is known, and then only those whose size fits.
function findMove(context, path, hash, size) {
  const name = path.split("/").at(-1);
  const candidates = context.files().filter((f) => f !== path && cleanPath(f) === f);
  const named = candidates.filter((f) => f.split("/").at(-1) === name);
  const fits = (f) => size === undefined || sizeFits(context.sizeOf(f), size);
  const same = named.find((f) => fits(f) && context.hashOf(f) === hash)
    ?? (size === undefined ? undefined : candidates.find((f) => !named.includes(f) && fits(f) && context.hashOf(f) === hash));
  if (same) return { state: "moved", to: same };
  if (named.length === 1) return { state: "moved-changed", to: named[0] };
  return null;
}

// The state of each anchored path: same, changed, moved (same content elsewhere), moved-changed (the
// only file with that name elsewhere, other content), gone, missing (not looked for: hooks), or refused.
export function checkAnchors(dir, id, { root = projectRoot(dir), anchors = readAnchors(dir), sizes = null, context = anchorContext(root) } = {}) {
  const files = anchors[id];
  if (!files) return null;
  context.attach?.(dir);
  if (!sizes && context.sizesOf !== dir) {
    context.sizes = readAnchorSizes(dir);
    context.sizesOf = dir;
  }
  const known = (sizes ?? context.sizes ?? {})[id] ?? {};
  const out = [];
  for (const [path, hash] of Object.entries(files)) {
    let now;
    try {
      now = hashNow(root, path, context);
    } catch {
      now = { refused: "cannot be read" };
    }
    if (now.refused) out.push({ path, state: "refused", reason: now.refused });
    else if (now.hash === hash) out.push({ path, state: "same" });
    else if (!now.missing) out.push({ path, state: "changed" });
    else if (path.endsWith("/")) out.push({ path, state: "gone" });
    else if (context.moves === false) out.push({ path, state: "missing" });
    else {
      let move = null;
      try {
        move = findMove(context, path, hash, known[path]);
      } catch {
        move = null;
      }
      out.push(move ? { path, ...move } : { path, state: "gone" });
    }
  }
  context.flush?.();
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
  if (list("missing").length) parts.push(`missing here (run stashpad anchors to look for a move): ${list("missing").map((f) => f.path).join(", ")}`);
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
