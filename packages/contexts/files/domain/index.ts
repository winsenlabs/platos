// The `files` domain (ADR M0.3 §1, context 10).
//
// Two aggregates, one shared notion of scope.
//
//   Attachment       a POINTER at a blob. Owns an address, a size, an owner, a
//                    binding to a turn, and an expiry. The bytes live behind
//                    `ObjectStore` and never enter this layer.
//   ArtifactRevision a VERSIONED INLINE DOCUMENT. Owns its content outright,
//                    in Postgres, and is append-only: one row per revision.
//
// They are deliberately NOT one union with nullable halves. An attachment has no
// content and an artifact has no storage key, and the fields that would have to
// be nullable to merge them (`storageKey`, `bytes`, `content`, `revision`) are
// exactly the ones every rule depends on being present.
//
// This layer imports `@platos/kernel` and its own siblings, and nothing else —
// no framework, no client, no peer context (ADR M0.3 §2).
export * from "./identifiers.js";
export * from "./errors.js";
export * from "./scope.js";
export * from "./policy.js";
export * from "./storage-key.js";
export * from "./attachment.js";
export * from "./attachment-intake.js";
export * from "./presigned-grant.js";
export * from "./destruction.js";
export * from "./artifact.js";
export * from "./artifact-revision.js";
