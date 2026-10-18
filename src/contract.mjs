// The agent-facing tool contract. Agents and prompts depend on tool names and arguments, so a silent
// change is a breaking change. A golden file (docs/tool-contract.json) records the contract; a test
// fails when the tools change without the golden file being updated on purpose.
import { createHash } from "node:crypto";
import { TOOLS } from "./mcp.mjs";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function contractOf(tools = TOOLS) {
  return {
    tools: tools.map((tool) => ({
      name: tool.name,
      required: [...(tool.inputSchema?.required ?? [])].sort(),
      arguments: Object.keys(tool.inputSchema?.properties ?? {}).sort(),
    })),
    hash: createHash("sha256").update(canonical(tools)).digest("hex"),
  };
}
