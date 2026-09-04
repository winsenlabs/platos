// The `BudgetCapCache` port — ADR M0.3 §7 decision 3, option (b).
//
// The decision is quoted in full because this port exists only to serve it:
//
//   "`BudgetGuard` pre-spend check is on the HOT TURN PATH — the lifecycle-layer
//   proposal's version put budget reads top-of-stack and dented latency. …
//   Recommend (b) — cached guard, exact reconcile off the outbox."
//
// So the guard reads its CAPS from here and its SPEND live. The asymmetry is the
// decision, not an accident of implementation:
//
//   A CAP changes when an operator edits one. That is minutes apart at worst,
//   and a cap that is thirty seconds stale enforces the previous limit for
//   thirty seconds — a bounded, explainable error.
//
//   SPEND changes every turn. A cached spend figure under-reports by exactly the
//   traffic that is happening right now, which is the traffic a cap exists to
//   stop, so the error is unbounded precisely when it matters.
//
// EVERY WRITE TO A CAP MUST FORGET. `configure`, `retire` and `override` all call
// `forget` — the alternative is an operator who lowers a cap, watches spend sail
// past it, and concludes the feature does not work. Forgetting is best-effort:
// a failure to forget is NOT a failure of the write, because the entry expires on
// its own and reporting an error would tell an operator their cap was not saved
// when it was.
//
// A MISS IS NOT AN ERROR. `read` returns `null` for both "nothing cached" and
// "the entry expired", and the guard loads from the repository and populates.
// Distinguishing the two would let a caller treat an expiry as a fault.

import type { EnvironmentScope, Result } from "@platos/kernel";

import type { Budget } from "../../domain/index.js";

export interface BudgetCapCache {
  /** The cached caps for a scope, or `null` on a miss. Never an error for a miss. */
  read(scope: EnvironmentScope): Promise<Result<readonly Budget[] | null>>;

  /** Cache a scope's caps for `ttlSeconds`. */
  write(scope: EnvironmentScope, budgets: readonly Budget[], ttlSeconds: number): Promise<Result<void>>;

  /** Drop a scope's entry. Called after every write to a cap in that scope. */
  forget(scope: EnvironmentScope): Promise<Result<void>>;
}
