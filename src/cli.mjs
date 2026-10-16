// Command line interface for Stashpad. Returns an exit code; never calls process.exit itself.
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseMemory } from "./memory-format.mjs";
import { StoreError, listMemories, readMemory, saveMemory } from "./store.mjs";

export const USAGE = `Usage:
  stashpad save <id> --kind <fact|preference|decision|task> --source-type <user|agent|tool|web> --source-ref "<where it came from>" --text "<the memory>" [--valid-from YYYY-MM-DD]
  stashpad get <id> [--json]
  stashpad list [--all] [--json]

Options:
  --dir <folder>   where memories live (default: $STASHPAD_DIR, or ./.stashpad/memories)
  --text -         read the memory text from standard input
  --json           print machine-readable output
  --help           show this help

Exit codes: 0 ok, 1 the memory or store has a problem, 2 wrong command or options.`;

const OPTIONS = {
  kind: { type: "string" },
  "source-type": { type: "string" },
  "source-ref": { type: "string" },
  text: { type: "string" },
  "valid-from": { type: "string" },
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
  const path = saveMemory(dir, {
    id,
    kind: values.kind,
    text: content,
    sourceType: values["source-type"],
    sourceRef: values["source-ref"],
    validFrom: values["valid-from"],
  });

  if (values.json) {
    io.stdout(JSON.stringify({ saved: id, path }));
  } else {
    io.stdout(`Saved ${id} to ${path}`);
  }
  return 0;
}

function cmdGet(io, dir, id, values) {
  const { text } = readMemory(dir, id);
  if (values.json) {
    const { meta, body } = parseMemory(text);
    io.stdout(JSON.stringify({ ...meta, body }));
  } else {
    io.stdout(text.replace(/\n$/, ""));
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
      case "save":
        if (!id) return usageError(io, "save needs an id, for example: stashpad save db-choice ...");
        return await cmdSave(io, dir, id, values);
      case "get":
        if (!id) return usageError(io, "get needs an id, for example: stashpad get db-choice");
        return cmdGet(io, dir, id, values);
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
