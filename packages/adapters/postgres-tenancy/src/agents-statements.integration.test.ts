// Statement counts for the two `agents` stores, MEASURED — the N+1 control.
//
// Every pin below is a number this suite observed rather than a number somebody
// expected, and every read is measured TWICE: once over a small fixture and once
// over one an order of magnitude larger. What matters is not the figure but that
// the figure DOES NOT MOVE with the number of rows. An N+1 does not announce
// itself in a suite — every value is correct and every test passes — it
// announces itself as a listing that took four seconds because the environment
// had forty agents.
//
// THE SHAPE MOVES THE COUNT AND THE ROW COUNT DOES NOT, which is the one thing
// to hold on to here. A bound read hydrates four relations, and the client SKIPS
// a relation whose foreign key is null — so an agent with a canary and a cluster
// costs more statements than one with neither, and TWENTY of either cost exactly
// what one of it costs. Both halves are pinned: the shape's cost, and its
// independence from the number of rows.
//
// THE WRITE COST OF THE SAVEPOINT IS PINNED TOO. A refusable write is three
// statements — `SAVEPOINT`, the write, `RELEASE SAVEPOINT` — and that is the
// price of the guard in `agents-guards.ts`. Pinning it is what stops the guard
// being removed as an optimisation without a number moving.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { HOME_ENVIRONMENT, scopeOf, startAgentsHarness, type AgentsHarness, type SeededAgent } from "./agents-harness.js";

let harness: AgentsHarness;
/** One agent with a canary and a cluster; the shape that costs the most. */
let rich: SeededAgent;
/** An agent with neither, so the null-relation saving is visible. */
let plain: SeededAgent;
/** Twenty versions, so a per-row cost would show. */
let deep: SeededAgent;

const HOME = scopeOf(HOME_ENVIRONMENT);
const HEAVY = 20;

/**
 * Statements the CLIENT sent, less the transaction frame.
 *
 * `BEGIN`/`COMMIT`/`ROLLBACK`/`DEALLOCATE` are the driver's bookkeeping and are
 * not what an N+1 is made of. `SAVEPOINT` and its two endings are NOT filtered
 * out: they are this adapter's own statements, they are the guard this tranche
 * turns on, and a filter that swallowed them would measure the guard at zero —
 * which is precisely the trap tranche 3 fell into with a lock that projected
 * `SELECT 1`. The connection probe is matched WHOLE for the same reason.
 */
function queries(): readonly string[] {
  return harness
    .statements()
    .filter(
      (statement) =>
        !/^\s*(BEGIN|COMMIT|ROLLBACK|DEALLOCATE)\s*$/iu.test(statement) &&
        !/^\s*SELECT 1\s*$/iu.test(statement),
    );
}

/**
 * Let the client's `query` events arrive.
 *
 * THE EVENT IS EMITTED ASYNCHRONOUSLY, AFTER THE CALL HAS RESOLVED, and a count
 * taken in the same tick can miss the last statement. That is not merely a
 * measurement that reads low: the missed event lands in the NEXT measurement's
 * array, so one pin reads one short and the pin after it reads one long. Both
 * halves were observed on a real container — `pageTemplates` measured 1 instead
 * of 2 and `observedVersionNumbers` measured 2 instead of 1, in the same run —
 * which is what a statement-count suite looks like when it is measuring the
 * event loop rather than the database.
 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

async function measure(work: () => Promise<unknown>): Promise<number> {
  await settle();
  harness.resetStatements();
  await work();
  await settle();
  return queries().length;
}

beforeAll(async () => {
  harness = await startAgentsHarness();
  plain = await harness.seedAgent({ slug: "statements-plain" });
  rich = await harness.seedAgent({ slug: "statements-rich" });
  deep = await harness.seedAgent({ slug: "statements-deep" });

  const cluster = await harness.seedCluster({ slug: "statements-cluster" });
  const canary = await harness.seedVersion(rich, 2, "canary");
  await harness.adapter.unitOfWork.run((transaction) =>
    harness.repository.updateBinding(
      {
        ...rich.binding,
        canaryVersionId: canary.agentVersionId,
        canaryPercent: 25,
        clusterId: cluster.clusterId,
      },
      transaction,
    ),
  );
  for (let number = 2; number <= HEAVY + 1; number += 1) {
    await harness.seedVersion(deep, number, `v${number}`);
  }
  for (let index = 0; index < HEAVY; index += 1) {
    await harness.seedTemplate({ name: `template-${index}`, agent: plain });
  }
}, 600_000);

afterAll(async () => {
  await harness?.stop();
});

describe("statement counts", () => {
  test("a bound read costs what its SHAPE costs, and nothing per row", async () => {
    const one = await measure(() => harness.repository.findBoundAgent(HOME, rich.agent.agentId));
    const bare = await measure(() => harness.repository.findBoundAgent(HOME, plain.agent.agentId));
    expect(one).toBe(5);
    // Two relations are null, so two statements are not issued at all.
    expect(bare).toBe(3);

    const listed = await measure(() => harness.repository.listBoundAgents(HOME));
    const all = await harness.repository.listBoundAgents(HOME);
    expect(all.ok && all.value.length).toBeGreaterThanOrEqual(3);
    // THREE agents, one of them with both optional relations: the SAME five.
    expect(listed).toBe(5);
  });

  test("a listing of twenty costs what a listing of three costs", async () => {
    const before = await measure(() => harness.repository.listBoundAgents(HOME));
    for (let index = 0; index < HEAVY; index += 1) {
      await harness.seedAgent({ slug: `statements-bulk-${index}` });
    }
    const after = await measure(() => harness.repository.listBoundAgents(HOME));
    expect(after).toBe(before);
    const page = await harness.repository.pageBoundAgents(HOME, {
      limit: 100,
      offset: 0,
      search: null,
      active: null,
    });
    expect(page.ok && page.value.total).toBeGreaterThan(HEAVY);
  });

  test("a page costs the listing plus exactly one count", async () => {
    // OVER THE SAME ROWS, and the first draft of this case was not — it took a
    // page of five off a scope of twenty-three and compared it with the whole
    // listing. The page happened to contain only agents with no canary and no
    // cluster, so it cost two statements FEWER, and the pin read as though
    // paging were cheaper than listing. It is not: the difference was the shape
    // of the rows that fell in the window. A page wide enough to hold every row
    // costs the listing plus the count, and nothing else.
    const listed = await measure(() => harness.repository.listBoundAgents(HOME));
    const paged = await measure(() =>
      harness.repository.pageBoundAgents(HOME, { limit: 500, offset: 0, search: null, active: null }),
    );
    expect(paged).toBe(listed + 1);
  });

  test("a version history is one statement whatever its length", async () => {
    const shallow = await measure(() => harness.repository.listVersions(plain.agent.agentId));
    const long = await measure(() => harness.repository.listVersions(deep.agent.agentId));
    expect(shallow).toBe(1);
    expect(long).toBe(1);
    const held = await harness.repository.listVersions(deep.agent.agentId);
    expect(held.ok && held.value.length).toBe(HEAVY + 1);
  });

  test("a version page is two statements: the rows and the total", async () => {
    const first = await measure(() =>
      harness.repository.pageVersions(deep.agent.agentId, { take: 5, offset: 0, cursor: null }),
    );
    expect(first).toBe(2);
  });

  test("a template page is two statements whatever the environment holds", async () => {
    const paged = await measure(() =>
      harness.scaffolding.pageTemplates(HOME, { limit: 5, offset: 0, agentId: null, search: null }),
    );
    expect(paged).toBe(2);
    const all = await harness.scaffolding.pageTemplates(HOME, {
      limit: 100,
      offset: 0,
      agentId: null,
      search: null,
    });
    expect(all.ok && all.value.total).toBeGreaterThanOrEqual(HEAVY);
  });

  test("the version-number read that takes the lock is ONE statement", async () => {
    // One, and not zero. The lock is a `SELECT … FOR UPDATE OF` and is counted
    // here rather than filtered away as a probe — see the note on `queries`.
    const counted = await measure(() =>
      harness.adapter.unitOfWork.run((transaction) =>
        harness.repository.observedVersionNumbers(deep.agent.agentId, transaction),
      ),
    );
    expect(counted).toBe(1);
    const statements = harness.statements().join(" ");
    expect(statements).toMatch(/FOR UPDATE OF/iu);
  });

  test("a refusable write is three statements, and the savepoint is two of them", async () => {
    const counted = await measure(() =>
      harness.adapter.unitOfWork.run((transaction) =>
        harness.repository.insertCluster(
          {
            clusterId: harness.freshId("0501") as never,
            environmentId: HOME.environmentId,
            name: "counted",
            slug: "counted" as never,
            description: null,
            metadata: null,
            createdAt: new Date("2026-05-01T09:00:00.000Z"),
            updatedAt: new Date("2026-05-01T09:00:00.000Z"),
          },
          transaction,
        ),
      ),
    );
    expect(counted).toBe(3);
    const sent = harness.statements().join(" | ");
    expect(sent).toMatch(/SAVEPOINT agents_sp_/u);
    expect(sent).toMatch(/RELEASE SAVEPOINT agents_sp_/u);
  });

  test("a loadout is written in four statements and read in one", async () => {
    const written = await measure(() =>
      harness.adapter.unitOfWork.run((transaction) =>
        harness.repository.replaceLoadout(plain.version.agentVersionId, [], transaction),
      ),
    );
    // SAVEPOINT, the delete, RELEASE. An empty loadout issues no insert.
    expect(written).toBe(3);
    const read = await measure(() => harness.repository.listLoadout(plain.version.agentVersionId));
    expect(read).toBe(1);
  });
});
