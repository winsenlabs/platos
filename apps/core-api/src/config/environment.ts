// THE ONE PLACE IN V1 FEATURE CODE THAT READS THE AMBIENT ENVIRONMENT.
//
// WIN-260's acceptance opens with "feature code does not read process.env", and
// that sentence is only worth writing down if something counts. Something does:
// `scripts/arch/env-access.mjs` scans every V1 source file for an environment
// read and fails on any that is not declared, and THIS FILE is the declaration.
// It is one file rather than one directory, because a directory-shaped exception
// grows a second reader the week after it is written and nothing goes red.
//
// WHY A FUNCTION AND NOT A CONSTANT. A module-level snapshot is read at import
// time, which is before the test runner has decided what the environment should
// be, and before a host embedding this package has finished setting one up. It
// is also unmockable without module surgery. Every caller passes the returned
// value onward as an ordinary argument, which is why `load.ts`, all five section
// modules and `platform.ts` are pure functions over an `EnvironmentSource` and
// are testable with an object literal.
//
// WHY IT COPIES. `process.env` is a live view: reading a key later returns
// whatever the value is THEN, and on some platforms the keys are matched
// case-insensitively. Configuration validated at startup and re-read at first
// use is exactly the failure this milestone exists to remove, so the snapshot is
// taken once, frozen, and validated. What booted is what is in force.
//
// WHY IT IS NOT IN `main.ts`. That file's own banner calls it "the ONE file
// entitled to assume it is a process", and it still is for signals, exit codes
// and the listener. The environment is different in kind: it is the INPUT to the
// configuration contract, so it belongs at the contract's edge, next to the
// schema that says what a valid one looks like. Keeping it here also means the
// gate's declared exception is a configuration file, which is the exception the
// acceptance criterion actually names.

import type { EnvironmentSource } from "./load.js";

/**
 * A frozen copy of the ambient environment.
 *
 * The only environment read in `packages/kernel`, `packages/contexts`,
 * `packages/adapters`, `apps/core-api` and `apps/mcp-stdio` outside a test
 * harness. `scripts/arch/env-access.mjs` enforces that and names this function's
 * file as the reason it is allowed.
 */
export function readProcessEnvironment(): EnvironmentSource {
  return Object.freeze({ ...process.env });
}
