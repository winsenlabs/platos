#!/usr/bin/env node
/**
 * Bin shim — `platools-doctor`.
 *
 * package.json maps the `platools-doctor` npm bin to the compiled
 * version of this file (`./dist/bin/doctor.js`). The shim is
 * intentionally thin: parse argv, run the doctor subcommand, set the
 * process exit code. All the real work lives in `../cli/doctor.ts`.
 */

import { doctorCommand } from "../cli/doctor.js";

void doctorCommand(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(
      `platools-doctor: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  });
