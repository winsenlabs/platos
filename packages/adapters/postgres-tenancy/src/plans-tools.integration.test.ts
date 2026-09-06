// WIN-258 T7 — `pageExposures` over a fixture BUILT TO PRODUCE TIES.
//
// THIS SUITE EXISTS TO CLOSE A GAP TRANCHE 5 DECLARED RATHER THAN HID.
// `mutations-tools.json` carries M09 under `unfalsifiable`: truncating
// `EXPOSURE_ORDER` to its first key survives, because the exposure order is
// applied twice — once in SQL and again in JavaScript — and only `pageExposures`
// can see the difference, since it is the one read whose window the DATABASE
// chooses. The entry's own words are that "a paging determinism proof needs a
// fixture built to produce ties across pages", and that nothing in the tree had
// one. This is that fixture.
//
// HOW THE TIES ARE MADE. Seventy-five tool names, each minted TWICE under a
// different schema hash — `Tool_name_schemaHash_key` permits exactly that — and
// both of the environment's entities expose all one hundred and fifty. So every
// tool name appears FOUR times in one environment: two tools, each exposed by
// two entities. The leading order key ties four ways over three hundred rows,
// which is the shape that makes the second and third keys load-bearing rather
// than decorative.
//
// THE ORDER IS PROVED TWO WAYS, AND THE FIRST IS THE ONE THAT CANNOT FLAKE.
// The statement the store SENDS is read back and checked to name all three
// keys: that is a property of this adapter, it is deterministic, and a truncated
// `ORDER BY` fails it every time. The second is behavioural — walking the pages
// and demanding they partition the listing — and is reported for what it is: a
// property that holds on this fixture, whose failure under a non-total order
// depends on which sort PostgreSQL picks for each window.
//
// THE COUNT DECOY IS THE INSTALLATION-GLOBAL `Tool`. Tools are not per tenant;
// exposures are. A second tenant exposing the SAME tools is seeded, so a total
// counted on the tool rather than on the exposure's environment would double.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  EntityId,
  ExposurePageQuery,
  SchemaHash,
  ToolExposure,
  ToolId,
  ToolName,
} from "@platos/context-tools/application/ports/index.js";
import { asToolsIdentifier } from "@platos/context-tools/application/ports/index.js";

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
import { startToolsHarness, type SeededToolsTenant, type ToolsHarness } from "./tools-harness.js";

let harness: ToolsHarness;
/** The dense tenant: two entities, one hundred and fifty tools each. */
let dense: SeededToolsTenant;
/** The sparse one: the same two entities, two tools each. */
let sparse: SeededToolsTenant;
/** The decoy: a third tenant exposing the SAME installation-global tools. */
let decoy: SeededToolsTenant;
let denseToolIds: readonly ToolId[] = [];

/** Distinct names; each is minted twice, so the leading key ties four ways. */
const NAMES = 75;
const TOOLS = NAMES * 2;
const ENTITIES = 2;
const DENSE_ROWS = TOOLS * ENTITIES;
const SPARSE_TOOLS = 2;
const SPARSE_ROWS = SPARSE_TOOLS * ENTITIES;
const PAGE = 25;

async function exposures(tenant: SeededToolsTenant, overrides: Partial<ExposurePageQuery> = {}) {
  const result = await harness.repository.pageExposures(tenant.scope, {
    limit: PAGE,
    offset: 0,
    entityId: null,
    search: null,
    ...overrides,
  });
  if (!result.ok) throw new Error(`pageExposures refused: ${result.error.code}`);
  return result.value;
}

async function everything(tenant: SeededToolsTenant): Promise<readonly ToolExposure[]> {
  const result = await harness.repository.listExposures(tenant.scope);
  if (!result.ok) throw new Error(`listExposures refused: ${result.error.code}`);
  return result.value;
}

const keysOf = (items: readonly ToolExposure[]): readonly string[] =>
  items.map((item) => String(item.exposureId));

/** The window statement of an exposure page: the one with a LIMIT. */
function exposureRowStatement(events: Parameters<typeof onlyStatement>[0]) {
  return onlyStatement(
    events,
    (sql) => /FROM\s+"public"\."EnvironmentEntityTool"/u.test(sql) && /\bLIMIT\b/u.test(sql),
  );
}

/** `count` tools, `NAMES` distinct names each minted twice. Global rows. */
async function mintTools(count: number, prefix: string): Promise<readonly ToolId[]> {
  const minted: ToolId[] = [];
  for (let index = 0; index < count; index += 1) {
    const name = `${prefix}-${String(Math.floor(index / 2)).padStart(3, "0")}`;
    const result = await harness.repository.upsertTool({
      name: asToolsIdentifier<ToolName>(name),
      description: "a tool the plan suite exposes",
      paramSchema: { type: "object" },
      category: "plans",
      // The SAME name under two hashes is two rows, which is what makes the
      // leading order key tie inside one entity as well as across two.
      schemaHash: asToolsIdentifier<SchemaHash>(
        `${prefix}${String(index).padStart(4, "0")}${"0".repeat(50)}`.slice(0, 64),
      ),
    });
    if (!result.ok) throw new Error(`tool mint refused: ${result.error.code}`);
    minted.push(result.value.toolId);
  }
  return minted;
}

async function exposeAll(tenant: SeededToolsTenant, toolIds: readonly ToolId[]): Promise<void> {
  for (const entityId of [tenant.wireEntityId, tenant.mcpEntityId]) {
    const written = await harness.repository.replaceExposures({
      scope: tenant.scope,
      entityId: asToolsIdentifier<EntityId>(entityId),
      callbackUrl: "https://example.test/hook",
      toolIds,
    });
    if (!written.ok) throw new Error(`exposure write refused: ${written.error.code}`);
  }
}

beforeAll(async () => {
  harness = await startToolsHarness();
  dense = await harness.seedToolsTenant("plans-dense");
  sparse = await harness.seedToolsTenant("plans-sparse");
  decoy = await harness.seedToolsTenant("plans-decoy");

  denseToolIds = await mintTools(TOOLS, "plans");
  await exposeAll(dense, denseToolIds);
  await exposeAll(sparse, denseToolIds.slice(0, SPARSE_TOOLS));
  // The decoy exposes the SAME global tools in ITS environment.
  await exposeAll(decoy, denseToolIds);
}, 1_200_000);

afterAll(async () => {
  await harness?.stop();
});

describe("count truth", () => {
  test("the total is this environment's exposures, not the tool's", async () => {
    const page = await exposures(dense);
    expect(page.total).toBe(DENSE_ROWS);
    // The decoy exposes the same installation-global tools. A total counted on
    // the tool would be 600 here and every page would still look right.
    expect((await exposures(decoy)).total).toBe(DENSE_ROWS);
    expect((await exposures(sparse)).total).toBe(SPARSE_ROWS);
    expect(await everything(dense)).toHaveLength(DENSE_ROWS);
  });

  test("the total narrows with the entity, and the two entities add up", async () => {
    const wire = await exposures(dense, {
      entityId: asToolsIdentifier<EntityId>(dense.wireEntityId),
    });
    const mcp = await exposures(dense, {
      entityId: asToolsIdentifier<EntityId>(dense.mcpEntityId),
    });
    expect(wire.total).toBe(TOOLS);
    expect(mcp.total).toBe(TOOLS);
    expect(wire.total + mcp.total).toBe(DENSE_ROWS);
  });

  test("the total under a search is the count of what the search matches", async () => {
    const all = await everything(dense);
    const searched = await exposures(dense, { search: "plans-01" });
    // Independently computed from the rows: `plans-010` through `plans-019`,
    // ten names, two tools each, two entities each.
    const expected = all.filter((row) => String(row.toolName).includes("plans-01")).length;
    expect(searched.total).toBe(expected);
    expect(searched.total).toBe(10 * 2 * ENTITIES);
  });

  test("the total does not move with the window", async () => {
    const last = await exposures(dense, { offset: DENSE_ROWS - 7 });
    expect(last.items).toHaveLength(7);
    expect(last.total).toBe(DENSE_ROWS);
    expect((await exposures(dense, { offset: DENSE_ROWS + 40 })).items).toHaveLength(0);
  });
});

describe("the order is total, and the fixture ties four ways", () => {
  test("the fixture really does tie: one name, four rows", async () => {
    const all = await everything(dense);
    const byName = new Map<string, number>();
    for (const row of all) {
      byName.set(String(row.toolName), (byName.get(String(row.toolName)) ?? 0) + 1);
    }
    expect(byName.size).toBe(NAMES);
    expect([...byName.values()].every((count) => count === 4)).toBe(true);
  });

  test("the WINDOW STATEMENT asks the database for all three order keys", async () => {
    // THE DETERMINISTIC HALF, and the one that kills `mutations-tools.json`'s
    // M09. The store sorts again in JavaScript afterwards, so a truncated SQL
    // `ORDER BY` leaves every returned page correctly ordered — but the
    // DATABASE chose which rows were on it. This reads the statement rather
    // than the rows, so the guard is visible whatever the planner does.
    const statement = exposureRowStatement(await capture(harness, () => exposures(dense)));
    const orderBy = statement.query.slice(statement.query.lastIndexOf("ORDER BY"));
    expect(orderBy).toMatch(/^ORDER BY/u);
    expect(orderBy).toContain(`"name"`);
    expect(orderBy).toContain(`"externalId"`);
    expect(orderBy).toContain(`"toolId"`);
  });

  test("the windows partition three hundred tied rows", async () => {
    // THE BEHAVIOURAL HALF. It holds on this fixture; whether it FAILS under a
    // non-total order depends on which sort PostgreSQL picks per window, which
    // is why the case above exists beside it rather than instead of it.
    const walked: string[] = [];
    for (const offset of windows(DENSE_ROWS, PAGE)) {
      walked.push(...keysOf((await exposures(dense, { offset })).items));
    }
    expect(walked).toHaveLength(DENSE_ROWS);
    expect(allDistinct(walked)).toBe(true);
    expect(new Set(walked)).toEqual(new Set(keysOf(await everything(dense))));
  });

  test("the same window twice gives the same rows", async () => {
    const first = keysOf((await exposures(dense, { offset: 100 })).items);
    const again = keysOf((await exposures(dense, { offset: 100 })).items);
    expect(again).toEqual(first);
  });
});

describe("statement cost", () => {
  test("a page is three statements over four rows and over three hundred", async () => {
    const small = await measure(harness, () => exposures(sparse));
    const big = await measure(harness, () => exposures(dense));
    // The count, the window, and the ONE binding fold `allowedAgentIds` needs.
    // The fold is per CALL, never per row — reading it inside the row loop is
    // an N+1 no returned value can see, because every value would be right.
    expect(small.counted).toBe(3);
    expect(big.counted).toBe(3);
    expect(big.total).toBeGreaterThanOrEqual(big.counted);
  });

  test("the cost does not move with the offset", async () => {
    const first = await measure(harness, () => exposures(dense, { offset: 0 }));
    const deep = await measure(harness, () => exposures(dense, { offset: DENSE_ROWS - PAGE }));
    expect(deep.counted).toBe(first.counted);
  });
});

describe("the plan", () => {
  let densePlan: PlanNode;
  let sparsePlan: PlanNode;

  beforeAll(async () => {
    densePlan = await explain(
      harness.client,
      exposureRowStatement(await capture(harness, () => exposures(dense))),
    );
    sparsePlan = await explain(
      harness.client,
      exposureRowStatement(await capture(harness, () => exposures(sparse))),
    );
  }, 300_000);

  test("the environment clause is served by an index rather than a table scan", async () => {
    // `EnvironmentEntityTool_environmentId_entityId_toolId_key` leads on
    // `environmentId`, which is the scope clause of every read here.
    expect(scansSequentially(densePlan, "EnvironmentEntityTool")).toBe(false);
    expect(indexesUsed(densePlan)).toContain(
      "EnvironmentEntityTool_environmentId_entityId_toolId_key",
    );
  });

  test("MEASURED: the window costs the environment, because the order is JOINED", async () => {
    // The order's leading key is `Tool.name` and its second is
    // `Entity.externalId` — neither is a column of the table being paged, so
    // PostgreSQL joins and sorts the environment's whole exposure set before it
    // can know which twenty-five are on the page. Same shape as
    // `pageBoundAgents`, same reason, and no index on this table can fix it.
    expect(rowsFrom(densePlan, "EnvironmentEntityTool")).toBe(DENSE_ROWS);
    expect(rowsFrom(sparsePlan, "EnvironmentEntityTool")).toBe(SPARSE_ROWS);
  });

  test("the window itself is applied by the database", async () => {
    expect(densePlan.nodeType).toBe("Limit");
    expect(densePlan.actualRows).toBe(PAGE);
  });
});
