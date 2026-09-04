// The `observability` domain (ADR M0.3 §1, context 12).
//
// This context is a PROJECTION and an AUDIT SINK. It owns no work of its own: it
// is fed self-describing outbox envelopes describing work other contexts already
// committed, and it turns them into analytical rows and audit records. That
// shapes everything here.
//
//   Nothing in this layer decides that something HAPPENED. It decides what a
//   thing that happened LOOKS LIKE in a column, whether a queued envelope is
//   ours, what a failed delivery becomes, and what survives an erasure.
//
//   Everything is total and nothing throws. The store's insert is all-or-nothing
//   per batch and the batch is frozen in a queue and replayed, so one value that
//   raises is not one bad row — it is a permanently stuck queue that discards
//   every good row queued behind it, for ever.
//
//   Money and identity are the two things it must not get wrong. The lane
//   arithmetic is a partition of what the provider billed, the rates are frozen
//   at the instant the work ran, and the identity columns are split three ways so
//   an erasure can clear the identifying ones and keep the pseudonymous one.
//
// This layer imports `@platos/kernel` and its own siblings, and nothing else —
// no framework, no client, no peer context (ADR M0.3 §2).
export * from "./identifiers.js";
export * from "./errors.js";
export * from "./projection-tables.js";
export * from "./column-values.js";
export * from "./attributes.js";
export * from "./token-lanes.js";
export * from "./observed-work.js";
export * from "./projection.js";
export * from "./json-read.js";
export * from "./observed-work-codec.js";
export * from "./envelope.js";
export * from "./delivery.js";
export * from "./sink-health.js";
export * from "./admin-audit.js";
export * from "./subject-erasure.js";
