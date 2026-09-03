// Use cases: one principal's standing, and the environment-wide breach sweep.
//
// Both are OPERATOR-FACING reads, and neither is on the hot path. That is what
// lets them do the work the guard cannot afford: evaluate every cap that touches
// a subject, including the ones nowhere near their limit, because an operator
// debugging a throttle needs to see the cap they did NOT hit as much as the one
// they did.
//
// THEY SHARE THE HOT PATH'S ARITHMETIC AND NOTHING ELSE. `statusesFor` in
// `evaluate-budgets.ts` is the one evaluation, so the number a turn was stopped
// by and the number shown to the operator investigating it cannot disagree. The
// source computes them in two methods with two copies of the same nine lines, and
// two copies of one arithmetic is how they come to differ under a later edit.
//
// THE RATE-LIMIT READING ARRIVES AS DATA. `identity-access` owns per-principal
// buckets (ADR §1 row 1) and is not on this context's allow-list, so the
// composition root reads them and passes them in. Nothing here computes a rate
// limit; it decides only whether the numbers it was handed have reached the
// ceilings handed with them.

import { err, ok, type Result } from "@platos/kernel";

import {
  concernsUser,
  describeBlock,
  evaluateBudget,
  firstBlocker,
  isRateLimited,
  readingContextFor,
  sweepSubjects,
  utilisationBasisPoints,
  windowKeyFor,
  type BreachedCap,
  type BudgetStatus,
  type ConsumptionSummary,
  type RateLimitReading,
} from "../domain/index.js";
import { overrideActive } from "../domain/index.js";
import { verifyOperator } from "./authorization.js";
import type { CostMonitoringDependencies } from "./dependencies.js";
import { readBudgetWindow } from "./read-spend.js";

export interface SummariseConsumptionQuery {
  readonly authorization: unknown;
  readonly userId: string;
  /** Read by the composition root from `identity-access`. Null when unavailable. */
  readonly rateLimit?: RateLimitReading | null;
}

export interface SweepBreachesQuery {
  readonly authorization: unknown;
  /** The users a wildcard cap fans out across. Empty means only fixed caps. */
  readonly activeUserIds: readonly string[];
}

export async function summariseConsumption(
  dependencies: CostMonitoringDependencies,
  query: SummariseConsumptionQuery,
): Promise<Result<ConsumptionSummary>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);

  const scope = granted.value.scope;
  const fetchedAt = dependencies.clock.now();
  const listed = await dependencies.repository.listBudgets(scope);
  // A cap list that cannot be read yields an empty, structurally valid answer.
  // The source does the same, and it is right for a drawer: "no caps" renders,
  // an exception does not, and the operator can retry.
  const budgets = listed.ok ? listed.value : [];

  const statuses: BudgetStatus[] = [];
  for (const budget of budgets) {
    if (!concernsUser(budget, query.userId)) continue;
    const context = readingContextFor(budget, query.userId);
    const reading = await readBudgetWindow(dependencies, scope, budget, context);
    // Drop THIS cap on a read failure and keep the rest. A partial answer is
    // useful and an operator can tell a missing row from a wrong one.
    if (!reading.ok) continue;
    statuses.push(
      evaluateBudget(budget, windowKeyFor(budget.period, fetchedAt), reading.value, fetchedAt),
    );
  }

  const blocker = firstBlocker(statuses);
  const rateLimit = query.rateLimit ?? null;
  return ok({
    userId: query.userId,
    blocked: blocker !== null,
    reason: blocker === null ? null : describeBlock(blocker),
    caps: statuses,
    rateLimit,
    rateLimited: isRateLimited(rateLimit),
    fetchedAt,
  });
}

/**
 * Every (cap, subject) pair at or past its cap right now.
 *
 * An OVERRIDDEN cap is not in the answer. The sweep exists to drive an
 * intervention — a list to act on — and a cap someone has deliberately let
 * through is not something to act on. `summariseConsumption` shows it, because
 * that surface exists to explain rather than to prompt.
 */
export async function sweepBreaches(
  dependencies: CostMonitoringDependencies,
  query: SweepBreachesQuery,
): Promise<Result<readonly BreachedCap[]>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);

  const scope = granted.value.scope;
  const listed = await dependencies.repository.listBudgets(scope);
  if (!listed.ok) return ok([]);

  const now = dependencies.clock.now();
  const breached: BreachedCap[] = [];
  for (const budget of listed.value) {
    if (!budget.enabled) continue;
    if (overrideActive(budget, now)) continue;
    if (budget.limitCents <= 0) continue;
    for (const subject of sweepSubjects(budget, query.activeUserIds)) {
      const context =
        budget.target.subject === "user"
          ? { userId: subject }
          : budget.target.subject === "agent"
            ? { agentId: budget.target.targetId }
            : {};
      const reading = await readBudgetWindow(dependencies, scope, budget, context);
      if (!reading.ok) continue;
      const status = evaluateBudget(budget, windowKeyFor(budget.period, now), reading.value, now);
      if (!status.breached) continue;
      breached.push({
        userId: subject,
        budgetId: budget.budgetId,
        percentBasisPoints: utilisationBasisPoints(status.spent, budget.limitCents),
        period: budget.period,
      });
    }
  }
  return ok(breached);
}
