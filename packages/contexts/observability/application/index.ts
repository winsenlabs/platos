// The `observability` application layer.
//
// Use cases, one per file, each a plain function over a frozen dependency
// bundle. There is no service class and no framework: a use case is invokable in
// memory against the in-memory doubles in `application/testing/`, and every one
// of them returns the kernel's `Result` rather than throwing.
//
// May import this context's `domain/`, its own `application/ports/`, its own
// `contracts/`, and the published `contracts/` of the peer contexts ADR M0.3 §1
// permits — which for `observability` is `tenancy` alone.
export * from "./ports/index.js";
export * from "./dependencies.js";
export * from "./views.js";
export * from "./probe-sink.js";
export * from "./drain-projections.js";
export * from "./describe-observability.js";
export * from "./record-admin-action.js";
export * from "./observability-erasure-target.js";
export * from "./observability-contract.js";
