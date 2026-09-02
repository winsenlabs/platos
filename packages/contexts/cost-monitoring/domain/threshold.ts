// `BudgetThresholdEvent` — the durable record that an alert is owed.
//
// A threshold crossing is not a notification. It is a ROW, unique on
// `[budgetId, windowKey, threshold]`, and the alert is a consequence of the row
// existing. That ordering is the whole design: the store's unique constraint is
// what makes "alert exactly once per transition" true across a process restart,
// a redelivery, two dispatchers racing, and the ninety-day expiry of the
// counters the percentage was computed from. Holding crossed-state in the
// counter store instead — which is the obvious cheaper thing — loses the record
// the moment the counters expire, and re-fires every alert for the window.
//
// WHICH THRESHOLDS FIRE, AND IN WHAT ORDER.
//
// Ascending, always. A cap that jumps from 40% to 90% in one turn crosses 50 and
// 80 as well as nothing else, and an operator who reads their alerts in arrival
// order should see the cap climbing rather than a single 80% with two silent
// predecessors. `domain/budget.ts` sorts and deduplicates on admission so this
// ordering costs nothing to maintain.
//
// EITHER DIMENSION CROSSES. Spend at 90% of the spend cap and turns at 10% of
// the turn cap crosses the 80% threshold, because the operator asked to hear
// when the budget was 80% consumed and one half of it is. The source's `||` is
// kept.
//
// AND THE COMPARISON IS ON THE EXACT RATIO. See `domain/spend.ts`: the source
// compares a figure it has already rounded to two decimals, so 49.996% crosses
// the 50% line — and because the crossing is durable and unique, the alert for
// the real crossing can then never be sent.

import type { EnvironmentId, Money } from "@platos/kernel";

import type { BudgetStatus } from "./budget-status.js";
import type { BudgetId, ThresholdEventId, WindowKey } from "./identifiers.js";
import { hasCrossed, runsCrossed } from "./spend.js";

export interface ThresholdEvent {
  readonly eventId: ThresholdEventId;
  readonly environmentId: EnvironmentId;
  readonly budgetId: BudgetId;
  readonly windowKey: WindowKey;
  /** The percentage line that was crossed. */
  readonly threshold: number;
  /** Spend at the instant of crossing. A snapshot, never recomputed. */
  readonly spent: Money;
  readonly tasks: number;
  readonly createdAt: Date;
}

/**
 * The thresholds a status is at or past, ascending.
 *
 * PURE. It does not know which have already fired — that is the store's unique
 * constraint to answer, and asking it here would mean reading rows on the hot
 * evaluation path to compute something the write is going to check anyway.
 */
export function crossedThresholds(status: BudgetStatus): readonly number[] {
  return status.budget.alertThresholds.filter(
    (threshold) =>
      hasCrossed(status.spent, status.budget.limitCents, threshold) ||
      runsCrossed(status.reading.tasks, status.budget.runsLimit, threshold),
  );
}

/**
 * The unique tuple, as one string.
 *
 * Used by the in-memory double and by any caller that wants to reason about
 * duplicate suppression without a database. It is the domain's statement of
 * `@@unique([budgetId, windowKey, threshold])`.
 */
export function thresholdEventKey(
  budgetId: BudgetId,
  windowKey: WindowKey,
  threshold: number,
): string {
  return `${budgetId}::${windowKey}::${threshold}`;
}

/**
 * Is this crossing already recorded?
 *
 * A convenience over the key, so a caller reads the intent rather than the
 * string algebra.
 */
export function alreadyRecorded(
  recorded: ReadonlySet<string>,
  budgetId: BudgetId,
  windowKey: WindowKey,
  threshold: number,
): boolean {
  return recorded.has(thresholdEventKey(budgetId, windowKey, threshold));
}
