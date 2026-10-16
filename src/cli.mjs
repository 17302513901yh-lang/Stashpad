// Command line interface for Stashpad. Returns an exit code; never calls process.exit itself.
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseMemory } from "./memory-format.mjs";
import { DATA_LABEL, findInstructionLikeText } from "./security.mjs";
import { serveMcp } from "./mcp.mjs";
import { runEval } from "./eval.mjs";
import {
  StoreError,
  acceptPending,
  historyOf,
  listMemories,
  listPending,
  queueForget,
  readAudit,
  readMemory,
  rejectPending,
  saveMemory,
  searchMemories,
} from "./store.mjs";

export const USAGE = `Usage:
  stashpad save <id> --kind <fact|preference|decision|task> --source-type <user|agent|tool|web> --source-ref "<where it came from>" --text "<the memory>" [--valid-from YYYY-MM-DD] [--supersedes <old-id>]
  stashpad get <id> [--json]
  stashpad history <id> [--json]
  stashpad list [--all] [--json]
  stashpad search <words...> [--limit N] [--all] [--json]
  stashpad forget <id> --reason "<why>"   ask for a memory to end (a person accepts it)
  stashpad review [--json]
  stashpad accept <id>
  stashpad reject <id> [--reason "<why>"]
  stashpad audit [--json]
  stashpad eval [--json]       run the fixed checks and baselines in a temporary store
  stashpad mcp                 serve the five agent tools over stdio (for MCP clients)

Notes:
  A save with --source-type user goes straight into the store.
  A save with agent, tool or web waits in review until a person runs accept or reject.

Options:
  --dir <folder>      where memories live (default: $STASHPAD_DIR, or ./.stashpad/memories)
  --text -            read the memory text from standard input
  --supersedes <id>   the memory this one replaces; that one gets an end date
  --reason "<why>"    why a waiting memory was rejected (kept in the audit log)
  --limit N           most results to show for search (default 10)
  --all               include memories that have ended
  --json              print machine-readable output
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
  all: { type: "boolean" },
  json: { type: "boolean" },
  dir: { type: "string" },
  help: { type: "boolean", short: "h" },
};

export function defaultIo() {
  return {
    stdout: (s) => process.stdout.write(`${s}\n`),
    stderr: (s) => process.stderr.write(`${s}\n`),
    env: process.env,
    cwd: process.cwd(),
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
  const missing = ["kind", "source-type", "source-ref", "text"].filter(
    (name) => values[name] === undefined,
  );
  if (missing.length > 0) {
    return usageError(io, `save needs: ${missing.map((m) => `--${m}`).join(", ")}`);
  }

  const content = values.text === "-" ? await io.readStdin() : values.text;
  const result = saveMemory(dir, {
    id,
    kind: values.kind,
    text: content,
    sourceType: values["source-type"],
    sourceRef: values["source-ref"],
    validFrom: values["valid-from"],
    supersedes: values.supersedes ?? null,
  });

  if (values.json) {
    io.stdout(JSON.stringify({ status: result.status, id, path: result.path }));
  } else if (result.status === "queued") {
    io.stdout(`Queued ${id} for review (not in the store yet). See it with "stashpad review".`);
  } else {
    io.stdout(`Saved ${id} to ${result.path}`);
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

function cmdList(io, dir, values) {
  const { rows, skipped } = listMemories(dir, { includeEnded: values.all === true });

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
    includeEnded: values.all === true,
    limit,
  });
  for (const item of skipped) {
    io.stderr(`skipped ${item.file}: ${item.reason}`);
  }

  if (values.json) {
    io.stdout(JSON.stringify(results));
    return 0;
  }
  if (results.length === 0) {
    io.stdout(`No match for "${text}" among ${total} searched memories. Try other words, or run "stashpad list".`);
    return 0;
  }
  for (const row of results) {
    io.stdout(`${row.score}  ${row.id}  ${row.kind}  ${row.summary}`);
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
  if (values.help) {
    io.stdout(USAGE);
    return 0;
  }
  if (positionals.length === 0) {
    return usageError(io, "No command given.");
  }

  const [command, id] = positionals;
  const dir = values.dir ?? io.env.STASHPAD_DIR ?? join(io.cwd, ".stashpad", "memories");

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
      case "forget":
        if (!id) return usageError(io, 'forget needs an id, for example: stashpad forget db-choice --reason "outdated"');
        return cmdForget(io, dir, id, values);
      case "eval":
        return cmdEval(io, values);
      case "mcp":
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
    throw error;
  }
}
