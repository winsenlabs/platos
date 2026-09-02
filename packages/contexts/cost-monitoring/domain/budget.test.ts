import { describe, expect, it } from "vitest";
import { asIdentifier, type EnvironmentId } from "@platos/kernel";

import {
  DEFAULT_ALERT_THRESHOLDS,
  MAX_ALERT_THRESHOLD,
  admitBudget,
  admitThresholds,
  applyIntake,
  byListingOrder,
  overrideActive,
  retire,
  withOverride,
  type Budget,
  type BudgetIntake,
} from "./budget.js";
import { ENVIRONMENT_WIDE } from "./budget-scope.js";
import { asCostIdentifier, type ActorId, type BudgetId } from "./identifiers.js";

const AT = new Date("2026-01-15T12:00:00.000Z");
const OPERATOR = asCostIdentifier<ActorId>("operator-1");

function intake(overrides: Partial<BudgetIntake> = {}): BudgetIntake {
  return { subject: "scope", period: "day", limitCents: 1_000, ...overrides };
}

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

describe("admitting thresholds", () => {
  it("defaults to the three the source ships", () => {
    const admitted = admitThresholds(undefined);
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value).toEqual(DEFAULT_ALERT_THRESHOLDS);
  });

  it("sorts and deduplicates, so two spellings of one cap are one cap", () => {
    // A duplicate would produce two crossing checks against one unique
    // constraint, and the second would take the violation path on every
    // evaluation for the life of the window.
    const admitted = admitThresholds([100, 50, 50, 80]);
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value).toEqual([50, 80, 100]);
  });

  it("allows a threshold past 100, so an overridden cap can still be watched", () => {
    expect(admitThresholds([150, MAX_ALERT_THRESHOLD]).ok).toBe(true);
  });

  it("refuses zero, which would cross the instant every window opened", () => {
    const denied = admitThresholds([0]);
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("COST_THRESHOLD_INVALID");
  });

  it("refuses a negative, a fractional, a non-finite and an out-of-range value", () => {
    for (const value of [-1, 12.5, Number.NaN, MAX_ALERT_THRESHOLD + 1]) {
      expect(admitThresholds([value]).ok).toBe(false);
    }
  });

  it("refuses an unbounded list", () => {
    expect(admitThresholds(Array.from({ length: 17 }, (_, index) => index + 1)).ok).toBe(false);
  });
});

describe("admitting a cap", () => {
  it("admits an ordinary environment-wide daily cap", () => {
    const admitted = admitBudget(intake());
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value.target.subject).toBe("scope");
    expect(admitted.value.target.tier).toBe("llm");
    expect(admitted.value.enabled).toBe(true);
  });

  it("refuses an unknown subject as a VALUE, not a throw", () => {
    // The source raises a bare Error and the surface above it decides the status
    // code with `message.startsWith("invalid_")`.
    const denied = admitBudget(intake({ subject: "team" }));
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("COST_BUDGET_INVALID");
    expect(denied.error.category).toBe("invalid_input");
  });

  it("refuses an unknown period and an unknown tier", () => {
    expect(admitBudget(intake({ period: "fortnight" })).ok).toBe(false);
    expect(admitBudget(intake({ tier: "bgo" })).ok).toBe(false);
  });

  it("refuses a negative or fractional limit on either dimension", () => {
    expect(admitBudget(intake({ limitCents: -1 })).ok).toBe(false);
    expect(admitBudget(intake({ limitCents: 1.5 })).ok).toBe(false);
    expect(admitBudget(intake({ runsLimit: -1 })).ok).toBe(false);
  });

  it("allows both dimensions at zero — a cap that only carries thresholds", () => {
    const admitted = admitBudget(intake({ limitCents: 0, runsLimit: 0 }));
    expect(admitted.ok).toBe(true);
  });

  it("refuses the wildcard on anything but a user cap", () => {
    for (const subject of ["scope", "agent"]) {
      const denied = admitBudget(intake({ subject, targetId: "*" }));
      expect(denied.ok).toBe(false);
      if (denied.ok) throw new Error("unreachable");
      expect(denied.error.code).toBe("COST_BUDGET_TARGET_INVALID");
    }
    expect(admitBudget(intake({ subject: "user", targetId: "*" })).ok).toBe(true);
  });

  it("refuses an agent cap that names no agent", () => {
    const denied = admitBudget(intake({ subject: "agent", targetId: "  " }));
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("COST_BUDGET_TARGET_INVALID");
  });

  it("refuses a skill filter on an llm cap, which that tier never reads", () => {
    const denied = admitBudget(intake({ tier: "llm", skillSlug: "web-search" }));
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("COST_BUDGET_INVALID");
    expect(admitBudget(intake({ tier: "skill", skillSlug: "web-search" })).ok).toBe(true);
  });

  it("trims before it judges, so a padded target is the same target", () => {
    const admitted = admitBudget(intake({ subject: "agent", targetId: "  agent-1  " }));
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value.target.targetId).toBe("agent-1");
  });

  it("never lets an intake set the override author", () => {
    const admitted = admitBudget(intake());
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value.target.overrideBy).toBeNull();
  });
});

describe("editing a cap", () => {
  it("carries the override author FORWARD rather than taking it from the edit", () => {
    // An operator editing a limit does not thereby become the author of an
    // override someone else authorised.
    const existing = budget({ target: { ...ENVIRONMENT_WIDE, overrideBy: OPERATOR } });
    const admitted = admitBudget(intake({ limitCents: 2_000 }));
    if (!admitted.ok) throw new Error("unreachable");
    const edited = applyIntake(existing, admitted.value, AT);
    expect(edited.limitCents).toBe(2_000);
    expect(edited.target.overrideBy).toBe(OPERATOR);
  });

  it("moves updatedAt and leaves createdAt alone", () => {
    const admitted = admitBudget(intake());
    if (!admitted.ok) throw new Error("unreachable");
    const later = new Date("2026-02-01T00:00:00.000Z");
    const edited = applyIntake(budget(), admitted.value, later);
    expect(edited.updatedAt).toEqual(later);
    expect(edited.createdAt).toEqual(AT);
  });
});

describe("overrides", () => {
  it("dates the override forward from now and records who authorised it", () => {
    const overridden = withOverride(budget(), 30, OPERATOR, AT);
    if (!overridden.ok) throw new Error("unreachable");
    expect(overridden.value.overrideUntil).toEqual(new Date("2026-01-15T12:30:00.000Z"));
    expect(overridden.value.target.overrideBy).toBe(OPERATOR);
  });

  it("is in force before its expiry and not at or after it", () => {
    const overridden = withOverride(budget(), 30, OPERATOR, AT);
    if (!overridden.ok) throw new Error("unreachable");
    expect(overrideActive(overridden.value, new Date("2026-01-15T12:29:59.999Z"))).toBe(true);
    expect(overrideActive(overridden.value, new Date("2026-01-15T12:30:00.000Z"))).toBe(false);
  });

  it("clears the author when it clears the override", () => {
    // Leaving the last authoriser's name on a cap with no override in force
    // reads, in an audit, as though the override were still theirs and open.
    const overridden = withOverride(budget(), 30, OPERATOR, AT);
    if (!overridden.ok) throw new Error("unreachable");
    const cleared = withOverride(overridden.value, 0, OPERATOR, AT);
    if (!cleared.ok) throw new Error("unreachable");
    expect(cleared.value.overrideUntil).toBeNull();
    expect(cleared.value.target.overrideBy).toBeNull();
  });

  it("refuses a negative or non-finite duration", () => {
    expect(withOverride(budget(), -1, OPERATOR, AT).ok).toBe(false);
    expect(withOverride(budget(), Number.NaN, OPERATOR, AT).ok).toBe(false);
  });
});

describe("retiring and ordering", () => {
  it("disables a retired cap without erasing it", () => {
    const retired = retire(budget(), AT);
    expect(retired.enabled).toBe(false);
    expect(retired.budgetId).toBe("budget-1");
  });

  it("orders by subject, then period, then id — a TOTAL order", () => {
    const rows = [
      budget({ budgetId: asCostIdentifier<BudgetId>("b"), period: "month" }),
      budget({ budgetId: asCostIdentifier<BudgetId>("a"), period: "month" }),
      budget({
        budgetId: asCostIdentifier<BudgetId>("c"),
        target: { ...ENVIRONMENT_WIDE, subject: "agent", targetId: "a-1" },
      }),
    ];
    expect([...rows].sort(byListingOrder).map((row) => row.budgetId)).toEqual(["c", "a", "b"]);
  });

  it("is a total order even for two caps written in the same millisecond", () => {
    // A paged listing whose order is not total silently drops and repeats rows
    // across pages.
    const left = budget({ budgetId: asCostIdentifier<BudgetId>("x") });
    const right = budget({ budgetId: asCostIdentifier<BudgetId>("y") });
    expect(byListingOrder(left, right)).toBe(-1);
    expect(byListingOrder(right, left)).toBe(1);
    expect(byListingOrder(left, left)).toBe(0);
  });
});
