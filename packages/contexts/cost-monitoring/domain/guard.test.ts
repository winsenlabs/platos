import { describe, expect, it } from "vitest";
import { asIdentifier, zero, type EnvironmentId, type Money } from "@platos/kernel";

import type { Budget } from "./budget.js";
import { ENVIRONMENT_WIDE } from "./budget-scope.js";
import { candidates, describeCap, guard, ladderFor, type SpendIntent } from "./guard.js";
import { asCostIdentifier, type AgentId, type BudgetId, type SkillSlug } from "./identifiers.js";
import { centsToMoney } from "./spend.js";

const AT = new Date("2026-01-15T12:00:00.000Z");

function cents(value: number): Money {
  const amount = centsToMoney(value);
  if (!amount.ok) throw new Error("unreachable");
  return amount.value;
}

function cap(id: string, overrides: Partial<Budget> = {}): Budget {
  return {
    budgetId: asCostIdentifier<BudgetId>(id),
    environmentId: asIdentifier<EnvironmentId>("env-1"),
    target: { ...ENVIRONMENT_WIDE, tier: "skill" },
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

function skillCap(id: string, skill: string | null, agent: string | null, limitCents = 1_000): Budget {
  return cap(id, {
    limitCents,
    target: {
      ...ENVIRONMENT_WIDE,
      tier: "skill",
      skillSlug: skill === null ? null : asCostIdentifier<SkillSlug>(skill),
      agentId: agent === null ? null : asCostIdentifier<AgentId>(agent),
    },
  });
}

const INTENT: SpendIntent = { tier: "skill", skillSlug: "web-search", agentId: "agent-1" };

const NOTHING_SPENT = () => zero();

describe("which caps are candidates", () => {
  it("keeps only enabled caps of the asked-for tier", () => {
    const pool = [
      skillCap("skill", null, null),
      cap("llm", { target: { ...ENVIRONMENT_WIDE, tier: "llm" } }),
      cap("disabled", { enabled: false }),
    ];
    expect(candidates(pool, INTENT).map((budget) => budget.budgetId)).toEqual(["skill"]);
  });

  it("never lets one tier's cap govern the other's spend", () => {
    const llm = cap("llm", { target: { ...ENVIRONMENT_WIDE, tier: "llm" }, limitCents: 1 });
    const verdict = guard([llm], INTENT, cents(9_999), NOTHING_SPENT, AT);
    expect(verdict.allowed).toBe(true);
  });
});

describe("the four rungs", () => {
  it("partitions on whether a cap filters by skill and by agent", () => {
    const rungs = ladderFor(INTENT);
    const pool = [
      skillCap("both", "web-search", "agent-1"),
      skillCap("skill-only", "web-search", null),
      skillCap("agent-only", null, "agent-1"),
      skillCap("neither", null, null),
    ];
    // Every cap matches exactly one rung.
    for (const budget of pool) {
      expect(rungs.filter((rung) => rung(budget))).toHaveLength(1);
    }
  });

  it("puts the skill filter above the agent filter", () => {
    // A skill cap is written about a named piece of behaviour; an agent cap
    // about a principal. The narrower statement is the one about behaviour.
    const rungs = ladderFor(INTENT);
    expect(rungs[1]?.(skillCap("s", "web-search", null))).toBe(true);
    expect(rungs[2]?.(skillCap("a", null, "agent-1"))).toBe(true);
  });

  it("skips a skill or agent rung when the intent has no such dimension", () => {
    const rungs = ladderFor({ tier: "skill", skillSlug: null, agentId: null });
    expect(rungs[0]?.(skillCap("both", null, null))).toBe(false);
    expect(rungs[3]?.(skillCap("neither", null, null))).toBe(true);
  });
});

describe("deciding", () => {
  it("allows when nothing matches at all", () => {
    expect(guard([], INTENT, cents(500), NOTHING_SPENT, AT).allowed).toBe(true);
  });

  it("refuses when the governing cap would be reached by this dispatch", () => {
    const verdict = guard([skillCap("c", null, null, 1_000)], INTENT, cents(400), () => cents(600), AT);
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error("unreachable");
    expect(verdict.refusal.budget.budgetId).toBe("c");
    expect(verdict.refusal.projected.microCents).toBe(1_000_000_000n);
  });

  it("adds the AMOUNT before comparing, not after", () => {
    // Checking the current total instead lets a single dispatch of any size
    // through the instant before a cap is reached — so a skill costing more
    // than its own cap is never stopped.
    const spent = () => cents(999);
    expect(guard([skillCap("c", null, null, 1_000)], INTENT, cents(0), spent, AT).allowed).toBe(true);
    expect(guard([skillCap("c", null, null, 1_000)], INTENT, cents(1), spent, AT).allowed).toBe(false);
  });

  it("treats a negative amount as zero rather than as a credit against the cap", () => {
    const verdict = guard([skillCap("c", null, null, 1_000)], INTENT, cents(-500), () => cents(1_000), AT);
    expect(verdict.allowed).toBe(false);
  });

  it("STOPS at the most specific rung that has any match, blocking or not", () => {
    // The exception is the point: a level-1 cap at 1% silences a level-4 cap at
    // 300%. Cascading would make an operator's per-agent exception impossible
    // to write, because the cap they were excepting from would still apply.
    const specific = skillCap("specific", "web-search", "agent-1", 100_000);
    const broad = skillCap("broad", null, null, 1);
    const verdict = guard([specific, broad], INTENT, cents(50), () => cents(10), AT);
    expect(verdict.allowed).toBe(true);
  });

  it("still refuses at the most specific rung when THAT cap is the one reached", () => {
    const specific = skillCap("specific", "web-search", "agent-1", 100);
    const broad = skillCap("broad", null, null, 100_000);
    const verdict = guard([specific, broad], INTENT, cents(50), () => cents(60), AT);
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error("unreachable");
    expect(verdict.refusal.budget.budgetId).toBe("specific");
  });

  it("SKIPS an overridden cap without leaving its rung", () => {
    // An override on the most specific cap suppresses the whole ladder, which
    // is what an operator granting an exception means.
    const overridden = skillCap("specific", "web-search", "agent-1", 1);
    const broad = skillCap("broad", null, null, 1);
    const verdict = guard(
      [{ ...overridden, overrideUntil: new Date("2026-01-15T13:00:00.000Z") }, broad],
      INTENT,
      cents(9_999),
      () => cents(9_999),
      AT,
    );
    expect(verdict.allowed).toBe(true);
  });

  it("stops honouring an override the instant it expires", () => {
    const expired = {
      ...skillCap("specific", "web-search", "agent-1", 1),
      overrideUntil: new Date("2026-01-15T12:00:00.000Z"),
    };
    const verdict = guard([expired], INTENT, cents(5), () => cents(5), AT);
    expect(verdict.allowed).toBe(false);
  });

  it("never blocks on an uncapped cap", () => {
    const verdict = guard([skillCap("c", null, null, 0)], INTENT, cents(9_999), () => cents(9_999), AT);
    expect(verdict.allowed).toBe(true);
  });
});

describe("naming a cap on a refusal", () => {
  it("builds the label from the cap's own dimensions", () => {
    expect(describeCap(skillCap("c", "web-search", "agent-1", 5_000))).toBe(
      "skill skill=web-search agent=agent-1 day/5000c",
    );
    expect(describeCap(skillCap("c", null, null, 100))).toBe("skill day/100c");
  });
});
