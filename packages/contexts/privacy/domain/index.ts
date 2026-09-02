// The `privacy` domain (ADR M0.3 §1, context 18).
//
// Two aggregates, one barrier, one state machine.
//
//   ErasureOperation  the durable, idempotent record of ONE right-to-erasure
//                     request: who was asked about (as a salted digest), what
//                     each target destroyed, what a legal hold kept, and whether
//                     the result was PROVED. It is the product; the deletions
//                     are only its evidence.
//   ErasureTombstone  one row per ALIAS an erased subject could be reached by,
//                     consulted before any identity is resolved or minted so an
//                     in-flight write cannot reintroduce the person the sweep
//                     destroyed. Bounded, content-free, fail-closed.
//
// This context depends on `tenancy` and the kernel and NOTHING else (ADR M0.3
// §1, §3). It does not import the contexts whose rows it erases: each of those
// implements the kernel `ErasureTarget` for the rows it is sole writer of, and
// the composition root injects the array. That graft is what stops right-to-
// erasure from becoming either a fan-in cycle ("privacy defines a port everyone
// implements") or a ten-way fan-out ("privacy imports every context").
//
// This layer imports `@platos/kernel` and its own siblings, and nothing else —
// no framework, no client, no peer context (ADR M0.3 §2). It performs no
// hashing: the salt is a secret and lives behind `SubjectHasher`.
export * from "./identifiers.js";
export * from "./errors.js";
export * from "./policy.js";
export * from "./alias.js";
export * from "./legal-hold.js";
export * from "./tombstone.js";
export * from "./target-outcome.js";
export * from "./erasure-operation.js";
export * from "./retry-schedule.js";
export * from "./content-free.js";
