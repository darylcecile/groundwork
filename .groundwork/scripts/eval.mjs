#!/usr/bin/env bun
import { main } from "./evals/cli.mjs";

try { process.exitCode = await main(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exitCode = 2; }
