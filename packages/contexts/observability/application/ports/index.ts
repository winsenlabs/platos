// Driven ports this context needs, and the adapter-facing port it OWNS.
//
// `ObservabilitySink` is published from here rather than from the kernel: ADR
// M0.3 §13 assigns it to `observability`, and
// `packages/adapters/clickhouse-observability` has exactly one import edge, to
// this entrypoint.
//
// The other three are driven ports with no vendor of their own:
// `ProjectionOutbox` is the drain side of the one transactional outbox,
// `ObservabilityRepository` is the canonical-store port behind this context's
// sole-writer ownership of `AdminAudit`, and `ErasedSubjectRegister` is the
// fail-closed question the drain must ask before it delivers.
//
// All four are implemented under `packages/adapters/*`, wired in
// `apps/core-api`, and never imported by `domain/` (ADR M0.3 §2).
export * from "./observability-sink.js";
export * from "./projection-outbox.js";
export * from "./observability-repository.js";
export * from "./erased-subject-register.js";
