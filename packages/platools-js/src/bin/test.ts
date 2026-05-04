#!/usr/bin/env node
/**
 * Bin shim — `platools-test`.
 *
 * package.json maps the `platools-test` npm bin to the compiled
 * version of this file (`./dist/bin/test.js`). The shim is
 * intentionally thin: parse argv, run the test subcommand, set the
 * process exit code. All the real work lives in `../cli/test.ts`.
 */

import { testCommand } from "../cli/test.js";

void testCommand(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(
      `platools-test: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  });
