// Optional encryption at rest for a store. Off by default: a plain store keeps plain Markdown files.
// When a store is encrypted (see "stashpad encrypt"), every memory, waiting write, rejected write,
// raw source copy, audit line and snapshot is sealed with AES-256-GCM. The key comes from a
// passphrase (scrypt, salt kept in the store marker) given in STASHPAD_PASSPHRASE or in a file named
// by STASHPAD_KEY_FILE. The passphrase itself is never written anywhere.
// Reading accepts both sealed and plain content, so a conversion that stops halfway loses nothing:
// running the command again finishes it.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { StoreError } from "./errors.mjs";

export const SEAL_PREFIX = "STASHPAD-SEALED-1:";
export const MARKER_BACKUP = ".stashpad-store.backup.json";
const NO_MARKER =
  'this store holds sealed files but its marker has no encryption settings. Run "stashpad doctor": it says how to put the marker back from its backup or a snapshot. Do not delete or recreate the marker by hand.';
const LINE_PREFIX = "SEALED1:";
const MARKER = ".stashpad-store.json";
const CHECK_TEXT = "stashpad key check";
// scrypt cost for new stores (OWASP advice: N=2^17, r=8, p=1). Each store keeps its own settings.
const KDF = { N: 2 ** 17, r: 8, p: 1 };
const MAXMEM = 512 * 1024 * 1024;
const keys = new Map(); // salt -> key, so scrypt runs once per process

export function encryptionOf(dir) {
  const path = join(dir, MARKER);
  if (!existsSync(path) || !lstatSync(path).isFile()) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return data.encryption ?? null;
  } catch {
    return null;
  }
}

export function passphraseFromEnv(env = process.env) {
  if (env.STASHPAD_KEY_FILE) {
    try {
      return readFileSync(env.STASHPAD_KEY_FILE, "utf8").replace(/\r?\n$/, "");
    } catch (error) {
      throw new StoreError(`cannot read the key file in STASHPAD_KEY_FILE (${error.code ?? error.message}).`);
    }
  }
  return env.STASHPAD_PASSPHRASE ?? null;
}

function deriveKey(passphrase, saltB64, params = KDF) {
  const N = params.N ?? params.n ?? KDF.N;
  const r = params.r ?? KDF.r;
  const p = params.p ?? KDF.p;
  const id = `${saltB64}\u0000${N}\u0000${r}\u0000${p}\u0000${passphrase}`;
  const cached = keys.get(id);
  if (cached) return cached;
  const key = scryptSync(passphrase, Buffer.from(saltB64, "base64"), 32, { N, r, p, maxmem: MAXMEM });
  keys.set(id, key);
  return key;
}

// A second key for naming source copies, so the sealing key is used for one job only.
export function namingKey(key) {
  return Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), "stashpad source names", 32));
}

function sealBytes(key, bytes) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

function openBytes(key, b64) {
  const raw = Buffer.from(b64, "base64");
  try {
    if (raw.length < 28) throw new Error("too short");
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12), { authTagLength: 16 });
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
  } catch {
    throw new StoreError("a sealed file could not be opened: the passphrase is wrong or the file was changed.");
  }
}

// A new encryption block for the marker: salt and a check value to recognise a wrong passphrase.
export function newEncryption(passphrase) {
  if (typeof passphrase !== "string" || passphrase.length < 12) {
    throw new StoreError("the passphrase must be at least 12 characters. Set STASHPAD_PASSPHRASE or STASHPAD_KEY_FILE.");
  }
  const salt = randomBytes(16).toString("base64");
  const key = deriveKey(passphrase, salt);
  return { cipher: "aes-256-gcm", kdf: "scrypt", n: KDF.N, r: KDF.r, p: KDF.p, salt, check: sealBytes(key, Buffer.from(CHECK_TEXT)) };
}

// The key for an encrypted store, or null for a plain one. Throws with a clear message when the
// passphrase is missing or wrong.
export function keyFor(dir, env = process.env) {
  const enc = encryptionOf(dir);
  if (enc === null) return null;
  const passphrase = passphraseFromEnv(env);
  if (!passphrase) {
    throw new StoreError("this store is encrypted. Set STASHPAD_PASSPHRASE (or STASHPAD_KEY_FILE) to open it.");
  }
  const key = deriveKey(passphrase, enc.salt, enc);
  let ok = false;
  try {
    ok = timingSafeEqual(openBytes(key, enc.check), Buffer.from(CHECK_TEXT));
  } catch {
    ok = false;
  }
  if (!ok) throw new StoreError("wrong passphrase for this encrypted store.");
  return key;
}

export const isSealed = (text) => typeof text === "string" && text.startsWith(SEAL_PREFIX);

// Text content of a store file, opened when sealed.
export function openText(dir, content) {
  const text = Buffer.isBuffer(content) ? content.toString("utf8") : content;
  if (!isSealed(text)) return text;
  const key = keyFor(dir);
  if (key === null) throw new StoreError(NO_MARKER);
  return openBytes(key, text.slice(SEAL_PREFIX.length)).toString("utf8");
}

export function openRaw(dir, buffer) {
  const head = buffer.subarray(0, SEAL_PREFIX.length).toString("utf8");
  if (head !== SEAL_PREFIX) return buffer;
  const key = keyFor(dir);
  if (key === null) throw new StoreError(NO_MARKER);
  return openBytes(key, buffer.subarray(SEAL_PREFIX.length).toString("utf8"));
}

// What to write for a store file: sealed when the store is encrypted, unchanged otherwise.
export function sealFor(dir, content, key = keyFor(dir)) {
  if (key === null) return content;
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  return SEAL_PREFIX + sealBytes(key, bytes);
}

export function readData(dir, path) {
  return openText(dir, readFileSync(path, "utf8"));
}

// One audit line: sealed on its own, so the log can still be appended to.
export function sealLine(dir, line, key = keyFor(dir)) {
  return key === null ? line : LINE_PREFIX + sealBytes(key, Buffer.from(line, "utf8"));
}

export function openLine(dir, line) {
  if (!line.startsWith(LINE_PREFIX)) return line;
  const key = keyFor(dir);
  if (key === null) throw new StoreError(NO_MARKER);
  return openBytes(key, line.slice(LINE_PREFIX.length)).toString("utf8");
}

export const isSealedLine = (line) => line.startsWith(LINE_PREFIX);

// Low-level helpers for converting a whole store with a known key (see encrypt.mjs).
export function sealWith(key, content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  return SEAL_PREFIX + sealBytes(key, bytes);
}
export function openWith(key, buffer) {
  const head = buffer.subarray(0, SEAL_PREFIX.length).toString("utf8");
  if (head !== SEAL_PREFIX) return null; // not sealed
  return openBytes(key, buffer.subarray(SEAL_PREFIX.length).toString("utf8"));
}
export const sealLineWith = (key, line) => LINE_PREFIX + sealBytes(key, Buffer.from(line, "utf8"));
export const openLineWith = (key, line) => (line.startsWith(LINE_PREFIX) ? openBytes(key, line.slice(LINE_PREFIX.length)).toString("utf8") : line);
