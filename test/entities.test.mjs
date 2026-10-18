import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.mjs";
import { handleMessage, TOOLS } from "../src/mcp.mjs";
import { aboutEntity, extractEntities, listEntities } from "../src/entities.mjs";
import { saveMemory } from "../src/store.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function store() {
  const dir = join(mkdtempSync(join(tmpdir(), "stashpad-ent-")), "s");
  const put = (id, text, extra = {}) => saveMemory(dir, { id, kind: "fact", text, sourceType: "user", sourceRef: "t", ...extra }, "2026-01-01");
  put("db", "The index lives in SQLite and the server in Postgres.");
  put("backup", "Nightly backups copy the Postgres data to S3.");
  put("cli", "The command line starts in `bin/stashpad.mjs` and loads src/cli.mjs.");
  put("old", "We used MongoDB before.");
  put("new", "We use Postgres now instead of MongoDB.", { supersedes: "old" });
  return dir;
}

test("names, tools and files are found without a model", () => {
  assert.deepEqual(extractEntities("The team uses GitHub Actions on Linux, Windows and macOS."), ["GitHub Actions", "Linux", "Windows"]);
  assert.deepEqual(extractEntities("De server draait op Postgres (versie 16) en Redis."), ["Postgres", "Redis"]);
  assert.deepEqual(extractEntities("Edit `config.toml` and docs/FORMAT.md."), ["config.toml", "docs/FORMAT.md"]);
  assert.deepEqual(extractEntities("The plan is simple. Every Tuesday we ship."), []);
});

test("list and about use current memories only, unless ended ones are asked for", () => {
  const dir = store();
  const { rows } = listEntities(dir);
  assert.deepEqual(rows[0], { name: "Postgres", memories: 3 });
  const about = aboutEntity(dir, "postgres");
  assert.deepEqual(about.memories.map((m) => m.id).sort(), ["backup", "db", "new"]);
  assert.ok(about.related.some((r) => r.name === "SQLite"));
  assert.match(about.label, /not an instruction/);
  assert.deepEqual(aboutEntity(dir, "MongoDB").memories.map((m) => m.id), ["new"]);
  assert.equal(aboutEntity(dir, "MongoDB", { includeEnded: true }).memories.length, 2);
});

test("an unknown name suggests close ones", () => {
  const dir = store();
  const about = aboutEntity(dir, "Postgre");
  assert.equal(about.found, false);
  assert.deepEqual(about.did_you_mean, ["Postgres"]);
});

test("CLI and MCP give the same answer", async () => {
  const dir = store();
  const out = [];
  const io = { stdout: (s) => out.push(s), stderr: () => {}, env: {}, cwd: root, readStdin: async () => "" };
  assert.equal(await run(["about", "src/cli.mjs", "--dir", dir], io), 0);
  assert.match(out.join("\n"), /cli  fact/);
  assert.equal(await run(["entities", "--dir", dir, "--json"], io), 0);
  const reply = handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "stashpad_about", arguments: { name: "SQLite" } } }, { dir });
  assert.deepEqual(JSON.parse(reply.result.content[0].text).memories.map((m) => m.id), ["db"]);
  assert.equal(TOOLS.find((t) => t.name === "stashpad_about").annotations.readOnlyHint, true);
});
