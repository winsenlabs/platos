// In-memory doubles and builders for exercising this context without
// infrastructure. Published from `application/testing` so a sibling package's
// tests and the composition root's smoke tests can reuse them rather than
// re-implement a weaker double.
export * from "./fixtures.js";
export * from "./builders.js";
export * from "./in-memory-jobs-repository.js";
export * from "./in-memory-approvals-repository.js";
export * from "./in-memory-infrastructure.js";
