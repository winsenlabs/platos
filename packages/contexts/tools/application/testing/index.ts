// In-memory doubles for this context's ports, and for the peers it calls.
//
// Published from `application/testing/` rather than hidden in a test file so
// `conversations` — the one context downstream of `tools` in the ADR M0.3 §1
// DAG — can exercise its turn loop against a real `ToolsContract` with no
// database, no customer backend and no MCP server. Framework-free, like
// everything else under `application/`.
export * from "./in-memory-tools-repository.js";
export * from "./in-memory-dispatch.js";
export * from "./in-memory-peers.js";
export * from "./fixtures.js";
