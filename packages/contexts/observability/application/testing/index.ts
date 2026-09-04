// In-memory doubles for this context's ports, plus the builders that make a
// well-formed Turn.
//
// Published from `application/testing/` rather than hidden in a test file so the
// composition root can exercise a real `ObservabilityContract` without a column
// store, a queue or a database — and so the adapter authors have an executable
// statement of what their implementations must do, including the predicate
// evaluation the residue rule depends on. Framework-free, like everything else
// under `application/`.
export * from "./in-memory-observability-sink.js";
export * from "./in-memory-projection-outbox.js";
export * from "./in-memory-observability-repository.js";
export * from "./fixtures.js";
export * from "./turn-fixture.js";
