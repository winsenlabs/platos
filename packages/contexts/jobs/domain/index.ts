// The `jobs` domain (ADR M0.3 §1, context 15).
//
// Two aggregates, one environment-keyed scope.
//
//   Job            a DEFINITION of durable work: handler source, how it may be
//                  started, who may start it, and an execution budget. It is not
//                  a run. Runs live behind the kernel's `DurableRuntime` port and
//                  belong to the durable-runtime adapter, which is why nothing
//                  here carries a run id or an execution count.
//   Approval       a HUMAN DECISION a turn is waiting on. Created when a turn
//                  needs approval; the turn then parks on a `DurableRuntime`
//                  suspension and resumes when the decision lands.
//
// They share an owner and a scope and nothing else, so they are two aggregates
// rather than one. A `Job` outlives every run of it; an `Approval` is born and
// dies inside a single turn.
//
// This layer imports `@platos/kernel` and its own siblings, and nothing else —
// no framework, no client, no peer context (ADR M0.3 §2).
export * from "./identifiers.js";
export * from "./errors.js";
export * from "./scope.js";
export * from "./payload.js";
export * from "./invocation.js";
export * from "./job-key.js";
export * from "./job.js";
export * from "./job-definition.js";
export * from "./execution-request.js";
export * from "./idempotency.js";
export * from "./approval-status.js";
export * from "./approval.js";
export * from "./approval-request.js";
