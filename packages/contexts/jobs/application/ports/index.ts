// Driven ports this context needs.
//
// `JobsRepository` and `ApprovalsRepository` are the canonical-store ports behind
// which this context's sole-writer ownership of `Job` and `AgentApproval` is
// realised. `IdempotencyStore` and `JobHandlerRuntime` are the two pieces of
// infrastructure the execution path cannot do without — a reserve-once keyspace
// and an isolate — each reduced to the meaning this context needs rather than the
// capability its vendor offers.
//
// ADR M0.3 §13 assigns no adapter-facing port to `jobs`, so unlike `files` this
// entrypoint publishes nothing another package OWNS: it exists because the
// adapters that implement these four import them from here, and for no other
// reason.
//
// Implemented under `packages/adapters/*`, wired in `apps/core-api`, never
// imported by `domain/` (ADR M0.3 §2).
export * from "./jobs-repository.js";
export * from "./approvals-repository.js";
export * from "./idempotency-store.js";
export * from "./job-handler-runtime.js";
