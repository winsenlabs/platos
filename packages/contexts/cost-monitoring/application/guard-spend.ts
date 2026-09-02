// `BudgetGuard` — the pre-spend check ADR M0.3 §1 row 13 names, wired the way
// §7 decision 3(b) requires.
//
// Caps come from the CACHE; spend is read LIVE. `application/ports/
// budget-cap-cache.ts` records why that asymmetry is the decision rather than an
// implementation detail. On a miss the caps are loaded once from the repository
// and written back, so a cold environment costs one read and every subsequent
// dispatch inside the cache window costs none.
//
// THE ESTIMATE IS PRICED BY `providers`, WHICH IS THE POINT OF THE DAG EDGE.
//
// A guard needs to know what the work about to happen will cost, and pricing is
// `providers`' property — it is the sole writer of `Model` and `ModelPrice` and
// the only context that can turn a token count into an amount. `estimateSpend`
// below calls its published contract. Copying a rate table across the boundary
// would create a second pricing authority, and the extraction source records
// what having two figures for one cost does to a cap: for one measured day the
// two disagreed by a factor of ten, and enforcement read the small one.
//
// A CALLER THAT ALREADY KNOWS THE AMOUNT PASSES IT. Most do — a skill dispatch
// has a fixed price and a settled turn has a real one. The pricing call is for
// the case where the caller has a token estimate and no amount.
//
// FAIL-OPEN, ONCE, AT THE TOP. Every storage failure in here yields the same
// verdict as no cap at all, under `policy.guard.failOpen`. The source scatters
// this across four `catch` blocks with three different swallow behaviours, one of
// which discards the error entirely with a comment saying a logger will be wired
// "once Logger wiring lands".

import { err, ok, zero, type EnvironmentScope, type Money, type Result } from "@platos/kernel";
import type { TokenUsageDraft } from "@platos/context-providers";

import {
  ALLOWED,
  foldBuckets,
  guard,
  spendFromCentsString,
  windowDays,
  type Budget,
  type GuardVerdict,
  type SpendIntent,
} from "../domain/index.js";
import type { CostMonitoringDependencies } from "./dependencies.js";
import { seriesFor } from "./read-spend.js";

export interface GuardSpendCommand {
  readonly scope: EnvironmentScope;
  readonly intent: SpendIntent;
  /** What the dispatch is expected to cost. Added to the window before comparing. */
  readonly amount: Money;
  readonly context?: { readonly agentId?: string | null; readonly userId?: string | null };
}

/**
 * May this dispatch proceed?
 *
 * The amount is added to the window BEFORE the comparison. Checking the current
 * total instead lets a single dispatch of any size through the instant before a
 * cap is reached — which, for a skill that costs more than its own cap, means the
 * cap never stops anything.
 */
export async function guardSpend(
  dependencies: CostMonitoringDependencies,
  command: GuardSpendCommand,
): Promise<Result<GuardVerdict>> {
  const budgets = await cachedBudgets(dependencies, command.scope);
  if (!budgets.ok) {
    return dependencies.policy.guard.failOpen ? ok(ALLOWED) : err(budgets.error);
  }

  // Every window this ladder could read, resolved up front. The domain rule is
  // pure and synchronous — a hot-path decision that awaited inside its own loop
  // would serialise one round-trip per candidate cap.
  const spent = new Map<string, Money>();
  for (const budget of budgets.value) {
    if (!budget.enabled || budget.target.tier !== command.intent.tier) continue;
    const reading = await guardWindow(dependencies, command.scope, budget, command.context ?? {});
    spent.set(budget.budgetId, reading);
  }

  return ok(
    guard(
      budgets.value,
      command.intent,
      command.amount,
      (budget) => spent.get(budget.budgetId) ?? zero(),
      dependencies.clock.now(),
    ),
  );
}

/**
 * The caps for a scope, from the cache when it has them.
 *
 * A cache read that FAILS is treated as a miss, not as an outage: the repository
 * is the authority and it is right there. A cache write that fails is ignored for
 * the same reason — the answer is already correct, and the next dispatch pays one
 * more read.
 */
export async function cachedBudgets(
  dependencies: CostMonitoringDependencies,
  scope: EnvironmentScope,
): Promise<Result<readonly Budget[]>> {
  const cached = await dependencies.capCache.read(scope);
  if (cached.ok && cached.value !== null) return ok(cached.value);

  const listed = await dependencies.repository.listBudgets(scope);
  if (!listed.ok) return err(listed.error);
  await dependencies.capCache.write(scope, listed.value, dependencies.policy.guard.capCacheSeconds);
  return ok(listed.value);
}

/**
 * One cap's chargeable spend, or zero when it cannot be read.
 *
 * Zero is the fail-open value here and it is the RIGHT one for a guard: an
 * unreadable window must not manufacture a breach out of an outage.
 */
async function guardWindow(
  dependencies: CostMonitoringDependencies,
  scope: EnvironmentScope,
  budget: Budget,
  context: { readonly agentId?: string | null; readonly userId?: string | null },
): Promise<Money> {
  const subject = seriesFor(budget, context);
  if (subject === null) return zero();
  const buckets = await dependencies.ledger.readWindow({
    scope,
    subject,
    days: windowDays(budget.period, dependencies.clock.now()),
    includeReserved: true,
  });
  if (!buckets.ok) return zero();
  const folded = foldBuckets(buckets.value.settled, buckets.value.reserved);
  if (!folded.ok) return zero();
  const total = folded.value.settled.microCents + folded.value.reserved.microCents;
  return { microCents: total, currency: folded.value.settled.currency };
}

export interface EstimateSpendQuery {
  /** `<provider>:<model>`, or a bare model name. `providers` resolves it. */
  readonly model: string;
  readonly usage: TokenUsageDraft;
  /** The instant to price at. The card in force then, not today's. */
  readonly at?: Date;
}

/**
 * What a piece of work will cost, priced by `providers`.
 *
 * The amount comes back as a canonical `Decimal(18, 6)` cent STRING and is read
 * exactly — never through a JSON number, which cannot carry eighteen digits. A
 * model with no rate card in force produces an error rather than a zero: an
 * unpriced turn that silently costs nothing is a cap that silently does not
 * apply, and `providers` refuses for the same reason on its own side.
 */
export async function estimateSpend(
  dependencies: CostMonitoringDependencies,
  query: EstimateSpendQuery,
): Promise<Result<Money>> {
  const priced = await dependencies.providers.priceModelUsage({
    model: query.model,
    usage: query.usage,
    at: query.at ?? dependencies.clock.now(),
  });
  if (!priced.ok) return err(priced.error);
  return spendFromCentsString(priced.value.costCents);
}
