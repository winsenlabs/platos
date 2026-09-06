// WIN-258 T7 — `ApprovalsRepository.list`, the one paged read in the tree that
// returns TWO counts under TWO DIFFERENT scopes.
//
// WHY THIS ONE GOT ITS OWN SUITE. Every other page in this package reports one
// `total`, counted under the same `where` as its items, and a total counted any
// other way is a defect. `ApprovalPage` reports `total` AND `pendingCount`, and
// the port's own sentence is "Pending in the WHOLE scope, not just this page —
// the live semantics". So the two are DELIBERATELY counted differently: `total`
// under the query's filters and its thirty-day window, `pendingCount` under the
// scope alone, with no window and no filter.
//
// THAT IS THE OPPOSITE OF A BUG AND IT IS ONE EDIT FROM BECOMING ONE. A reader
// who noticed the asymmetry and "fixed" it — counting pending under
// `listingWhere` so the two agree — would change what an operator's badge means
// without changing a single page. The fixture below is built so the two answers
// CANNOT coincide: a third of the approvals are older than the default window,
// and pending rows are seeded on both sides of it. `total` therefore sees fewer
// rows than `pendingCount` counts pending ones, at the default window.
//
// AND THE WINDOW IS THE COUNT-TRUTH TRAP. `sinceDays` defaults to thirty and is
// applied as `createdAt >= now - 30d`. A store that dropped it would answer a
// larger total against a page that still looked entirely reasonable, and no
// length check anywhere could see it — which is why the fixture spreads the
// three hundred rows over ninety days rather than stamping them all at once.
//
// `AgentApproval_environmentId_status_createdAt_idx` IS THE INDEX THIS READ
// NEEDS AND, UNUSUALLY IN THIS TRANCHE, ALREADY HAS: the scope clause, the
// status filter and the order key, in that order, all on the table being paged.
// It is measured here as the POSITIVE control for the two findings the other
// suites carry.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  Approval,
  ApprovalId,
  ApprovalQuery,
  ApprovalRowId,
  EnvironmentScope,
} from "@platos/context-jobs/application/ports/index.js";
import { asIdentifier } from "@platos/context-jobs/application/ports/index.js";

import { startJobsHarness, type JobsHarness } from "./jobs-harness.js";
import {
  allDistinct,
  capture,
  explain,
  indexesUsed,
  measure,
  nodeTypesOf,
  onlyStatement,
  rowsFrom,
  scansSequentially,
  windows,
  type PlanNode,
} from "./plans-probe.js";

let harness: JobsHarness;
let dense: EnvironmentScope;
let sparse: EnvironmentScope;

const DENSE_ROWS = 300;
const SPARSE_ROWS = 3;
/** How many of the dense scope's approvals are older than the default window. */
const OUTSIDE_WINDOW = 100;
/** Every third row is left pending; the rest are approved. */
const PENDING_EVERY = 3;
const PAGE = 25;
/** Wide enough to reach every seeded row, so a window can be turned OFF. */
const WIDE_DAYS = 3650;
/** The store's own default, restated so the fixture can straddle it. */
const DEFAULT_WINDOW_DAYS = 30;

/**
 * The instant the fixture is built around, taken from the REAL clock.
 *
 * `createListingClock` is `() => new Date()` and the store measures `sinceDays`
 * back from it, so a fixture stamped at a fixed literal instant would fall
 * entirely outside the default window the day this suite was written and stay
 * there. It is captured once in `beforeAll` and every row is stamped relative
 * to it, which keeps the window boundary the fixture straddles meaningful
 * without making any assertion depend on WHEN the suite runs.
 */
let now = new Date();
const DAY = 86_400_000;

const REQUESTER = "operator-plans";

async function list(scope: EnvironmentScope, query: Partial<ApprovalQuery> = {}) {
  const result = await harness.stores.approvals.list(scope, {
    sinceDays: WIDE_DAYS,
    limit: PAGE,
    offset: 0,
    ...query,
  } as ApprovalQuery);
  if (!result.ok) throw new Error(`list refused: ${result.error.code}`);
  return result.value;
}

const idsOf = (rows: readonly Approval[]): readonly string[] =>
  rows.map((row) => String(row.approvalId));

/** The window statement of an approval page: the one with a LIMIT. */
function approvalRowStatement(events: Parameters<typeof onlyStatement>[0]) {
  return onlyStatement(
    events,
    (sql) => /FROM\s+"public"\."AgentApproval"/u.test(sql) && /\bLIMIT\b/u.test(sql),
  );
}

/**
 * `count` approvals spread over ninety days, a third of them pending.
 *
 * Index 0 is the OLDEST. The first `OUTSIDE_WINDOW` of them are stamped more
 * than `DEFAULT_WINDOW_DAYS` before `now`, so the default window excludes exactly
 * those.
 */
async function seedApprovals(scope: EnvironmentScope, count: number, outside: number) {
  for (let index = 0; index < count; index += 1) {
    // Outside: three windows back, walking forward in half-days so no two rows
    // share an instant. Inside: one to twenty-nine days, which the default
    // window always reaches.
    const inner = DEFAULT_WINDOW_DAYS - 1;
    const daysAgo =
      index < outside
        ? DEFAULT_WINDOW_DAYS * 3 - index * 0.5
        : inner - ((index - outside) % inner);
    const at = new Date(now.getTime() - daysAgo * DAY);
    const approval: Approval = {
      rowId: asIdentifier<ApprovalRowId>(harness.base.freshId("0061")),
      approvalId: asIdentifier<ApprovalId>(`appr-plans-${String(index).padStart(4, "0")}`),
      source: "request_approval",
      agentId: null,
      threadId: null,
      turnId: null,
      action: index % 10 === 0 ? "MARKED delete the staging index" : "delete a row",
      details: null,
      toolName: null,
      arguments: null,
      requestedBy: REQUESTER,
      requestDigest: null,
      requestedByTokenId: null,
      status: index % PENDING_EVERY === 0 ? "pending" : "approved",
      timeoutSeconds: 300,
      createdAt: at,
      updatedAt: at,
      resolution: null,
      consumedAt: null,
      outcome: null,
    };
    await harness.base.adapter.unitOfWork.run(async (transaction) => {
      const written = await harness.stores.approvals.insertApproval(scope, approval, transaction);
      if (!written.ok) throw new Error(`fixture approval refused: ${written.error.code}`);
    });
  }
}

/** How many of the dense fixture's rows are pending, computed from the seed rule. */
function pendingSeeded(count: number): number {
  let pending = 0;
  for (let index = 0; index < count; index += 1) if (index % PENDING_EVERY === 0) pending += 1;
  return pending;
}

beforeAll(async () => {
  harness = await startJobsHarness();
  now = new Date();
  dense = await harness.freshScope();
  sparse = await harness.freshScope();
  await seedApprovals(dense, DENSE_ROWS, OUTSIDE_WINDOW);
  await seedApprovals(sparse, SPARSE_ROWS, 0);
}, 1_800_000);

afterAll(async () => {
  await harness?.stop();
});

describe("count truth", () => {
  test("the total is this scope's rows inside the window", async () => {
    const wide = await list(dense);
    expect(wide.total).toBe(DENSE_ROWS);
    expect((await list(sparse)).total).toBe(SPARSE_ROWS);
  });

  test("the total NARROWS with the window, which is the filter a length cannot see", async () => {
    const wide = await list(dense);
    const defaulted = await list(dense, { sinceDays: null });
    // `sinceDays: null` takes the store's own default of thirty days, and the
    // fixture put a hundred rows outside it.
    expect(defaulted.total).toBe(DENSE_ROWS - OUTSIDE_WINDOW);
    expect(wide.total - defaulted.total).toBe(OUTSIDE_WINDOW);
    // Both pages are full and identical in length; only the totals differ.
    expect(defaulted.rows).toHaveLength(PAGE);
    expect(wide.rows).toHaveLength(PAGE);
  });

  test("the total narrows with the status filter too, and the halves add up", async () => {
    const wide = await list(dense);
    const pending = await list(dense, { status: "pending" });
    const approved = await list(dense, { status: "approved" });
    expect(pending.total).toBe(pendingSeeded(DENSE_ROWS));
    expect(pending.total + approved.total).toBe(wide.total);
  });

  test("the total narrows with the search, computed independently from the rows", async () => {
    const everything = await list(dense, { limit: DENSE_ROWS });
    const searched = await list(dense, { search: "MARKED" });
    expect(searched.total).toBe(
      everything.rows.filter((row) => row.action.includes("MARKED")).length,
    );
    expect(searched.total).toBe(DENSE_ROWS / 10);
  });

  test("PENDING IS COUNTED OVER THE WHOLE SCOPE, ON PURPOSE, AND DIFFERS", async () => {
    // The port: "Pending in the WHOLE scope, not just this page". So it ignores
    // the window AND the filters, and this fixture makes the two disagree in
    // both directions at once.
    const defaulted = await list(dense, { sinceDays: null });
    const wide = await list(dense);
    const seeded = pendingSeeded(DENSE_ROWS);
    expect(defaulted.pendingCount).toBe(seeded);
    expect(wide.pendingCount).toBe(seeded);
    // It counts rows the DEFAULT window's total does not.
    expect(defaulted.pendingCount).toBeGreaterThan(0);
    expect(defaulted.total).toBe(DENSE_ROWS - OUTSIDE_WINDOW);

    // And a status filter that excludes every pending row leaves it untouched.
    const approvedOnly = await list(dense, { status: "approved" });
    expect(approvedOnly.pendingCount).toBe(seeded);
    expect(approvedOnly.total).toBe(DENSE_ROWS - seeded);
  });

  test("pending is nonetheless SCOPED: another environment's pending rows are not counted", async () => {
    expect((await list(sparse)).pendingCount).toBe(pendingSeeded(SPARSE_ROWS));
  });

  test("neither count moves with the window it is reported beside", async () => {
    const first = await list(dense, { offset: 0 });
    const last = await list(dense, { offset: DENSE_ROWS - 4 });
    const past = await list(dense, { offset: DENSE_ROWS + 60 });
    expect(last.rows).toHaveLength(4);
    expect(past.rows).toHaveLength(0);
    for (const page of [first, last, past]) {
      expect(page.total).toBe(DENSE_ROWS);
      expect(page.pendingCount).toBe(pendingSeeded(DENSE_ROWS));
    }
  });
});

describe("page truth over three hundred approvals", () => {
  test("the windows partition the listing", async () => {
    const walked: string[] = [];
    for (const offset of windows(DENSE_ROWS, PAGE)) {
      walked.push(...idsOf((await list(dense, { offset })).rows));
    }
    expect(walked).toHaveLength(DENSE_ROWS);
    expect(allDistinct(walked)).toBe(true);
  });

  test("the listing is NEWEST FIRST across every page", async () => {
    const walked: Approval[] = [];
    for (const offset of windows(DENSE_ROWS, PAGE)) {
      walked.push(...(await list(dense, { offset })).rows);
    }
    const stamps = walked.map((row) => row.createdAt.getTime());
    expect(stamps).toEqual([...stamps].sort((left, right) => right - left));
  });
});

describe("statement cost", () => {
  test("a page is THREE statements over three rows and over three hundred", async () => {
    const small = await measure(harness.base, () => list(sparse));
    const big = await measure(harness.base, () => list(dense));
    expect(big.counted).toBe(small.counted);
    // The window, its total, and the scope-wide pending count. The third is the
    // price of the port's second number and it does not grow with the rows.
    expect(big.counted).toBe(3);
    expect(big.total).toBeGreaterThanOrEqual(big.counted);
  });

  test("the cost does not move with the offset", async () => {
    const first = await measure(harness.base, () => list(dense, { offset: 0 }));
    const deep = await measure(harness.base, () => list(dense, { offset: DENSE_ROWS - PAGE }));
    expect(deep.counted).toBe(first.counted);
  });
});

describe("the plan", () => {
  let filtered: PlanNode;
  let unfiltered: PlanNode;

  beforeAll(async () => {
    unfiltered = await explain(
      harness.base.client,
      approvalRowStatement(await capture(harness.base, () => list(dense))),
    );
    filtered = await explain(
      harness.base.client,
      approvalRowStatement(
        await capture(harness.base, () => list(dense, { status: "pending" })),
      ),
    );
  }, 300_000);

  test("THE POSITIVE CONTROL: the index this read needs already exists", async () => {
    // `AgentApproval_environmentId_status_createdAt_idx` is the scope clause,
    // the status filter and the order key, in that order, all on the table
    // being paged — which is exactly what `Thread` did not have and what this
    // tranche's migration gave it.
    expect(scansSequentially(unfiltered, "AgentApproval")).toBe(false);
    expect(indexesUsed(filtered)).toContain("AgentApproval_environmentId_status_createdAt_idx");
  });

  test("MEASURED: with the status named, the plan reads its window and not the scope", async () => {
    // The three leading columns are all constrained or ordered, so the rows
    // come off the index in order and the window stops the scan.
    //
    // MEASURED AT 28 FOR A WINDOW OF 25, and the pin is written as a bound
    // rather than as that figure: the extra rows are the planner's, not the
    // store's — a `Limit` over an ordered index scan is entitled to pull a few
    // more than it returns — and pinning 28 would be pinning PostgreSQL's
    // internals. What this dimension has to be able to say is that the read is
    // bounded by its WINDOW and not by its SCOPE, and the scope here holds a
    // hundred pending rows.
    const pendingInScope = pendingSeeded(DENSE_ROWS);
    expect(rowsFrom(filtered, "AgentApproval")).toBeLessThan(pendingInScope);
    expect(rowsFrom(filtered, "AgentApproval")).toBeLessThan(PAGE * 2);
    expect(nodeTypesOf(filtered)).not.toContain("Seq Scan");
  });

  test("MEASURED AND REPORTED: with NO status, the middle column is unconstrained", async () => {
    // The same shape `Thread` had, one table over: `status` sits between the
    // equality column and the order column, so an unfiltered listing cannot get
    // its order from this index. It is REPORTED rather than fixed — the read is
    // bounded by one environment's approvals, the index still serves the scope
    // clause, and adding a second three-column index for the unfiltered case is
    // a schema decision with a write cost, not a test's to take.
    expect(rowsFrom(unfiltered, "AgentApproval")).toBeGreaterThan(PAGE);
    expect(rowsFrom(unfiltered, "AgentApproval")).toBeLessThanOrEqual(DENSE_ROWS);
  });
});
