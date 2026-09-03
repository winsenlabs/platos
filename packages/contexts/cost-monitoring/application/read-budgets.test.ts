import { describe, expect, it } from "vitest";

import { asCostIdentifier, type BudgetId } from "../domain/index.js";
import { describeBudget, listBudgets, pageBudgets } from "./read-budgets.js";
import { buildCostTestContext, otherEnvironment, testBudget } from "./testing/index.js";

describe("listing caps", () => {
  it("returns the scope's caps in the listing order", () => {
    const context = buildCostTestContext();
    context.repository.seedBudget(
      testBudget(context.scope, { budgetId: asCostIdentifier<BudgetId>("b"), period: "month" }),
    );
    context.repository.seedBudget(
      testBudget(context.scope, { budgetId: asCostIdentifier<BudgetId>("a"), period: "day" }),
    );
    return listBudgets(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
    }).then((listed) => {
      if (!listed.ok) throw new Error("unreachable");
      expect(listed.value.map((budget) => budget.budgetId)).toEqual(["a", "b"]);
    });
  });

  it("NEVER returns a cap from another environment", async () => {
    const context = buildCostTestContext();
    context.repository.seedBudget(testBudget(otherEnvironment()));
    const listed = await listBudgets(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
    });
    if (!listed.ok) throw new Error("unreachable");
    expect(listed.value).toEqual([]);
  });

  it("takes the environment FROM the grant, so a caller cannot name another", async () => {
    const context = buildCostTestContext();
    context.repository.seedBudget(testBudget(context.scope));
    const elsewhere = await listBudgets(context.dependencies, {
      authorization: context.tenancy.grant("metadata", otherEnvironment()),
    });
    if (!elsewhere.ok) throw new Error("unreachable");
    expect(elsewhere.value).toEqual([]);
  });

  it("refuses a grant tenancy did not issue", async () => {
    const context = buildCostTestContext();
    const denied = await listBudgets(context.dependencies, { authorization: {} });
    expect(denied.ok).toBe(false);
  });
});

describe("paging caps", () => {
  it("returns a page and the total beside it", async () => {
    const context = buildCostTestContext();
    for (const index of ["a", "b", "c"]) {
      context.repository.seedBudget(
        testBudget(context.scope, { budgetId: asCostIdentifier<BudgetId>(index) }),
      );
    }
    const page = await pageBudgets(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      limit: 2,
      offset: 0,
    });
    if (!page.ok) throw new Error("unreachable");
    expect(page.value.items.map((budget) => budget.budgetId)).toEqual(["a", "b"]);
    expect(page.value.total).toBe(3);
  });

  it("clamps a page wider than the policy allows", async () => {
    const context = buildCostTestContext();
    context.repository.seedBudget(testBudget(context.scope));
    const page = await pageBudgets(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      limit: 100_000,
      offset: 0,
    });
    expect(page.ok).toBe(true);
  });

  it("clamps a zero, a negative and a fractional page", async () => {
    const context = buildCostTestContext();
    for (const index of ["a", "b"]) {
      context.repository.seedBudget(
        testBudget(context.scope, { budgetId: asCostIdentifier<BudgetId>(index) }),
      );
    }
    for (const limit of [0, -5, 1.9]) {
      const page = await pageBudgets(context.dependencies, {
        authorization: context.tenancy.grant("metadata"),
        limit,
        offset: -3,
      });
      if (!page.ok) throw new Error("unreachable");
      expect(page.value.items).toHaveLength(1);
      expect(page.value.total).toBe(2);
    }
  });
});

describe("describing one cap", () => {
  it("returns it by id", async () => {
    const context = buildCostTestContext();
    const seeded = context.repository.seedBudget(testBudget(context.scope));
    const found = await describeBudget(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      budgetId: seeded.budgetId,
    });
    if (!found.ok) throw new Error("unreachable");
    expect(found.value.budgetId).toBe(seeded.budgetId);
  });

  it("reports a cap in ANOTHER environment as not found, never as forbidden", async () => {
    // A caller must not be able to learn that an id exists somewhere else.
    const context = buildCostTestContext();
    const elsewhere = context.repository.seedBudget(testBudget(otherEnvironment()));
    const denied = await describeBudget(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      budgetId: elsewhere.budgetId,
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("COST_BUDGET_NOT_FOUND");
  });
});
