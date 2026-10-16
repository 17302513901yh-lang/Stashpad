#!/usr/bin/env node
import { defaultIo, run } from "../src/cli.mjs";

process.exitCode = await run(process.argv.slice(2), defaultIo());
