// Driven ports this context needs, and the one adapter-facing port it OWNS.
//
// `ObjectStore` is published from here rather than from the kernel: ADR M0.3 §13
// assigns it to `files`, and `packages/adapters/objectstore-minio` has exactly
// one import edge, to this entrypoint. `FilesRepository` is the canonical-store
// port behind which this context's sole-writer ownership of `MessageAttachment`
// and `Artifact` is realised.
//
// Implemented under `packages/adapters/*`, wired in `apps/core-api`, never
// imported by `domain/` (ADR M0.3 §2).
export * from "./object-store.js";
export * from "./files-repository.js";
