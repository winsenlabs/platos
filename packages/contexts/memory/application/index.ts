// The `memory` application layer.
//
// Use cases, one per file, each a plain function over a frozen dependency
// bundle. There is no service class and no framework: a use case is invokable in
// memory against the in-memory doubles in `application/testing/`, and every one
// of them returns the kernel's `Result` rather than throwing.
//
// May import this context's `domain/`, its own `application/ports/`, its own
// `contracts/`, and the published `contracts/` of the peer contexts ADR M0.3 §1
// permits — which for `memory` are `tenancy` and `providers`.
export * from "./ports/index.js";
export * from "./dependencies.js";
export * from "./authorization.js";
export * from "./embedding.js";
export * from "./judge-pricing.js";
export * from "./remember.js";
export * from "./revise.js";
export * from "./read-memories.js";
export * from "./forget.js";
export * from "./recall.js";
export * from "./retrieve-context.js";
export * from "./knowledge-graph.js";
export * from "./graph-queries.js";
export * from "./extract-from-conversation.js";
export * from "./synthesize-profile.js";
export * from "./reconcile-feedback.js";
export * from "./working-memory.js";
export * from "./memory-erasure-target.js";
export * from "./views.js";
