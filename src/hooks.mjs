// Commands that agent apps run as hooks. They read the app's event as JSON on standard input, never
// fail the agent (errors go to standard error, the exit code stays 0) and stay small and fast.
// Claude Code events: SessionStart (also after /compact), UserPromptSubmit, PreCompact, SessionEnd.
// Other agents can call the same commands from their own hooks or scripts.
import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { relative, isAbsolute } from "node:path";
import { buildBrief, DEFAULT_BRIEF_CHARS } from "./brief.mjs";
import { createHandoff } from "./handoff.mjs";
import { recall } from "./recall.mjs";
import { readPins } from "./pins.mjs";
import { findSecrets } from "./security.mjs";
import { existsSync as exists } from "node:fs";
import { resolve } from "node:path";

export const HOOK_EVENTS = ["session-start", "prompt", "pre-compact", "session-end"];
const TAIL_BYTES = 2 * 1024 * 1024;

export function parseEvent(raw) {
  if (!raw || !raw.trim()) return {};
  try {
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function readTail(path) {
  const size = statSync(path).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(fd);
  }
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join(" ");
  }
  return "";
}

// What the session was doing, read from the end of a Claude Code transcript (JSON Lines): the last
// few things the user asked and the files that were written. Deterministic: no model reads it.
export function summarizeTranscript(path, { cwd = null, prompts = 3, files = 10 } = {}) {
  if (!path || !existsSync(path)) return null;
  const asks = [];
  const touched = [];
  for (const line of readTail(path).split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = entry.message ?? entry;
    if (entry.isMeta || entry.isCompactSummary) continue;
    if (message?.role === "user") {
      const text = textOf(message.content).replace(/\s+/g, " ").trim();
      if (text && !text.startsWith("<") && !text.startsWith("Caveat:")) asks.push(text);
    }
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        const file = part?.type === "tool_use" ? part.input?.file_path ?? part.input?.notebook_path : null;
        if (typeof file === "string") {
          // Shown with forward slashes on every system, relative to the project when inside it.
          const shown = (cwd && isAbsolute(file) && !relative(cwd, file).startsWith("..") ? relative(cwd, file) : file).replace(/\\/g, "/");
          if (!touched.includes(shown)) touched.push(shown);
        }
      }
    }
  }
  if (asks.length === 0 && touched.length === 0) return null;
  return { asks: asks.slice(-prompts), files: touched.slice(-files) };
}

function clip(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export function handoffText(summary, reason) {
  const parts = [`Automatic note at ${reason}. It records what was going on; check the code and git status before acting on it.`];
  const asks = summary.asks.filter((a) => findSecrets(a).length === 0);
  if (asks.length === 0 && summary.files.length === 0) return null;
  if (asks.length) parts.push(`Last requests: ${asks.map((a, i) => `(${i + 1}) ${clip(a, 220)}`).join(" ")}`);
  if (summary.files.length) parts.push(`Files written: ${summary.files.join(", ")}`);
  return parts.join("\n");
}

// Returns the text to print (may be empty). Never throws.
export function runHook(dir, event, input = {}, { maxChars = DEFAULT_BRIEF_CHARS, globalDir = null } = {}) {
  const global = globalDir && resolve(globalDir) !== resolve(dir) && exists(globalDir) ? globalDir : null;
  try {
    switch (event) {
      case "session-start": {
        const after = input.source === "compact" ? "Context was just compacted. Your Stashpad memory, again:\n" : "";
        if (!global) return after + buildBrief(dir, { maxChars }).text;
        // Project first; the global store (true in every project) gets a third of the room.
        const project = buildBrief(dir, { maxChars: Math.floor(maxChars * 0.67) }).text;
        const everywhere = buildBrief(global, { maxChars: Math.floor(maxChars * 0.33) }).text.split("\n").slice(1);
        return `${after}${project}\nGlobal store (all projects):\n${everywhere.join("\n")}`;
      }
      case "prompt": {
        const local = recall(dir, input.prompt ?? "", { exclude: readPins(dir) });
        if (!global) return local.text;
        const wide = recall(global, input.prompt ?? "", { exclude: readPins(global), limit: Math.max(0, 3 - local.hits.length) });
        if (!wide.text) return local.text;
        if (!local.text) return wide.text.replace("Stashpad memories", "Stashpad global memories");
        return `${local.text}\n${wide.text.split("\n").slice(2).join("\n")}`;
      }
      case "pre-compact":
      case "session-end": {
        const summary = summarizeTranscript(input.transcript_path, { cwd: input.cwd ?? null });
        if (!summary) return "";
        const reason = event === "pre-compact" ? `compaction (${input.trigger ?? "auto"})` : "the end of a session";
        const text = handoffText(summary, reason);
        if (!text) return "";
        try {
          createHandoff(dir, { text, origin: "auto", from: "hook" });
        } catch {
          // a refused note (for example a secret in a file name) must not break the agent
        }
        return "";
      }
      default:
        return "";
    }
  } catch (error) {
    return { error: error.message };
  }
}
