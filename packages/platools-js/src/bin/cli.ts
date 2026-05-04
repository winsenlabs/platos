#!/usr/bin/env node
/**
 * Bin shim — `platools`.
 *
 * package.json maps the `platools` npm bin to the compiled version
 * of this file (`./dist/bin/cli.js`). The shim is intentionally thin
 * — parse argv, dispatch via `main()`, set the process exit code.
 * All the real work lives in `../cli/index.ts`.
 */

import { main } from "../cli/index.js";

void main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(
      `platools: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  });
