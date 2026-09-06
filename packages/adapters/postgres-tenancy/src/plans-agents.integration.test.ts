// WIN-258 T7 — `pageBoundAgents` under a DENSE fixture: count truth, page
// truth, statement cost and the plan PostgreSQL actually chose.
//
// WHY A SECOND AGENTS SUITE. `agents-statements.integration.test.ts` already
// pins what a bound read costs and proves twenty rows cost what three cost. It
// stops there, and three of the four things WIN-258's acceptance names are on
// the other side of that line:
//
//   * TWENTY IS NOT DENSE. A page cap tested against twenty rows cannot tell a
//     capped read from an uncapped one — both return twenty. This suite seeds
//     THREE HUNDRED bindings in one environment and takes pages of twenty-five.
//   * A TOTAL IS NOT A LENGTH. `BoundAgentPage.total` is what a surface renders
//     beside the page, and nothing in the tree compares it with the real count
//     under the SAME scope and the SAME filters. An off-by-scope total is a
//     silent correctness bug, not a performance one, and the fixture here is
//     built to produce one if the store has it: the peer environment holds
//     agents IN THE SAME PROJECT, which is exactly the set a total counted on
//     the project rather than the environment would swallow.
//   * A STATEMENT COUNT IS NOT A ROW COUNT. Two statements that read three
//     hundred rows to return twenty-five are still two statements. The plans
//     below are read with `EXPLAIN (ANALYZE)` and the rows the plan actually
//     touched are pinned, which is the only form in which "no full hydration"
//     is a measurement rather than a hope.
//
// WHAT THE REAL DATABASE SAID, AND IT IS NOT WHAT THE PIN WOULD HAVE BEEN.
// `pageBoundAgents` orders by `agent.createdAt DESC, agent.id DESC` — columns on
// the JOINED row, not on `AgentBinding`. No index on `AgentBinding` can deliver
// that order, so PostgreSQL reads EVERY binding in the environment, joins each
// to its agent, sorts the lot and then throws all but the window away. The page
// is correct and its statement count is flat; its ROW cost is linear in the size
// of the environment. That is measured below rather than asserted away, and the
// index that would fix it does not exist because the sort key is not on the
// table being paged — a schema question this tranche reports rather than
// answers, since `Agent.createdAt` would have to be denormalised onto the
// binding for any index to help.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { AgentQuery, BoundAgent } from "@platos/context-agents/application/ports/index.js";

import {
  HOME_ENVIRONMENT,
  PEER_ENVIRONMENT,
  scopeOf,
  startAgentsHarness,
  type AgentsHarness,
} from "./agents-harness.js";
import {
  allDistinct,
  capture,
  explain,
  indexesUsed,
  measure,
  nodeTypesOf,
  onlyStatement,
  rowsFrom,
  windows,
  type PlanNode,
} from "./plans-probe.js";

let harness: AgentsHarness;

/** The dense environment. Three hundred bindings, ordered by a joined column. */
const DENSE = scopeOf(HOME_ENVIRONMENT);
/** The sparse one, IN THE SAME PROJECT. Three bindings, and the count decoy. */
const SPARSE = scopeOf(PEER_ENVIRONMENT);

const DENSE_ROWS = 300;
const SPARSE_ROWS = 3;
/** How many of the dense environment's agents are paused. */
const DENSE_PAUSED = 40;
/** The window every page property below is walked in. */
const PAGE = 25;

/** The whole listing, no filters. */
const WIDE: AgentQuery = { limit: 1000, offset: 0, search: null, active: null };

function query(overrides: Partial<AgentQuery>): AgentQuery {
  return { ...WIDE, ...overrides };
}

async function page(scope: typeof DENSE, overrides: Partial<AgentQuery>) {
  const result = await harness.repository.pageBoundAgents(scope, query(overrides));
  if (!result.ok) throw new Error(`page refused: ${result.error.code}`);
  return result.value;
}

async function listed(scope: typeof DENSE): Promise<readonly BoundAgent[]> {
  const result = await harness.repository.listBoundAgents(scope);
  if (!result.ok) throw new Error(`listing refused: ${result.error.code}`);
  return result.value;
}

const idsOf = (items: readonly BoundAgent[]): readonly string[] =>
  items.map((item) => String(item.agent.agentId));

/** The row-reading statement of a page: the binding scan, not its count. */
function pageRowStatement(events: Parameters<typeof onlyStatement>[0]) {
  return onlyStatement(
    events,
    (sql) => /FROM\s+"public"\."AgentBinding"/u.test(sql) && /\bLIMIT\b/u.test(sql),
  );
}

beforeAll(async () => {
  harness = await startAgentsHarness();
  // The dense environment. Names carry a marker every tenth agent so a search
  // filter has a non-trivial, INDEPENDENTLY COMPUTABLE answer.
  for (let index = 0; index < DENSE_ROWS; index += 1) {
    await harness.seedAgent({
      slug: index % 10 === 0 ? `dense-marked-${index}` : `dense-plain-${index}`,
      environmentId: HOME_ENVIRONMENT,
      isActive: index >= DENSE_PAUSED,
      // Distinct instants, so `createdAt DESC` is not one giant tie. The id
      // tie-break still has to be applied; the case that proves it is below.
      createdAt: new Date(Date.UTC(2026, 4, 1, 9, 0, 0) + index * 1000),
    });
  }
  // The decoy: same PROJECT, different ENVIRONMENT. A total counted on the
  // project would include these three.
  for (let index = 0; index < SPARSE_ROWS; index += 1) {
    await harness.seedAgent({
      slug: `sparse-marked-${index}`,
      environmentId: PEER_ENVIRONMENT,
      createdAt: new Date(Date.UTC(2026, 4, 2, 9, 0, 0) + index * 1000),
    });
  }
}, 900_000);

afterAll(async () => {
  await harness?.stop();
});

describe("count truth", () => {
  test("the total is the environment's own rows, not the project's", async () => {
    const dense = await page(DENSE, { limit: PAGE });
    const sparse = await page(SPARSE, { limit: PAGE });
    expect(dense.total).toBe(DENSE_ROWS);
    expect(sparse.total).toBe(SPARSE_ROWS);
    // The two scopes share a project. A total counted one level up would answer
    // 303 for both, and both pages would still look right.
    expect(dense.total + sparse.total).toBe(DENSE_ROWS + SPARSE_ROWS);
  });

  test("the total is the count of the FILTERED set, computed independently", async () => {
    const everything = await listed(DENSE);
    expect(everything).toHaveLength(DENSE_ROWS);

    const paused = await page(DENSE, { limit: PAGE, active: false });
    const active = await page(DENSE, { limit: PAGE, active: true });
    expect(paused.total).toBe(everything.filter((row) => !row.agent.isActive).length);
    expect(active.total).toBe(everything.filter((row) => row.agent.isActive).length);
    expect(paused.total).toBe(DENSE_PAUSED);
    expect(paused.total + active.total).toBe(DENSE_ROWS);

    const searched = await page(DENSE, { limit: PAGE, search: "MARKED" });
    // Case-insensitive across name and slug, and the fixture put the marker in
    // both. The expected value is derived from the rows, never from the seed
    // loop's arithmetic — a total that agreed with the loop but not with the
    // rows would be the bug this case is for.
    expect(searched.total).toBe(
      everything.filter((row) => String(row.agent.slug).includes("marked")).length,
    );
    expect(searched.total).toBe(DENSE_ROWS / 10);
  });

  test("the total does not move with the window it is reported beside", async () => {
    const first = await page(DENSE, { limit: PAGE, offset: 0 });
    const last = await page(DENSE, { limit: PAGE, offset: DENSE_ROWS - 5 });
    const past = await page(DENSE, { limit: PAGE, offset: DENSE_ROWS + 100 });
    expect(first.items).toHaveLength(PAGE);
    // The final window is SHORT, which is the case a `length <= limit` assertion
    // over a two-row fixture can never distinguish from a page cap that does not
    // work at all.
    expect(last.items).toHaveLength(5);
    expect(past.items).toHaveLength(0);
    for (const result of [first, last, past]) expect(result.total).toBe(DENSE_ROWS);
  });
});

describe("page truth over three hundred rows", () => {
  test("the windows partition the listing: nothing dropped, nothing repeated", async () => {
    const walked: string[] = [];
    for (const offset of windows(DENSE_ROWS, PAGE)) {
      const window = await page(DENSE, { limit: PAGE, offset });
      walked.push(...idsOf(window.items));
    }
    expect(walked).toHaveLength(DENSE_ROWS);
    expect(allDistinct(walked)).toBe(true);
    // And in the SAME order the unpaged listing gives, which is what makes the
    // order total rather than merely deterministic within one page.
    expect(walked).toEqual(idsOf(await listed(DENSE)));
  });

  test("a filtered walk partitions the filtered set", async () => {
    const total = (await page(DENSE, { limit: 1, active: false })).total;
    const walked: string[] = [];
    for (const offset of windows(total, PAGE)) {
      const window = await page(DENSE, { limit: PAGE, offset, active: false });
      walked.push(...idsOf(window.items));
    }
    expect(walked).toHaveLength(DENSE_PAUSED);
    expect(allDistinct(walked)).toBe(true);
  });
});

describe("statement cost", () => {
  test("a page of twenty-five costs the same in an environment of 3 and of 300", async () => {
    const sparse = await measure(harness, () => page(SPARSE, { limit: PAGE }));
    const dense = await measure(harness, () => page(DENSE, { limit: PAGE }));
    expect(dense.counted).toBe(sparse.counted);
    // FOUR, MEASURED: the binding window, its count, and the two relations
    // that are not null on this fixture — the agent and the active version.
    // The client SKIPS a relation whose foreign key is null, so the canary and
    // the cluster cost nothing here. Every one of the four is a set read with
    // `IN (…)`; none is per row, which is why three hundred cost what three do.
    expect(dense.counted).toBe(4);
    expect(dense.total).toBeGreaterThanOrEqual(dense.counted);
  });

  test("the cost does not move with the OFFSET either", async () => {
    const first = await measure(harness, () => page(DENSE, { limit: PAGE, offset: 0 }));
    const deep = await measure(harness, () =>
      page(DENSE, { limit: PAGE, offset: DENSE_ROWS - PAGE }),
    );
    expect(deep.counted).toBe(first.counted);
  });
});

describe("the plan", () => {
  let plan: PlanNode;
  let sparsePlan: PlanNode;

  beforeAll(async () => {
    const dense = await capture(harness, () => page(DENSE, { limit: PAGE }));
    plan = await explain(harness.client, pageRowStatement(dense));
    const sparse = await capture(harness, () => page(SPARSE, { limit: PAGE }));
    sparsePlan = await explain(harness.client, pageRowStatement(sparse));
  }, 300_000);

  test("the environment clause is served by an index rather than a scan", async () => {
    // `AgentBinding_environmentId_agentId_key` leads on `environmentId`, so the
    // scope clause is an index lookup. This is the half that DOES work.
    expect(indexesUsed(plan)).toContain("AgentBinding_environmentId_agentId_key");
  });

  test("MEASURED: the page reads the whole environment because the sort key is JOINED", async () => {
    // Three hundred bindings read to return twenty-five, and three read to
    // return three. The statement count is flat; the row cost is not. No index
    // on `AgentBinding` can change this: the order is `Agent.createdAt DESC`,
    // a column on the other table.
    expect(rowsFrom(plan, "AgentBinding")).toBe(DENSE_ROWS);
    expect(rowsFrom(sparsePlan, "AgentBinding")).toBe(SPARSE_ROWS);
    // The AGENT side is touched for every binding READ, not for every binding
    // RETURNED — the join happens before the window is taken. Measured at 900
    // for three hundred bindings, across the three nodes the planner used; the
    // pin is the LINEARITY rather than the multiplier, because which nodes the
    // planner picks is its business and how many rows they see is not.
    expect(rowsFrom(plan, "Agent")).toBeGreaterThanOrEqual(DENSE_ROWS);
    // And the sort is real: no index can deliver a joined column's order.
    expect(nodeTypesOf(plan)).toContain("Sort");
  });

  test("the window is applied by the database, not after the rows are in hand", async () => {
    // A `Limit` node is the difference between "PostgreSQL returned 25 rows" and
    // "PostgreSQL returned 300 rows and the client kept 25". The second shape
    // returns exactly the same page.
    expect(plan.nodeType).toBe("Limit");
    expect(plan.actualRows).toBe(PAGE);
  });
});
