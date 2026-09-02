// In-memory doubles for this context's ports, and for the two peers it calls.
//
// Published from `application/testing/` rather than hidden in a test file so the
// one context downstream of `cost-monitoring` in the ADR M0.3 §1 DAG —
// `conversations`, which the ADR extracts last — can exercise its own turn
// engine against a real `CostMonitoringContract` without a database, a counter
// store or an outbound transport. Framework-free, like everything else under
// `application/`.
export * from "./in-memory-budget-repository.js";
export * from "./in-memory-spend-ledger.js";
export * from "./in-memory-cap-cache.js";
export * from "./in-memory-notifier.js";
export * from "./in-memory-peers.js";
export * from "./fixtures.js";
