// The `jobs` application layer (ADR M0.3 §1, context 15).
//
// Use cases are free functions taking the frozen dependency bundle and a command,
// returning the kernel's `Result`. No class, no container, no framework: a use
// case is callable from a test with in-memory doubles and from the composition
// root with adapters, and neither call site is privileged.
//
// This layer imports `domain/`, its own `ports/`, `@platos/kernel` and the
// `tenancy` CONTRACT — and nothing else (ADR M0.3 §2).
export * from "./ports/index.js";
export * from "./dependencies.js";
export * from "./minting.js";
export * from "./views.js";
export * from "./register-job.js";
export * from "./execute-job.js";
export * from "./read-jobs.js";
export * from "./request-approval.js";
export * from "./resolve-approval.js";
export * from "./read-approvals.js";
export * from "./sweep-expired-approvals.js";
export * from "./jobs-erasure-target.js";
export * from "./jobs-contract.js";
