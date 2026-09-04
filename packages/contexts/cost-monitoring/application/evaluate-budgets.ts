// Use case: where every cap in a scope stands right now.
//
// This is the hot-path enforcement read. A turn calls it, learns whether it is
// blocked, and — when it is not — proceeds. Every caller of the source's version
// is on the path of a request a person is waiting for.
//
// SO IT FAILS OPEN, DELIBERATELY, AND THE DECISION IS IN THE POLICY.
//
// A cap list that cannot be read yields "not blocked" rather than an error, and a
// counter series that cannot be read drops THAT cap and keeps the rest. The
// alternative — stalling a turn because a counter store hiccuped — is a worse
// outage than the spend it failed to stop, and it is an outage of everything
// rather than of one cap. `policy.guard.failOpen` makes it a setting, because an
// installation that would rather stop than overspend is making a legitimate
// different choice; what is not legitimate is making it by accident inside a bare
// `catch {}`, which is what the source does in five places.
//
// CAPS THAT DO NOT APPLY ARE SKIPPED BEFORE ANY COUNTER IS READ. An agent cap for
// another agent should cost nothing, and reading its window first would put a
// counter round-trip on the hot path for every cap in the environment.

import { err, ok, type EnvironmentScope, type Result } from "@platos/kernel";

import {
  appliesTo,
  describeBlock,
  evaluateBudget,
  firstBlocker,
  windowKeyFor,
  type Budget,
  type BudgetStatus,
} from "../domain/index.js";
import { verifyOperator } from "./authorization.js";
import type { CostMonitoringDependencies } from "./dependencies.js";
import { readBudgetWindow, type SpendContext } from "./read-spend.js";

export interface EvaluateBudgetsQuery {
  readonly authorization: unknown;
  readonly context: SpendContext;
}

export interface BudgetVerdict {
  readonly caps: readonly BudgetStatus[];
  readonly blocked: boolean;
  /** The refusal an operator reads, or null. Rendered once, in the domain. */
  readonly reason: string | null;
}

export const NOT_BLOCKED: BudgetVerdict = Object.freeze({
  caps: Object.freeze([]),
  blocked: false,
  reason: null,
});

export async function evaluateBudgets(
  dependencies: CostMonitoringDependencies,
  query: EvaluateBudgetsQuery,
): Promise<Result<BudgetVerdict>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  return ok(await evaluateForScope(dependencies, granted.value.scope, query.context));
}

/**
 * The same evaluation, taking an already-derived scope.
 *
 * The runtime path has no operator grant — a turn is not an operator action — so
 * the composition root calls this with the scope it resolved when it authenticated
 * the request. Splitting it here is what stops the runtime path from having to
 * fabricate a grant, which is the shape that eventually gets a fabricated grant
 * accepted somewhere it should not be.
 */
export async function evaluateForScope(
  dependencies: CostMonitoringDependencies,
  scope: EnvironmentScope,
  context: SpendContext,
): Promise<BudgetVerdict> {
  const listed = await dependencies.repository.listBudgets(scope);
  if (!listed.ok) {
    return dependencies.policy.guard.failOpen ? NOT_BLOCKED : blockedByOutage();
  }
  const statuses = await statusesFor(dependencies, scope, listed.value, context);
  const blocker = firstBlocker(statuses);
  return {
    caps: statuses,
    blocked: blocker !== null,
    reason: blocker === null ? null : describeBlock(blocker),
  };
}

/**
 * Evaluate a set of caps against one context.
 *
 * Shared by the hot path and the operator-facing consumption drawer, so the
 * number a turn was stopped by and the number shown to the operator investigating
 * it are computed by the same code. The source computes them separately, and two
 * copies of one arithmetic is how they come to disagree.
 */
export async function statusesFor(
  dependencies: CostMonitoringDependencies,
  scope: EnvironmentScope,
  budgets: readonly Budget[],
  context: SpendContext,
): Promise<readonly BudgetStatus[]> {
  const now = dependencies.clock.now();
  const statuses: BudgetStatus[] = [];
  for (const budget of budgets) {
    if (!budget.enabled) continue;
    if (!appliesTo(budget, context)) continue;
    const reading = await readBudgetWindow(dependencies, scope, budget, context);
    // A counter read that failed drops THIS cap and keeps the others. A partial
    // answer is useful and an operator can tell a missing row from a wrong one;
    // an empty answer looks like "no caps configured", which is a lie.
    if (!reading.ok) continue;
    statuses.push(evaluateBudget(budget, windowKeyFor(budget.period, now), reading.value, now));
  }
  return statuses;
}

/** The fail-CLOSED verdict, for an installation that has turned fail-open off. */
function blockedByOutage(): BudgetVerdict {
  return {
    caps: [],
    blocked: true,
    reason: "Budget enforcement is unavailable and this installation does not fail open",
  };
}
