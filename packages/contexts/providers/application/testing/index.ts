// In-memory doubles for this context's ports, and for the two peers it calls.
//
// Published from `application/testing/` rather than hidden in a test file so the
// contexts downstream of `providers` in the ADR M0.3 §1 DAG — `agents`, `tools`,
// `memory`, `cost-monitoring` and `conversations` — can exercise their own use
// cases against a real `ProvidersContract` without a database, a vault, or a
// provider account. Framework-free, like everything else under `application/`.
export * from "./in-memory-providers-repository.js";
export * from "./in-memory-model-router.js";
export * from "./in-memory-probe-cache.js";
export * from "./in-memory-peers.js";
export * from "./fixtures.js";
