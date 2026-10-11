#!/usr/bin/env node
// @ts-check
// npm create @littlebigbrain -- --template documents-link [dir]
import { main } from "../lib/create.mjs";

main(process.argv.slice(2)).catch((error) => {
  console.error(`create-littlebigbrain: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
