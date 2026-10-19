// "stashpad doctor": checks that Stashpad can run here and that the store is healthy, and says
// in plain words what to do about each problem. Nothing is changed.
import { accessSync, constants, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateDocuments } from "./memory-format.mjs";
import { handleMessage, TOOLS } from "./mcp.mjs";
import { MARKER, hasSealedFiles, isInsideInstall, listSnapshots, markerRescue, readStoreFormat } from "./safety.mjs";
import { loadStoreSynonyms } from "./synonyms.mjs";
import { MAX_WAITING } from "./security.mjs";
import { contentHash, saveMemory, staleMemories } from "./store.mjs";
import { parseMemory } from "./memory-format.mjs";
import { encryptionOf, keyFor, openLine, readData } from "./vault.mjs";
import { plainFilesInEncryptedStore } from "./encrypt.mjs";
import { STORE_FORMAT, VERSION } from "./version.mjs";

const ok = (name, detail) => ({ name, status: "ok", detail });
const warn = (name, detail, fix) => ({ name, status: "warn", detail, fix });
const fail = (name, detail, fix) => ({ name, status: "fail", detail, fix });

function checkNode(version) {
  const major = Number(String(version).replace(/^v/, "").split(".")[0]);
  return major >= 20
    ? ok("node", `Node ${version}`)
    : fail("node", `Node ${version} is too old`, "Install Node 20 or newer (https://nodejs.org).");
}

// Saves, searches and reads one memory through the same code the agent tools use, in a temp folder.
function selfTest() {
  const temp = mkdtempSync(join(tmpdir(), "stashpad-doctor-"));
  const dir = join(temp, "store");
  try {
    saveMemory(dir, { id: "selftest", kind: "fact", text: "Doctor round trip works fine.", sourceType: "user", sourceRef: "doctor" });
    const call = (name, args) =>
      handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { dir }).result;
    const found = call("stashpad_search", { query: "doctor" });
    if (found.isError || !found.content[0].text.includes("selftest")) throw new Error("search did not find the test memory");
    const got = call("stashpad_get", { id: "selftest" });
    if (got.isError) throw new Error("get failed");
    const listed = handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { dir }).result.tools;
    if (listed.length !== TOOLS.length) throw new Error("tool list is incomplete");
    return ok("self-test", `save, search and get work; ${listed.length} agent tools are served`);
  } catch (error) {
    return fail("self-test", `the built-in round trip failed: ${error.message}`, "Reinstall Stashpad. If it still fails, report this message.");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function checkStore(dir) {
  const checks = [];
  if (!existsSync(dir)) {
    checks.push(ok("store", `${dir} does not exist yet; it is created on the first save`));
    return checks;
  }
  if (!statSync(dir).isDirectory()) {
    checks.push(fail("store", `${dir} is not a folder`, "Point STASHPAD_DIR or --dir at a folder."));
    return checks;
  }
  try {
    accessSync(dir, constants.R_OK | constants.W_OK);
    checks.push(ok("store", `${dir} can be read and written`));
  } catch {
    checks.push(fail("store", `${dir} cannot be read or written`, "Fix the folder permissions, or choose another folder with STASHPAD_DIR."));
    return checks;
  }

  try {
    const format = readStoreFormat(dir);
    if (format === null) {
      checks.push(warn("format", "this store has no format marker (made by an older version)", 'Run "stashpad migrate --dry-run", then "stashpad migrate".'));
    } else if (format > STORE_FORMAT) {
      checks.push(fail("format", `store format ${format} is newer than this Stashpad (${VERSION})`, "Update Stashpad. Reading works; writing is blocked to protect the files."));
    } else {
      checks.push(ok("format", `store format ${format}`));
    }
  } catch (error) {
    checks.push(fail("format", error.message, `Restore from a snapshot ("stashpad snapshots"), or remove ${MARKER} and run "stashpad migrate".`));
  }

  if (encryptionOf(dir) === null && hasSealedFiles(dir)) {
    const rescue = markerRescue(dir);
    checks.push(
      fail(
        "encryption",
        "the store holds sealed files but its marker has no encryption settings",
        rescue ? `Run "stashpad migrate": it puts the marker back from ${rescue.from}.` : "Find .stashpad-store.json in a backup of this folder and put it back. Do not run encrypt: a new key would lock the old files for good.",
      ),
    );
    return checks;
  }
  if (encryptionOf(dir) !== null) {
    try {
      keyFor(dir);
      const plain = plainFilesInEncryptedStore(dir);
      checks.push(
        plain === 0
          ? ok("encryption", "on; every data file is sealed")
          : warn("encryption", `on, but ${plain} file(s) are still plain text`, 'Run "stashpad encrypt" again to finish sealing them.'),
      );
    } catch (error) {
      checks.push(fail("encryption", error.message, "Set STASHPAD_PASSPHRASE or STASHPAD_KEY_FILE to the passphrase used for this store."));
      return checks;
    }
  }
  const names = readdirSync(dir).filter((name) => name.endsWith(".md"));
  const links = names.filter((name) => lstatSync(join(dir, name)).isSymbolicLink());
  if (links.length > 0) {
    checks.push(warn("links", `${links.length} memory file(s) are links and are skipped: ${links.slice(0, 3).join(", ")}`, "Replace each link with a real file, or delete it."));
  }
  let files;
  try {
    files = names.filter((name) => !links.includes(name)).map((name) => ({ name, text: readData(dir, join(dir, name)) }));
  } catch (error) {
    checks.push(fail("memories", `the memory files cannot be opened: ${error.message}`, 'Check the passphrase, or run "stashpad migrate" if the marker was damaged.'));
    return checks;
  }
  const problems = validateDocuments(files);
  checks.push(
    problems.length === 0
      ? ok("memories", `${files.length} memory files, all valid`)
      : fail("memories", `${problems.length} problem(s), for example ${problems[0].file}: ${problems[0].message}`, "Invalid files are skipped by search. Fix or restore them; see docs/FORMAT.md."),
  );

  const pending = join(dir, "pending");
  const waiting = existsSync(pending) ? readdirSync(pending).length : 0;
  if (waiting >= MAX_WAITING) {
    checks.push(fail("review queue", `full: ${waiting} of ${MAX_WAITING}; new agent notes are being refused`, 'Run "stashpad review" (or "stashpad ui") and accept or reject.'));
  } else if (waiting > 0) {
    checks.push(warn("review queue", `${waiting} of ${MAX_WAITING} write(s) waiting for review`, 'Run "stashpad review", then accept or reject.'));
  }
  if (problems.length === 0) {
    const edited = editedByHand(dir, files);
    if (edited.length > 0) {
      checks.push(warn("edited by hand", `${edited.length} memory file(s) changed outside Stashpad since they were saved: ${edited.slice(0, 3).join(", ")}`, "Fine if you edited them yourself. If not, compare with a snapshot (stashpad snapshots)."));
    }
    const stale = staleMemories(dir);
    if (stale.length > 0) {
      checks.push(warn("not confirmed", `${stale.length} memory/memories from agents, tools or the web not confirmed in 180 days, oldest: ${stale.slice(0, 3).map((s) => s.id).join(", ")}`, 'Check each one: "stashpad confirm <id>" if still true, "stashpad forget <id>" if not.'));
    }
  }
  const synonyms = loadStoreSynonyms(dir);
  if (synonyms.problem !== null) {
    checks.push(warn("synonyms", synonyms.problem, "Fix or delete synonyms.json. Search works without it."));
  }
  checks.push(ok("snapshots", `${listSnapshots(dir).length} snapshot(s)`));
  if (isInsideInstall(dir)) {
    checks.push(warn("location", "the store is inside the Stashpad folder", "Set STASHPAD_DIR to a folder outside it, so an update cannot replace your memories."));
  }
  return checks;
}

// Compares each file's text with the last fingerprint the audit log holds for it.
function editedByHand(dir, files) {
  const path = join(dir, "audit.jsonl");
  if (!existsSync(path)) return [];
  const last = new Map();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry = JSON.parse(openLine(dir, line));
      if (typeof entry.hash === "string" && ["saved", "confirmed"].includes(entry.action)) last.set(entry.id, entry.hash);
    } catch {
      // a broken audit line is not this check's business
    }
  }
  return files
    .filter((f) => last.has(f.name.slice(0, -3)) && last.get(f.name.slice(0, -3)) !== contentHash(parseMemory(f.text).body))
    .map((f) => f.name.slice(0, -3));
}

export function runDoctor(dir, { nodeVersion = process.version } = {}) {
  const checks = [checkNode(nodeVersion), selfTest(), ...checkStore(dir)];
  return { version: VERSION, store: dir, checks, healthy: checks.every((c) => c.status !== "fail") };
}
