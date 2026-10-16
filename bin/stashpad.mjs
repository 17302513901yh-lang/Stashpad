#!/usr/bin/env node
import { defaultIo, run } from "../src/cli.mjs";

// When the reader of our output closes early (for example `stashpad ... | head`), stop quietly.
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

process.exitCode = await run(process.argv.slice(2), defaultIo());
