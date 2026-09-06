// WIN-258 T7 — `pageBudgets` under a DENSE fixture. The full-hydration finding.
//
// WHAT THIS SUITE FOUND, AND IT IS A DESIGN THIS TRANCHE PINS RATHER THAN
// CHANGES. `pageBudgets` reads EVERY live cap in the environment, decodes each
// one, sorts the decoded values and slices the window out in JavaScript. Its
// statement count is one and does not move; its ROW cost is the size of the
// environment whatever the window asks for. That is exactly the shape WIN-258's
// acceptance means by "full hydration", and it is invisible to every functional
// assertion in this package: the page that comes back is correct, in the right
// order, with the right total, at every fixture size.
//
// IT IS DELIBERATE, AND `cost-budgets.ts` SAYS SO. The listing order's leading
// key is `Budget.target.subject`, which is not a column: it is decoded out of
// the encoded `scope` text together with `agentId`. SQL cannot ORDER BY a value
// the database does not hold, so cutting the window in the database would apply
// a DIFFERENT order from the one the port names — which is worse than reading
// too many rows, because it is wrong rather than slow.
//
// SO THE PIN IS THE COST, NOT AN OBJECTION TO IT. The cases below measure the
// rows read at two fixture sizes and pin them as EQUAL TO THE LIVE SET at each,
// which is a statement a reader can act on: it says the cap on this read is the
// number of caps an environment holds, and it will fail the day somebody makes
// the read cheaper as well as the day somebody makes it worse. `total` being
// the same read rather than a second `count` is the compensation, and that is
// pinned too — the page and the total it is rendered beside cannot disagree
// about which rows exist, even under a concurrent write.
//
// THE TOMBSTONE IS THE COUNT-TRUTH TRAP HERE. `retireBudget` sets `deletedAt`
// and the row stays, because a threshold event points at it. A total that
// counted the table rather than the live set would be right until the first
// retirement and wrong forever after, and no page would ever look wrong.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  Budget,
  BudgetId,
  EnvironmentScope,
} from "@platos/context-cost-monitoring/application/ports/index.js";
import { asIdentifier } from "@platos/context-cost-monitoring/application/ports/index.js";

import { conformanceBudget } from "./cost-conformance.js";
import { startCostHarness, type CostHarness } from "./cost-harness.js";
import {
  allDistinct,
  capture,
  explain,
  indexesUsed,
  measure,
  onlyStatement,
  rowsFrom,
  scansSequentially,
  windows,
  type PlanNode,
} from "./plans-probe.js";

let harness: CostHarness;
let dense: EnvironmentScope;
let sparse: EnvironmentScope;

const DENSE_ROWS = 300;
const SPARSE_ROWS = 3;
/** Caps retired in the dense environment. Their rows survive; their reads do not. */
const RETIRED = 45;
const PAGE = 25;

const budgetIdOf = (value: string): BudgetId => asIdentifier<BudgetId>(value);

async function page(scope: EnvironmentScope, offset = 0, limit = PAGE) {
  const result = await harness.repository.pageBudgets(scope, { limit, offset });
  if (!result.ok) throw new Error(`pageBudgets refused: ${result.error.code}`);
  return result.value;
}

async function listed(scope: EnvironmentScope): Promise<readonly Budget[]> {
  const result = await harness.repository.listBudgets(scope);
  if (!result.ok) throw new Error(`listBudgets refused: ${result.error.code}`);
  return result.value;
}

const idsOf = (items: readonly Budget[]): readonly string[] =>
  items.map((item) => String(item.budgetId));

/** The one statement a budget page sends. */
function budgetStatement(events: Parameters<typeof onlyStatement>[0]) {
  return onlyStatement(events, (sql) => /FROM\s+"public"\."Budget"/u.test(sql));
}

/** `count` caps in `scope`, cycling the three subjects so the order has work. */
async function seedBudgets(scope: EnvironmentScope, count: number): Promise<readonly string[]> {
  const subjects = ["scope", "agent", "user"] as const;
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const budgetId = harness.base.freshId("0081");
    await harness.base.adapter.unitOfWork.run(async (transaction) => {
      const written = await harness.repository.insertBudget(
        conformanceBudget(scope, budgetId, subjects[index % subjects.length] as "scope", {
          // `period` is the SECOND key of the listing order, so cycling it makes
          // the tie-break on the identifier load-bearing rather than decorative.
          period: index % 2 === 0 ? "day" : "month",
        }),
        transaction,
      );
      if (!written.ok) throw new Error(`fixture cap refused: ${written.error.code}`);
    });
    ids.push(budgetId);
  }
  return ids;
}

beforeAll(async () => {
  harness = await startCostHarness();
  dense = await harness.freshScope();
  sparse = await harness.freshScope();
  const seeded = await seedBudgets(dense, DENSE_ROWS);
  await seedBudgets(sparse, SPARSE_ROWS);
  for (let index = 0; index < RETIRED; index += 1) {
    await harness.base.adapter.unitOfWork.run(async (transaction) => {
      const retired = await harness.repository.retireBudget(
        dense,
        budgetIdOf(seeded[index] as string),
        new Date("2026-06-01T00:00:00.000Z"),
        transaction,
      );
      if (!retired.ok || !retired.value) throw new Error("fixture retirement refused");
    });
  }
}, 1_200_000);

afterAll(async () => {
  await harness?.stop();
});

describe("count truth", () => {
  test("the total is the LIVE set: a tombstoned cap is gone from both halves", async () => {
    const first = await page(dense);
    expect(first.total).toBe(DENSE_ROWS - RETIRED);
    // Independently: the unpaged listing filters the same way, and the two must
    // agree. A total taken over the table would answer 300 here and every page
    // would still look right.
    expect(await listed(dense)).toHaveLength(DENSE_ROWS - RETIRED);
  });

  test("the total is this environment's own caps", async () => {
    expect((await page(sparse)).total).toBe(SPARSE_ROWS);
  });

  test("the total does not move with the window", async () => {
    const live = DENSE_ROWS - RETIRED;
    const last = await page(dense, live - 5);
    const past = await page(dense, live + 50);
    expect(last.items).toHaveLength(5);
    expect(past.items).toHaveLength(0);
    expect(last.total).toBe(live);
    expect(past.total).toBe(live);
  });

  test("retiring one cap moves the total by exactly one", async () => {
    const before = (await page(sparse)).total;
    const victim = (await listed(sparse))[0] as Budget;
    await harness.base.adapter.unitOfWork.run(async (transaction) => {
      const retired = await harness.repository.retireBudget(
        sparse,
        victim.budgetId,
        new Date("2026-06-02T00:00:00.000Z"),
        transaction,
      );
      if (!retired.ok || !retired.value) throw new Error("retirement refused");
    });
    const after = await page(sparse);
    expect(after.total).toBe(before - 1);
    expect(idsOf(after.items)).not.toContain(String(victim.budgetId));
  });
});

describe("page truth over three hundred caps", () => {
  test("the windows partition the listing in the order the port names", async () => {
    const live = (await page(dense, 0, 1)).total;
    const walked: string[] = [];
    for (const offset of windows(live, PAGE)) {
      walked.push(...idsOf((await page(dense, offset)).items));
    }
    expect(walked).toHaveLength(live);
    expect(allDistinct(walked)).toBe(true);
    // The order is `subject`, then `period`, then id — applied over the DECODED
    // values, which is why the store cuts the window itself.
    expect(walked).toEqual(idsOf(await listed(dense)));
  });
});

describe("statement cost", () => {
  test("a page is ONE statement, and one for three caps as for three hundred", async () => {
    const small = await measure(harness.base, () => page(sparse));
    const big = await measure(harness.base, () => page(dense));
    expect(small.counted).toBe(1);
    expect(big.counted).toBe(1);
    expect(big.total).toBeGreaterThanOrEqual(big.counted);
  });

  test("the total costs NO extra statement, so it cannot disagree with the page", async () => {
    // A second `count` under its own snapshot could report a number the items
    // beside it contradict. Here they are one read.
    const narrow = await measure(harness.base, () => page(dense, 0, 1));
    expect(narrow.counted).toBe(1);
  });
});

describe("the plan", () => {
  let densePlan: PlanNode;
  let sparsePlan: PlanNode;
  let narrowPlan: PlanNode;

  beforeAll(async () => {
    densePlan = await explain(
      harness.base.client,
      budgetStatement(await capture(harness.base, () => page(dense))),
    );
    sparsePlan = await explain(
      harness.base.client,
      budgetStatement(await capture(harness.base, () => page(sparse))),
    );
    narrowPlan = await explain(
      harness.base.client,
      budgetStatement(await capture(harness.base, () => page(dense, 0, 1))),
    );
  }, 300_000);

  test("the scope clause is served by an index rather than a table scan", async () => {
    expect(scansSequentially(densePlan, "Budget")).toBe(false);
    expect(indexesUsed(densePlan).length).toBeGreaterThan(0);
  });

  test("MEASURED: the read hydrates the whole live set, whatever the window asks", async () => {
    const live = DENSE_ROWS - RETIRED;
    expect(rowsFrom(densePlan, "Budget")).toBe(live);
    expect(rowsFrom(sparsePlan, "Budget")).toBeLessThanOrEqual(SPARSE_ROWS);
    // A page of ONE costs the same rows as a page of twenty-five. This is the
    // whole finding in one line: the window is not in the statement.
    expect(rowsFrom(narrowPlan, "Budget")).toBe(live);
  });

  test("the statement carries no LIMIT, which is why the window costs nothing to widen", async () => {
    const captured = budgetStatement(await capture(harness.base, () => page(dense, 0, 1)));
    expect(/\bLIMIT\b/u.test(captured.query)).toBe(false);
    expect(/\bORDER BY\b/u.test(captured.query)).toBe(false);
  });
});
