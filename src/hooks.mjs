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
import { givenIds, updateSession } from "./sessions.mjs";
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
    return content.filter((part) => (part?.type === "text" || part?.type === "input_text") && typeof part.text === "string").map((part) => part.text).join(" ");
  }
  return "";
}

// What the session was doing, read from the end of an agent session file (JSON Lines): the last
// few things the user asked and the files that were written. Deterministic: no model reads it.
// Two shapes: Claude Code transcripts (message per line) and Codex CLI rollouts (response_item per line).
export function summarizeTranscript(path, { cwd = null, prompts = 3, files = 10 } = {}) {
  if (!path || !existsSync(path)) return null;
  const asks = [];
  const touched = [];
  const ask = (text) => {
    const clean = text.replace(/\s+/g, " ").trim();
    // Injected context (environment, AGENTS.md, caveats) is not something the user asked.
    // Codex writes a user message twice (response_item and event_msg); the copies sit next to each other.
    if (clean && !clean.startsWith("<") && !clean.startsWith("Caveat:") && asks.at(-1) !== clean) asks.push(clean);
  };
  const touch = (file) => {
    // Shown with forward slashes on every system, relative to the project when inside it.
    const shown = (cwd && isAbsolute(file) && !relative(cwd, file).startsWith("..") ? relative(cwd, file) : file).replace(/\\/g, "/");
    if (!touched.includes(shown)) touched.push(shown);
  };
  const patched = (patch) => {
    for (const match of patch.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)) touch(match[1].trim());
  };
  for (const line of readTail(path).split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "event_msg" && entry.payload?.type === "user_message" && typeof entry.payload.message === "string") {
      // Codex CLI: the same user text as a response_item message, sometimes stored only here.
      ask(entry.payload.message);
      continue;
    }
    if (entry.type === "response_item" && entry.payload) {
      // Codex CLI: user messages, and apply_patch calls whose patch names the files it adds or updates.
      // Codex also sends the project's AGENTS.md as a user message; that is context, not a request.
      // Shape from the third-party notes at https://lin-guanguo.github.io/llm-memory-research/agent-cli/codex-session-files/
      // (checked against one CLI version only; Codex does not document this file format).
      const payload = entry.payload;
      if (payload.type === "message" && payload.role === "user") {
        const text = textOf(payload.content);
        if (!text.trimStart().startsWith("# AGENTS.md")) ask(text);
      }
      if (payload.type === "custom_tool_call" && payload.name === "apply_patch" && typeof payload.input === "string") {
        patched(payload.input);
      }
      if (payload.type === "function_call" && typeof payload.arguments === "string") {
        // A patch sent through a shell or function wrapper arrives as a JSON string; the patch is one of its values.
        let args = {};
        try {
          args = JSON.parse(payload.arguments);
        } catch {}
        for (const value of Object.values(args ?? {}).flat()) {
          if (typeof value === "string" && value.includes("*** Begin Patch")) patched(value);
        }
      }
      continue;
    }
    const message = entry.message ?? entry;
    if (entry.isMeta || entry.isCompactSummary) continue;
    if (message?.role === "user") ask(textOf(message.content));
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        const file = part?.type === "tool_use" ? part.input?.file_path ?? part.input?.notebook_path : null;
        if (typeof file === "string") touch(file);
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

// Session state is a convenience: when it cannot be read or written (an encrypted store without
// the passphrase, a read-only folder) the hook still does its main job.
function note(dir, input, change) {
  try {
    updateSession(dir, input.session_id, change);
  } catch {
    // see above
  }
}

function safeGiven(dir, input) {
  try {
    return givenIds(dir, input.session_id);
  } catch {
    return [];
  }
}

function given(state, ids) {
  state.prompts = (state.prompts ?? 0) + 1;
  if (ids.length === 0) return;
  state.given = [...state.given, ...ids];
  state.last = { at: new Date().toISOString(), ids };
}

// Returns the text to print (may be empty). Never throws.
export function runHook(dir, event, input = {}, { maxChars = DEFAULT_BRIEF_CHARS, globalDir = null } = {}) {
  const global = globalDir && resolve(globalDir) !== resolve(dir) && exists(globalDir) ? globalDir : null;
  const cwd = typeof input.cwd === "string" && isAbsolute(input.cwd) ? input.cwd : process.cwd();
  try {
    switch (event) {
      case "session-start": {
        // Compaction or /clear drops what the prompt hook gave earlier, so it may be given again.
        note(dir, input, (s) => {
          if (input.source === "compact" || input.source === "clear") s.given = [];
          s.source = typeof input.source === "string" ? input.source.slice(0, 20) : null;
        });
        if (global) note(global, input, (s) => {
          if (input.source === "compact" || input.source === "clear") s.given = [];
        });
        const after = input.source === "compact" ? "Context was just compacted. Your Stashpad memory, again:\n" : "";
        if (!global) return after + buildBrief(dir, { maxChars, cwd }).text;
        // Project first; the global store (true in every project) gets a third of the room.
        const project = buildBrief(dir, { maxChars: Math.floor(maxChars * 0.67), cwd }).text;
        const everywhere = buildBrief(global, { maxChars: Math.floor(maxChars * 0.33), cwd }).text.split("\n").slice(1);
        return `${after}${project}\nGlobal store (all projects):\n${everywhere.join("\n")}`;
      }
      case "prompt": {
        // Memories this session already got from this hook are not pasted again.
        const local = recall(dir, input.prompt ?? "", { exclude: [...readPins(dir), ...safeGiven(dir, input)], cwd });
        note(dir, input, (s) => given(s, local.hits));
        if (!global) return local.text;
        const wide = recall(global, input.prompt ?? "", { exclude: [...readPins(global), ...safeGiven(global, input)], limit: Math.max(0, 3 - local.hits.length), cwd });
        note(global, input, (s) => given(s, wide.hits));
        if (!wide.text) return local.text;
        if (!local.text) return wide.text.replace("Stashpad memories", "Stashpad global memories");
        return `${local.text}\n${wide.text.split("\n").slice(2).join("\n")}`;
      }
      case "pre-compact":
      case "session-end": {
        if (event === "session-end") note(dir, input, (s) => (s.ended_at = new Date().toISOString()));
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
