// The testing barrel.
//
// Doubles and fixtures only: no `describe`, no `it`, no assertion. This module
// is imported by suites in this package and by nothing else — it is not on
// `package.json`'s exports, so a peer cannot reach it even if it wanted to.

export * from "./in-memory-stores.js";
export * from "./in-memory-peers.js";
export * from "./in-memory-providers.js";
export * from "./in-memory-infrastructure.js";
export * from "./fixtures.js";
