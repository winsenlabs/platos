// The `cost-monitoring` domain (ADR M0.3 §1, context 13).
//
// Three aggregates and one boundary.
//
//   Budget                a cap: an environment, a subject, a period, a spend
//                         ceiling and a turn ceiling, and the thresholds it
//                         should speak up at. `BudgetThresholdEvent` is its
//                         durable "this already fired" record.
//   AlertChannel          where an alert goes, plus the per-kind configuration
//                         that addresses it. It holds a REFERENCE to material,
//                         never material.
//   AlertDelivery         the outbound ledger. One row per recipient per
//                         crossing, with `AlertDeliveryRetry` as its
//                         append-only history.
//
// The boundary is the recipient. This context is the sole holder of the
// `Notifier` port (ADR M0.3 §13) and NEVER imports `channels` — the two are
// different things that both end in a message: `channels` is a conversational
// surface an end user talks to, this is an operational alert an operator
// subscribed to.
//
// ADR §6 requires the eighteen-method `BudgetService` to be split. The three
// pieces it names are here as three files: `budget.ts` and `budget-scope.ts` are
// the policy, `spend.ts` and `window.ts` are the ledger arithmetic, and
// `guard.ts` is the pre-spend check.
//
// This layer imports `@platos/kernel` and its own siblings, and nothing else —
// no framework, no client, no peer context (ADR M0.3 §2).
export * from "./identifiers.js";
export * from "./errors.js";
export * from "./policy.js";
export * from "./window.js";
export * from "./spend.js";
export * from "./budget-scope.js";
export * from "./budget.js";
export * from "./budget-status.js";
export * from "./threshold.js";
export * from "./guard.js";
export * from "./alert-topic.js";
export * from "./alert-channel.js";
export * from "./alert-delivery.js";
export * from "./alert-message.js";
export * from "./consumption.js";
