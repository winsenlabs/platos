// The `files` application layer.
//
// Use cases, one per file, each a plain function over a frozen dependency
// bundle. There is no service class and no framework: a use case is invokable in
// memory against the in-memory doubles in `application/testing/`, and every one
// of them returns the kernel's `Result` rather than throwing.
//
// May import this context's `domain/`, its own `application/ports/`, its own
// `contracts/`, and the published `contracts/` of the peer contexts ADR M0.3 §1
// permits — which for `files` is `tenancy` alone.
export * from "./ports/index.js";
export * from "./dependencies.js";
export * from "./views.js";
export * from "./presign-attachment-upload.js";
export * from "./bind-attachments-to-turn.js";
export * from "./read-attachment.js";
export * from "./destroy-attachment.js";
export * from "./write-artifact-revision.js";
export * from "./read-artifact-revision.js";
export * from "./files-erasure-target.js";
export * from "./files-contract.js";
