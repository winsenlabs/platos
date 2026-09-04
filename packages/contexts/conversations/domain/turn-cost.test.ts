// The identity: a turn costs exactly the sum of its steps.
//
// EVERY ASSERTION HERE IS AN EXACT bigint. A test that compared shapes — "has a
// cost", "is a Money" — would pass against a system that charged nothing, which
// is why the zeroing mutation M-C1 exists: replace `sum(amounts)` with `zero()`
// in `rollUpTurnCost` and the three named cases below go red.
//
// AND THE RESIDUE IS ZERO, WHICH THE SOURCE CANNOT CLAIM. `roundCents` in the
// extraction source rounds the rollup to FOUR decimal places while both
// `Turn.costCents` and `Step.costCents` hold SIX, so its stored turn total is
// the sum of its stored step totals rounded — differing by up to 5e-5 cents on
// every multi-step turn. Micro-cents in bigints have no grid to round to, and
// the last case asserts the difference is exactly `0n`.

import { describe, expect, it } from "vitest";
import { money, moneyToCentsString, type Money } from "@platos/kernel";

import { NO_TURN_COST, PRIMARY_STEP_SEQUENCE, rollUpPrimaryCost, rollUpTurnCost } from "./turn-cost.js";
import { openStep, settleStep, type Step } from "./step.js";
import { NO_STEP_RATES, type StepRate, type StepRateBook } from "./step-rates.js";
import { stepUsage } from "./step-usage.js";
import { asConversationsIdentifier, type StepId, type TurnId } from "./identifiers.js";

const AT = new Date("2026-01-01T00:00:00.000Z");
const TURN = asConversationsIdentifier<TurnId>("turn-1");

function rate(source: StepRate["source"] = "LITELLM"): StepRate {
  return { usdPerToken: "0.000003000000", source, observedAt: AT, sourceRef: null };
}

function book(source: StepRate["source"] = "LITELLM"): StepRateBook {
  return { input: rate(source), output: rate(source), cacheRead: rate(source), cacheWrite: rate(source) };
}

/**
 * A settled step.
 *
 * An UNPRICED step carries zero counts, which is not a convenience: a step that
 * failed before the provider answered consumed nothing, and `step-rates.ts`
 * refuses a row that charged tokens against a rate it does not carry. So "no
 * rates" and "no tokens" arrive together here exactly as they do in the running
 * system, and the fixture cannot express the row the guard forbids.
 */
function step(sequence: number, microCents: bigint | null, rates: StepRateBook = book()): Step {
  const open = openStep({
    stepId: asConversationsIdentifier<StepId>(`step-${sequence}`),
    turnId: TURN,
    sequence,
    model: "anthropic:claude-test",
    startedAt: AT,
  });
  const usage =
    microCents === null ? stepUsage({}) : stepUsage({ inputTokens: 1_000, outputTokens: 100 });
  if (!usage.ok) throw new Error(usage.error.code);
  const settled = settleStep(open, {
    status: "SUCCEEDED",
    usage: usage.value,
    cost: microCents === null ? null : money(microCents),
    modelPriceId: null,
    rates,
    error: null,
    completedAt: AT,
  });
  if (!settled.ok) throw new Error(settled.error.code);
  return settled.value;
}

describe("rollUpTurnCost", () => {
  it("sums three steps to an EXACT micro-cent total", () => {
    const rolled = rollUpTurnCost([
      step(1, 3_300_000n),
      step(2, 1_250_017n),
      step(3, 92_483n),
    ]);
    expect(rolled.amount.microCents).toBe(4_642_500n);
    expect(moneyToCentsString(rolled.amount)).toBe("4.642500");
    expect(rolled.stepCount).toBe(3);
    expect(rolled.unpricedSteps).toBe(0);
    expect(rolled.complete).toBe(true);
  });

  it("leaves NO RESIDUE: the total minus the parts is exactly zero", () => {
    const steps = [step(1, 1n), step(2, 999_999n), step(3, 7n)];
    const rolled = rollUpTurnCost(steps);
    const parts = steps.reduce<bigint>((total, one) => total + (one.cost as Money).microCents, 0n);
    expect(rolled.amount.microCents - parts).toBe(0n);
    expect(rolled.amount.microCents).toBe(1_000_007n);
  });

  it("is associative: the order the steps arrive in cannot change the total", () => {
    const forwards = rollUpTurnCost([step(1, 17n), step(2, 340_001n), step(3, 6n)]);
    const backwards = rollUpTurnCost([step(3, 6n), step(2, 340_001n), step(1, 17n)]);
    expect(forwards.amount.microCents).toBe(backwards.amount.microCents);
    expect(forwards.amount.microCents).toBe(340_024n);
  });

  it("counts an UNPRICED step and marks the total incomplete", () => {
    const rolled = rollUpTurnCost([step(1, 500_000n), step(2, null, NO_STEP_RATES)]);
    expect(rolled.amount.microCents).toBe(500_000n);
    expect(rolled.stepCount).toBe(2);
    expect(rolled.unpricedSteps).toBe(1);
    expect(rolled.complete).toBe(false);
  });

  it("distinguishes an EMPTY turn from a turn whose one step is unpriced", () => {
    const empty = rollUpTurnCost([]);
    const unpriced = rollUpTurnCost([step(1, null, NO_STEP_RATES)]);
    expect(empty.amount.microCents).toBe(0n);
    expect(unpriced.amount.microCents).toBe(0n);
    // Same amount, different truth. A test that could not tell these apart
    // would be a test of nothing.
    expect(empty.complete).toBe(true);
    expect(unpriced.complete).toBe(false);
    expect(empty.stepCount).toBe(0);
    expect(unpriced.stepCount).toBe(1);
  });

  it("marks a total incomplete when a rate was UNAVAILABLE, even though it priced", () => {
    const rolled = rollUpTurnCost([step(1, 250_000n, book("UNAVAILABLE"))]);
    expect(rolled.amount.microCents).toBe(250_000n);
    expect(rolled.unpricedSteps).toBe(0);
    expect(rolled.complete).toBe(false);
  });

  it("an empty roll-up is exactly the published zero", () => {
    expect(rollUpTurnCost([])).toEqual(NO_TURN_COST);
  });
});

describe("rollUpPrimaryCost — what the turn's OWN calls cost", () => {
  it("keeps step 1 and excludes every delegated step", () => {
    const steps = [step(PRIMARY_STEP_SEQUENCE, 1_000_000n), step(2, 4_000_000n), step(3, 500_000n)];
    const primary = rollUpPrimaryCost(steps);
    const whole = rollUpTurnCost(steps);
    expect(primary.amount.microCents).toBe(1_000_000n);
    expect(whole.amount.microCents).toBe(5_500_000n);
    // `Turn.costCents` is the WHOLE rollup. Reporting the primary as the turn's
    // cost is the mistake `message_persisted` makes in the extraction source,
    // and it understates a delegating turn by the whole delegated slice.
    expect(whole.amount.microCents - primary.amount.microCents).toBe(4_500_000n);
  });

  it("names the primary sequence as 1, matching the row layout it describes", () => {
    expect(PRIMARY_STEP_SEQUENCE).toBe(1);
  });
});
