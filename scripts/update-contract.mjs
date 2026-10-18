// Rewrites docs/tool-contract.json. Run it only when a change to the agent tools is on purpose.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { contractOf } from "../src/contract.mjs";

const target = fileURLToPath(new URL("../docs/tool-contract.json", import.meta.url));
writeFileSync(target, `${JSON.stringify(contractOf(), null, 2)}\n`);
console.log(`wrote ${target}`);
