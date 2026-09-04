// What a turn cost, derived from its steps and from nothing else.
//
// THE IDENTITY THIS FILE EXISTS TO MAKE TRUE:
//
//     Turn.costCents === SUM(Step.costCents)   exactly, with no residue.
//
// The extraction source cannot state that identity, for two separate reasons,
// and both are fixed here rather than carried.
//
// FIRST, IT ROUNDS THE ROLLUP TO A FINER GRID THAN THE COLUMNS HOLD.
// `roundCents` is `Math.round(cents * 10_000) / 10_000` — four decimal places —
// while `Turn.costCents` and `Step.costCents` are both `Decimal(18, 6)`. So the
// stored turn total is the sum of the stored step totals rounded to four places,
// and the two differ by up to 5e-5 cents on every turn that has more than one
// step. Here every amount is a kernel `Money`: an exact integer count of
// micro-cents in a bigint, which IS `Decimal(18, 6)`. `sum` over bigints is
// associative and exact, so there is no grid to round to and no residue to
// explain. The identity holds bit for bit.
//
// SECOND, THE ROLLUP AND THE STEP ROWS DISAGREE ABOUT WHAT COUNTS. The source
// writes the primary model call as step 1 and every sub-agent call as steps 2..n
// on the SAME turn, then rolls up `message.costCents + sum(extraSteps.costCents)`
// — which is right — while `message_persisted` reports parent-step usage only,
// and `failTurn` writes a turn cost of the primary step alone, losing the whole
// delegated spend of a turn that delegated and then failed. Three code paths,
// three answers. `rollUpTurnCost` takes THE STEPS, all of them, and is the only
// way a turn cost is ever produced in this package — including on the failure
// path, which is what `abandonTurn` and `settleTurn` both call.
//
// WHAT `complete` MEANS, AND WHY IT IS NOT COSMETIC. A step that failed before
// `providers` priced it has a null cost, and a step whose rate card said
// `UNAVAILABLE` was priced against a rate nobody could observe. Either way the
// turn total is a FLOOR rather than a fact, and a bill that cannot say so is a
// bill that overstates its own confidence. So the rollup carries the flag, and
// `unpricedSteps` says how many rows it is missing.

import { sum, zero, type Money } from "@platos/kernel";

import { ratesFullyObserved } from "./step-rates.js";
import type { Step } from "./step.js";

export interface TurnCost {
  /** The exact sum of every step's cost. Never rounded, never estimated. */
  readonly amount: Money;
  /** How many steps were rolled up, sub-agent steps included. */
  readonly stepCount: number;
  /** Steps that carry no cost at all: they failed before they were priced. */
  readonly unpricedSteps: number;
  /**
   * False when any step is unpriced, or was priced against an `UNAVAILABLE`
   * rate. A `false` here means `amount` is a floor.
   */
  readonly complete: boolean;
}

export const NO_TURN_COST: TurnCost = Object.freeze({
  amount: zero(),
  stepCount: 0,
  unpricedSteps: 0,
  complete: true,
});

/**
 * Roll a turn's steps into one amount.
 *
 * TAKES THE STEPS AND NOTHING ELSE. There is deliberately no parameter for a
 * pre-computed total, no parameter for "the primary step's cost", and no way to
 * pass the sub-agent steps separately from the rest: the three shapes that let
 * the source produce three different answers for one turn are all
 * unrepresentable here.
 *
 * An empty turn costs exactly zero and is `complete`. That is not the same as a
 * turn whose one step is unpriced, which costs zero and is NOT complete, and a
 * test that could not tell those apart would be a test of nothing.
 */
export function rollUpTurnCost(steps: readonly Step[]): TurnCost {
  const priced = steps.filter((step) => step.cost !== null);
  const amounts = priced.map((step) => step.cost as Money);
  const unpricedSteps = steps.length - priced.length;
  const observed = priced.every((step) => ratesFullyObserved(step.rates));
  return Object.freeze({
    amount: sum(amounts),
    stepCount: steps.length,
    unpricedSteps,
    complete: unpricedSteps === 0 && observed,
  });
}

/**
 * The steps a turn's own model calls produced, without the delegated ones.
 *
 * Published because an operator reading a bill genuinely wants both figures —
 * what this agent cost and what it cost including everything it delegated to.
 * It is NOT what `Turn.costCents` is: that is the whole rollup, and calling this
 * one "the turn cost" is the mistake `message_persisted` makes.
 */
export function rollUpPrimaryCost(steps: readonly Step[]): TurnCost {
  return rollUpTurnCost(steps.filter((step) => step.sequence === PRIMARY_STEP_SEQUENCE));
}

/**
 * The sequence the turn's own first model call occupies.
 *
 * The source writes the primary call at sequence 1 and every delegated call at
 * `index + 2`, so the constant is not arbitrary — it is the row layout, and
 * naming it here is what stops a reader guessing at a bare `1`.
 */
export const PRIMARY_STEP_SEQUENCE = 1;
