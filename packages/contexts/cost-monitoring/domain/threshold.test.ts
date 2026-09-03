import { describe, expect, it } from "vitest";
import { asIdentifier, type EnvironmentId } from "@platos/kernel";

import { ENVIRONMENT_WIDE } from "./budget-scope.js";
import { evaluateBudget } from "./budget-status.js";
import type { Budget } from "./budget.js";
import { asCostIdentifier, type BudgetId, type WindowKey } from "./identifiers.js";
import { centsToMoney, type SpendReading } from "./spend.js";
import { alreadyRecorded, crossedThresholds, thresholdEventKey } from "./threshold.js";

const AT = new Date("2026-01-15T12:00:00.000Z");
const WINDOW = asCostIdentifier<WindowKey>("2026-01-15");
const BUDGET_ID = asCostIdentifier<BudgetId>("budget-1");

function budget(overrides: Partial<Budget> = {}): Budget {
  return {
    budgetId: BUDGET_ID,
    environmentId: asIdentifier<EnvironmentId>("env-1"),
    target: ENVIRONMENT_WIDE,
    period: "day",
    limitCents: 1_000,
    runsLimit: 0,
    alertThresholds: [50, 80, 100],
    enabled: true,
    overrideUntil: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function reading(settledCents: number, tasks = 0): SpendReading {
  const settled = centsToMoney(settledCents);
  const zeroed = centsToMoney(0);
  if (!settled.ok || !zeroed.ok) throw new Error("unreachable");
  return { settled: settled.value, reserved: zeroed.value, tasks };
}

function crossed(budgetValue: Budget, spendReading: SpendReading): readonly number[] {
  return crossedThresholds(evaluateBudget(budgetValue, WINDOW, spendReading, AT));
}

describe("which thresholds a status has crossed", () => {
  it("returns nothing below the first line", () => {
    expect(crossed(budget(), reading(499))).toEqual([]);
  });

  it("returns every line at or past, ASCENDING", () => {
    // A cap that jumps from 40% to 90% in one turn crosses 50 and 80 too. An
    // operator reading their alerts in arrival order should see the cap
    // climbing rather than one number with two silent predecessors.
    expect(crossed(budget(), reading(900))).toEqual([50, 80]);
    expect(crossed(budget(), reading(1_000))).toEqual([50, 80, 100]);
  });

  it("crosses at the line, not above it", () => {
    expect(crossed(budget(), reading(500))).toEqual([50]);
  });

  it("does NOT cross on a figure that merely rounds to the line", () => {
    // The source compares a figure it has already rounded to two decimals, so
    // 49.996% crossed the 50% line — an alert about a fact that had not
    // happened, and because the crossing is durable and unique the correct one
    // could then never be sent.
    const status = evaluateBudget(budget(), WINDOW, reading(499.96), AT);
    expect(status.percentBasisPoints).toBe(5_000);
    expect(crossedThresholds(status)).toEqual([]);
  });

  it("crosses on EITHER dimension", () => {
    // Spend at 10% and turns at 90% still crosses 80: the operator asked to
    // hear when the budget was 80% consumed, and one half of it is.
    const both = budget({ limitCents: 1_000, runsLimit: 10 });
    expect(crossed(both, reading(100, 9))).toEqual([50, 80]);
  });

  it("respects a cap's own threshold list rather than the default", () => {
    expect(crossed(budget({ alertThresholds: [90] }), reading(900))).toEqual([90]);
    expect(crossed(budget({ alertThresholds: [] }), reading(9_999))).toEqual([]);
  });

  it("can cross a threshold past 100 on an overridden cap", () => {
    const watched = budget({
      alertThresholds: [100, 150],
      overrideUntil: new Date("2026-01-15T13:00:00.000Z"),
    });
    expect(crossed(watched, reading(1_500))).toEqual([100, 150]);
  });

  it("never crosses when both dimensions are uncapped", () => {
    expect(crossed(budget({ limitCents: 0, runsLimit: 0 }), reading(9_999, 9_999))).toEqual([]);
  });
});

describe("the unique tuple", () => {
  it("is the store's `@@unique([budgetId, windowKey, threshold])`, as a string", () => {
    expect(thresholdEventKey(BUDGET_ID, WINDOW, 50)).toBe("budget-1::2026-01-15::50");
  });

  it("distinguishes the same threshold in two windows", () => {
    expect(thresholdEventKey(BUDGET_ID, WINDOW, 50)).not.toBe(
      thresholdEventKey(BUDGET_ID, asCostIdentifier<WindowKey>("2026-01-16"), 50),
    );
  });

  it("distinguishes two thresholds in one window", () => {
    expect(thresholdEventKey(BUDGET_ID, WINDOW, 50)).not.toBe(
      thresholdEventKey(BUDGET_ID, WINDOW, 80),
    );
  });

  it("answers whether a crossing is already recorded", () => {
    const recorded = new Set([thresholdEventKey(BUDGET_ID, WINDOW, 50)]);
    expect(alreadyRecorded(recorded, BUDGET_ID, WINDOW, 50)).toBe(true);
    expect(alreadyRecorded(recorded, BUDGET_ID, WINDOW, 80)).toBe(false);
  });
});
