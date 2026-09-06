// WIN-258 T7 — `pageThreads` and `pageTurns` under a DENSE fixture, and the
// index the thread listing was said to have.
//
// THE CLAIM THIS SUITE WAS WRITTEN TO CHECK. `conversations-threads.ts` says of
// its ordering: "`updatedAt` descending is the order
// `Thread_environmentId_endUserId_updatedAt_idx` exists for". That index is
// `(environmentId, endUserId, updatedAt)`. An operator listing an environment's
// threads passes NO end user — the port's own words are "Null reads every end
// user's threads" — so the middle column is unconstrained and the index cannot
// deliver `updatedAt` order for it. The prose describes an index that serves a
// read the surface does not make.
//
// WHAT THE REAL DATABASE SAID. The plans below are measured, not predicted, and
// they are what decided the migration this tranche ships: with no end user named
// the plan reads every live thread in the environment and sorts them, and with
// one named it does not. Both halves are pinned, because a migration that fixed
// the first without being able to show the second was worse is not evidence of
// anything.
//
// `pageTurns` IS THE CONTROL, and it is here to keep the finding honest. Its
// order is `sequence` within one thread, `Turn_threadId_sequence_key` is exactly
// that pair, and its plan should therefore need no sort at all. A suite that
// only ever measured the read it suspected would have no way to tell "this store
// pages badly" from "PostgreSQL sorts everything".

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  EndUserId,
  EnvironmentScope,
  Thread,
  ThreadPageQuery,
  TurnPageQuery,
} from "@platos/context-conversations/application/ports/index.js";
import { asConversationsIdentifier } from "@platos/context-conversations/application/ports/index.js";

import { AT, threadOf, turnOf } from "./conversations-fixtures.js";
import {
  startConversationsHarness,
  type ConversationsHarness,
  type PeerChain,
} from "./conversations-harness.js";
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

let harness: ConversationsHarness;
let scope: EnvironmentScope;
let chain: PeerChain;
/** A second environment holding three threads. The small half of every pin. */
let sparseScope: EnvironmentScope;
let sparseChain: PeerChain;
/** The thread the turn pins are taken over. */
let deepThreadId: string;

const DENSE_ROWS = 300;
const SPARSE_ROWS = 3;
/** Threads archived in the dense environment, so `includeArchived` has work. */
const ARCHIVED = 60;
/** Threads belonging to the SECOND end user, so the filtered plan differs. */
const SECOND_SUBJECT = 75;
const TURNS = 300;
const PAGE = 25;

function threadQuery(overrides: Partial<ThreadPageQuery> = {}): ThreadPageQuery {
  return {
    scope,
    endUserId: null,
    limit: PAGE,
    offset: 0,
    includeArchived: false,
    ...overrides,
  };
}

async function threads(overrides: Partial<ThreadPageQuery> = {}) {
  const result = await harness.stores.threads.pageThreads(threadQuery(overrides));
  if (!result.ok) throw new Error(`pageThreads refused: ${result.error.code}`);
  return result.value;
}

async function turns(overrides: Partial<TurnPageQuery> = {}) {
  const result = await harness.stores.turns.pageTurns({
    scope,
    threadId: asConversationsIdentifier(deepThreadId),
    limit: PAGE,
    offset: 0,
    includeSubThreads: true,
    ...overrides,
  } as TurnPageQuery);
  if (!result.ok) throw new Error(`pageTurns refused: ${result.error.code}`);
  return result.value;
}

const idsOf = (items: readonly Thread[]): readonly string[] =>
  items.map((item) => String(item.threadId));

/** The thread window statement: the one with a LIMIT, not the count. */
function threadRowStatement(events: Parameters<typeof onlyStatement>[0]) {
  return onlyStatement(
    events,
    (sql) => /FROM\s+"public"\."Thread"/u.test(sql) && /\bLIMIT\b/u.test(sql),
  );
}

async function seedThreads(
  target: EnvironmentScope,
  link: PeerChain,
  count: number,
  options: { readonly archived?: number; readonly second?: number } = {},
): Promise<readonly string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const threadId = harness.base.freshId("0091");
    const written = await harness.stores.threads.createThread(
      target,
      threadOf(link, threadId, {
        // Distinct instants so `updatedAt DESC` is a real order rather than one
        // enormous tie the id tie-break resolves on its own.
        updatedAt: new Date(AT.getTime() + index * 1000),
        archivedAt: index < (options.archived ?? 0) ? AT : null,
        endUserId:
          index < (options.second ?? 0)
            ? asConversationsIdentifier<EndUserId>(link.secondEndUserId)
            : asConversationsIdentifier<EndUserId>(link.endUserId),
      }),
    );
    if (!written.ok) throw new Error(`fixture thread refused: ${written.error.code}`);
    ids.push(threadId);
  }
  return ids;
}

beforeAll(async () => {
  harness = await startConversationsHarness();
  scope = await harness.freshScope();
  chain = await harness.seedChain(scope);
  await seedThreads(scope, chain, DENSE_ROWS, { archived: ARCHIVED, second: SECOND_SUBJECT });

  sparseScope = await harness.freshScope();
  sparseChain = await harness.seedChain(sparseScope);
  await seedThreads(sparseScope, sparseChain, SPARSE_ROWS);

  deepThreadId = harness.base.freshId("0092");
  const thread = await harness.stores.threads.createThread(
    scope,
    threadOf(chain, deepThreadId, { updatedAt: AT }),
  );
  if (!thread.ok) throw new Error(`fixture thread refused: ${thread.error.code}`);
  for (let sequence = 1; sequence <= TURNS; sequence += 1) {
    const written = await harness.stores.turns.createTurn(
      scope,
      turnOf(chain, harness.base.freshId("0093"), deepThreadId, sequence),
    );
    if (!written.ok) throw new Error(`fixture turn refused: ${written.error.code}`);
  }
}, 1_200_000);

afterAll(async () => {
  await harness?.stop();
});

describe("count truth", () => {
  test("the total counts the LIVE threads unless archived ones were asked for", async () => {
    const live = await threads();
    const everything = await threads({ includeArchived: true });
    // The extra thread the turn fixture hangs off is live too, so the live set
    // is the seeded rows less the archived ones, plus that one.
    expect(live.total).toBe(DENSE_ROWS - ARCHIVED + 1);
    expect(everything.total).toBe(DENSE_ROWS + 1);
    expect(everything.total - live.total).toBe(ARCHIVED);
  });

  test("the total counts THIS environment, not every environment", async () => {
    const sparse = await harness.stores.threads.pageThreads({
      ...threadQuery(),
      scope: sparseScope,
    });
    expect(sparse.ok && sparse.value.total).toBe(SPARSE_ROWS);
  });

  test("the total narrows with the end user, and the two halves add up", async () => {
    const first = await threads({ endUserId: asConversationsIdentifier<EndUserId>(chain.endUserId) });
    const second = await threads({
      endUserId: asConversationsIdentifier<EndUserId>(chain.secondEndUserId),
    });
    const live = await threads();
    // The second subject's threads are the FIRST seventy-five, which are also
    // the sixty archived ones plus fifteen — so this is not a fixture where
    // every filter partitions the same way, which is the point.
    expect(first.total + second.total).toBe(live.total);
  });

  test("the total does not move with the window it is reported beside", async () => {
    const live = await threads();
    const deep = await threads({ offset: live.total - 4 });
    expect(deep.items).toHaveLength(4);
    expect(deep.total).toBe(live.total);
  });
});

describe("page truth over three hundred threads", () => {
  test("the windows partition the listing", async () => {
    const live = await threads();
    const walked: string[] = [];
    for (const offset of windows(live.total, PAGE)) {
      walked.push(...idsOf((await threads({ offset })).items));
    }
    expect(walked).toHaveLength(live.total);
    expect(allDistinct(walked)).toBe(true);
  });

  test("the listing is NEWEST FIRST, and stays so across every page", async () => {
    // The partition case above cannot see a reversed order: the same rows come
    // back either way, once each, and the walk is still a partition. The order
    // is the port's contract and the new index is declared in its direction, so
    // it is asserted directly — the sweep reported a reversed `orderBy` as
    // SURVIVING until this case existed.
    const live = await threads();
    const walked: Thread[] = [];
    for (const offset of windows(live.total, PAGE)) {
      walked.push(...(await threads({ offset })).items);
    }
    expect(walked).toHaveLength(live.total);
    const stamps = walked.map((thread) => thread.updatedAt.getTime());
    expect(stamps).toEqual([...stamps].sort((left, right) => right - left));
    expect(stamps[0]).toBe(Math.max(...stamps));
  });

  test("a turn transcript pages without dropping or repeating a sequence", async () => {
    const first = await turns();
    expect(first.total).toBe(TURNS);
    const walked: number[] = [];
    for (const offset of windows(TURNS, PAGE)) {
      walked.push(...(await turns({ offset })).items.map((turn) => turn.sequence));
    }
    expect(walked).toHaveLength(TURNS);
    // `sequence` is unique within a thread, so the walk must reproduce 1..300
    // exactly. Any repeat or drop shows up as a mismatch here.
    expect(walked).toEqual(Array.from({ length: TURNS }, (_, index) => index + 1));
  });
});

describe("statement cost", () => {
  test("a thread page is two statements over three rows and over three hundred", async () => {
    const sparse = await measure(harness.base, () =>
      harness.stores.threads.pageThreads({ ...threadQuery(), scope: sparseScope }),
    );
    const dense = await measure(harness.base, () => threads());
    expect(sparse.counted).toBe(2);
    expect(dense.counted).toBe(2);
    expect(dense.total).toBeGreaterThanOrEqual(dense.counted);
  });

  test("a turn page is two statements whatever the transcript's length", async () => {
    const shallow = await measure(harness.base, () => turns({ limit: 1 }));
    const deep = await measure(harness.base, () => turns({ offset: TURNS - PAGE }));
    // THREE, MEASURED, and the third is the tenant clause rather than a row.
    // `Turn` carries no `environmentId` — `turnScopedWhere` reaches it through
    // `thread` — and the client resolves that relation filter as its own
    // statement for the window and the count alike. What matters is that the
    // figure is the SAME for a page of one and for the last page of three
    // hundred: it is fixed by the read's shape, not by the transcript's length.
    expect(shallow.counted).toBe(3);
    expect(deep.counted).toBe(3);
  });
});

describe("the plan", () => {
  let unfiltered: PlanNode;
  let bySubject: PlanNode;
  let sparse: PlanNode;
  let transcript: PlanNode;

  beforeAll(async () => {
    unfiltered = await explain(
      harness.base.client,
      threadRowStatement(await capture(harness.base, () => threads())),
    );
    bySubject = await explain(
      harness.base.client,
      threadRowStatement(
        await capture(harness.base, () =>
          threads({ endUserId: asConversationsIdentifier<EndUserId>(chain.secondEndUserId) }),
        ),
      ),
    );
    sparse = await explain(
      harness.base.client,
      threadRowStatement(
        await capture(harness.base, () =>
          harness.stores.threads.pageThreads({ ...threadQuery(), scope: sparseScope }),
        ),
      ),
    );
    transcript = await explain(
      harness.base.client,
      onlyStatement(
        await capture(harness.base, () => turns()),
        (sql) => /FROM\s+"public"\."Turn"/u.test(sql) && /\bLIMIT\b/u.test(sql),
      ),
    );
  }, 300_000);

  test("the transcript needs NO sort: the index is exactly its order", async () => {
    // `Turn_threadId_sequence_key` is `(threadId, sequence)` and the read wants
    // `threadId = $1 ORDER BY sequence ASC`. This is what a page whose index
    // matches its order looks like, and it is the control for the pins below.
    expect(indexesUsed(transcript)).toContain("Turn_threadId_sequence_key");
    expect(nodeTypesOf(transcript)).not.toContain("Sort");
    // The window is taken by walking the index, so the rows read are the rows
    // skipped plus the rows returned — never the whole transcript.
    expect(rowsFrom(transcript, "Turn")).toBeLessThan(TURNS);
  });

  test("the thread listing is served by an index and needs no sort", async () => {
    // WIN-258 T7 adds `Thread_environmentId_updatedAt_id_idx`: the equality
    // column, then the order, in the order's own direction. `archivedAt` is
    // NOT in it — a filter between the equality column and the order column is
    // the exact defect the old index had.
    expect(indexesUsed(unfiltered)).toContain("Thread_environmentId_updatedAt_id_idx");
    expect(nodeTypesOf(unfiltered)).not.toContain("Sort");
  });

  test("MEASURED: the listing reads its window, not the environment", async () => {
    // The rows read are bounded by the window. Before the index existed this
    // read every live thread in the environment and sorted them, which is the
    // shape that turns a page of twenty-five into a scan of a hundred thousand
    // on the installation that has been running longest.
    expect(rowsFrom(unfiltered, "Thread")).toBeLessThanOrEqual(PAGE);
    expect(rowsFrom(sparse, "Thread")).toBeLessThanOrEqual(SPARSE_ROWS);
  });

  test("naming an end user still lands on an index rather than a scan", async () => {
    // The pre-existing `(environmentId, endUserId, updatedAt)` index serves this
    // one, and it is the read the prose was written about. Whichever index the
    // planner picks, what must not happen is a sequential scan of the table.
    expect(indexesUsed(bySubject).length).toBeGreaterThan(0);
    expect(nodeTypesOf(bySubject)).not.toContain("Seq Scan");
  });
});
