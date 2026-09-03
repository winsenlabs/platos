// The `cost-monitoring` application layer.
//
// Use cases, one per file, each a plain function over a frozen dependency
// bundle. There is no service class and no framework: a use case is invokable in
// memory against the in-memory doubles in `application/testing/`, and every one
// of them returns the kernel's `Result` rather than throwing.
//
// ADR M0.3 §6 requires the eighteen-method `BudgetService` to be split, and names
// the three pieces. They are here as three groups of files rather than three
// classes, which is the same split with no object to accumulate a nineteenth
// method:
//
//   BudgetPolicy  `read-budgets.ts`, `configure-budget.ts`
//   BudgetLedger  `read-spend.ts`, `record-spend.ts`, `evaluate-budgets.ts`
//   BudgetGuard   `guard-spend.ts`
//
// and the alerting half — crossings, dispatch, reconciliation, channels — which
// the source folded into the same class and which has nothing to do with any of
// the three.
//
// May import this context's `domain/`, its own `application/ports/`, its own
// `contracts/`, and the published `contracts/` of the peer contexts ADR M0.3 §1
// permits — which for `cost-monitoring` are `tenancy` and `providers`.
export * from "./ports/index.js";
export * from "./dependencies.js";
export * from "./authorization.js";
export * from "./read-spend.js";
export * from "./read-budgets.js";
export * from "./configure-budget.js";
export * from "./evaluate-budgets.js";
export * from "./guard-spend.js";
export * from "./record-spend.js";
export * from "./notification-target.js";
export * from "./detect-crossings.js";
export * from "./deliver-crossing.js";
export * from "./reconcile-deliveries.js";
export * from "./manage-alert-channels.js";
export * from "./probe-alert-channel.js";
export * from "./summarise-consumption.js";
export * from "./views.js";
