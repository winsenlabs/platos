// The `privacy` application layer.
//
// Use cases, one per file, each a plain function over a frozen dependency
// bundle. There is no service class and no framework: a use case is invokable in
// memory against the in-memory doubles in `application/testing/`, and every one
// of them returns the kernel's `Result` rather than throwing.
//
// May import this context's `domain/`, its own `application/ports/`, its own
// `contracts/`, and the published `contracts/` of the peer contexts ADR M0.3 §1
// permits — which for `privacy` is `tenancy` alone. It does NOT import the
// contexts whose rows it erases: those arrive as `ErasureTarget[]` through the
// kernel port, injected at the composition root (§3).
export * from "./ports/index.js";
export * from "./dependencies.js";
export * from "./views.js";
export * from "./subject-digests.js";
export * from "./resolve-subject.js";
export * from "./guard-subject-write.js";
export * from "./seal-subject.js";
export * from "./plan-erasure.js";
export * from "./run-erasure-pass.js";
export * from "./record-pass.js";
export * from "./erasure-events.js";
export * from "./request-erasure.js";
export * from "./retry-erasure.js";
export * from "./inventory-subject.js";
export * from "./privacy-contract.js";
