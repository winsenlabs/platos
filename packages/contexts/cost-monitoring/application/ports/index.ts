// Driven ports this context needs, and the adapter-facing port it OWNS.
//
// `Notifier` is published from here rather than from the kernel: ADR M0.3 §13
// assigns it to `cost-monitoring`, and `packages/adapters/notifier-email` and
// `packages/adapters/notifier-webhook` each have exactly one import edge, to this
// entrypoint. `BudgetRepository` is the canonical-store port behind which this
// context's sole-writer ownership of `Budget`, `BudgetThresholdEvent`,
// `AlertChannel`, `AlertChannelConfiguration`, `AlertDelivery` and
// `AlertDeliveryRetry` is realised. `SpendLedger` is the near-line counter seam
// enforcement reads, and `BudgetCapCache` is what ADR §7 decision 3(b) requires
// of the guard.
//
// Implemented under `packages/adapters/*`, wired in `apps/core-api`, never
// imported by `domain/` (ADR M0.3 §2).
export * from "./budget-repository.js";
export * from "./spend-ledger.js";
export * from "./notifier.js";
export * from "./budget-cap-cache.js";
