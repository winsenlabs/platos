// THE TWO WAYS A CORE-API CALL FAILS, AND WHY THEY LIVE APART FROM THE CLIENT.
//
// `coreApi.server.ts` reads `~/env.server` at module load, which parses the whole
// environment and refuses a process that has not been configured. That is right
// for a CLIENT — a dashboard with no upstream URL should fail at boot rather than
// at the first request — and wrong for an ERROR TYPE. `m4Mutation.server.ts` needs
// to recognise a core refusal so it can answer with the code and the status core
// stated instead of rendering another deployable's prose; it does not need a
// configured upstream to do that, and a module that could not be imported without
// one made four suites fail at collection for the sake of two `instanceof` checks.
//
// So the types are here and the transport is there. `coreApi.server.ts` re-exports
// both, so every call site still has one import.

/**
 * A refusal core-api stated, carried with the code it stated it under.
 *
 * THE CODE IS KEPT AND THE BODY IS NOT RENDERED TO A BROWSER by any caller. A V1
 * error body names an `errorId` and a `traceRef` an operator can chase in the core
 * process's logs; reflecting it into a dashboard page would publish the internals
 * of another deployable to whoever asked, and would make the 404 that hides a
 * foreign tenant distinguishable from the 404 that means the slug is wrong.
 */
export class CoreApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields: readonly { readonly field: string; readonly code: string; readonly message: string }[] = [],
  ) {
    super(message);
    this.name = "CoreApiError";
  }
}

/** core-api could not be reached at all, or did not answer JSON. */
export class CoreApiUnavailableError extends Error {
  readonly code = "CORE_API_UNAVAILABLE";
  constructor(message = "The core API is unavailable") {
    super(message);
    this.name = "CoreApiUnavailableError";
  }
}

/** True when a refusal means "this operator may not", rather than "this broke". */
export function isForbidden(error: unknown): boolean {
  return error instanceof CoreApiError && (error.status === 403 || error.status === 404);
}

/** True when a refusal means "this browser is not signed in". */
export function isUnauthenticated(error: unknown): boolean {
  return error instanceof CoreApiError && error.status === 401;
}
