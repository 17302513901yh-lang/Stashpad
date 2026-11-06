// Commands that agent apps run as hooks. They read the app's event as JSON on standard input, never
// fail the agent (errors go to standard error, the exit code stays 0) and stay small and fast.
// Claude Code events: SessionStart (also after /compact), UserPromptSubmit, PreCompact, SessionEnd.
// Other agents can call the same commands from their own hooks or scripts.
import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { relative, isAbsolute } from "node:path";
import { buildBrief, DEFAULT_BRIEF_CHARS } from "./brief.mjs";
import { createHandoff, validBranch } from "./handoff.mjs";
import { recall } from "./recall.mjs";
import { readPins } from "./pins.mjs";
import { fence, redactSecrets } from "./security.mjs";
import { givenIds, listSessions, sessionKey, updateSession } from "./sessions.mjs";
import { gitStatus } from "./git.mjs";
import { logShown } from "./shown.mjs";
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

const MAX_UNCOMMITTED = 10;

// The note's text, with secrets masked (before anything is cut short, so a cut cannot split one), or
// null when there is nothing to say. Returns { text, redacted, branch }.
//   git:     { branch, files } from git status, or null
//   unclean: the time the previous session was last active, when it never reached the session end
export function handoffText(summary, reason, { git = null, unclean = null } = {}) {
  let redacted = 0;
  const mask = (text) => {
    const r = redactSecrets(text);
    redacted += r.count;
    return r.text;
  };
  const asks = (summary?.asks ?? []).map(mask);
  const files = (summary?.files ?? []).map(mask);
  const open = (git?.files ?? []).map(mask);
  if (asks.length === 0 && files.length === 0 && unclean === null) return null;
  const parts = unclean
    ? [`Automatic note: the previous session (last active ${String(unclean).slice(0, 16).replace("T", " ")} UTC) did not end cleanly; no session end was recorded. It may have crashed or been closed, or it may still be running in another window. Treat its work as unfinished; check the code and git status before acting on it.`]
    : [`Automatic note at ${reason}. It records what was going on; check the code and git status before acting on it.`];
  if (asks.length) parts.push(`Last requests: ${asks.map((a, i) => `(${i + 1}) ${clip(a, 220)}`).join(" ")}`);
  if (files.length) parts.push(`Files written: ${files.join(", ")}`);
  const branch = git?.branch ? mask(git.branch) : null;
  if (branch) parts.push(`Branch: ${branch}`);
  if (open.length) parts.push(`Uncommitted: ${open.slice(0, MAX_UNCOMMITTED).join(", ")}${open.length > MAX_UNCOMMITTED ? ` (+${open.length - MAX_UNCOMMITTED} more)` : ""}`);
  if (redacted) parts.push(`${redacted} secret(s) masked as [REDACTED].`);
  // The record keeps the branch only when it is a clean name; a masked one stays in the text only.
  return { text: parts.join("\n"), redacted, branch: branch && validBranch(branch) ? branch : null };
}

// A session that wrote prompts but never reached the session end (crashed, killed, closed without
// the hook): the next session start leaves an automatic handoff about it, once.
function noteUncleanEnd(dir, input) {
  try {
    const me = sessionKey(input.session_id);
    if (!me) return;
    const previous = listSessions(dir).find((s) => s.session !== me && (s.prompts ?? 0) > 0 && !s.ended_at && !s.unclean_noted);
    if (!previous) return;
    updateSession(dir, previous.session, (s) => (s.unclean_noted = new Date().toISOString()));
    const summary = typeof previous.transcript_path === "string" ? summarizeTranscript(previous.transcript_path, { cwd: previous.cwd ?? null }) : null;
    const where = typeof previous.cwd === "string" && existsSync(previous.cwd) ? previous.cwd : null;
    const written = handoffText(summary, "an unclean end", { git: where ? gitStatus(where) : null, unclean: previous.updated_at });
    createHandoff(dir, { text: written.text, origin: "auto", from: "hook", redacted: written.redacted, branch: written.branch });
  } catch {
    // never break the session start
  }
}

// Where the session's transcript and working folder are, for noteUncleanEnd (local paths, kept in
// the git-ignored session file only).
function remember(state, input) {
  if (typeof input.transcript_path === "string" && isAbsolute(input.transcript_path) && input.transcript_path.length < 1000) state.transcript_path = input.transcript_path;
  if (typeof input.cwd === "string" && isAbsolute(input.cwd) && input.cwd.length < 1000) state.cwd = input.cwd;
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
        if (input.source !== "compact") noteUncleanEnd(dir, input);
        note(dir, input, (s) => {
          if (input.source === "compact" || input.source === "clear") s.given = [];
          s.source = typeof input.source === "string" ? input.source.slice(0, 20) : null;
          remember(s, input);
        });
        if (global) note(global, input, (s) => {
          if (input.source === "compact" || input.source === "clear") s.given = [];
        });
        const after = input.source === "compact" ? "Context was just compacted. Your Stashpad memory, again:\n" : "";
        // Stashpad's own line stays outside the data block; everything recalled goes inside it.
        if (!global) {
          const brief = buildBrief(dir, { maxChars, cwd, anchorMoves: false });
          const out = after + fence(brief.text);
          logShown(dir, { event: "session-start", ids: brief.ids, chars: out.length, session: input.session_id });
          return out;
        }
        // Project first; the global store (true in every project) gets a third of the room.
        const project = buildBrief(dir, { maxChars: Math.floor(maxChars * 0.67), cwd, anchorMoves: false });
        const wide = buildBrief(global, { maxChars: Math.floor(maxChars * 0.33), cwd, anchorMoves: false });
        const everywhere = wide.text.split("\n").slice(1).join("\n");
        const out = after + fence(`${project.text}\nGlobal store (all projects):\n${everywhere}`);
        logShown(dir, { event: "session-start", ids: project.ids, chars: out.length - everywhere.length, session: input.session_id });
        logShown(global, { event: "session-start", ids: wide.ids, chars: everywhere.length, session: input.session_id });
        return out;
      }
      case "prompt": {
        // Memories this session already got from this hook are not pasted again.
        const local = recall(dir, input.prompt ?? "", { exclude: [...readPins(dir), ...safeGiven(dir, input)], cwd, anchorMoves: false });
        note(dir, input, (s) => {
          given(s, local.hits);
          remember(s, input);
        });
        const shown = (store, result, out) => {
          if (result.hits.length) logShown(store, { event: "prompt", ids: result.hits, chars: out, session: input.session_id });
        };
        if (!global) {
          const out = fence(local.text);
          shown(dir, local, out.length);
          return out;
        }
        const wide = recall(global, input.prompt ?? "", { exclude: [...readPins(global), ...safeGiven(global, input)], limit: Math.max(0, 3 - local.hits.length), cwd, anchorMoves: false });
        note(global, input, (s) => given(s, wide.hits));
        const extra = wide.text.split("\n").slice(2).join("\n");
        const out = !wide.text ? fence(local.text) : !local.text ? fence(wide.text.replace("Stashpad memories", "Stashpad global memories")) : fence(`${local.text}\n${extra}`);
        shown(dir, local, out.length - (wide.text ? extra.length : 0));
        shown(global, wide, extra.length);
        return out;
      }
      case "pre-compact":
      case "session-end": {
        if (event === "session-end") note(dir, input, (s) => (s.ended_at = new Date().toISOString()));
        const summary = summarizeTranscript(input.transcript_path, { cwd: input.cwd ?? null });
        if (!summary) return "";
        const reason = event === "pre-compact" ? `compaction (${input.trigger ?? "auto"})` : "the end of a session";
        const written = handoffText(summary, reason, { git: gitStatus(cwd) });
        if (!written) return "";
        try {
          createHandoff(dir, { text: written.text, origin: "auto", from: "hook", redacted: written.redacted, branch: written.branch });
        } catch {
          // a refused note (for example one over the size limit) must not break the agent
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
