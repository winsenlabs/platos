import { describe, expect, it } from "vitest";
import { asIdentifier, zero, type EnvironmentId } from "@platos/kernel";

import { ENVIRONMENT_WIDE } from "./budget-scope.js";
import { appliesTo, describeBlock, evaluateBudget, firstBlocker } from "./budget-status.js";
import type { Budget } from "./budget.js";
import { asCostIdentifier, type BudgetId, type WindowKey } from "./identifiers.js";
import { centsToMoney, type SpendReading } from "./spend.js";

const AT = new Date("2026-01-15T12:00:00.000Z");
const WINDOW = asCostIdentifier<WindowKey>("2026-01-15");

function budget(overrides: Partial<Budget> = {}): Budget {
  return {
    budgetId: asCostIdentifier<BudgetId>("budget-1"),
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

function reading(settledCents: number, tasks = 0, reservedCents = 0): SpendReading {
  const settled = centsToMoney(settledCents);
  const reserved = centsToMoney(reservedCents);
  if (!settled.ok || !reserved.ok) throw new Error("unreachable");
  return { settled: settled.value, reserved: reserved.value, tasks };
}

describe("evaluating one cap", () => {
  it("reports utilisation and does not block below the cap", () => {
    const status = evaluateBudget(budget(), WINDOW, reading(500), AT);
    expect(status.percentBasisPoints).toBe(5_000);
    expect(status.breached).toBe(false);
    expect(status.blocked).toBe(false);
  });

  it("blocks AT the cap, not above it", () => {
    expect(evaluateBudget(budget(), WINDOW, reading(999.999999), AT).blocked).toBe(false);
    expect(evaluateBudget(budget(), WINDOW, reading(1_000), AT).blocked).toBe(true);
  });

  it("compares the cap against settled PLUS reserved", () => {
    // Without the in-flight half, two concurrent turns from one principal both
    // read "under cap" and both proceed past the gate.
    expect(evaluateBudget(budget(), WINDOW, reading(600, 0, 300), AT).blocked).toBe(false);
    expect(evaluateBudget(budget(), WINDOW, reading(600, 0, 400), AT).blocked).toBe(true);
  });

  it("blocks on the turn dimension alone", () => {
    const capped = budget({ limitCents: 0, runsLimit: 10 });
    expect(evaluateBudget(capped, WINDOW, reading(0, 9), AT).blocked).toBe(false);
    expect(evaluateBudget(capped, WINDOW, reading(0, 10), AT).blocked).toBe(true);
  });

  it("never blocks on a dimension left uncapped", () => {
    const uncapped = budget({ limitCents: 0, runsLimit: 0 });
    const status = evaluateBudget(uncapped, WINDOW, reading(9_999, 9_999), AT);
    expect(status.blocked).toBe(false);
    expect(status.percentBasisPoints).toBe(0);
    expect(status.runsPercentBasisPoints).toBe(0);
  });

  it("separates BREACHED from BLOCKED when an override is in force", () => {
    // A surface with only `blocked` would show an overridden cap running at
    // 150% as healthy.
    const overridden = budget({ overrideUntil: new Date("2026-01-15T13:00:00.000Z") });
    const status = evaluateBudget(overridden, WINDOW, reading(1_500), AT);
    expect(status.breached).toBe(true);
    expect(status.blocked).toBe(false);
    expect(status.overrideActive).toBe(true);
    expect(status.percentBasisPoints).toBe(15_000);
  });

  it("stops suppressing the block the instant the override expires", () => {
    const overridden = budget({ overrideUntil: new Date("2026-01-15T12:00:00.000Z") });
    expect(evaluateBudget(overridden, WINDOW, reading(1_500), AT).blocked).toBe(true);
  });

  it("carries the whole reading, so a surface can show the in-flight half", () => {
    const status = evaluateBudget(budget(), WINDOW, reading(100, 2, 50), AT);
    expect(status.reading.tasks).toBe(2);
    expect(status.reading.reserved.microCents).toBe(50_000_000n);
    expect(status.spent.microCents).toBe(150_000_000n);
  });
});

describe("choosing the blocker", () => {
  it("returns the FIRST blocked cap, not the worst", () => {
    // An operator who fixes the cap they were told about should then hit the
    // next one, rather than the same message.
    const first = evaluateBudget(
      budget({ budgetId: asCostIdentifier<BudgetId>("first") }),
      WINDOW,
      reading(1_000),
      AT,
    );
    const worse = evaluateBudget(
      budget({ budgetId: asCostIdentifier<BudgetId>("worse") }),
      WINDOW,
      reading(9_000),
      AT,
    );
    expect(firstBlocker([first, worse])?.budget.budgetId).toBe("first");
  });

  it("returns null when nothing blocks", () => {
    expect(firstBlocker([evaluateBudget(budget(), WINDOW, reading(1), AT)])).toBeNull();
    expect(firstBlocker([])).toBeNull();
  });

  it("renders one refusal, naming the dimension that actually blocked", () => {
    const spend = evaluateBudget(budget(), WINDOW, reading(1_200), AT);
    expect(describeBlock(spend)).toBe(
      "Budget cap exceeded: scope/day — 1200.000000 of 1000 cents",
    );
    const turns = evaluateBudget(
      budget({ limitCents: 0, runsLimit: 5 }),
      WINDOW,
      reading(0, 5),
      AT,
    );
    expect(describeBlock(turns)).toBe("Budget cap exceeded: scope/day — 5 of 5 turns");
  });
});

describe("whether a cap applies at all", () => {
  it("applies an environment cap to everything", () => {
    expect(appliesTo(budget(), {})).toBe(true);
  });

  it("applies an agent cap only to its own agent", () => {
    const agentCap = budget({
      target: { ...ENVIRONMENT_WIDE, subject: "agent", targetId: "agent-1" },
    });
    expect(appliesTo(agentCap, { agentId: "agent-1" })).toBe(true);
    expect(appliesTo(agentCap, { agentId: "agent-2" })).toBe(false);
    expect(appliesTo(agentCap, {})).toBe(false);
  });

  it("applies a named user cap only to that user", () => {
    const userCap = budget({
      target: { ...ENVIRONMENT_WIDE, subject: "user", targetId: "user-1" },
    });
    expect(appliesTo(userCap, { userId: "user-1" })).toBe(true);
    expect(appliesTo(userCap, { userId: "user-2" })).toBe(false);
  });

  it("applies a wildcard user cap to any user, and to no anonymous turn", () => {
    // Guessing a user would charge one principal's allowance against a turn
    // that has none.
    const wildcard = budget({ target: { ...ENVIRONMENT_WIDE, subject: "user", targetId: "*" } });
    expect(appliesTo(wildcard, { userId: "anyone" })).toBe(true);
    expect(appliesTo(wildcard, {})).toBe(false);
    expect(appliesTo(wildcard, { userId: "" })).toBe(false);
    expect(appliesTo(wildcard, { userId: null })).toBe(false);
  });

  it("is decided before any counter is read", () => {
    // Purity is the property: an agent cap for another agent must cost nothing
    // to skip, or every cap in an environment puts a round-trip on the hot path.
    const status = evaluateBudget(budget(), WINDOW, { settled: zero(), reserved: zero(), tasks: 0 }, AT);
    expect(status.spent.microCents).toBe(0n);
  });
});
