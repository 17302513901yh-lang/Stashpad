// Command line front end for scripts/port-lib.mjs. Example:
// npm run port -- --project graphiti --source-url https://github.com/getzep/graphiti \
//   --commit <full commit hash> --license Apache-2.0 --copyright "Copyright 2024, Zep Software, Inc." \
//   --upstream-path graphiti_core/utils/maintenance/edge_operations.py \
//   --file ../graphiti/graphiti_core/utils/maintenance/edge_operations.py \
//   --body-file my-translation.mjs --dest graphiti/temporal.mjs \
//   --license-file ../graphiti/LICENSE --modified-note "Python translated to JavaScript, two rules kept"
// Leave out --body-file to copy the original file as it is. The license is checked before anything is read.
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
    "body-file": { type: "string" },
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
    bodyFile: values["body-file"],
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
