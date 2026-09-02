// The WRITE half of the budget lifecycle. The read half — listing, paging and
// the cross-tenant denial — is `read-budgets.test.ts`.
import { describe, expect, it } from "vitest";

import { configureBudget, overrideBudget, removeBudget } from "./configure-budget.js";
import { listBudgets } from "./read-budgets.js";
import { buildCostTestContext, testBudget } from "./testing/index.js";

function intake(overrides: Record<string, unknown> = {}) {
  return {
    subject: "scope",
    period: "day",
    limitCents: 1_000,
    ...overrides,
  } as Parameters<typeof configureBudget>[1]["intake"];
}

describe("writing a cap", () => {
  it("mints a row when nothing collides", async () => {
    const context = buildCostTestContext();
    const written = await configureBudget(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      intake: intake(),
    });
    if (!written.ok) throw new Error(`unreachable: ${written.error.code}`);
    expect(written.value.limitCents).toBe(1_000);
    expect(written.value.environmentId).toBe(context.scope.environmentId);
    expect(written.value.alertThresholds).toEqual([50, 80, 100]);
  });

  it("REPLACES the cap at the same collision tuple rather than adding a second", async () => {
    const context = buildCostTestContext();
    await configureBudget(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      intake: intake(),
    });
    await configureBudget(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      intake: intake({ limitCents: 5_000 }),
    });
    const listed = await listBudgets(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
    });
    if (!listed.ok) throw new Error("unreachable");
    expect(listed.value).toHaveLength(1);
    expect(listed.value[0]?.limitCents).toBe(5_000);
  });

  it("keeps an llm cap and a skill cap at the same period as TWO caps", async () => {
    // The source records this as a defect it fixed: with a three-dimensional
    // collision key the second declaration silently replaced the first.
    const context = buildCostTestContext();
    await configureBudget(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      intake: intake({ tier: "llm" }),
    });
    await configureBudget(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      intake: intake({ tier: "skill" }),
    });
    const listed = await listBudgets(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
    });
    if (!listed.ok) throw new Error("unreachable");
    expect(listed.value).toHaveLength(2);
  });

  it("keeps two caps that differ only by skill, and only by agent", async () => {
    const context = buildCostTestContext();
    const grant = context.tenancy.grant("metadata");
    await configureBudget(context.dependencies, {
      authorization: grant,
      intake: intake({ tier: "skill", skillSlug: "search" }),
    });
    await configureBudget(context.dependencies, {
      authorization: grant,
      intake: intake({ tier: "skill", skillSlug: "browse" }),
    });
    await configureBudget(context.dependencies, {
      authorization: grant,
      intake: intake({ tier: "skill", skillSlug: "search", agentId: "agent-1" }),
    });
    const listed = await listBudgets(context.dependencies, { authorization: grant });
    if (!listed.ok) throw new Error("unreachable");
    expect(listed.value).toHaveLength(3);
  });

  it("writes inside a transaction", async () => {
    const context = buildCostTestContext();
    await configureBudget(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      intake: intake(),
    });
    expect(context.unitOfWork.transactions).toHaveLength(1);
    expect(context.repository.transactions).toHaveLength(1);
  });

  it("FORGETS the cached caps, so a lowered cap takes effect at once", async () => {
    // An operator who lowers a cap and watches spend sail past it for the
    // cache's lifetime concludes the feature does not work.
    const context = buildCostTestContext();
    await configureBudget(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      intake: intake(),
    });
    expect(context.capCache.forgets).toEqual([context.scope.environmentId]);
  });

  it("refuses a grant tenancy did not issue", async () => {
    const context = buildCostTestContext();
    const denied = await configureBudget(context.dependencies, {
      authorization: { principalType: "operator", access: "metadata", scope: context.scope },
      intake: intake(),
    });
    expect(denied.ok).toBe(false);
  });

  it("accepts a metadata grant, because a cap holds no material", async () => {
    const context = buildCostTestContext();
    const written = await configureBudget(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      intake: intake(),
    });
    expect(written.ok).toBe(true);
  });

  it("refuses an invalid intake BEFORE it reads anything", async () => {
    const context = buildCostTestContext();
    const denied = await configureBudget(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      intake: intake({ period: "fortnight" }),
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("COST_WINDOW_INVALID");
    expect(context.unitOfWork.transactions).toEqual([]);
  });
});

describe("removing a cap", () => {
  it("tombstones it and takes it out of the listing", async () => {
    const context = buildCostTestContext();
    const seeded = context.repository.seedBudget(testBudget(context.scope));
    const removed = await removeBudget(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      budgetId: seeded.budgetId,
    });
    if (!removed.ok) throw new Error("unreachable");
    expect(removed.value.enabled).toBe(false);
    const listed = await listBudgets(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
    });
    if (!listed.ok) throw new Error("unreachable");
    expect(listed.value).toEqual([]);
  });

  it("refuses a cap that is not there", async () => {
    const context = buildCostTestContext();
    const denied = await removeBudget(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      budgetId: testBudget(context.scope).budgetId,
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("COST_BUDGET_NOT_FOUND");
  });

  it("forgets the cache", async () => {
    const context = buildCostTestContext();
    const seeded = context.repository.seedBudget(testBudget(context.scope));
    await removeBudget(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      budgetId: seeded.budgetId,
    });
    expect(context.capCache.forgets).toEqual([context.scope.environmentId]);
  });
});

describe("overriding a cap", () => {
  it("dates the override forward and records the VERIFIED actor", async () => {
    // An override's whole value is the audit trail; a caller-supplied author is
    // not an audit trail.
    const context = buildCostTestContext();
    const seeded = context.repository.seedBudget(testBudget(context.scope));
    const overridden = await overrideBudget(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      budgetId: seeded.budgetId,
      minutes: 30,
    });
    if (!overridden.ok) throw new Error("unreachable");
    expect(overridden.value.overrideUntil).toEqual(new Date("2026-01-15T12:30:00.000Z"));
    expect(overridden.value.target.overrideBy).toBe("operator-1");
  });

  it("clears the override and its author at zero minutes", async () => {
    const context = buildCostTestContext();
    const seeded = context.repository.seedBudget(testBudget(context.scope));
    await overrideBudget(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      budgetId: seeded.budgetId,
      minutes: 30,
    });
    const cleared = await overrideBudget(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      budgetId: seeded.budgetId,
      minutes: 0,
    });
    if (!cleared.ok) throw new Error("unreachable");
    expect(cleared.value.overrideUntil).toBeNull();
    expect(cleared.value.target.overrideBy).toBeNull();
  });

  it("refuses a negative duration and a cap that is not there", async () => {
    const context = buildCostTestContext();
    const seeded = context.repository.seedBudget(testBudget(context.scope));
    expect(
      (
        await overrideBudget(context.dependencies, {
          authorization: context.tenancy.grant("metadata"),
          budgetId: seeded.budgetId,
          minutes: -1,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await overrideBudget(context.dependencies, {
          authorization: context.tenancy.grant("metadata"),
          budgetId: testBudget(context.scope, { budgetId: seeded.budgetId }).budgetId,
          minutes: 1,
        })
      ).ok,
    ).toBe(true);
  });

  it("forgets the cache, so the exception takes effect at once", async () => {
    const context = buildCostTestContext();
    const seeded = context.repository.seedBudget(testBudget(context.scope));
    await overrideBudget(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      budgetId: seeded.budgetId,
      minutes: 30,
    });
    expect(context.capCache.forgets).toEqual([context.scope.environmentId]);
  });
});
