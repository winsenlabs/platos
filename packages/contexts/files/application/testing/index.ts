// In-memory doubles for this context's ports.
//
// Published from `application/testing/` rather than hidden in a test file so the
// contexts downstream of `files` in the ADR M0.3 §1 DAG can exercise their own
// use cases against a real `FilesContract` without a bucket or a database.
// Framework-free, like everything else under `application/`.
export * from "./in-memory-object-store.js";
export * from "./in-memory-files-repository.js";
export * from "./fixtures.js";
