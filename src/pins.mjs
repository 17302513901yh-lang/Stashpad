// Pinned memories: the few rules that must reach the agent at the start of every session and after
// every compaction ("never push to main", "answers in Dutch"). Only a person pins, from the command
// line; agents cannot pin. The list is a store-level file, so memory files keep their fixed format.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { StoreError } from "./errors.mjs";
import { writeAtomic } from "./fsx.mjs";
import { withStoreLock } from "./lock.mjs";
import { prepareForWrite } from "./safety.mjs";
import { isCurrent, readMemory, todayIso } from "./store.mjs";
import { parseMemory } from "./memory-format.mjs";
import { keyFor, openText, sealFor } from "./vault.mjs";

export const PINS_FILE = "pins.json";
export const MAX_PINS = 12;

export function readPins(dir) {
  const path = join(dir, PINS_FILE);
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(openText(dir, readFileSync(path, "utf8")));
    return Array.isArray(data.pinned) ? data.pinned.filter((id) => typeof id === "string") : [];
  } catch (error) {
    if (error instanceof StoreError) throw error;
    return [];
  }
}

function writePins(dir, ids) {
  writeAtomic(join(dir, PINS_FILE), sealFor(dir, `${JSON.stringify({ pinned: ids }, null, 2)}\n`));
}

export function pinMemory(dir, id) {
  return withStoreLock(dir, () => {
    keyFor(dir);
    prepareForWrite(dir);
    const { meta } = parseMemory(readMemory(dir, id).text);
    if (!isCurrent(meta, todayIso())) throw new StoreError(`"${id}" is not current, so it cannot be pinned.`);
    const pins = readPins(dir);
    if (pins.includes(id)) return { id, changed: false, count: pins.length };
    if (pins.length >= MAX_PINS) {
      throw new StoreError(`already ${MAX_PINS} pinned memories. Unpin one first: pinned text is sent every session, so keep it short.`);
    }
    writePins(dir, [...pins, id]);
    return { id, changed: true, count: pins.length + 1 };
  });
}

export function unpinMemory(dir, id) {
  return withStoreLock(dir, () => {
    keyFor(dir);
    const pins = readPins(dir);
    if (!pins.includes(id)) return { id, changed: false, count: pins.length };
    writePins(dir, pins.filter((p) => p !== id));
    return { id, changed: true, count: pins.length - 1 };
  });
}
