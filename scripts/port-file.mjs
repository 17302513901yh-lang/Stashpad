// Command line front end for scripts/port-lib.mjs. Example:
// node scripts/port-file.mjs --project graphiti --source-url https://github.com/getzep/graphiti \
//   --commit 1a2b3c4 --license Apache-2.0 --copyright "Copyright 2025 Zep" \
//   --upstream-path graphiti_core/utils/validity.py --file ../graphiti/graphiti_core/utils/validity.py \
//   --dest graphiti/validity.mjs --license-file ../graphiti/LICENSE --modified-note "ported to JavaScript, names kept"
import { parseArgs } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PortError, portFile } from "./port-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const today = new Date().toISOString().slice(0, 10);

const { values } = parseArgs({
  options: {
    project: { type: "string" },
    "source-url": { type: "string" },
    commit: { type: "string" },
    license: { type: "string" },
    copyright: { type: "string" },
    "upstream-path": { type: "string" },
    file: { type: "string" },
    dest: { type: "string" },
    "license-file": { type: "string" },
    "modified-note": { type: "string" },
  },
  strict: true,
});

try {
  const result = portFile({
    root,
    project: values.project,
    sourceUrl: values["source-url"],
    commit: values.commit,
    license: values.license,
    copyright: values.copyright,
    upstreamPath: values["upstream-path"],
    sourceFile: values.file,
    dest: values.dest,
    licenseFile: values["license-file"],
    modifiedNote: values["modified-note"],
    today,
  });
  console.log(`Ported ${result.dest} under ${result.license}. License text: ${result.licenseText}. Notices and provenance log updated.`);
} catch (error) {
  if (error instanceof PortError) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
