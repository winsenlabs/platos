// Driven ports this context needs.
//
// `PrivacyRepository` is the canonical-store port behind which this context's
// sole-writer ownership of `ErasureOperation` and `ErasureTombstone` is
// realised. `SubjectDirectory`, `SubjectHasher` and `LegalHoldRegister` are the
// three things an erasure needs that this context is not allowed to reach for
// itself: who the person is, the salt, and the operator's hold list.
//
// The kernel `ErasureTarget[]` is NOT a port declared here. It is a kernel port
// implemented by every context that owns subject-keyed rows and injected as an
// array at the composition root (ADR M0.3 §3), so it arrives as a dependency
// rather than as something this package defines.
//
// Implemented under `packages/adapters/*` and `apps/core-api`, wired at the
// composition root, never imported by `domain/` (ADR M0.3 §2).
export * from "./privacy-repository.js";
export * from "./subject-directory.js";
export * from "./subject-hasher.js";
export * from "./legal-hold-register.js";
