// The transaction boundary, proved by FAILURE INJECTION against a real
// PostgreSQL — and the three scope refusals, proved by violating input.
//
// A SUITE THAT ONLY SHOWED THE HAPPY PATH WOULD PROVE NOTHING. The defect this
// programme has shipped twice is a returned error `Result` that COMMITS: the
// unit of work sees a resolved promise, commits, and the caller reads a refusal
// over rows that survived. So every case here forces the SECOND write of a pair
// to fail and asserts that NEITHER row survives, on a connection the failing
// transaction never touched.
//
// THE SECOND CONNECTION IS THE POINT. A writer can see its own uncommitted rows,
// so "the row is gone when the writer looks again" proves nothing about
// durability. `harness.base.databaseUrl` is exposed for exactly this, and every
// assertion below reads through a client this adapter's pool has never used.
//
// ---------------------------------------------------------------------------
// WHAT IS ATOMIC HERE, AND WHY EACH ONE MATTERS
// ---------------------------------------------------------------------------
//
//   `saveSettlement` writes the turn, deletes its old steps and inserts the new
//   ones. `Turn.costCents` is the sum of `Step.costCents`; a settlement that
//   committed the turn and lost the steps would leave a rollup with no parts,
//   and every read of that turn would answer a cost of zero against a stored
//   total that says otherwise.
//
//   The ERASURE anonymises the executions and deletes the threads in ONE
//   transaction opened by `privacy`. Half of it is a subject whose words are
//   gone and whose operator audit trail still names them, which is the worse
//   half to leave behind.
//
//   `allocateTurnSequence` takes a `FOR UPDATE` on the thread row and the lock
//   is held by the CALLER's transaction. A second allocator blocks until the
//   first commits, which is the whole promise of the port — and the case below
//   proves the block by racing two of them.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  asConversationsIdentifier,
  money,
  rollUpTurnCost,
  sumStepUsage,
  type ActorId,
  type AgentId,
  type AgentVersionId,
  type EndUserId,
  type EnvironmentScope,
  type ModelPriceId,
  type PostmanContextHandle,
  type PostmanExecution,
  type PostmanExecutionId,
  type Step,
  type StepId,
  type Thread,
  type ThreadId,
  type TransactionScope,
  type Turn,
  type TurnId,
} from "@platos/context-conversations/application/ports/index.js";
import { runResult } from "@platos/context-conversations/application/ports/index.js";

import type { ConversationsHarness, PeerChain } from "./conversations-harness.js";
import {
  CONFORMANCE_RATES,
  RATE_OBSERVED_AT,
  RATE_SOURCE,
  RATE_SOURCE_REF,
  startConversationsHarness,
} from "./conversations-harness.js";
import {
  TRANSACTION_NOT_OPEN,
  TRANSACTION_SCOPE_FOREIGN,
  TRANSACTION_SCOPE_UNKNOWN,
  TransactionScopeError,
} from "./transaction.js";

let harness: ConversationsHarness;
let chain: PeerChain;
let scope: EnvironmentScope;

const AT = new Date("2026-05-01T09:00:00.000Z");
const uuid = (tail: string) => `c3000000-0000-4000-8000-${tail.padStart(12, "0")}`;

/** A client over the same database that this adapter's pool has never touched. */
interface Observer {
  count(table: string, column: string, value: string): Promise<number>;
  close(): Promise<void>;
}

async function openObserver(): Promise<Observer> {
  const { PrismaClient } = await import("@platos/tenancy-database");
  const client = new PrismaClient({ datasources: { db: { url: harness.base.databaseUrl } } });
  const raw = client as unknown as {
    $queryRawUnsafe(text: string, ...values: unknown[]): Promise<readonly { total: bigint }[]>;
    $disconnect(): Promise<void>;
  };
  return {
    async count(table: string, column: string, value: string): Promise<number> {
      const rows = await raw.$queryRawUnsafe(
        `SELECT COUNT(*)::bigint AS total FROM "${table}" WHERE "${column}" = $1::uuid`,
        value,
      );
      return Number(rows[0]?.total ?? 0n);
    },
    close: () => raw.$disconnect(),
  };
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

function turnOf(turnId: string, threadId: string, sequence: number, overrides: Partial<Turn> = {}): Turn {
  return Object.freeze({
    turnId: asConversationsIdentifier<TurnId>(turnId),
    threadId: asConversationsIdentifier<ThreadId>(threadId),
    parentTurnId: null,
    agentVersionId: asConversationsIdentifier<AgentVersionId>(chain.agentVersionId),
    versionBucket: "CURRENT" as const,
    sequence,
    inputText: "hello",
    outputText: null,
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
    ...overrides,
  });
}

function stepOf(stepId: string, turnId: string, sequence: number, overrides: Partial<Step> = {}): Step {
  const rate = (usdPerToken: string) => ({
    usdPerToken,
    source: RATE_SOURCE,
    observedAt: RATE_OBSERVED_AT,
    // NOT NULL, and that is `ModelPrice_rate_check` reaching through
    // `Step_price_snapshot`; see `RATE_SOURCE_REF` in the harness.
    sourceRef: RATE_SOURCE_REF,
  });
  return Object.freeze({
    stepId: asConversationsIdentifier<StepId>(stepId),
    turnId: asConversationsIdentifier<TurnId>(turnId),
    sequence,
    model: "anthropic:claude-test",
    status: "SUCCEEDED" as const,
    retryCount: 0,
    usage: Object.freeze({
      inputTokens: 1_000,
      outputTokens: 200,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningTokens: 0,
    }),
    cost: money(4_500_000n),
    modelPriceId: asConversationsIdentifier<ModelPriceId>(chain.modelPriceId),
    rates: Object.freeze({
      input: rate(CONFORMANCE_RATES.input),
      output: rate(CONFORMANCE_RATES.output),
      cacheRead: rate(CONFORMANCE_RATES.cacheRead),
      cacheWrite: rate(CONFORMANCE_RATES.cacheWrite),
    }),
    latencyMs: 1_000,
    error: null,
    startedAt: AT,
    completedAt: AT,
    createdAt: AT,
    ...overrides,
  });
}

function executionOf(tail: string, overrides: Partial<PostmanExecution> = {}): PostmanExecution {
  return Object.freeze({
    executionId: asConversationsIdentifier<PostmanExecutionId>(uuid(`8${tail}`)),
    agentId: asConversationsIdentifier<AgentId>(chain.agentId),
    templateId: null,
    requestId: uuid(`9${tail}`),
    requestFingerprint: "e".repeat(64),
    actorUserId: asConversationsIdentifier<ActorId>(chain.actorUserId),
    simulatedEndUserId: asConversationsIdentifier<EndUserId>(chain.endUserId),
    contextHandle: asConversationsIdentifier<PostmanContextHandle>(uuid(`a${tail}`)),
    contextExpiresAt: AT,
    status: "PENDING" as const,
    threadId: null,
    turnId: null,
    completedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

beforeAll(async () => {
  harness = await startConversationsHarness();
  scope = await harness.freshScope();
  chain = await harness.seedChain(scope);
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

describe("a settlement is atomic, and the second write is the one that fails", () => {
  test("a step that violates its own CHECK takes the turn's update with it", async () => {
    const threadId = uuid("1");
    const turnId = uuid("11");
    expect((await harness.stores.threads.createThread(scope, threadOf(threadId))).ok).toBe(true);
    expect(
      (await harness.stores.turns.createTurn(scope, turnOf(turnId, threadId, 1, { status: "PENDING" })))
        .ok,
    ).toBe(true);

    // THE INJECTION. The first step is fine and the SECOND names a `ModelPrice`
    // whose rates it does not carry, so `Step_price_snapshot` refuses it AFTER
    // the turn's own UPDATE has already run inside the same transaction. The
    // guard cannot see this one: the mismatch is between the row and a card in
    // another table, which is why the failure lands at the statement rather than
    // before it.
    const settlement = await harness.stores.turns.saveSettlement(scope, {
      turn: turnOf(turnId, threadId, 1, { outputText: "thirty days", latencyMs: 10 }),
      steps: [
        stepOf(uuid("21"), turnId, 1),
        stepOf(uuid("22"), turnId, 2, {
          rates: Object.freeze({
            input: {
              usdPerToken: "0.000009000000",
              source: RATE_SOURCE,
              observedAt: RATE_OBSERVED_AT,
              sourceRef: RATE_SOURCE_REF,
            },
            output: {
              usdPerToken: CONFORMANCE_RATES.output,
              source: RATE_SOURCE,
              observedAt: RATE_OBSERVED_AT,
              sourceRef: RATE_SOURCE_REF,
            },
            cacheRead: {
              usdPerToken: CONFORMANCE_RATES.cacheRead,
              source: RATE_SOURCE,
              observedAt: RATE_OBSERVED_AT,
              sourceRef: RATE_SOURCE_REF,
            },
            cacheWrite: {
              usdPerToken: CONFORMANCE_RATES.cacheWrite,
              source: RATE_SOURCE,
              observedAt: RATE_OBSERVED_AT,
              sourceRef: RATE_SOURCE_REF,
            },
          }),
        }),
      ],
    });
    expect(settlement.ok).toBe(false);

    const observer = await openObserver();
    try {
      // NEITHER HALF SURVIVED. Zero steps is the obvious half; the turn still
      // being PENDING is the half a store that committed the update would fail.
      expect(await observer.count("Step", "turnId", turnId)).toBe(0);
      const turn = await harness.stores.turns.findTurn(
        scope,
        asConversationsIdentifier<TurnId>(turnId),
      );
      expect(turn.ok && turn.value?.status).toBe("PENDING");
      expect(turn.ok && turn.value?.outputText).toBeNull();
    } finally {
      await observer.close();
    }
  }, 120_000);

  test("a settlement that SUCCEEDS is visible on the other connection", async () => {
    // THE CONTROL. Without it the case above is satisfied by a store that never
    // writes anything at all, which is the vacuity a failure-injection suite is
    // most likely to acquire.
    const threadId = uuid("2");
    const turnId = uuid("12");
    expect((await harness.stores.threads.createThread(scope, threadOf(threadId))).ok).toBe(true);
    expect(
      (await harness.stores.turns.createTurn(scope, turnOf(turnId, threadId, 1, { status: "PENDING" })))
        .ok,
    ).toBe(true);
    const settled = await harness.stores.turns.saveSettlement(scope, {
      turn: turnOf(turnId, threadId, 1, { outputText: "thirty days", latencyMs: 10 }),
      steps: [stepOf(uuid("23"), turnId, 1), stepOf(uuid("24"), turnId, 2)],
    });
    expect(settled.ok).toBe(true);

    const observer = await openObserver();
    try {
      expect(await observer.count("Step", "turnId", turnId)).toBe(2);
    } finally {
      await observer.close();
    }
  }, 120_000);
});

describe("the erasure's two halves commit together or not at all", () => {
  test("a failure after the anonymise leaves the executions un-stripped", async () => {
    const threadId = uuid("3");
    expect((await harness.stores.threads.createThread(scope, threadOf(threadId))).ok).toBe(true);
    expect((await harness.stores.postman.createExecution(scope, executionOf("1"))).ok).toBe(true);

    // THE INJECTION. `privacy` owns the transaction, so the failure is thrown
    // from the caller's own callback AFTER the store's two writes have run —
    // which is exactly the shape of a legal-hold check that ran too late, or of
    // a sibling target refusing inside the same unit of work.
    await expect(
      harness.base.adapter.unitOfWork.run(async (transaction: TransactionScope) => {
        const stripped = await harness.stores.conversationsErasure.anonymizeExecutionsForEndUser(
          asConversationsIdentifier<EndUserId>(chain.endUserId),
          scope.organizationId,
          transaction,
        );
        expect(stripped.ok).toBe(true);
        const deleted = await harness.stores.conversationsErasure.deleteThreadsForEndUser(
          asConversationsIdentifier<EndUserId>(chain.endUserId),
          scope.organizationId,
          transaction,
        );
        expect(deleted.ok).toBe(true);
        throw new Error("a sibling erasure target refused");
      }),
    ).rejects.toThrow("a sibling erasure target refused");

    // BOTH HALVES CAME BACK. The thread is there and the execution still names
    // the subject; a store whose two writes were two transactions would have
    // left the audit trail stripped and the words behind.
    const observer = await openObserver();
    try {
      expect(await observer.count("Thread", "id", threadId)).toBe(1);
      expect(await observer.count("PostmanExecution", "simulatedEndUserId", chain.endUserId)).toBe(1);
    } finally {
      await observer.close();
    }
  }, 120_000);

  test("and the same pair, committed, is durable on the other connection", async () => {
    await harness.base.adapter.unitOfWork.run(async (transaction: TransactionScope) => {
      await harness.stores.conversationsErasure.anonymizeExecutionsForEndUser(
        asConversationsIdentifier<EndUserId>(chain.endUserId),
        scope.organizationId,
        transaction,
      );
      await harness.stores.conversationsErasure.deleteThreadsForEndUser(
        asConversationsIdentifier<EndUserId>(chain.endUserId),
        scope.organizationId,
        transaction,
      );
    });
    const observer = await openObserver();
    try {
      expect(await observer.count("Thread", "id", uuid("3"))).toBe(0);
      expect(await observer.count("PostmanExecution", "simulatedEndUserId", chain.endUserId)).toBe(0);
      // THE AUDIT ROW ITSELF SURVIVED, stripped. Anonymise is not delete, and a
      // store that had deleted it would satisfy the count above just as well.
      expect(await observer.count("PostmanExecution", "actorUserId", chain.actorUserId)).toBe(1);
    } finally {
      await observer.close();
    }
  }, 120_000);
});

describe("the three transaction-scope refusals, each with its own code", () => {
  test("a write with no transaction open is `not_open`", async () => {
    const refused = await harness.stores.conversationsErasure.deleteThreadsForEndUser(
      asConversationsIdentifier<EndUserId>(chain.endUserId),
      scope.organizationId,
      { transactionId: "pg-txn-never" } as unknown as TransactionScope,
    ).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(TransactionScopeError);
    expect((refused as TransactionScopeError).code).toBe(TRANSACTION_NOT_OPEN);
  });

  test("a write inside a transaction, carrying a FINISHED token, is `scope_unknown`", async () => {
    const stale = await harness.base.adapter.unitOfWork.run(
      async (transaction: TransactionScope) => transaction,
    );
    const refused = await runResult(
      harness.base.adapter.unitOfWork,
      async () =>
        harness.stores.conversationsErasure.deleteThreadsForEndUser(
          asConversationsIdentifier<EndUserId>(chain.endUserId),
          scope.organizationId,
          stale,
        ),
      )
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(TransactionScopeError);
    expect((refused as TransactionScopeError).code).toBe(TRANSACTION_SCOPE_UNKNOWN);
  });

  test("a write carrying ANOTHER LIVE transaction's token is `scope_foreign`", async () => {
    // TWO OPEN AT ONCE, which is the only way this third code can be reached and
    // the reason it is a third code: `scope_unknown` says the transaction is
    // over, this says it is somebody else's. A single shared code would make the
    // two indistinguishable in a log.
    //
    // THE CONCURRENT TRANSACTION IS OPENED OUTSIDE THIS ASYNC CONTEXT and parked
    // on a gate, and that is not a stylistic choice. `UnitOfWork.run` JOINS an
    // open transaction rather than opening a second one — the kernel port says
    // so and it is what keeps a composed use case atomic — so a nested `run`
    // would hand back the OUTER token and there would be nothing foreign about
    // it. The first draft of this case did exactly that and observed no refusal
    // at all. The token below is in `open` when the write is issued, so only the
    // identity check can refuse it, which is precisely what separates
    // `scope_foreign` from `scope_unknown`.
    let release = (): void => undefined;
    const gate = new Promise<void>((settle) => {
      release = settle;
    });
    let concurrent: TransactionScope | undefined;
    const held = new Promise<void>((ready) => {
      void harness.base.adapter.unitOfWork.run(async (transaction: TransactionScope) => {
        concurrent = transaction;
        ready();
        await gate;
      });
    });
    await held;
    const other = concurrent as TransactionScope;

    let refused: unknown;
    await harness.base.adapter.unitOfWork.run(async (live: TransactionScope) => {
      expect(other.transactionId).not.toBe(live.transactionId);
      refused = await harness.stores.conversationsErasure
        .deleteThreadsForEndUser(
          asConversationsIdentifier<EndUserId>(chain.endUserId),
          scope.organizationId,
          other,
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );
    });
    release();

    expect(refused).toBeInstanceOf(TransactionScopeError);
    expect((refused as TransactionScopeError).code).toBe(TRANSACTION_SCOPE_FOREIGN);
  }, 120_000);
});

describe("the sequence allocation is serialised by a real row lock", () => {
  test("a second allocator waits for the first transaction to finish", async () => {
    const threadId = uuid("4");
    expect((await harness.stores.threads.createThread(scope, threadOf(threadId))).ok).toBe(true);
    const thread = asConversationsIdentifier<ThreadId>(threadId);

    // THE FIRST TRANSACTION TAKES THE LOCK AND HOLDS IT while the second one
    // asks for the same thread. If `FOR UPDATE` were not there, the second
    // allocation would return the same number as the first — which is precisely
    // the `@@unique([threadId, sequence])` violation the lock exists to stop.
    const order: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = runResult(harness.base.adapter.unitOfWork, async () => {
      const allocated = await harness.stores.threads.allocateTurnSequence(scope, thread);
      order.push("first-allocated");
      // The turn is inserted INSIDE the same transaction, so the second
      // allocator — once it is let through — sees it and answers 2.
      await harness.stores.turns.createTurn(scope, turnOf(uuid("13"), threadId, 1));
      await held;
      order.push("first-committed");
      return allocated;
    });

    // Let the first allocator take the lock before the second one asks.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const second = runResult(harness.base.adapter.unitOfWork, async () => {
      const allocated = await harness.stores.threads.allocateTurnSequence(scope, thread);
      order.push("second-allocated");
      return allocated;
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    // STILL BLOCKED. This is the assertion the whole case is for: the second
    // allocator has been asking for a quarter of a second and has not been
    // answered, because the first transaction holds the row.
    expect(order).toEqual(["first-allocated"]);

    release();
    expect(await first).toEqual({ ok: true, value: 1 });
    expect(await second).toEqual({ ok: true, value: 2 });
    expect(order).toEqual(["first-allocated", "first-committed", "second-allocated"]);
  }, 120_000);
});
