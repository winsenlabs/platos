// Statement counts, MEASURED — the N+1 control for `conversations`' reads.
//
// EVERY PIN IS TAKEN TWICE, over a small thread and one an order of magnitude
// larger, and both must be identical. A read whose cost grows with the rows it
// returns is correct in every case and expensive in exactly one: the
// conversation that has been running longest, which for this context is the
// whole product.
//
// THE TURN READS ARE THE INTERESTING PIN, and they are the reason this file
// exists rather than being a formality. `Turn.cost` and `Turn.usage` are rolled
// up from the STEP rows — the `Turn` row has a column for one of their nine
// numbers — so every read that answers a turn also reads steps. The obvious
// wrong implementation is one query for the page and one per turn for its
// steps, which is invisible on a fixture of two turns and linear on a real
// transcript. Both `pageTurns` and `readTranscriptTurns` are measured over a
// page of two and a page of twenty.
//
// `measureForkDepth` IS THE OTHER ONE. The in-memory double walks
// `parentThreadId` in a loop; against a real store that is one query per
// ancestor. It is measured at a fork depth of one and again at a depth of eight.
//
// THE PROBE PATTERN IS ANCHORED, and this is tranche 3's trap rather than a
// precaution. Its advisory lock projected `SELECT 1`, which is exactly the shape
// these suites strip to discard the driver's connection probe, so the lock was
// measured at ZERO statements and a mutation that removed it survived the sweep.
// `allocateTurnSequence`'s lock projects `id AS "lockedThreadId"`, the filter
// below matches ONLY a statement that is `SELECT 1` and nothing else, and every
// measurement records the unfiltered count beside the filtered one.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  asConversationsIdentifier,
  rollUpTurnCost,
  sumStepUsage,
  type ActorId,
  type AgentId,
  type AgentVersionId,
  type EndUserId,
  type EnvironmentScope,
  type PostmanContextHandle,
  type PostmanExecution,
  type PostmanExecutionId,
  type Thread,
  type ThreadId,
  type Turn,
  type TurnId,
} from "@platos/context-conversations/application/ports/index.js";
import { runResult } from "@platos/kernel";

import type { ConversationsHarness, PeerChain } from "./conversations-harness.js";
import { startConversationsHarness } from "./conversations-harness.js";

let harness: ConversationsHarness;
let chain: PeerChain;
let scope: EnvironmentScope;

const AT = new Date("2026-05-01T09:00:00.000Z");
const uuid = (prefix: string, index: number) =>
  `c4${prefix.padStart(6, "0")}-0000-4000-8000-${String(index).padStart(12, "0")}`;

interface Fixture {
  readonly threadId: ThreadId;
  readonly turnIds: readonly TurnId[];
  /** The deepest thread of a fork chain rooted at `threadId`. */
  readonly deepestForkId: ThreadId;
}

let small: Fixture;
let large: Fixture;

/**
 * Statements the CLIENT sent, less the transaction frame.
 *
 * `BEGIN`/`COMMIT`/`ROLLBACK`/`DEALLOCATE` are the driver's bookkeeping and are
 * not what an N+1 is made of. `SELECT 1` is the driver's connection probe and is
 * matched ONLY when the whole statement is that and nothing else, so a read that
 * genuinely projects a constant cannot be discarded by the thing measuring it.
 */
function queries(): readonly string[] {
  return harness.base
    .statements()
    .filter(
      (statement) =>
        !/^\s*(BEGIN|COMMIT|ROLLBACK|DEALLOCATE|SAVEPOINT|RELEASE|ROLLBACK TO)\b/iu.test(statement) &&
        !/^\s*SELECT\s+1\s*$/iu.test(statement),
    );
}

interface Measurement {
  readonly counted: number;
  readonly total: number;
}

async function measure(work: () => Promise<unknown>): Promise<Measurement> {
  harness.base.resetStatements();
  await work();
  return { counted: queries().length, total: harness.base.statements().length };
}

function threadOf(threadId: string, overrides: Partial<Thread> = {}): Thread {
  return Object.freeze({
    threadId: asConversationsIdentifier<ThreadId>(threadId),
    agentId: asConversationsIdentifier<AgentId>(chain.agentId),
    endUserId: asConversationsIdentifier<EndUserId>(chain.endUserId),
    clusterId: null,
    parentThreadId: null,
    forkedUpToTurnId: null,
    forkedTurnIds: Object.freeze([]),
    compactedUpToTurnId: null,
    title: null,
    status: "ACTIVE" as const,
    summary: null,
    compactionState: "IDLE" as const,
    compactedAt: null,
    sessionContext: null,
    tags: Object.freeze([]),
    pinnedAt: null,
    archivedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

function turnOf(turnId: string, threadId: string, sequence: number): Turn {
  return Object.freeze({
    turnId: asConversationsIdentifier<TurnId>(turnId),
    threadId: asConversationsIdentifier<ThreadId>(threadId),
    parentTurnId: null,
    agentVersionId: asConversationsIdentifier<AgentVersionId>(chain.agentVersionId),
    versionBucket: "CURRENT" as const,
    sequence,
    inputText: "hello",
    outputText: "hi",
    input: null,
    output: null,
    thinkingContent: null,
    status: "SUCCEEDED" as const,
    externalRuntimeId: null,
    idempotencyKey: null,
    cost: rollUpTurnCost([]),
    usage: sumStepUsage([]),
    latencyMs: null,
    startedAt: null,
    completedAt: null,
    createdAt: AT,
  });
}

function executionOf(index: number): PostmanExecution {
  return Object.freeze({
    executionId: asConversationsIdentifier<PostmanExecutionId>(uuid("8", index)),
    agentId: asConversationsIdentifier<AgentId>(chain.agentId),
    templateId: null,
    requestId: uuid("9", index),
    requestFingerprint: "f".repeat(64),
    actorUserId: asConversationsIdentifier<ActorId>(chain.actorUserId),
    simulatedEndUserId: null,
    contextHandle: asConversationsIdentifier<PostmanContextHandle>(uuid("a", index)),
    contextExpiresAt: AT,
    status: "PENDING" as const,
    threadId: null,
    turnId: null,
    completedAt: null,
    createdAt: AT,
    updatedAt: AT,
  });
}

/** One thread with `turns` turns, and a fork chain `depth` deep hanging off it. */
async function seedFixture(prefix: string, turns: number, depth: number): Promise<Fixture> {
  const threadId = uuid(prefix, 0);
  expect((await harness.stores.threads.createThread(scope, threadOf(threadId))).ok).toBe(true);
  const turnIds: TurnId[] = [];
  for (let index = 1; index <= turns; index += 1) {
    const turnId = uuid(`${prefix}1`, index);
    const written = await harness.stores.turns.createTurn(
      scope,
      turnOf(turnId, threadId, index),
    );
    expect(written.ok).toBe(true);
    turnIds.push(asConversationsIdentifier<TurnId>(turnId));
  }

  // THE FORK CHAIN, each level branching at the SAME ancestor turn — which
  // `Thread_ancestry` permits, because `forkedUpToTurnId` may name a turn of the
  // parent OR one already in the parent's own `forkedTurnIds`.
  let parentId = threadId;
  let deepest = threadId;
  const boundary = turnIds[0];
  if (boundary === undefined) throw new Error("the fixture needs at least one turn");
  for (let level = 1; level <= depth; level += 1) {
    const forkId = uuid(`${prefix}2`, level);
    const written = await harness.stores.threads.createThread(
      scope,
      threadOf(forkId, {
        parentThreadId: asConversationsIdentifier<ThreadId>(parentId),
        forkedTurnIds: [boundary],
        forkedUpToTurnId: boundary,
      }),
    );
    expect(written.ok).toBe(true);
    parentId = forkId;
    deepest = forkId;
  }
  return {
    threadId: asConversationsIdentifier<ThreadId>(threadId),
    turnIds,
    deepestForkId: asConversationsIdentifier<ThreadId>(deepest),
  };
}

beforeAll(async () => {
  harness = await startConversationsHarness();
  scope = await harness.freshScope();
  chain = await harness.seedChain(scope);
  small = await seedFixture("1", 2, 1);
  large = await seedFixture("2", 20, 8);
  for (let index = 0; index < 12; index += 1) {
    expect((await harness.stores.postman.createExecution(scope, executionOf(index))).ok).toBe(true);
  }
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

/** Assert one read costs the same over both fixtures, and say what that is. */
async function pinned(
  label: string,
  statements: number,
  work: (fixture: Fixture) => Promise<unknown>,
): Promise<void> {
  const onSmall = await measure(() => work(small));
  const onLarge = await measure(() => work(large));
  expect({ label, ...onSmall }).toEqual({ label, counted: statements, total: onSmall.total });
  expect({ label, counted: onLarge.counted }).toEqual({ label, counted: statements });
  // THE UNFILTERED COUNT IS RECORDED TOO, so a statement the filter above
  // discards cannot make a read look free. It is at least the counted one.
  expect(onSmall.total).toBeGreaterThanOrEqual(onSmall.counted);
}

describe("reads that answer a Turn cost the same for two turns and for twenty", () => {
  test("pageTurns is THREE statements, not one per turn", async () => {
    // THE PAGE, ITS STEPS AND THE COUNT — measured rather than assumed, and the
    // middle one is the finding. The ORM resolves a to-many `select` with a
    // SECOND query over an `IN` list of the page's ids, not with a join and not
    // with one query per row: three statements for a page of two turns and three
    // for a page of twenty, which is the property this file exists to hold. The
    // pin was first written at TWO on the assumption of a join and the first run
    // corrected it; the number here is the measurement.
    await pinned("pageTurns", 3, (fixture) =>
      harness.stores.turns.pageTurns({
        scope,
        threadId: fixture.threadId,
        limit: 50,
        offset: 0,
        includeSubThreads: true,
      }),
    );
  }, 120_000);

  test("readTranscriptTurns is TWO statements: the turns and their steps", async () => {
    // TWO, and the same two for two turns and for twenty. A transcript is read
    // on every prompt a long conversation builds, so this is the pin that would
    // catch a rollup done one turn at a time.
    await pinned("readTranscriptTurns", 2, (fixture) =>
      harness.stores.turns.readTranscriptTurns(scope, fixture.threadId, 0, 50),
    );
  }, 120_000);

  test("findTurnWithSteps is TWO, however many steps the turn has", async () => {
    await pinned("findTurnWithSteps", 2, (fixture) =>
      harness.stores.turns.findTurnWithSteps(scope, fixture.turnIds[0] as TurnId),
    );
  }, 120_000);

  test("findInheritedTurns resolves a whole list in ONE statement", async () => {
    // TWO — the turns and their steps — for a list of two and for a list of
    // twenty. The obvious wrong shape is one lookup per inherited turn, which is
    // what a fork's transcript would do on every prompt it builds.
    await pinned("findInheritedTurns", 2, (fixture) =>
      harness.stores.threads.findInheritedTurns(scope, fixture.turnIds),
    );
  }, 120_000);

  test("countToolCalls folds a whole list in ONE statement", async () => {
    await pinned("countToolCalls", 1, (fixture) =>
      harness.stores.turns.countToolCalls(scope, fixture.turnIds),
    );
  }, 120_000);
});

describe("the fork-chain reads do not walk the chain in JavaScript", () => {
  test("measureForkDepth is ONE statement at depth one and at depth eight", async () => {
    await pinned("measureForkDepth", 1, (fixture) =>
      harness.stores.threads.measureForkDepth(scope, fixture.deepestForkId),
    );
  }, 120_000);

  test("countForks is ONE statement", async () => {
    await pinned("countForks", 1, (fixture) =>
      harness.stores.threads.countForks(scope, fixture.threadId),
    );
  }, 120_000);
});

describe("the listings are two statements and the point lookups one", () => {
  test("pageThreads is TWO: the page and its total", async () => {
    await pinned("pageThreads", 2, () =>
      harness.stores.threads.pageThreads({
        scope,
        endUserId: null,
        limit: 50,
        offset: 0,
        includeArchived: true,
      }),
    );
  }, 120_000);

  test("pageExecutions is TWO", async () => {
    await pinned("pageExecutions", 2, () =>
      harness.stores.postman.pageExecutions({ scope, actorUserId: null, limit: 50, offset: 0 }),
    );
  }, 120_000);

  test("findThread, findExecution and findByHandle are ONE each", async () => {
    await pinned("findThread", 1, (fixture) =>
      harness.stores.threads.findThread(scope, fixture.threadId),
    );
    await pinned("findExecution", 1, () =>
      harness.stores.postman.findExecution(scope, executionOf(0).executionId),
    );
    await pinned("findByHandle", 1, () =>
      harness.stores.postman.findByHandle(scope, executionOf(0).contextHandle),
    );
  }, 120_000);

  test("findByRequest with a NULL template sends NOTHING", async () => {
    // ZERO, and it is the one measurement in this file that is meant to be zero.
    // `@@unique([templateId, requestId])` is vacuous when the template is null —
    // PostgreSQL treats NULLs as distinct — so the port says a null template
    // answers null and the caller creates. A store that filtered on null instead
    // would find a row a previous ad-hoc request left behind and report a replay
    // the constraint never prevented.
    const measured = await measure(() =>
      harness.stores.postman.findByRequest(scope, null, uuid("9", 0)),
    );
    expect(measured.counted).toBe(0);
  }, 120_000);
});

describe("the erasure plan counts without walking the tenant tree", () => {
  test("censusForEndUser is FOUR statements, one per model", async () => {
    // FOUR counts whose predicates reach down the relation graph, and the same
    // four for a subject with one thread and a subject with thirty. The N+1 this
    // shape invites is not in the rows at all: it is listing the organization's
    // environments and then counting per environment, which is linear in the
    // TENANT tree and invisible on a fixture with one environment.
    await pinned("censusForEndUser", 4, () =>
      harness.stores.conversationsErasure.censusForEndUser(
        asConversationsIdentifier<EndUserId>(chain.endUserId),
        scope.organizationId,
      ),
    );
  }, 120_000);

  test("censusForActor is ONE, because three of its four numbers need no query", async () => {
    await pinned("censusForActor", 1, () =>
      harness.stores.conversationsErasure.censusForActor(
        chain.actorUserId,
        scope.organizationId,
      ),
    );
  }, 120_000);

  test("findHeldThreads is ONE", async () => {
    await pinned("findHeldThreads", 1, () =>
      harness.stores.conversationsErasure.findHeldThreads(
        asConversationsIdentifier<EndUserId>(chain.endUserId),
        scope.organizationId,
      ),
    );
  }, 120_000);
});

describe("the sequence allocation's LOCK is measured, not discarded", () => {
  test("allocateTurnSequence is TWO statements and the first is the row lock", async () => {
    // THE ANCHOR. If the lock projected `SELECT 1` the filter above would strip
    // it and this pin would read ONE — which is exactly how WIN-258 T3's advisory
    // lock was measured at zero and survived a mutation that deleted it. The
    // projection is `id AS "lockedThreadId"`, so it is counted, and the assertion
    // below names it.
    const measured = await measure(() =>
      runResult(harness.base.adapter.unitOfWork, () =>
        harness.stores.threads.allocateTurnSequence(scope, small.threadId),
      ),
    );
    expect(measured.counted).toBe(2);
    expect(queries().some((statement) => statement.includes("lockedThreadId"))).toBe(true);
    expect(queries().some((statement) => /FOR UPDATE/iu.test(statement))).toBe(true);
  }, 120_000);

  test("acquireCompactionLock is ONE conditional UPDATE", async () => {
    const measured = await measure(() =>
      harness.stores.threads.acquireCompactionLock(scope, large.threadId),
    );
    expect(measured.counted).toBe(1);
  }, 120_000);
});
