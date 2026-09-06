// THE ONE PLACE THIS BINARY READS THE AMBIENT ENVIRONMENT.
//
// The stdio binary is the second V1 deployable, and it has a process edge of its
// own: `runtime.ts` validates `PLATOS_MCP_STDIO_RUNTIME_MODULE` fail-closed and
// `main.ts` decides an exit code. Until WIN-260 the read that fed that
// validation sat inline in `main.ts`, the same way `apps/core-api/src/main.ts`
// held its own — which was invisible, because nothing counted.
//
// `scripts/arch/env-access.mjs` counts now, and it found this one. The rule it
// enforces is one declared reader per deployable, in a file that does nothing
// else, so the exception can be checked by reading two short files rather than
// by trusting a directory-shaped allowance.
//
// IT DOES NOT SHARE `apps/core-api`'s READER, and that is deliberate rather than
// duplication left in place. ADR M0.3 §5.1 rule (j) makes `apps/core-api` the
// single composition root; this binary's own banner in `runtime.ts` records why
// it must not reach into that tree, and importing the core-api package here
// would pull an HTTP framework into a process that speaks over a pipe. Two
// deployables, two process edges, one read each.
//
// WHY IT COPIES AND FREEZES, and why it is a function rather than a constant:
// `apps/core-api/src/config/environment.ts` states both at length, and the
// reasons are the same ones. What booted is what is in force.

/** A frozen copy of the ambient environment, taken once, at startup. */
export function readProcessEnvironment(): Readonly<Record<string, string | undefined>> {
  return Object.freeze({ ...process.env });
}
