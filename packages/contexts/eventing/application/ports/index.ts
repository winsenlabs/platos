// Driven ports of the `eventing` context.
//
// Implemented by `packages/adapters/*` and wired in `apps/core-api`. Never
// imported by `domain/` — the arrows point inward, and a port is an
// application-layer concept because it is a use case that decides it needs one.
//
// This is the second of this package's two published entry points
// (`@platos/context-eventing/application/ports/index.js`), and it is the one an
// adapter imports. ADR M0.3 §13: an adapter-facing port belongs to the context
// whose capability it serves, and does not move into the kernel merely because
// its implementation lives under `packages/adapters/`.
//
// NOTE ON `Notifier`. ADR M0.3 §13 assigns the `Notifier` port to
// `cost-monitoring`, and `notifier-email` / `notifier-webhook` are that
// context's adapters (`scripts/arch/v1-project-graph.mjs`). Nothing here
// duplicates it. `NotificationQueue` is a different seam: it hands off a
// REQUEST for delivery, and what eventually performs the send is downstream of
// this context entirely.

export type { NotificationRuleRepository, EventingErasureSelector } from "./notification-rule-repository.js";
export type { DestinationScreen, ScreenedDestination } from "./destination-screen.js";
export type { NotificationQueue, EnqueuedNotification } from "./notification-queue.js";

// WIN-258 T5 — the domain and kernel values the canonical-store port's
// SIGNATURE already names.
//
// WITHOUT THIS BLOCK `NotificationRuleRepository` IS UNIMPLEMENTABLE OUTSIDE
// THIS PACKAGE. `notification-rule-repository.ts` above imports `NotificationRule`,
// `NotificationRuleId` and `RuleName` from `../../domain/index.js` as TYPES and
// re-exports none of them, and `contracts/index.ts` publishes the read VIEW
// (`NotificationRuleView`) rather than the aggregate — so every one of the nine
// methods was declared in terms of names an adapter package had no way to spell.
// The same omission was found on `EndUserStore` (T2), on `SessionRevocationOrder`
// (T3) and on `governance`'s whole aggregate set (T5); this is the fourth, and it
// is repaired the same way. The entry point publishes exactly what the port's own
// signatures use, plus the parsers and error constructors an adapter must call to
// honour them, and nothing more.
//
// THE PARSERS ARE HERE FOR A STRONGER REASON THAN CONVENIENCE. `filters` and
// `delivery` are JSONB columns behind ONE check each on their ROOT
// (`NotificationRule_filters_json_root`, `NotificationRule_delivery_json_root`,
// both `jsonb_typeof(...) = 'object'`), so NOTHING in the database constrains a
// field inside either. A store that CAST a stored column to `RuleFilter` or
// `Destination` would put a value outside those types into `ruleAdmits` and into
// the delivery adapter, with no error anywhere. `parseRuleFilter` and
// `parseDestination` are what let the adapter refuse such a row by name instead,
// and `toRuleFilterInput`/`toDestinationInput` are the matching write halves —
// an adapter that re-derived either would be a second copy of the column shape.
//
// The kernel values are republished for the reason `identity-access`',
// `cost-monitoring`'s and `governance`'s port entry points republish theirs:
// `EnvironmentScope`, `TenantScope`, `TransactionScope` and `Result` are in every
// method above, and an adapter reaching for `@platos/kernel` directly would be a
// second import edge into the kernel from a package whose only declared
// dependency is the context whose ports it satisfies.
export type { EnvironmentScope, NotResult, PrincipalId, Result, TenantScope, TransactionScope } from "@platos/kernel";
// WIN-260 (M2.5): `runResult` joins them, and `NotResult` beside it.
// `UnitOfWork.run` REFUSES a callback whose answer is a `Result` — such a
// callback RESOLVES, and a resolved callback COMMITS, which is the defect
// `cost-monitoring` shipped — so `runResult` is the only way to end a unit of
// work with a failure, and every canonical store's suite needs it. It is
// republished HERE rather than imported from `@platos/kernel` in the adapter,
// for the reason stated above: that would be the second import edge into the
// kernel this paragraph exists to refuse.
export { asIdentifier, contains, environmentScope, err, ok, runResult } from "@platos/kernel";

export type {
  Destination,
  DestinationInput,
  EventName,
  EventPattern,
  NewNotificationRule,
  NotificationRule,
  NotificationRuleEdit,
  NotificationRuleId,
  RuleFilter,
  RuleFilterInput,
  RuleName,
  SubjectId,
} from "../../domain/index.js";
export {
  createNotificationRule,
  NOTIFICATION_RULE_MODEL,
  OWNED_CANONICAL_MODELS,
  parseDestination,
  parseRuleFilter,
  parseRuleName,
  repositoryUnavailable,
  ruleNameTaken,
  ruleNotFound,
  toDestinationInput,
  toRuleFilterInput,
} from "../../domain/index.js";
