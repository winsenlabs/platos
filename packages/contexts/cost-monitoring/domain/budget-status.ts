// Where one cap stands right now — the single evaluation rule.
//
// THE SOURCE COMPUTES THIS TWICE, VERBATIM. `BudgetService.evaluate` and
// `BudgetService.getUserConsumptionSummary` each hold their own copy of the same
// nine lines: two percentages, two hard-stop comparisons, an override check, and
// the boolean that combines them. A third copy computes only the override check
// inside the pre-spend ladder, and a fourth inside the breach sweep. Four copies
// of one rule is four places for the enforcement decision and the number shown to
// the operator beside it to disagree — which is exactly the class of defect the
// extraction source's own comments record twice over on the cost fields.
//
// It is ONE function here, and both the enforcement path and the display path
// call it.
//
// THE BLOCK RULE, PRECISELY:
//
//   an uncapped dimension never blocks (limit <= 0)
//   spend blocks at or above the cap, not above it
//   turns block at or above the cap, not above it
//   either dimension blocks alone
//   an override in force suppresses the block WITHOUT hiding the breach
//
// That last clause is why `blocked` and `breached` are separate fields. An
// overridden cap that is at 150% is still breached, and a surface that only had
// `blocked` would show it as healthy.

import type { Money } from "@platos/kernel";

import { overrideActive, type Budget } from "./budget.js";
import type { WindowKey } from "./identifiers.js";
import {
  chargeableSpend,
  isAtLimit,
  spendToCentsString,
  utilisationBasisPoints,
  type SpendReading,
} from "./spend.js";

export interface BudgetStatus {
  readonly budget: Budget;
  readonly windowKey: WindowKey;
  /** Settled plus in-flight: what the cap was compared against. */
  readonly spent: Money;
  readonly reading: SpendReading;
  /** Hundredths of one percent. A display figure; nothing decides on it. */
  readonly percentBasisPoints: number;
  readonly runsPercentBasisPoints: number;
  /** At or past a cap on either dimension, override or no override. */
  readonly breached: boolean;
  /** Breached AND not overridden: the turn does not proceed. */
  readonly blocked: boolean;
  readonly overrideActive: boolean;
}

/** Turn utilisation in basis points. Uncapped is zero, never a division by zero. */
function runsBasisPoints(tasks: number, runsLimit: number): number {
  if (runsLimit <= 0) return 0;
  return Math.round((tasks / runsLimit) * 10_000);
}

export function evaluateBudget(
  budget: Budget,
  windowKey: WindowKey,
  reading: SpendReading,
  at: Date,
): BudgetStatus {
  const spent = chargeableSpend(reading);
  const overridden = overrideActive(budget, at);
  const costBreached = isAtLimit(spent, budget.limitCents);
  const runsBreached = budget.runsLimit > 0 && reading.tasks >= budget.runsLimit;
  const breached = costBreached || runsBreached;
  return {
    budget,
    windowKey,
    spent,
    reading,
    percentBasisPoints: utilisationBasisPoints(spent, budget.limitCents),
    runsPercentBasisPoints: runsBasisPoints(reading.tasks, budget.runsLimit),
    breached,
    blocked: breached && !overridden,
    overrideActive: overridden,
  };
}

/**
 * The first cap that stops a turn, or null.
 *
 * FIRST, not worst. The source returns the first blocked status it finds and
 * names it in the refusal, and an operator who fixes the cap they were told
 * about should then hit the next one rather than the same message. Reporting the
 * most-utilised cap instead would name a cap that is not necessarily the one
 * refusing.
 */
export function firstBlocker(statuses: readonly BudgetStatus[]): BudgetStatus | null {
  return statuses.find((status) => status.blocked) ?? null;
}

/**
 * The refusal an operator reads. Rendered ONCE, here.
 *
 * The source builds this string in two places with the same words and a
 * different null-handling tail, so the same breach reads differently depending
 * on which surface reported it.
 */
export function describeBlock(status: BudgetStatus): string {
  const dimension = status.budget.runsLimit > 0 && status.reading.tasks >= status.budget.runsLimit
    ? `${status.reading.tasks} of ${status.budget.runsLimit} turns`
    : `${spendToCentsString(status.spent)} of ${status.budget.limitCents} cents`;
  return `Budget cap exceeded: ${status.budget.target.subject}/${status.budget.period} — ${dimension}`;
}

/**
 * Does this cap apply to the context a turn is running in?
 *
 * Separated from evaluation because it is a different question, asked before any
 * counter is read: an agent cap for another agent should cost nothing to skip.
 *
 *   `scope` applies to everything in the environment.
 *   `agent` applies when the running agent is its target.
 *   `user`  applies to its named user, or — as the `*` wildcard — to EVERY user
 *           independently, which means it cannot be evaluated at all when the
 *           caller has no user. Skipping is right: guessing a user would charge
 *           one principal's allowance against an anonymous turn.
 */
export function appliesTo(
  budget: Budget,
  context: { readonly agentId?: string | null; readonly userId?: string | null },
): boolean {
  const target = budget.target;
  if (target.subject === "agent") return target.targetId === (context.agentId ?? "");
  if (target.subject === "user") {
    if (target.targetId === "*") return (context.userId ?? "") !== "";
    return target.targetId === (context.userId ?? "");
  }
  return true;
}
