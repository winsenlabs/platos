import { describe, expect, it } from "vitest";
import { asIdentifier, type EnvironmentId } from "@platos/kernel";

import { ENVIRONMENT_WIDE, EVERY_USER } from "./budget-scope.js";
import type { Budget } from "./budget.js";
import {
  concernsUser,
  isRateLimited,
  readingContextFor,
  sweepSubjects,
  type RateLimitReading,
} from "./consumption.js";
import { asCostIdentifier, type BudgetId, type SkillSlug } from "./identifiers.js";

const AT = new Date("2026-01-15T12:00:00.000Z");

function budget(overrides: Partial<Budget> = {}): Budget {
  return {
    budgetId: asCostIdentifier<BudgetId>("budget-1"),
    environmentId: asIdentifier<EnvironmentId>("env-1"),
    target: ENVIRONMENT_WIDE,
    period: "day",
    limitCents: 1_000,
    runsLimit: 0,
    alertThresholds: [],
    enabled: true,
    overrideUntil: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

describe("which caps belong in a user's drawer", () => {
  it("includes environment-wide caps every user inherits", () => {
    // Leaving them out is how an operator concludes a user has no cap and then
    // cannot explain the refusal.
    expect(concernsUser(budget(), "user-1")).toBe(true);
  });

  it("includes the wildcard cap and the user's own", () => {
    expect(
      concernsUser(budget({ target: { ...ENVIRONMENT_WIDE, subject: "user", targetId: EVERY_USER } }), "user-1"),
    ).toBe(true);
    expect(
      concernsUser(budget({ target: { ...ENVIRONMENT_WIDE, subject: "user", targetId: "user-1" } }), "user-1"),
    ).toBe(true);
  });

  it("excludes another user's cap", () => {
    expect(
      concernsUser(budget({ target: { ...ENVIRONMENT_WIDE, subject: "user", targetId: "user-2" } }), "user-1"),
    ).toBe(false);
  });

  it("includes agent caps, because a user working through one is stopped by it", () => {
    expect(
      concernsUser(budget({ target: { ...ENVIRONMENT_WIDE, subject: "agent", targetId: "a-1" } }), "user-1"),
    ).toBe(true);
  });

  it("EXCLUDES a skill-tier cap that names a skill", () => {
    // There can be dozens; they are about a piece of behaviour rather than about
    // this person, and a drawer listing them buries the rows that explain the
    // refusal.
    expect(
      concernsUser(
        budget({
          target: { ...ENVIRONMENT_WIDE, tier: "skill", skillSlug: asCostIdentifier<SkillSlug>("s") },
        }),
        "user-1",
      ),
    ).toBe(false);
  });

  it("INCLUDES a skill-tier cap with no skill filter, which is environment-wide in effect", () => {
    expect(concernsUser(budget({ target: { ...ENVIRONMENT_WIDE, tier: "skill" } }), "user-1")).toBe(true);
  });

  it("excludes a disabled cap", () => {
    expect(concernsUser(budget({ enabled: false }), "user-1")).toBe(false);
  });
});

describe("the counters a cap reads for one user", () => {
  it("reads an agent cap against the AGENT, carrying the user along", () => {
    // Reading it against the user would charge the whole environment's spend to
    // one person's drawer.
    const agentCap = budget({ target: { ...ENVIRONMENT_WIDE, subject: "agent", targetId: "a-1" } });
    expect(readingContextFor(agentCap, "user-1")).toEqual({ agentId: "a-1", userId: "user-1" });
  });

  it("reads an environment or user cap against the user", () => {
    expect(readingContextFor(budget(), "user-1")).toEqual({ userId: "user-1" });
    const userCap = budget({ target: { ...ENVIRONMENT_WIDE, subject: "user", targetId: EVERY_USER } });
    expect(readingContextFor(userCap, "user-1")).toEqual({ userId: "user-1" });
  });
});

describe("rate-limit ceilings", () => {
  function reading(overrides: Partial<RateLimitReading> = {}): RateLimitReading {
    return {
      minute: 0,
      hour: 0,
      day: 0,
      perMinute: null,
      perHour: null,
      perDay: null,
      ...overrides,
    };
  }

  it("is not limited when there is no reading at all", () => {
    expect(isRateLimited(null)).toBe(false);
  });

  it("treats an UNSET ceiling as no ceiling, not as a ceiling of zero", () => {
    // Expressing a missing ceiling as 0 would mark every principal
    // rate-limited, because every count is at or above zero.
    expect(isRateLimited(reading({ minute: 500 }))).toBe(false);
  });

  it("is limited at or past any one ceiling", () => {
    expect(isRateLimited(reading({ minute: 9, perMinute: 10 }))).toBe(false);
    expect(isRateLimited(reading({ minute: 10, perMinute: 10 }))).toBe(true);
    expect(isRateLimited(reading({ hour: 100, perHour: 100 }))).toBe(true);
    expect(isRateLimited(reading({ day: 1_000, perDay: 1_000 }))).toBe(true);
  });

  it("ignores a ceiling of zero, which is an unset ceiling written differently", () => {
    expect(isRateLimited(reading({ minute: 0, perMinute: 0 }))).toBe(false);
  });
});

describe("the breach sweep's subjects", () => {
  it("fans a wildcard cap across every active user", () => {
    const wildcard = budget({ target: { ...ENVIRONMENT_WIDE, subject: "user", targetId: EVERY_USER } });
    expect(sweepSubjects(wildcard, ["a", "b"])).toEqual(["a", "b"]);
  });

  it("evaluates a named user cap against that one user", () => {
    const named = budget({ target: { ...ENVIRONMENT_WIDE, subject: "user", targetId: "u-1" } });
    expect(sweepSubjects(named, ["a", "b"])).toEqual(["u-1"]);
  });

  it("reports an environment or agent cap as ONE composite row", () => {
    // It is breached for everyone at once; listing it per user reports one
    // breach as a hundred.
    expect(sweepSubjects(budget(), ["a", "b"])).toEqual([EVERY_USER]);
    const agentCap = budget({ target: { ...ENVIRONMENT_WIDE, subject: "agent", targetId: "a-1" } });
    expect(sweepSubjects(agentCap, ["a", "b"])).toEqual([EVERY_USER]);
  });
});
