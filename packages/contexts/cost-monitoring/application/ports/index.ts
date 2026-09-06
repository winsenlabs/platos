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

// WIN-258 T5 — the domain values `BudgetRepository`'s SIGNATURES already name.
//
// WITHOUT THIS BLOCK THE CANONICAL-STORE PORT IS UNIMPLEMENTABLE OUTSIDE THIS
// PACKAGE. `budget-repository.ts` above imports `Budget`, `AlertChannel`,
// `AlertDelivery` and eleven more from `../../domain/index.js` as TYPES and
// re-exports none of them, and `contracts/index.ts` publishes the read VIEWS
// rather than the aggregates. So every method below was declared in terms of
// names an adapter package — the only kind of package ADR M0.3 §2 permits to
// implement a driven port — had no way to spell. The same omission was found
// twice already on this issue, on `EndUserStore` and on `SessionRevocationOrder`;
// this is the third, and it is repaired the same way: the port entry point
// publishes exactly what the port's own signatures use, and nothing more.
//
// THE FOUR FUNCTIONS ARE HERE FOR A DIFFERENT AND STRONGER REASON.
// `Budget.scope` is ONE text column carrying seven facts, and
// `domain/budget-scope.ts` says in as many words that its encoding is a domain
// decision "NOT left to an adapter", because the decode's fallback — an
// unreadable column governs the WHOLE environment rather than nothing — is the
// difference between a cap that stops spend and one that does not. An adapter
// that could not name `encodeBudgetTarget` would have written its own, and two
// encoders over one unversioned column is how a row becomes unreadable by the
// release that did not write it. `byListingOrder` is published for the same
// reason: `pageBudgets`'s contract is that exact total order, and a paged
// listing whose order is not total drops and repeats rows across pages.
// The kernel values these signatures name, republished for the same reason
// `identity-access`'s port entry point republishes its own. `EnvironmentScope`,
// `TransactionScope`, `Result` and `Money` are in EVERY method above, and an
// adapter that reached for `@platos/kernel` directly would be a second import
// edge into the kernel from a package whose only declared dependency is the
// context whose port it satisfies.
export type { EnvironmentScope, Money, Result, TransactionScope } from "@platos/kernel";
export { asIdentifier, environmentScope, err, moneyToCentsString, ok } from "@platos/kernel";

export { centsToMoney, repositoryUnavailable } from "../../domain/index.js";
export type {
  AlertChannel,
  AlertChannelId,
  AlertDelivery,
  AlertDeliveryId,
  AlertDeliveryRetry,
  AgentId,
  Budget,
  BudgetId,
  BudgetPeriod,
  BudgetTarget,
  BudgetTier,
  ChannelConfiguration,
  ChannelKind,
  ClaimToken,
  CredentialRef,
  DayStamp,
  DeduplicationKey,
  DeliveryKind,
  DeliveryStatus,
  IdempotencyKey,
  SpendCounters,
  ThresholdEvent,
  ThresholdEventId,
  WindowKey,
} from "../../domain/index.js";
export {
  asCostIdentifier,
  byListingOrder,
  decodeBudgetTarget,
  encodeBudgetTarget,
} from "../../domain/index.js";
