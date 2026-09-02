// The `JobHandlerRuntime` port — running untrusted handler source, abstractly.
//
// The live implementation is a `node:worker_threads` worker running a
// `node:vm` context with code generation disabled, a 32 MB heap and an empty
// environment. NONE of that may appear in this layer: a worker thread is a Node
// capability, and a context that named it could not be exercised in memory and
// could not be hosted anywhere else.
//
// WHAT THIS LAYER KEEPS is the part that is a rule rather than a mechanism —
// the timeout (`domain/job.ts`), the admissibility of the result
// (`domain/payload.ts`), and the classification of a failure into one of the
// three live codes. WHAT THE ADAPTER KEEPS is isolation. The split is drawn so
// that an adapter cannot weaken a rule and this layer cannot weaken isolation.
//
// THE OUTCOME IS A CLOSED UNION, NOT AN EXCEPTION. The live service distinguishes
// its three failure modes by catching two private error classes and defaulting
// the rest, which means a new failure mode silently becomes
// `JOB_EXECUTION_FAILED`. Here every mode is a named member, so adding one is a
// compile error at each call site rather than a silent reclassification.

import type { JsonValue, Result } from "@platos/kernel";

export interface HandlerInvocation {
  /** The handler source, verbatim from the row. */
  readonly source: string;
  /** Names the sandbox context and the worker; never used for lookup. */
  readonly jobKey: string;
  readonly payload: JsonValue;
  readonly timeoutMs: number;
}

export type HandlerOutcome =
  /** Ran to completion. `value` is `null` when the handler returned nothing. */
  | { readonly kind: "completed"; readonly value: JsonValue | null }
  /** Exceeded `timeoutMs`. */
  | { readonly kind: "timed-out" }
  /** Produced output that is not serialisable JSON. */
  | { readonly kind: "result-rejected"; readonly reason: string }
  /** Threw, exited non-zero, or failed to start. */
  | { readonly kind: "failed"; readonly reason: string };

export interface JobHandlerRuntime {
  /**
   * Run one handler to a terminal outcome.
   *
   * MUST NOT REJECT. Every failure mode is a member of `HandlerOutcome`; a
   * rejected promise is a defect in the adapter, and `Result` carries only the
   * "could not run this at all" case.
   */
  run(invocation: HandlerInvocation): Promise<Result<HandlerOutcome>>;

  /**
   * Parse the source without running it, for registration.
   *
   * Returns the parse error message, or `null` when it parses. The live
   * `checkSyntax` builds a `new Function(...)` and reports `error.message`.
   */
  checkSyntax(source: string): Promise<Result<string | null>>;
}
