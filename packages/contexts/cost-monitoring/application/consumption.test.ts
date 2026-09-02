// The two operator-facing reads, and the spend-ledger writes they read from.
import { describe, expect, it } from "vitest";

import {
  ENVIRONMENT_WIDE,
  EVERY_USER,
  asCostIdentifier,
  dayStamp,
  type AgentId,
  type BudgetId,
  type SkillSlug,
} from "../domain/index.js";
import { evaluateForScope } from "./evaluate-budgets.js";
import { recordTurn, releaseSpend, reserveSpend, settleSpend } from "./record-spend.js";
import { seriesFor } from "./read-spend.js";
import { summariseConsumption, sweepBreaches } from "./summarise-consumption.js";
import { buildCostTestContext, cents, testBudget } from "./testing/index.js";

const USER = { kind: "user", userId: "user-1" } as const;

describe("which counter series a cap reads", () => {
  it("reads a NAMED user cap against that user", () => {
    const context = buildCostTestContext();
    const named = testBudget(context.scope, {
      target: { ...ENVIRONMENT_WIDE, subject: "user", targetId: "user-1" },
    });
    expect(seriesFor(named, { userId: "someone-else" })).toEqual(USER);
  });

  it("reads a WILDCARD user cap against the CALLING user", () => {
    // One row, and every user measured against it independently out of their
    // own bucket. Read against the wildcard string it would be one shared
    // allowance the first busy user exhausts for everyone.
    const context = buildCostTestContext();
    const wildcard = testBudget(context.scope, {
      target: { ...ENVIRONMENT_WIDE, subject: "user", targetId: EVERY_USER },
    });
    expect(seriesFor(wildcard, { userId: "user-1" })).toEqual(USER);
    expect(seriesFor(wildcard, { userId: "user-2" })).toEqual({ kind: "user", userId: "user-2" });
  });

  it("cannot measure a wildcard cap with no calling user", () => {
    const context = buildCostTestContext();
    const wildcard = testBudget(context.scope, {
      target: { ...ENVIRONMENT_WIDE, subject: "user", targetId: EVERY_USER },
    });
    expect(seriesFor(wildcard, {})).toBeNull();
  });

  it("reads a skill cap against the tier series, keyed by skill and agent", () => {
    const context = buildCostTestContext();
    const skill = testBudget(context.scope, {
      target: {
        ...ENVIRONMENT_WIDE,
        tier: "skill",
        skillSlug: asCostIdentifier<SkillSlug>("search"),
        agentId: asCostIdentifier<AgentId>("agent-1"),
      },
    });
    expect(seriesFor(skill, {})).toEqual({
      kind: "tier",
      tier: "skill",
      skillSlug: "search",
      agentId: "agent-1",
    });
  });

  it("uses an EMPTY string, not a sentinel, for an absent dimension", () => {
    // The source's reader and writer had to be matched by hand over this
    // placeholder; here one derivation serves both.
    const context = buildCostTestContext();
    const skill = testBudget(context.scope, { target: { ...ENVIRONMENT_WIDE, tier: "skill" } });
    expect(seriesFor(skill, {})).toEqual({
      kind: "tier",
      tier: "skill",
      skillSlug: "",
      agentId: "",
    });
  });
});

describe("writing to the ledger", () => {
  it("records a turn, and NOTHING else", async () => {
    // Two writers over one field is how every per-user cost surface came to
    // read exactly twice the real figure while the cache-aware total read once.
    const context = buildCostTestContext();
    await recordTurn(context.dependencies, { scope: context.scope, subject: USER });
    context.repository.seedBudget(
      testBudget(context.scope, {
        limitCents: 0,
        runsLimit: 1,
        target: { ...ENVIRONMENT_WIDE, subject: "user", targetId: "user-1" },
      }),
    );
    const verdict = await evaluateForScope(context.dependencies, context.scope, { userId: "user-1" });
    expect(verdict.caps[0]?.reading.tasks).toBe(1);
    expect(verdict.caps[0]?.spent.microCents).toBe(0n);
  });

  it("holds a reservation against the window while a turn runs", async () => {
    const context = buildCostTestContext();
    context.repository.seedBudget(
      testBudget(context.scope, {
        limitCents: 1_000,
        target: { ...ENVIRONMENT_WIDE, subject: "user", targetId: "user-1" },
      }),
    );
    await reserveSpend(context.dependencies, {
      scope: context.scope,
      subject: USER,
      estimate: cents(600),
    });
    const verdict = await evaluateForScope(context.dependencies, context.scope, { userId: "user-1" });
    expect(verdict.caps[0]?.reading.reserved.microCents).toBe(600_000_000n);
  });

  it("SETTLES a reservation into the settled series in one operation", async () => {
    // Between a release and a charge there is an instant in which the spend is
    // invisible to every concurrent guard.
    const context = buildCostTestContext();
    context.repository.seedBudget(
      testBudget(context.scope, {
        limitCents: 1_000,
        target: { ...ENVIRONMENT_WIDE, subject: "user", targetId: "user-1" },
      }),
    );
    const held = await reserveSpend(context.dependencies, {
      scope: context.scope,
      subject: USER,
      estimate: cents(600),
    });
    if (!held.ok) throw new Error("unreachable");
    await settleSpend(context.dependencies, { handle: held.value, actual: cents(412.5) });

    const verdict = await evaluateForScope(context.dependencies, context.scope, { userId: "user-1" });
    expect(verdict.caps[0]?.reading.reserved.microCents).toBe(0n);
    expect(verdict.caps[0]?.reading.settled.microCents).toBe(412_500_000n);
  });

  it("gives a reservation back when the turn never ran", async () => {
    const context = buildCostTestContext();
    context.repository.seedBudget(
      testBudget(context.scope, {
        limitCents: 1_000,
        target: { ...ENVIRONMENT_WIDE, subject: "user", targetId: "user-1" },
      }),
    );
    const held = await reserveSpend(context.dependencies, {
      scope: context.scope,
      subject: USER,
      estimate: cents(600),
    });
    if (!held.ok) throw new Error("unreachable");
    await releaseSpend(context.dependencies, held.value);
    const verdict = await evaluateForScope(context.dependencies, context.scope, { userId: "user-1" });
    expect(verdict.caps[0]?.spent.microCents).toBe(0n);
  });
});

describe("one principal's standing", () => {
  it("shows the environment cap a user inherits alongside their own", async () => {
    // Leaving the inherited cap out is how an operator concludes a user has no
    // cap and then cannot explain the refusal.
    const context = buildCostTestContext();
    context.repository.seedBudget(
      testBudget(context.scope, { budgetId: asCostIdentifier<BudgetId>("environment") }),
    );
    context.repository.seedBudget(
      testBudget(context.scope, {
        budgetId: asCostIdentifier<BudgetId>("theirs"),
        target: { ...ENVIRONMENT_WIDE, subject: "user", targetId: "user-1" },
      }),
    );
    const summary = await summariseConsumption(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      userId: "user-1",
    });
    if (!summary.ok) throw new Error("unreachable");
    expect(summary.value.caps.map((row) => row.budget.budgetId).sort()).toEqual([
      "environment",
      "theirs",
    ]);
  });

  it("hides another user's cap and a per-skill cap", async () => {
    const context = buildCostTestContext();
    context.repository.seedBudget(
      testBudget(context.scope, {
        budgetId: asCostIdentifier<BudgetId>("someone-else"),
        target: { ...ENVIRONMENT_WIDE, subject: "user", targetId: "user-2" },
      }),
    );
    context.repository.seedBudget(
      testBudget(context.scope, {
        budgetId: asCostIdentifier<BudgetId>("per-skill"),
        target: {
          ...ENVIRONMENT_WIDE,
          tier: "skill",
          skillSlug: asCostIdentifier<SkillSlug>("search"),
        },
      }),
    );
    const summary = await summariseConsumption(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      userId: "user-1",
    });
    if (!summary.ok) throw new Error("unreachable");
    expect(summary.value.caps).toEqual([]);
  });

  it("uses the SAME evaluation the hot path does", async () => {
    // Two copies of one arithmetic is how the number a turn was stopped by and
    // the number shown to the operator come to disagree.
    const context = buildCostTestContext();
    context.repository.seedBudget(
      testBudget(context.scope, {
        target: { ...ENVIRONMENT_WIDE, subject: "user", targetId: "user-1" },
      }),
    );
    context.ledger.seed(context.scope, USER, dayStamp(context.clock.now()), {
      costWithCacheCents: 1_000,
    });
    const summary = await summariseConsumption(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      userId: "user-1",
    });
    const verdict = await evaluateForScope(context.dependencies, context.scope, { userId: "user-1" });
    if (!summary.ok) throw new Error("unreachable");
    expect(summary.value.blocked).toBe(true);
    expect(summary.value.reason).toBe(verdict.reason);
    expect(summary.value.caps[0]?.percentBasisPoints).toBe(verdict.caps[0]?.percentBasisPoints);
  });

  it("folds in a rate-limit reading it was HANDED", async () => {
    // identity-access owns the buckets and is not on this context's allow-list,
    // so the reading arrives as data. Nothing here computes a rate limit.
    const context = buildCostTestContext();
    const summary = await summariseConsumption(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      userId: "user-1",
      rateLimit: { minute: 60, hour: 0, day: 0, perMinute: 60, perHour: null, perDay: null },
    });
    if (!summary.ok) throw new Error("unreachable");
    expect(summary.value.rateLimited).toBe(true);
  });

  it("is not rate-limited when it was handed no reading at all", async () => {
    const context = buildCostTestContext();
    const summary = await summariseConsumption(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      userId: "user-1",
    });
    if (!summary.ok) throw new Error("unreachable");
    expect(summary.value.rateLimited).toBe(false);
    expect(summary.value.rateLimit).toBeNull();
  });

  it("returns a structurally valid answer when the counters cannot be read", async () => {
    const context = buildCostTestContext();
    context.repository.seedBudget(testBudget(context.scope));
    context.ledger.unavailable = true;
    const summary = await summariseConsumption(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      userId: "user-1",
    });
    if (!summary.ok) throw new Error("unreachable");
    expect(summary.value.caps).toEqual([]);
    expect(summary.value.blocked).toBe(false);
  });

  it("refuses a grant tenancy did not issue", async () => {
    const context = buildCostTestContext();
    const denied = await summariseConsumption(context.dependencies, {
      authorization: {},
      userId: "user-1",
    });
    expect(denied.ok).toBe(false);
  });
});

describe("the breach sweep", () => {
  it("fans a wildcard cap across every active user and reports only the breached", async () => {
    const context = buildCostTestContext();
    context.repository.seedBudget(
      testBudget(context.scope, {
        budgetId: asCostIdentifier<BudgetId>("everyone"),
        target: { ...ENVIRONMENT_WIDE, subject: "user", targetId: EVERY_USER },
      }),
    );
    const day = dayStamp(context.clock.now());
    context.ledger.seed(context.scope, { kind: "user", userId: "heavy" }, day, {
      costWithCacheCents: 1_000,
    });
    context.ledger.seed(context.scope, { kind: "user", userId: "light" }, day, {
      costWithCacheCents: 10,
    });

    const breached = await sweepBreaches(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      activeUserIds: ["heavy", "light"],
    });
    if (!breached.ok) throw new Error("unreachable");
    expect(breached.value).toEqual([
      { userId: "heavy", budgetId: "everyone", percentBasisPoints: 10_000, period: "day" },
    ]);
  });

  it("reports an environment cap as ONE composite row, not one per user", async () => {
    const context = buildCostTestContext();
    context.repository.seedBudget(testBudget(context.scope));
    context.ledger.seed(context.scope, { kind: "environment" }, dayStamp(context.clock.now()), {
      costWithCacheCents: 2_000,
    });
    const breached = await sweepBreaches(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      activeUserIds: ["a", "b", "c"],
    });
    if (!breached.ok) throw new Error("unreachable");
    expect(breached.value).toHaveLength(1);
    expect(breached.value[0]?.userId).toBe(EVERY_USER);
    expect(breached.value[0]?.percentBasisPoints).toBe(20_000);
  });

  it("EXCLUDES an overridden cap, because it is not something to act on", async () => {
    // `summariseConsumption` shows it, because that surface explains rather than
    // prompts.
    const context = buildCostTestContext();
    context.repository.seedBudget(
      testBudget(context.scope, { overrideUntil: new Date("2026-01-15T13:00:00.000Z") }),
    );
    context.ledger.seed(context.scope, { kind: "environment" }, dayStamp(context.clock.now()), {
      costWithCacheCents: 2_000,
    });
    const breached = await sweepBreaches(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      activeUserIds: [],
    });
    if (!breached.ok) throw new Error("unreachable");
    expect(breached.value).toEqual([]);
  });

  it("skips an uncapped cap, which cannot be breached", async () => {
    const context = buildCostTestContext();
    context.repository.seedBudget(testBudget(context.scope, { limitCents: 0 }));
    const breached = await sweepBreaches(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      activeUserIds: [],
    });
    if (!breached.ok) throw new Error("unreachable");
    expect(breached.value).toEqual([]);
  });
});
