// In-memory doubles and fixtures for the `eventing` context.
//
// Shipped inside the package rather than in a test-only folder so the whole
// context is exercisable in memory by anyone who depends on it — the property
// ADR M0.3 §2 buys by keeping `domain/` and `application/` framework-free.
export * from "./in-memory-rule-repository.js";
export * from "./in-memory-queue.js";
export * from "./fixtures.js";
