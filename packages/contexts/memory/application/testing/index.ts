// Test doubles and builders for this context.
//
// Shipped inside the package rather than in a test directory because they are
// part of the seam this context offers: an adapter author writes their
// implementation against the same in-memory behaviour the use cases are proven
// against, and a downstream context wiring `MemoryContract` into its own tests
// can build a working memory out of `harness()` in one line.
//
// They are `private` package files and the package's `dist/` is inert, so
// nothing here reaches a running installation.
export * from "./counting-digest.js";
export * from "./fixtures.js";
export * from "./in-memory-cache.js";
export * from "./in-memory-embedding-model.js";
export * from "./in-memory-judge.js";
export * from "./in-memory-knowledge-graph-repository.js";
export * from "./in-memory-memory-repository.js";
export * from "./in-memory-peers.js";
