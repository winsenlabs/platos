// The hot-path guard, and the ADR §7 decision 3(b) trade it is built on.
import { describe, expect, it } from "vitest";

import {
  DEFAULT_COST_MONITORING_POLICY,
  ENVIRONMENT_WIDE,
  asCostIdentifier,
  dayStamp,
  type AgentId,
  type BudgetId,
  type SkillSlug,
} from "../domain/index.js";
import { cachedBudgets, estimateSpend, guardSpend } from "./guard-spend.js";
import { buildCostTestContext, cents, testBudget } from "./testing/index.js";

const SKILL_INTENT = { tier: "skill", skillSlug: "search", agentId: "agent-1" } as const;

function skillCap(id: string, skill: string | null, agent: string | null, limitCents: number) {
  return { budgetId: asCostIdentifier<BudgetId>(id), skill, agent, limitCents };
}

function seedSkillCap(
  context: ReturnType<typeof buildCostTestContext>,
  spec: ReturnType<typeof skillCap>,
) {
  return context.repository.seedBudget(
    testBudget(context.scope, {
      budgetId: spec.budgetId,
      limitCents: spec.limitCents,
      target: {
        ...ENVIRONMENT_WIDE,
        tier: "skill",
        skillSlug: spec.skill === null ? null : asCostIdentifier<SkillSlug>(spec.skill),
        agentId: spec.agent === null ? null : asCostIdentifier<AgentId>(spec.agent),
      },
    }),
  );
}

describe("the cached caps", () => {
  it("loads from the repository on a miss and populates the cache", async () => {
    const context = buildCostTestContext();
    context.repository.seedBudget(testBudget(context.scope));
    const first = await cachedBudgets(context.dependencies, context.scope);
    if (!first.ok) throw new Error("unreachable");
    expect(first.value).toHaveLength(1);
    expect(context.capCache.writes).toBe(1);
    expect(context.capCache.holds(context.scope)).toBe(true);
  });

  it("serves the second read from the cache without touching the store", async () => {
    const context = buildCostTestContext();
    context.repository.seedBudget(testBudget(context.scope));
    await cachedBudgets(context.dependencies, context.scope);
    await cachedBudgets(context.dependencies, context.scope);
    expect(context.capCache.reads).toBe(2);
    expect(context.capCache.writes).toBe(1);
  });

  it("EXPIRES, so a stale cap enforces the previous limit for a BOUNDED time", async () => {
    // The trade decision 3(b) accepts: staleness on the cap, never on the spend.
    const context = buildCostTestContext();
    context.repository.seedBudget(testBudget(context.scope));
    await cachedBudgets(context.dependencies, context.scope);
    context.clock.advanceSeconds(DEFAULT_COST_MONITORING_POLICY.guard.capCacheSeconds + 1);
    expect(context.capCache.holds(context.scope)).toBe(false);
    await cachedBudgets(context.dependencies, context.scope);
    expect(context.capCache.writes).toBe(2);
  });

  it("treats a cache FAILURE as a miss, because the store is the authority", async () => {
    const context = buildCostTestContext();
    context.capCache.unavailable = true;
    context.repository.seedBudget(testBudget(context.scope));
    const loaded = await cachedBudgets(context.dependencies, context.scope);
    if (!loaded.ok) throw new Error("unreachable");
    expect(loaded.value).toHaveLength(1);
  });
});

describe("deciding", () => {
  it("allows a dispatch that stays under the governing cap", async () => {
    const context = buildCostTestContext();
    seedSkillCap(context, skillCap("broad", null, null, 1_000));
    const verdict = await guardSpend(context.dependencies, {
      scope: context.scope,
      intent: SKILL_INTENT,
      amount: cents(100),
    });
    if (!verdict.ok) throw new Error("unreachable");
    expect(verdict.value.allowed).toBe(true);
  });

  it("refuses when the window plus this dispatch would reach the cap", async () => {
    const context = buildCostTestContext();
    seedSkillCap(context, skillCap("broad", null, null, 1_000));
    context.ledger.seed(
      context.scope,
      { kind: "tier", tier: "skill", skillSlug: "", agentId: "" },
      dayStamp(context.clock.now()),
      { costWithCacheCents: 950 },
    );
    const verdict = await guardSpend(context.dependencies, {
      scope: context.scope,
      intent: SKILL_INTENT,
      amount: cents(50),
    });
    if (!verdict.ok) throw new Error("unreachable");
    expect(verdict.value.allowed).toBe(false);
    if (verdict.value.allowed) throw new Error("unreachable");
    expect(verdict.value.refusal.budget.budgetId).toBe("broad");
  });

  it("reads the SKILL series for a skill cap, not the environment series", async () => {
    // The source's tier reader and its writer had to be matched by hand over the
    // placeholder used for an absent dimension; here the derivation is one
    // function and the double records what it was asked for.
    const context = buildCostTestContext();
    seedSkillCap(context, skillCap("broad", null, null, 1_000));
    await guardSpend(context.dependencies, {
      scope: context.scope,
      intent: SKILL_INTENT,
      amount: cents(1),
    });
    expect(context.ledger.reads[0]?.subject).toEqual({
      kind: "tier",
      tier: "skill",
      skillSlug: "",
      agentId: "",
    });
  });

  it("never lets an llm cap govern skill spend", async () => {
    const context = buildCostTestContext();
    context.repository.seedBudget(testBudget(context.scope, { limitCents: 1 }));
    const verdict = await guardSpend(context.dependencies, {
      scope: context.scope,
      intent: SKILL_INTENT,
      amount: cents(9_999),
    });
    if (!verdict.ok) throw new Error("unreachable");
    expect(verdict.value.allowed).toBe(true);
  });

  it("lets the most specific cap SILENCE a broader one that is already breached", async () => {
    // The exception is the point. Cascading would make a per-agent exception
    // impossible to write.
    const context = buildCostTestContext();
    seedSkillCap(context, skillCap("specific", "search", "agent-1", 100_000));
    seedSkillCap(context, skillCap("broad", null, null, 1));
    context.ledger.seed(
      context.scope,
      { kind: "tier", tier: "skill", skillSlug: "", agentId: "" },
      dayStamp(context.clock.now()),
      { costWithCacheCents: 9_999 },
    );
    const verdict = await guardSpend(context.dependencies, {
      scope: context.scope,
      intent: SKILL_INTENT,
      amount: cents(10),
    });
    if (!verdict.ok) throw new Error("unreachable");
    expect(verdict.value.allowed).toBe(true);
  });

  it("counts in-flight reservations against the cap", async () => {
    const context = buildCostTestContext();
    seedSkillCap(context, skillCap("broad", null, null, 1_000));
    const series = { kind: "tier", tier: "skill", skillSlug: "", agentId: "" } as const;
    context.ledger.seed(context.scope, series, dayStamp(context.clock.now()), {
      costWithCacheCents: 500,
    });
    context.ledger.seedReserved(context.scope, series, dayStamp(context.clock.now()), {
      costWithCacheCents: 480,
    });
    const verdict = await guardSpend(context.dependencies, {
      scope: context.scope,
      intent: SKILL_INTENT,
      amount: cents(20),
    });
    if (!verdict.ok) throw new Error("unreachable");
    expect(verdict.value.allowed).toBe(false);
  });
});

describe("failing open", () => {
  it("allows the dispatch when the caps cannot be read at all", async () => {
    // Stalling a turn because a store hiccuped is a worse outage than the spend
    // it failed to stop, and it is an outage of everything rather than of one
    // cap.
    const context = buildCostTestContext();
    context.capCache.unavailable = true;
    context.repository.failOn.add("listBudgets");
    const verdict = await guardSpend(context.dependencies, {
      scope: context.scope,
      intent: SKILL_INTENT,
      amount: cents(1),
    });
    if (!verdict.ok) throw new Error("unreachable");
    expect(verdict.value.allowed).toBe(true);
  });

  it("allows the dispatch when a WINDOW cannot be read", async () => {
    // An unreadable window must not manufacture a breach out of an outage.
    const context = buildCostTestContext();
    seedSkillCap(context, skillCap("broad", null, null, 1));
    context.ledger.unavailable = true;
    const verdict = await guardSpend(context.dependencies, {
      scope: context.scope,
      intent: SKILL_INTENT,
      amount: cents(0),
    });
    if (!verdict.ok) throw new Error("unreachable");
    expect(verdict.value.allowed).toBe(true);
  });

  it("fails CLOSED when the installation has turned fail-open off", async () => {
    const context = buildCostTestContext({
      policy: {
        ...DEFAULT_COST_MONITORING_POLICY,
        guard: { ...DEFAULT_COST_MONITORING_POLICY.guard, failOpen: false },
      },
    });
    context.capCache.unavailable = true;
    context.repository.failOn.add("listBudgets");
    const verdict = await guardSpend(context.dependencies, {
      scope: context.scope,
      intent: SKILL_INTENT,
      amount: cents(1),
    });
    expect(verdict.ok).toBe(false);
  });
});

describe("estimating what work will cost", () => {
  it("asks PROVIDERS, and reads the answer as an exact amount", async () => {
    // Pricing is providers' property. Copying a rate table across the boundary
    // would create a second pricing authority, and the source records what two
    // figures for one cost do to a cap.
    const context = buildCostTestContext();
    context.providers.seedRateCard({
      model: "anthropic:claude",
      inputUsdPerToken: "0.000003",
      outputUsdPerToken: "0.000015",
    });
    const estimate = await estimateSpend(context.dependencies, {
      model: "anthropic:claude",
      usage: { inputTokens: 1_000, outputTokens: 100 },
    });
    if (!estimate.ok) throw new Error("unreachable");
    // 1000 * 3e-6 + 100 * 1.5e-5 USD = 0.0045 USD = 0.45 cents.
    expect(estimate.value.microCents).toBe(450_000n);
    expect(context.providers.priced).toEqual(["anthropic:claude"]);
  });

  it("REFUSES an unpriced model rather than estimating zero", async () => {
    // An unpriced turn that silently costs nothing is a cap that silently does
    // not apply.
    const context = buildCostTestContext();
    const denied = await estimateSpend(context.dependencies, {
      model: "unknown:model",
      usage: { inputTokens: 1 },
    });
    expect(denied.ok).toBe(false);
  });

  it("keeps every digit of a sub-cent amount", async () => {
    const context = buildCostTestContext();
    context.providers.seedRateCard({
      model: "anthropic:haiku",
      inputUsdPerToken: "0.000000250000",
      outputUsdPerToken: "0",
    });
    const estimate = await estimateSpend(context.dependencies, {
      model: "anthropic:haiku",
      usage: { inputTokens: 3 },
    });
    if (!estimate.ok) throw new Error("unreachable");
    // 3 * 2.5e-7 USD = 7.5e-7 USD = 7.5e-5 cents = 75 micro-cents.
    expect(estimate.value.microCents).toBe(75n);
  });
});
