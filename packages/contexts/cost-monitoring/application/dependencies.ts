// What every use case in this context is constructed with.
//
// One frozen bundle rather than nine constructor parameters, so adding a
// collaborator does not ripple through every call site and so a test can build
// the whole context from in-memory doubles in one expression.
//
// TIME AND IDENTITY ARE INPUTS. `clock` and `ids` are kernel ports; nothing in
// this package reaches for the wall clock or a random generator. That is what
// makes "the lease expired", "the window rolled over at midnight" and "the
// override ran out" tests rather than waits — and this context is almost entirely
// about time, so it matters here more than anywhere.
//
// ON `tenancy` AND `providers`. ADR M0.3 §1 row 13 permits this context exactly
// these two peers plus the kernel, and BOTH handles are genuinely called:
//
//   `tenancy` is the authorization seam in `authorization.ts` — the grant it
//   mints is what a control-surface use case verifies before it reads or writes
//   a cap or a channel.
//
//   `providers` is how a spend becomes a NUMBER. A pre-spend guard has to know
//   what the work about to happen will cost, and pricing is `providers`'
//   property: it is the sole writer of `Model` and `ModelPrice` and the only
//   context that can turn a token count into an amount. `estimate-spend.ts` is
//   the one place this context calls it, and it calls
//   `ProvidersContract.priceModelUsage` — the published contract method, not a
//   rate table copied across the boundary. A copied rate table would be a second
//   pricing authority, and the extraction source records what having two figures
//   for one cost does to a cap.

import type { Clock, IdGenerator, UnitOfWork } from "@platos/kernel";
import type { ProvidersContract } from "@platos/context-providers";
import type { TenancyContract } from "@platos/context-tenancy";

import type { CostMonitoringPolicy } from "../domain/index.js";
import type {
  BudgetCapCache,
  BudgetRepository,
  Notifier,
  SpendLedger,
} from "./ports/index.js";

export interface CostMonitoringDependencies {
  readonly repository: BudgetRepository;
  readonly ledger: SpendLedger;
  readonly capCache: BudgetCapCache;
  /**
   * One notifier per transport, composed at the root.
   *
   * A LIST rather than a single handle, because `Notifier` is one port with
   * three implementations and the ADR's containment rule puts each vendor client
   * in its own adapter. `notifierFor` below is the only resolution, so a kind
   * with no adapter fails in one place with one message rather than at three
   * call sites with three.
   */
  readonly notifiers: readonly Notifier[];
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly unitOfWork: UnitOfWork;
  readonly policy: CostMonitoringPolicy;
  readonly tenancy: TenancyContract;
  readonly providers: ProvidersContract;
}

export function costMonitoringDependencies(
  dependencies: CostMonitoringDependencies,
): CostMonitoringDependencies {
  return Object.freeze({ ...dependencies });
}

/** The adapter that serves a channel kind, or null when none is composed. */
export function notifierFor(
  dependencies: CostMonitoringDependencies,
  kind: string,
): Notifier | null {
  return (
    dependencies.notifiers.find((notifier) =>
      (notifier.kinds as readonly string[]).includes(kind),
    ) ?? null
  );
}
