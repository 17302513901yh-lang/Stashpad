// Prints the settings that connect an agent client to Stashpad. It prints; it never edits a
// client's files. Stashpad speaks plain MCP over stdio, so any client that supports MCP works.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CLIENTS = ["generic", "claude-code", "vscode", "codex", "agents-md"];

const binPath = () => resolve(fileURLToPath(new URL("../bin/stashpad.mjs", import.meta.url)));

export function setupText(client, { dir = null } = {}) {
  const bin = binPath();
  const env = dir === null ? null : { STASHPAD_DIR: resolve(dir) };
  switch (client) {
    case "generic": {
      const server = { command: "node", args: [bin, "mcp"], ...(env ? { env } : {}) };
      return [
        "Most MCP clients (Claude Desktop, Cursor, Windsurf, Gemini CLI and others) take this block in their MCP settings file:",
        JSON.stringify({ mcpServers: { stashpad: server } }, null, 2),
      ].join("\n");
    }
    case "claude-code":
      return `claude mcp add stashpad${env ? ` -e STASHPAD_DIR="${env.STASHPAD_DIR}"` : ""} -- node "${bin}" mcp`;
    case "vscode": {
      const server = { type: "stdio", command: "node", args: [bin, "mcp"], ...(env ? { env } : {}) };
      return ["Put this in .vscode/mcp.json:", JSON.stringify({ servers: { stashpad: server } }, null, 2)].join("\n");
    }
    case "codex":
      return [
        "Add this to ~/.codex/config.toml:",
        "[mcp_servers.stashpad]",
        'command = "node"',
        `args = [${JSON.stringify(bin)}, "mcp"]`,
        ...(env ? ["[mcp_servers.stashpad.env]", `STASHPAD_DIR = ${JSON.stringify(env.STASHPAD_DIR)}`] : []),
      ].join("\n");
    case "agents-md":
      return 'No MCP needed: run "stashpad sync-agents AGENTS.md" to put a short brief in the file your agent already reads. The agent saves with plain commands.';
    default:
      return null;
  }
}
