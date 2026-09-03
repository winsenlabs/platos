// In-memory doubles for this context's ports, and for the peers it calls.
//
// Published from `application/testing/` rather than hidden in a test file so the
// contexts downstream of `agents` in the ADR M0.3 §1 DAG — `governance` and
// `conversations` — can exercise their own use cases against a real
// `AgentsContract` without a database. Framework-free, like everything else
// under `application/`.
export * from "./in-memory-agents-repository.js";
export * from "./in-memory-scaffolding.js";
export * from "./in-memory-peers.js";
export * from "./fixtures.js";
