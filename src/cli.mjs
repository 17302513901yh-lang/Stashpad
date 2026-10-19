// Command line interface for Stashpad. Returns an exit code; never calls process.exit itself.
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseMemory } from "./memory-format.mjs";
import { DATA_LABEL, findInstructionLikeText } from "./security.mjs";
import { serveMcp } from "./mcp.mjs";
import { runEval } from "./eval.mjs";
import { importMemories } from "./importer.mjs";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { exportMemories } from "./export.mjs";
import { archiveSource } from "./sources.mjs";
import { buildBrief, DEFAULT_BRIEF_CHARS, HANDOVER_PREFIX, isHandoverId, syncAgentsFile } from "./brief.mjs";
import { CLIENTS, setupText } from "./setup.mjs";
import { aboutEntity, listEntities } from "./entities.mjs";
import { decryptStore, encryptStore } from "./encrypt.mjs";
import { encryptionOf } from "./vault.mjs";
import { checkClientLaunch, checkPathNode } from "./clientcheck.mjs";
import { HOOK_EVENTS, parseEvent, runHook } from "./hooks.mjs";
import { pinMemory, readPins, unpinMemory } from "./pins.mjs";
import { recall } from "./recall.mjs";
import { globalStore, locateStore } from "./locate.mjs";
import { addSynonyms, logMiss, missReport } from "./misses.mjs";
import { runDoctor } from "./doctor.mjs";
import { contractOf } from "./contract.mjs";
import { VERSION, STORE_FORMAT } from "./version.mjs";
import {
  createSnapshot,
  isInsideInstall,
  listSnapshots,
  migrateStore,
  restoreSnapshot,
} from "./safety.mjs";
import { openInBrowser, startUi } from "./ui.mjs";
import {
  StoreError,
  acceptPending,
  findDuplicates,
  mergeMemories,
  confirmMemory,
  historyOf,
  listMemories,
  listPending,
  queueForget,
  readAudit,
  readMemory,
  rejectPending,
  saveMemory,
  searchMemories,
  todayIso,
} from "./store.mjs";

import { cancelHandoff, claimHandoff, createHandoff, listHandoffs } from "./handoff.mjs";
import { giveFeedback, lint } from "./feedback.mjs";
export const USAGE = `Usage:
  stashpad save <id> --kind <fact|preference|decision|task> --source-type <user|agent|tool|web> --source-ref "<where it came from>" --text "<the memory>" [--valid-from YYYY-MM-DD] [--expires YYYY-MM-DD] [--supersedes <old-id>]
  stashpad get <id> [--json]
  stashpad history <id> [--json]
  stashpad list [--all] [filters] [--json]
  stashpad search <words...> [--limit N] [--all] [filters] [--explain] [--json]
      filters: --kind decision,preference  --source-type user,agent  --as-of YYYY-MM-DD (what was valid that day)
               --since YYYY-MM-DD  --until YYYY-MM-DD (on valid_from)
  stashpad entities [--limit N] [--json]  names, tools and files the memories talk about, most mentioned first
  stashpad about <name...> [--json]       the memories about one of them, and what is mentioned with it
  stashpad misses [--json]             words that searches looked for but did not find, with close words from your memories
  stashpad synonym add <word> <word...>   add a synonym group to this store (synonyms.json)
  stashpad duplicates [--json]         pairs of current memories that say almost the same
  stashpad merge <keep-id> <other-id...>   keep one, end the others (a person only; nothing is deleted)
  stashpad pin <id> | unpin <id> | pins   pin the few rules every session must see (a person only; at most 12)
  stashpad recall <words...> [--json]     the memories that clearly match a request (what the prompt hook adds)
  stashpad hook <session-start|prompt|pre-compact|session-end>   for agent hooks: reads the event JSON on stdin, never fails
  stashpad confirm <id>                   say a memory is still true (updates last_confirmed_at)
  stashpad forget <id> --reason "<why>"   ask for a memory to end (a person accepts it)
  stashpad review [--json]
  stashpad accept <id>
  stashpad reject <id> [--reason "<why>"]
  stashpad audit [--json]
  stashpad import <file> [--format jsonl|text] [--source-ref "<source>"]   queue memories from an export
  stashpad export [--all] [--out <file>]   write memories as JSON Lines (current only; --all adds ended ones)
  stashpad eval [--json]       run the fixed checks and baselines in a temporary store
  stashpad mcp                 serve the eight agent tools over stdio (for MCP clients)
  stashpad ui [--port N] [--open]   review waiting memories in a page on this computer (Ctrl+C stops it)
  stashpad setup [generic|claude-code|vscode|codex|agents-md]   print the settings that connect an agent to Stashpad
  stashpad where [--json]              which store this folder uses, and why
  stashpad doctor [--client] [--json]  check that Stashpad and the store are healthy, with a fix for each problem
  stashpad brief [--max-chars N] [--json]   short plain-text summary for the start of a session (any agent can read it)
  stashpad handover --text "<what the next session needs>" [--source-type user|agent]   leave a note for the next session
  stashpad handoff leave --text "<where I stopped, what is next>" [--from <agent>] [--auto] [--expires-days N]
  stashpad handoff list [--all] [--json]   open handoffs (listing never takes one)
  stashpad handoff claim [<id>] [--by <agent>] [--json]   take one handoff, exactly once (a person's notes first)
  stashpad handoff cancel <id> [--reason "<why>"]
  stashpad feedback <id> --signal helpful|stale|wrong [--note "<why>"]   wrong also asks for the memory to end
  stashpad lint [--json]               memories worth a look: marked stale/wrong, unconfirmed, expiring, broken links
  stashpad sync-agents [<file>]        put the brief into AGENTS.md (or another file) between markers; other text is kept
  stashpad encrypt                     optional: seal the whole store (needs STASHPAD_PASSPHRASE or STASHPAD_KEY_FILE)
  stashpad decrypt [--yes]             turn an encrypted store back into plain files
  stashpad snapshot [--label <name>]   copy the store to <store>/.snapshots/ (an automatic one is taken daily before edits)
  stashpad snapshots [--json]          list snapshots
  stashpad restore <snapshot> [--yes]  put a snapshot back (without --yes it only shows what would happen)
  stashpad migrate [--dry-run]         bring the store to the current format (snapshot first)
  stashpad contract [--json]           show the agent tool contract and its hash
  stashpad --version                   show the version

Notes:
  A save with --source-type user goes straight into the store.
  A save with agent, tool or web waits in review until a person runs accept or reject.

Options:
  --dir <folder>      where memories live (default: $STASHPAD_DIR, else .stashpad/memories in the project:
                      the nearest folder above that has one, else the git root; worktrees share the main one)
  --global, -g        use the global store (~/.stashpad/global or $STASHPAD_GLOBAL_DIR) for what is true in every project
  --text -            read the memory text from standard input
  --supersedes <id>   the memory this one replaces; that one gets an end date
  --source-file <path> keep a copy of the raw source in the store (up to 5 MB), linked from source_ref
  --out <file>        write the export to a file instead of the screen (refuses to overwrite)
  --reason "<why>"    why a waiting memory was rejected (kept in the audit log)
  --limit N           most results to show for search (default 10)
  --all               include memories that have ended
  --json              print machine-readable output
  --label <name>      name part of a snapshot
  --dry-run           show what would change, change nothing
  --yes               confirm a restore
  --version, -v       show the version
  --help              show this help

Exit codes: 0 ok, 1 the memory or store has a problem, 2 wrong command or options.`;

const OPTIONS = {
  kind: { type: "string" },
  "source-type": { type: "string" },
  "source-ref": { type: "string" },
  text: { type: "string" },
  "valid-from": { type: "string" },
  limit: { type: "string" },
  supersedes: { type: "string" },
  reason: { type: "string" },
  "source-file": { type: "string" },
  out: { type: "string" },
  port: { type: "string" },
  open: { type: "boolean" },
  all: { type: "boolean" },
  json: { type: "boolean" },
  dir: { type: "string" },
  label: { type: "string" },
  "dry-run": { type: "boolean" },
  client: { type: "boolean" },
  global: { type: "boolean", short: "g" },
  "max-chars": { type: "string" },
  expires: { type: "string" },
  "expires-days": { type: "string" },
  auto: { type: "boolean" },
  from: { type: "string" },
  by: { type: "string" },
  signal: { type: "string" },
  note: { type: "string" },
  "as-of": { type: "string" },
  since: { type: "string" },
  until: { type: "string" },
  explain: { type: "boolean" },
  yes: { type: "boolean" },
  version: { type: "boolean", short: "v" },
  help: { type: "boolean", short: "h" },
};

export function defaultIo() {
  return {
    stdout: (s) => process.stdout.write(`${s}\n`),
    stderr: (s) => process.stderr.write(`${s}\n`),
    env: process.env,
    cwd: process.cwd(),
    stdinIsTTY: process.stdin.isTTY === true,
    readStdin: () =>
      new Promise((resolve, reject) => {
        let data = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => (data += chunk));
        process.stdin.on("end", () => resolve(data));
        process.stdin.on("error", reject);
      }),
  };
}

function usageError(io, message) {
  io.stderr(`${message}\n\n${USAGE}`);
  return 2;
}

async function cmdSave(io, dir, id, values) {
  const required = ["kind", "source-type", "text"];
  if (values["source-file"] === undefined) required.push("source-ref");
  const missing = required.filter((name) => values[name] === undefined);
  if (missing.length > 0) {
    return usageError(io, `save needs: ${missing.map((m) => `--${m}`).join(", ")}`);
  }

  const content = values.text === "-" ? await io.readStdin() : values.text;
  let sourceRef = values["source-ref"] ?? "";
  if (values["source-file"] !== undefined) {
    const raw = archiveSource(dir, values["source-file"]);
    sourceRef = sourceRef === "" ? `raw: ${raw}` : `${sourceRef}; raw: ${raw}`;
  }
  const result = saveMemory(dir, {
    id,
    kind: values.kind,
    text: content,
    sourceType: values["source-type"],
    sourceRef,
    validFrom: values["valid-from"],
    validTo: values.expires ?? null,
    supersedes: values.supersedes ?? null,
  });

  if (values.json) {
    io.stdout(JSON.stringify({ status: result.status, id, path: result.path, maybe_replaces: result.maybe_replaces }));
  } else if (result.status === "queued") {
    io.stdout(`Queued ${id} for review (not in the store yet). See it with "stashpad review".`);
  } else {
    io.stdout(`Saved ${id} to ${result.path}`);
  }
  if (!values.json && result.maybe_replaces.length > 0) {
    const ids = result.maybe_replaces.map((c) => c.id).join(", ");
    io.stdout(`Looks related to: ${ids}. If it replaces one, end the old one: stashpad forget <id> --reason "replaced by ${id}"`);
  }
  return 0;
}

function cmdReview(io, dir, values) {
  const { rows, skipped } = listPending(dir);
  for (const item of skipped) io.stderr(`skipped ${item.file}: ${item.reason}`);
  if (values.json) {
    io.stdout(JSON.stringify(rows));
    return 0;
  }
  if (rows.length === 0) {
    io.stdout("Nothing waiting for review.");
    return 0;
  }
  for (const row of rows) {
    const replaces = row.supersedes ? `  replaces ${row.supersedes}` : "";
    const flag = row.flagged ? "  [check: reads like an instruction]" : "";
    io.stdout(`${row.id}  ${row.kind}  from ${row.source_type}: ${row.source_ref}${replaces}  ${row.summary}${flag}`);
    for (const conflict of row.conflicts ?? []) {
      const effect = conflict.would_end ? " (accepting it ends that one)" : "";
      io.stdout(`    may conflict with ${conflict.id}${effect}`);
    }
  }
  return 0;
}

function cmdAccept(io, dir, id) {
  const path = acceptPending(dir, id);
  if (id.startsWith("forget-")) {
    io.stdout(`Ended ${id.slice("forget-".length)}. It stays in the store with its end date.`);
  } else {
    io.stdout(`Accepted ${id} into the store: ${path}`);
  }
  return 0;
}

function cmdReject(io, dir, id, values) {
  const path = rejectPending(dir, id, values.reason ?? null);
  io.stdout(`Rejected ${id}. Kept for the record in ${path}`);
  return 0;
}

function cmdImport(io, dir, file, values) {
  const format = values.format ?? (file.endsWith(".jsonl") ? "jsonl" : "text");
  const content = readFileSync(file, "utf8");
  const { queued, skipped } = importMemories(dir, content, {
    format,
    sourceRef: values["source-ref"] ?? `import: ${file}`,
  });
  for (const item of skipped) io.stderr(`skipped ${item.id}: ${item.reason}`);
  io.stdout(
    `Queued ${queued.length} memories for review from ${file}. Nothing is searchable until a person accepts them (stashpad review).`,
  );
  return skipped.length > 0 && queued.length === 0 ? 1 : 0;
}

function cmdEval(io, values) {
  const report = runEval();
  if (values.json) {
    io.stdout(JSON.stringify(report, null, 2));
  } else {
    io.stdout(`Stashpad eval (${report.data})`);
    io.stdout(`Models: ${report.models}`);
    for (const c of report.cases) {
      io.stdout(`${c.passed ? "PASS" : "FAIL"}  ${c.name}  (${c.detail})`);
    }
    io.stdout("Metrics:");
    for (const [key, value] of Object.entries(report.metrics)) io.stdout(`  ${key}: ${value}`);
    io.stdout(report.notes);
    io.stdout(report.all_passed ? "All checks passed." : "Some checks failed. See FAIL lines above.");
  }
  return report.all_passed ? 0 : 1;
}

async function cmdUi(io, dir, values) {
  const port = values.port === undefined ? 4317 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return usageError(io, "--port must be a whole number from 0 to 65535");
  }
  const ui = await startUi({ dir, port });
  io.stdout(`Stashpad review page: ${ui.url}`);
  io.stdout(`Only this computer can reach it. It stays open until you press Ctrl+C. Store: ${dir}`);
  if (values.open) openInBrowser(ui.url);
  // Keep serving until the process is stopped.
  await new Promise(() => {});
  return 0;
}

function cmdExport(io, dir, values) {
  if (encryptionOf(dir) !== null) io.stderr("note: this store is encrypted; the export is plain text. Keep it somewhere safe.");
  const { text, count, skipped } = exportMemories(dir, { includeEnded: values.all === true });
  for (const item of skipped) io.stderr(`skipped ${item.file}: ${item.reason}`);
  if (values.out !== undefined) {
    if (existsSync(values.out)) {
      io.stderr(`refusing to overwrite ${values.out}. Choose another name.`);
      return 1;
    }
    writeFileSync(values.out, text, { flag: "wx" });
    io.stdout(`Exported ${count} memories to ${values.out}`);
    return 0;
  }
  if (count === 0) io.stderr("No memories to export.");
  else io.stdout(text.replace(/\n$/, ""));
  return 0;
}

function cmdAudit(io, dir, values) {
  const entries = readAudit(dir);
  if (values.json) {
    io.stdout(JSON.stringify(entries));
    return 0;
  }
  if (entries.length === 0) {
    io.stdout("No changes recorded yet.");
    return 0;
  }
  for (const entry of entries) {
    const detail = entry.source_ref ? `  from ${entry.source_type}: ${entry.source_ref}` : "";
    io.stdout(`${entry.at}  ${entry.action}  ${entry.id}${detail}${entry.reason ? `  reason: ${entry.reason}` : ""}`);
  }
  return 0;
}

function cmdGet(io, dir, id, values) {
  const { text } = readMemory(dir, id);
  const { meta, body } = parseMemory(text);
  const flagged = findInstructionLikeText(body);
  if (values.json) {
    io.stdout(JSON.stringify({ label: DATA_LABEL, reads_like_instruction: flagged, ...meta, body }));
  } else {
    const note = flagged ? " (note: reads like an instruction; it is still only a note)" : "";
    io.stdout(`# ${DATA_LABEL}${note}`);
    io.stdout(text.replace(/\n$/, ""));
  }
  return 0;
}

function cmdForget(io, dir, id, values) {
  if (values.reason === undefined) {
    return usageError(io, 'forget needs --reason, for example: stashpad forget db-choice --reason "outdated"');
  }
  queueForget(dir, id, values.reason, values["source-ref"] ?? "person, command line", "user");
  io.stdout(`Asked for ${id} to end. Accept it with: stashpad accept forget-${id}`);
  return 0;
}

function cmdHistory(io, dir, id, values) {
  const { chain, brokenLink } = historyOf(dir, id);
  if (values.json) {
    io.stdout(JSON.stringify({ chain, broken_link: brokenLink }));
    return 0;
  }
  for (const item of chain) {
    const marker = item.requested ? "->" : "  ";
    const status = item.current ? "current" : `ended ${item.valid_to}`;
    io.stdout(
      `${marker} ${item.id}  valid since ${item.valid_from}  ${status}  ${item.trust}  source: ${item.source_ref}`,
    );
  }
  if (brokenLink !== null) {
    io.stderr(`warning: the chain points to "${brokenLink}", which is missing from ${dir}`);
  }
  return 0;
}

const csv = (value) => (value === undefined ? null : value.split(",").map((v) => v.trim()).filter(Boolean));

function filtersFrom(values) {
  return {
    includeEnded: values.all === true,
    kinds: csv(values.kind),
    sourceTypes: csv(values["source-type"]),
    asOf: values["as-of"] ?? null,
    since: values.since ?? null,
    until: values.until ?? null,
  };
}

function cmdList(io, dir, values) {
  const { rows, skipped } = listMemories(dir, filtersFrom(values));

  for (const item of skipped) {
    io.stderr(`skipped ${item.file}: ${item.reason}`);
  }

  if (values.json) {
    io.stdout(JSON.stringify(rows));
    return 0;
  }
  if (rows.length === 0) {
    io.stdout(`No memories in ${dir}${values.all ? "" : " that are current"}.`);
    return 0;
  }
  for (const row of rows) {
    const status = row.valid_to === null ? "current" : `ended ${row.valid_to}`;
    io.stdout(`${row.id}  ${row.kind}  since ${row.valid_from}  ${status}  ${row.trust}  ${row.summary}`);
  }
  return 0;
}

function cmdSearch(io, dir, query, values) {
  const text = query.join(" ").trim();
  if (text === "") {
    return usageError(io, 'search needs words, for example: stashpad search "database"');
  }
  const limit = values.limit === undefined ? 10 : Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return usageError(io, "--limit must be a whole number from 1 to 100");
  }

  const { total, results, skipped } = searchMemories(dir, text, {
    ...filtersFrom(values),
    limit,
    explain: values.explain === true,
  });
  for (const item of skipped) {
    io.stderr(`skipped ${item.file}: ${item.reason}`);
  }

  if (values.json) {
    io.stdout(JSON.stringify(results));
    return 0;
  }
  if (results.length === 0) logMiss(dir, text);
  if (results.length === 0) {
    io.stdout(`No match for "${text}" among ${total} searched memories. Try other words, or run "stashpad list".`);
    return 0;
  }
  for (const row of results) {
    io.stdout(`${row.score}  ${row.id}  ${row.kind}  ${row.summary}`);
    if (row.matched) io.stdout(`      matched: ${row.matched.join(", ")}  source: ${row.source_type}  valid ${row.valid_from} to ${row.valid_to ?? "now"}`);
  }
  return 0;
}

function cmdSetup(io, dir, client, values) {
  const text = setupText(client ?? "generic", { dir: values.dir ?? io.env.STASHPAD_DIR ?? null });
  if (text === null) return usageError(io, `Unknown client "${client}". Choose one of: ${CLIENTS.join(", ")}.`);
  io.stdout(text);
  io.stdout("Settings formats differ a little between clients; check yours if this does not load.");
  return 0;
}

async function cmdDoctor(io, dir, values) {
  const report = runDoctor(dir);
  if (values.client) {
    const pathNode = checkPathNode(io.env);
    report.checks.push(pathNode.ok ? { name: "node on PATH", status: "ok", detail: pathNode.detail } : { name: "node on PATH", status: "warn", detail: pathNode.detail, fix: pathNode.fix });
    const launch = await checkClientLaunch({ dir: values.dir ?? io.env.STASHPAD_DIR ?? dir, env: io.env });
    report.checks.push(
      launch.ok
        ? { name: "client start", status: "ok", detail: `the server ${launch.detail} in ${launch.ms} ms, started like an agent app does` }
        : { name: "client start", status: "fail", detail: launch.detail + (launch.stderr ? ` | ${launch.stderr}` : ""), fix: launch.fix },
    );
    report.healthy = report.checks.every((c) => c.status !== "fail");
  }
  if (values.json) {
    io.stdout(JSON.stringify(report, null, 2));
  } else {
    io.stdout(`Stashpad ${report.version}, store: ${dir}${values.where ? ` (${values.where})` : ""}`);
    for (const c of report.checks) {
      io.stdout(`${c.status.toUpperCase().padEnd(4)}  ${c.name}: ${c.detail}`);
      if (c.fix) io.stdout(`        fix: ${c.fix}`);
    }
    io.stdout(report.healthy ? "Nothing is broken." : "Something needs fixing. See the FAIL lines above.");
  }
  return report.healthy ? 0 : 1;
}

function cmdBrief(io, dir, values) {
  const maxChars = values["max-chars"] === undefined ? DEFAULT_BRIEF_CHARS : Number(values["max-chars"]);
  if (!Number.isInteger(maxChars) || maxChars < 300 || maxChars > 20000) {
    return usageError(io, "--max-chars must be a whole number from 300 to 20000");
  }
  const brief = buildBrief(dir, { maxChars });
  io.stdout(values.json ? JSON.stringify(brief) : brief.text);
  return 0;
}

async function cmdHandover(io, dir, values) {
  if (values.text === undefined) {
    return usageError(io, 'handover needs --text, for example: stashpad handover --text "Auth work is half done; next: add tests."');
  }
  const text = values.text === "-" ? await io.readStdin() : values.text;
  const today = todayIso();
  const { rows } = listMemories(dir);
  const existing = new Set(rows.map((r) => r.id));
  let id = `${HANDOVER_PREFIX}${today}`;
  for (let n = 2; existing.has(id) || existsSync(join(dir, "pending", `${id}.md`)); n += 1) {
    id = `${HANDOVER_PREFIX}${today}-${n}`;
  }
  const previous = rows.filter((r) => isHandoverId(r.id)).map((r) => r.id).sort().pop() ?? null;
  const sourceType = values["source-type"] ?? "user";
  const result = saveMemory(dir, {
    id,
    kind: "task",
    text,
    sourceType,
    sourceRef: values["source-ref"] ?? "handover note",
    supersedes: sourceType === "user" ? previous : null,
  });
  io.stdout(
    result.status === "queued"
      ? `Queued ${id} for review. It shows in the brief once a person accepts it.`
      : `Saved ${id}. The next session sees it first in "stashpad brief".`,
  );
  return 0;
}

function cmdSyncAgents(io, dir, file) {
  const done = syncAgentsFile(dir, file ?? join(io.cwd, "AGENTS.md"));
  io.stdout(`${done.action} the Stashpad block in ${file ?? "AGENTS.md"} (${done.shown} of ${done.total} memories).`);
  io.stdout("Note: that file now holds copies of your memories. Do not commit it if they are private.");
  return 0;
}

function cmdSnapshot(io, dir, values) {
  const made = createSnapshot(dir, values.label ?? "manual");
  io.stdout(`Snapshot ${made.name} (${made.files} files). Put it back with: stashpad restore ${made.name} --yes`);
  return 0;
}

function cmdSnapshots(io, dir, values) {
  const names = listSnapshots(dir);
  if (values.json) {
    io.stdout(JSON.stringify(names));
    return 0;
  }
  if (names.length === 0) io.stdout("No snapshots yet. Make one with: stashpad snapshot");
  for (const name of names) io.stdout(name);
  return 0;
}

function cmdRestore(io, dir, name, values) {
  if (values.yes !== true) {
    io.stdout(`Would put snapshot ${name} back into ${dir}. The current state is snapshotted first, so this can be undone.`);
    io.stdout("Nothing changed. Run again with --yes to do it.");
    return 0;
  }
  const done = restoreSnapshot(dir, name);
  io.stdout(`Restored ${done.restored} (${done.files} files). Undo with: stashpad restore ${done.safety} --yes`);
  return 0;
}

function cmdMigrate(io, dir, values) {
  const result = migrateStore(dir, { dryRun: values["dry-run"] === true });
  if (values.json) {
    io.stdout(JSON.stringify(result));
    return result.problems.length > 0 ? 1 : 0;
  }
  io.stdout(`Store format ${result.from} -> ${result.to}${result.dry_run ? " (dry run, nothing written)" : ""}`);
  if (result.steps.length === 0) io.stdout("Already up to date.");
  for (const step of result.steps) io.stdout(`  ${result.dry_run ? "would" : "did"}: ${step}`);
  if (result.snapshot) io.stdout(`Snapshot before the change: ${result.snapshot}`);
  for (const problem of result.problems) io.stderr(`problem: ${problem}`);
  return result.problems.length > 0 ? 1 : 0;
}

function cmdContract(io, values) {
  const contract = contractOf();
  if (values.json) {
    io.stdout(JSON.stringify({ version: VERSION, store_format: STORE_FORMAT, ...contract }, null, 2));
    return 0;
  }
  io.stdout(`Stashpad ${VERSION}, store format ${STORE_FORMAT}`);
  for (const tool of contract.tools) io.stdout(`${tool.name}(${tool.arguments.join(", ")})  required: ${tool.required.join(", ")}`);
  io.stdout(`hash ${contract.hash}`);
  return 0;
}

async function cmdHandoff(io, dir, [action, id], values) {
  if (action === "leave") {
    if (values.text === undefined) return usageError(io, 'handoff leave needs --text, for example: stashpad handoff leave --text "Parser half done; next: tests."');
    const text = values.text === "-" ? await io.readStdin() : values.text;
    const days = values["expires-days"] === undefined ? undefined : Number(values["expires-days"]);
    const r = createHandoff(dir, { text, origin: values.auto ? "auto" : "manual", from: values.from ?? null, ...(days === undefined ? {} : { expiresDays: days }) });
    if (values.json) io.stdout(JSON.stringify(r));
    else io.stdout(`Left handoff ${r.id} (${r.origin}, expires ${r.expires_at.slice(0, 10)}). The next session takes it with: stashpad handoff claim${r.replaced.length ? `\nIt replaces ${r.replaced.join(", ")}.` : ""}`);
    return 0;
  }
  if (action === "list") {
    const r = listHandoffs(dir, { all: values.all === true });
    if (values.json) io.stdout(JSON.stringify(r));
    else if (r.handoffs.length === 0) io.stdout(values.all ? "No handoffs." : "No open handoffs.");
    else for (const h of r.handoffs) io.stdout(`${h.id}  ${h.state}  ${h.origin}${h.from ? ` from ${h.from}` : ""}  ${h.preview}`);
    return 0;
  }
  if (action === "claim") {
    const r = claimHandoff(dir, { id: id ?? null, by: values.by ?? null });
    if (values.json) io.stdout(JSON.stringify(r));
    else if (!r.claimed) io.stdout(r.reason);
    else {
      io.stdout(`# ${r.label}`);
      io.stdout(`Handoff ${r.id} (${r.origin}${r.from ? ` from ${r.from}` : ""}, ${r.created_at.slice(0, 16).replace("T", " ")} UTC)${r.flagged ? ` [check: ${r.flagged}]` : ""}:`);
      io.stdout(r.text);
      if (r.others_open > 0) io.stdout(`${r.others_open} more open: stashpad handoff list`);
    }
    return 0;
  }
  if (action === "cancel") {
    if (!id) return usageError(io, "handoff cancel needs an id. See them with: stashpad handoff list");
    const r = cancelHandoff(dir, id, { reason: values.reason ?? null });
    io.stdout(values.json ? JSON.stringify(r) : `Cancelled ${r.id}.`);
    return 0;
  }
  return usageError(io, "handoff needs leave, list, claim or cancel.");
}

function cmdFeedback(io, dir, id, values) {
  if (values.signal === undefined) return usageError(io, "feedback needs --signal helpful, stale or wrong.");
  const r = giveFeedback(dir, id, { signal: values.signal, note: values.note ?? null, by: values.by ?? null });
  if (values.json) io.stdout(JSON.stringify(r));
  else io.stdout(`Noted: ${id} is ${r.signal}.${r.forget_request && !r.forget_request.error ? " An ending request waits in review." : ""}${r.forget_request?.error ? ` (No ending request: ${r.forget_request.error})` : ""}`);
  return 0;
}

function cmdLint(io, dir, values) {
  const r = lint(dir);
  if (values.json) io.stdout(JSON.stringify(r));
  else if (r.findings.length === 0) io.stdout(`Nothing to look at among ${r.checked} memories.`);
  else {
    io.stdout(`${r.findings.length} finding(s) among ${r.checked} memories:`);
    for (const f of r.findings) io.stdout(`  ${f.rule}  ${f.id}: ${f.message}`);
  }
  return 0;
}

export async function run(argv, io = defaultIo()) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    return usageError(io, error.message);
  }

  const { values, positionals } = parsed;
  if (values.version) {
    io.stdout(`stashpad ${VERSION}`);
    return 0;
  }
  if (values.help) {
    io.stdout(USAGE);
    return 0;
  }
  if (positionals.length === 0) {
    return usageError(io, "No command given.");
  }

  const [command, id] = positionals;
  const located = locateStore({ cwd: io.cwd, env: io.env, explicit: values.dir, global: values.global === true });
  const dir = located.dir;

  try {
    switch (command) {
      case "search":
        return cmdSearch(io, dir, positionals.slice(1), values);
      case "save":
        if (!id) return usageError(io, "save needs an id, for example: stashpad save db-choice ...");
        return await cmdSave(io, dir, id, values);
      case "get":
        if (!id) return usageError(io, "get needs an id, for example: stashpad get db-choice");
        return cmdGet(io, dir, id, values);
      case "entities": {
        const limit = values.limit === undefined ? 30 : Number(values.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) return usageError(io, "--limit must be a whole number from 1 to 500");
        const { total, rows } = listEntities(dir, { limit, includeEnded: values.all === true });
        if (values.json) io.stdout(JSON.stringify({ total, rows }));
        else if (rows.length === 0) io.stdout("No names, tools or files found in the current memories.");
        else {
          for (const row of rows) io.stdout(`${String(row.memories).padStart(3)}  ${row.name}`);
          if (total > rows.length) io.stdout(`${total - rows.length} more; use --limit to see them.`);
        }
        return 0;
      }
      case "about": {
        const name = positionals.slice(1).join(" ").trim();
        if (name === "") return usageError(io, 'about needs a name, for example: stashpad about Postgres');
        const result = aboutEntity(dir, name, { includeEnded: values.all === true });
        if (values.json) {
          io.stdout(JSON.stringify(result));
          return 0;
        }
        if (!result.found) {
          io.stdout(`Nothing stored about "${name}".${result.did_you_mean.length ? ` Did you mean: ${result.did_you_mean.join(", ")}?` : ""}`);
          return 0;
        }
        io.stdout(`# ${result.label}`);
        io.stdout(`${result.name}: ${result.memories.length} memory/memories`);
        for (const m of result.memories) io.stdout(`  ${m.id}  ${m.kind}  ${m.summary}`);
        if (result.related.length > 0) io.stdout(`Mentioned with: ${result.related.map((r) => `${r.name} (${r.together})`).join(", ")}`);
        return 0;
      }
      case "misses": {
        const rows = missReport(dir);
        if (values.json) io.stdout(JSON.stringify(rows));
        else if (rows.length === 0) io.stdout("No missed searches recorded.");
        else {
          for (const r of rows) {
            const hint = r.close.length ? `  close: ${r.close.join(", ")}  ->  stashpad synonym add ${r.term} ${r.close[0]}` : "";
            io.stdout(`${String(r.count).padStart(3)}x  ${r.term}${hint}`);
          }
        }
        return 0;
      }
      case "synonym": {
        if (id !== "add") return usageError(io, "use: stashpad synonym add <word> <word...>");
        const done = addSynonyms(dir, positionals.slice(2));
        io.stdout(`Added. ${done.groups} synonym group(s) in this store.`);
        return 0;
      }
      case "duplicates": {
        const pairs = findDuplicates(dir);
        if (values.json) io.stdout(JSON.stringify(pairs));
        else if (pairs.length === 0) io.stdout("No near-duplicates among the current memories.");
        else {
          for (const p of pairs) io.stdout(`${p.similarity}  ${p.a}  ${p.b}`);
          io.stdout("Keep one with: stashpad merge <keep-id> <other-id>");
        }
        return 0;
      }
      case "merge": {
        const drop = positionals.slice(2);
        if (!id || drop.length === 0) return usageError(io, "merge needs the id to keep and at least one to end, for example: stashpad merge db-choice db-choice-copy");
        const done = mergeMemories(dir, id, drop);
        io.stdout(`Kept ${done.keep}; ended ${done.ended.join(", ")}. Their history stays in the store.`);
        return 0;
      }
      case "pin":
      case "unpin": {
        if (!id) return usageError(io, `${command} needs an id, for example: stashpad ${command} no-force-push`);
        const done = command === "pin" ? pinMemory(dir, id) : unpinMemory(dir, id);
        io.stdout(done.changed ? `${command === "pin" ? "Pinned" : "Unpinned"} ${id} (${done.count} pinned).` : `Nothing changed (${done.count} pinned).`);
        return 0;
      }
      case "pins": {
        const pins = readPins(dir);
        if (values.json) io.stdout(JSON.stringify(pins));
        else io.stdout(pins.length ? pins.join("\n") : "Nothing pinned. Pin a rule with: stashpad pin <id>");
        return 0;
      }
      case "recall": {
        const words = positionals.slice(1).join(" ").trim();
        if (!words) return usageError(io, 'recall needs words, for example: stashpad recall "add a database migration"');
        const result = recall(dir, words);
        if (values.json) io.stdout(JSON.stringify(result));
        else io.stdout(result.text || "No clear match.");
        return 0;
      }
      case "hook": {
        if (!HOOK_EVENTS.includes(id)) return usageError(io, `hook needs one of: ${HOOK_EVENTS.join(", ")}`);
        let raw = "";
        try {
          raw = io.stdinIsTTY ? "" : await io.readStdin();
        } catch {
          raw = "";
        }
        const out = runHook(dir, id, parseEvent(raw), { globalDir: values.global ? null : globalStore(io.env) });
        if (typeof out === "object" && out?.error) io.stderr(`stashpad hook ${id}: ${out.error}`);
        else if (out) io.stdout(out);
        return 0;
      }
      case "confirm": {
        if (!id) return usageError(io, "confirm needs an id, for example: stashpad confirm db-choice");
        const done = confirmMemory(dir, id);
        io.stdout(done.changed ? `Confirmed ${id} as still true today.` : `${id} was already confirmed today.`);
        return 0;
      }
      case "forget":
        if (!id) return usageError(io, 'forget needs an id, for example: stashpad forget db-choice --reason "outdated"');
        return cmdForget(io, dir, id, values);
      case "eval":
        return cmdEval(io, values);
      case "import":
        if (!id) return usageError(io, "import needs a file, for example: stashpad import notes.jsonl");
        return cmdImport(io, dir, id, values);
      case "setup":
        return cmdSetup(io, dir, id, values);
      case "where":
        if (values.json) io.stdout(JSON.stringify({ dir, how: located.how, global: globalStore(io.env) }));
        else {
          io.stdout(`${dir}`);
          io.stdout(`chosen by: ${located.how}`);
          io.stdout(`global store: ${globalStore(io.env)}${existsSync(globalStore(io.env)) ? "" : " (not made yet)"}`);
        }
        return 0;
      case "doctor":
        return await cmdDoctor(io, dir, { ...values, where: located.how });
      case "brief":
        return cmdBrief(io, dir, values);
      case "handover":
        return await cmdHandover(io, dir, values);
      case "handoff":
        return await cmdHandoff(io, dir, positionals.slice(1), values);
      case "feedback":
        if (!id) return usageError(io, "feedback needs an id, for example: stashpad feedback db-choice --signal stale");
        return cmdFeedback(io, dir, id, values);
      case "lint":
        return cmdLint(io, dir, values);
      case "sync-agents":
        return cmdSyncAgents(io, dir, id);
      case "encrypt": {
        const done = encryptStore(dir, io.env);
        io.stdout(`${done.resumed ? "Finished encrypting" : "Encrypted"} the store (${done.files} files sealed, snapshots included).`);
        io.stdout("Keep the passphrase safe. Without it nobody can read these memories, not even you.");
        return 0;
      }
      case "decrypt": {
        if (values.yes !== true) {
          io.stdout("Would turn every sealed file back into plain text, snapshots included. Nothing changed. Run again with --yes.");
          return 0;
        }
        const done = decryptStore(dir, io.env);
        io.stdout(`Decrypted the store (${done.files} files are plain text again).`);
        return 0;
      }
      case "snapshot":
        return cmdSnapshot(io, dir, values);
      case "snapshots":
        return cmdSnapshots(io, dir, values);
      case "restore":
        if (!id) return usageError(io, "restore needs a snapshot name. See them with: stashpad snapshots");
        return cmdRestore(io, dir, id, values);
      case "migrate":
        return cmdMigrate(io, dir, values);
      case "contract":
        return cmdContract(io, values);
      case "mcp":
        if (isInsideInstall(dir)) {
          io.stderr(`warning: the store (${dir}) is inside the Stashpad install folder. An update may replace it. Set STASHPAD_DIR to a folder outside it.`);
        }
        await serveMcp({ dir, input: process.stdin, output: process.stdout });
        return 0;
      case "review":
        return cmdReview(io, dir, values);
      case "accept":
        if (!id) return usageError(io, "accept needs an id, for example: stashpad accept agent-note");
        return cmdAccept(io, dir, id);
      case "reject":
        if (!id) return usageError(io, "reject needs an id, for example: stashpad reject agent-note");
        return cmdReject(io, dir, id, values);
      case "export":
        return cmdExport(io, dir, values);
      case "ui":
        return await cmdUi(io, dir, values);
      case "audit":
        return cmdAudit(io, dir, values);
      case "history":
        if (!id) return usageError(io, "history needs an id, for example: stashpad history db-choice-v2");
        return cmdHistory(io, dir, id, values);
      case "list":
        return cmdList(io, dir, values);
      default:
        return usageError(io, `Unknown command "${command}".`);
    }
  } catch (error) {
    if (error instanceof StoreError) {
      io.stderr(`Error: ${error.message}`);
      return 1;
    }
    const hints = {
      EACCES: "no permission for that file or folder",
      EPERM: "the system does not allow that change",
      ENOSPC: "the disk is full",
      ENOENT: "a file or folder was not found",
      EROFS: "the folder is read-only",
      EISDIR: "a folder was given where a file was expected",
    };
    if (typeof error?.code === "string" && hints[error.code]) {
      io.stderr(`Error: ${hints[error.code]} (${error.path ?? error.code}). Run "stashpad doctor" to check the setup.`);
      return 1;
    }
    throw error;
  }
}
