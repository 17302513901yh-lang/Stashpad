// Prints the settings that connect an agent client to Stashpad. It prints; it never edits a
// client's files. Stashpad speaks plain MCP over stdio, so any client that supports MCP works.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CLIENTS = ["generic", "claude-code", "vscode", "codex", "agents-md"];

const binPath = () => resolve(fileURLToPath(new URL("../bin/stashpad.mjs", import.meta.url)));

// How to start the server. Run through npx, the install path is a temporary cache that can vanish,
// so the settings then say "npx -y stashpad mcp" instead of a file path.
// Otherwise the full path to this Node is used, not just "node": an agent app often starts servers
// with a different PATH than your terminal (nvm, Volta, Windows, macOS apps), and then "node" is
// missing or too old. That is the most common reason an MCP server does not connect.
export function launcher(bin, nodePath = process.execPath) {
  if (/[\\/]_npx[\\/]/.test(bin)) return { command: "npx", args: ["-y", "stashpad", "mcp"] };
  return { command: nodePath, args: [bin, "mcp"] };
}

export { binPath };

export function setupText(client, { dir = null, bin: binOverride = null, nodePath = process.execPath } = {}) {
  const bin = binOverride ?? binPath();
  const run = launcher(bin, nodePath);
  const env = dir === null ? null : { STASHPAD_DIR: resolve(dir) };
  switch (client) {
    case "generic": {
      const server = { ...run, ...(env ? { env } : {}) };
      return [
        "Most MCP clients (Claude Desktop, Cursor, Windsurf, Gemini CLI and others) take this block in their MCP settings file:",
        JSON.stringify({ mcpServers: { stashpad: server } }, null, 2),
      ].join("\n");
    }
    case "claude-code":
      return `claude mcp add stashpad${env ? ` -e STASHPAD_DIR="${env.STASHPAD_DIR}"` : ""} -- ${[run.command, ...run.args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`;
    case "vscode": {
      const server = { type: "stdio", ...run, ...(env ? { env } : {}) };
      return ["Put this in .vscode/mcp.json:", JSON.stringify({ servers: { stashpad: server } }, null, 2)].join("\n");
    }
    case "codex":
      return [
        "Add this to ~/.codex/config.toml:",
        "[mcp_servers.stashpad]",
        `command = ${JSON.stringify(run.command)}`,
        `args = [${run.args.map((a) => JSON.stringify(a)).join(", ")}]`,
        ...(env ? ["[mcp_servers.stashpad.env]", `STASHPAD_DIR = ${JSON.stringify(env.STASHPAD_DIR)}`] : []),
      ].join("\n");
    case "agents-md":
      return 'No MCP needed: run "stashpad sync-agents AGENTS.md" to put a short brief in the file your agent already reads. The agent saves with plain commands.';
    default:
      return null;
  }
}
