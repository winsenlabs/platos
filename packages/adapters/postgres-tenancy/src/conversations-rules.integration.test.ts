// The rules the DATABASE keeps that no port method restates, and the four places
// the in-memory double is WRONG rather than different.
//
// `conversations-constraints.integration.test.ts` stands each write guard beside
// the CHECK it restates. This file is the other half: behaviour the store has to
// get right because a trigger or a foreign key will otherwise refuse it, and
// behaviour the conformance differential cannot see because the double would
// have to be wrong for it to.
//
// THE FOUR DOUBLE DIVERGENCES, EACH WITH ITS OWN SECTION BELOW:
//
//   `readTranscriptTurns` is documented as SUCCEEDED-only and
//   `InMemoryConversations` does not filter on status at all.
//
//   Every erasure method takes an `organizationId` and the double ignores it,
//   filtering on the subject alone — which is a cross-tenant erasure.
//
//   `deleteThreadsForEndUser` must delete a fork BEFORE its ancestor, because
//   `Thread_forkedUpToTurnId_fkey` is `ON DELETE RESTRICT`; the double deletes
//   from a `Map` and would agree with a store that got the order wrong.
//
//   `anonymizeExecutionsForActor`'s port comment says it severs `actorUserId`.
//   The database forbids that three ways over. The double does not do it either.

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
  type Turn,
  type TurnId,
} from "@platos/context-conversations/application/ports/index.js";

import type { ConversationsHarness, PeerChain } from "./conversations-harness.js";
import {
  CONFORMANCE_RATES,
  RATE_OBSERVED_AT,
  RATE_SOURCE,
  startConversationsHarness,
} from "./conversations-harness.js";

let harness: ConversationsHarness;
let chain: PeerChain;
let scope: EnvironmentScope;

const AT = new Date("2026-05-01T09:00:00.000Z");
const uuid = (tail: string) => `c2000000-0000-4000-8000-${tail.padStart(12, "0")}`;

function db(): { $executeRawUnsafe(text: string, ...values: unknown[]): Promise<number> } {
  return harness.base.client as unknown as {
    $executeRawUnsafe(text: string, ...values: unknown[]): Promise<number>;
  };
}

async function refusedByDatabase(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("the database accepted a write a rule forbids");
}

function threadOf(link: PeerChain, threadId: string, overrides: Partial<Thread> = {}): Thread {
  return Object.freeze({
    threadId: asConversationsIdentifier<ThreadId>(threadId),
    agentId: asConversationsIdentifier<AgentId>(link.agentId),
    endUserId: asConversationsIdentifier<EndUserId>(link.endUserId),
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

function turnOf(
  link: PeerChain,
  turnId: string,
  threadId: string,
  sequence: number,
  overrides: Partial<Turn> = {},
): Turn {
  return Object.freeze({
    turnId: asConversationsIdentifier<TurnId>(turnId),
    threadId: asConversationsIdentifier<ThreadId>(threadId),
    parentTurnId: null,
    agentVersionId: asConversationsIdentifier<AgentVersionId>(link.agentVersionId),
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

/** A settled, PRICED step, charged against the harness's own card. */
function pricedStep(link: PeerChain, stepId: string, turnId: string): Step {
  const rate = (usdPerToken: string) => ({
    usdPerToken,
    source: RATE_SOURCE,
    observedAt: RATE_OBSERVED_AT,
    sourceRef: null,
  });
  return Object.freeze({
    stepId: asConversationsIdentifier<StepId>(stepId),
    turnId: asConversationsIdentifier<TurnId>(turnId),
    sequence: 1,
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
    modelPriceId: asConversationsIdentifier<ModelPriceId>(link.modelPriceId),
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
  });
}

function executionOf(
  link: PeerChain,
  tail: string,
  overrides: Partial<PostmanExecution> = {},
): PostmanExecution {
  return Object.freeze({
    executionId: asConversationsIdentifier<PostmanExecutionId>(uuid(`3${tail}`)),
    agentId: asConversationsIdentifier<AgentId>(link.agentId),
    templateId: null,
    requestId: uuid(`4${tail}`),
    requestFingerprint: "c".repeat(64),
    actorUserId: asConversationsIdentifier<ActorId>(link.actorUserId),
    simulatedEndUserId: asConversationsIdentifier<EndUserId>(link.endUserId),
    contextHandle: asConversationsIdentifier<PostmanContextHandle>(uuid(`5${tail}`)),
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

describe("readTranscriptTurns is SUCCEEDED-only, and the double is not", () => {
  test("an unsettled turn is left out of the transcript", async () => {
    const threadId = uuid("1");
    expect((await harness.stores.threads.createThread(scope, threadOf(chain, threadId))).ok).toBe(
      true,
    );
    for (const [tail, sequence, status] of [
      ["11", 1, "SUCCEEDED"],
      ["12", 2, "FAILED"],
      ["13", 3, "SUCCEEDED"],
    ] as const) {
      const written = await harness.stores.turns.createTurn(
        scope,
        turnOf(chain, uuid(tail), threadId, sequence, { status }),
      );
      expect(written.ok).toBe(true);
    }

    const transcript = await harness.stores.turns.readTranscriptTurns(
      scope,
      asConversationsIdentifier<ThreadId>(threadId),
      0,
      10,
    );
    expect(transcript.ok).toBe(true);
    if (!transcript.ok) return;
    // TWO, NOT THREE. `InMemoryConversations.readTranscriptTurns` filters on the
    // thread and the sequence alone and would answer three; the port's own
    // sentence is "Every SUCCEEDED turn of a thread after `afterSequence`", and
    // a transcript carrying a failed turn replays a question the agent never
    // answered. This is the divergence the conformance scenario deliberately
    // does not seed, because seeding it would fail on the double's behaviour.
    expect(transcript.value.map((turn) => turn.sequence)).toEqual([1, 3]);
  });

  test("`afterSequence` and the limit are both honoured, ascending", async () => {
    const transcript = await harness.stores.turns.readTranscriptTurns(
      scope,
      asConversationsIdentifier<ThreadId>(uuid("1")),
      1,
      1,
    );
    expect(transcript.ok).toBe(true);
    if (!transcript.ok) return;
    expect(transcript.value.map((turn) => turn.sequence)).toEqual([3]);
  });
});

describe("the erasure is scoped to ONE organization, and the double is not", () => {
  test("a second tenant's identically-named subject is not counted or deleted", async () => {
    // THE DOUBLE IGNORES `organizationId` ENTIRELY. It filters on the subject
    // alone, which is safe in a fixture with one tenant and is the exact shape of
    // a cross-tenant erasure in a real installation. Neither `Thread` nor
    // `PostmanExecution` stores an organization, so the containment is a relation
    // filter through `Environment` and `Project`; a store that dropped it would
    // pass every case in the conformance run.
    const foreign = await harness.foreignChain();
    const foreignThreadId = uuid("21");
    expect(
      (await harness.stores.threads.createThread(foreign.scope, threadOf(foreign, foreignThreadId)))
        .ok,
    ).toBe(true);

    const census = await harness.stores.conversationsErasure.censusForEndUser(
      asConversationsIdentifier<EndUserId>(foreign.endUserId),
      // THE WRONG ORGANIZATION on purpose: the subject is real and the tenant is
      // somebody else's.
      scope.organizationId,
    );
    expect(census.ok).toBe(true);
    if (!census.ok) return;
    expect(census.value.threadCount).toBe(0);

    const deleted = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.conversationsErasure.deleteThreadsForEndUser(
        asConversationsIdentifier<EndUserId>(foreign.endUserId),
        scope.organizationId,
        transaction,
      ),
    );
    expect(deleted).toEqual({ ok: true, value: 0 });

    const survived = await harness.stores.threads.findThread(
      foreign.scope,
      asConversationsIdentifier<ThreadId>(foreignThreadId),
    );
    expect(survived.ok && survived.value !== null).toBe(true);
  });
});

describe("Thread_forkedUpToTurnId_fkey — a fork must be deleted before its ancestor", () => {
  test("a single unordered DELETE is refused by the database", async () => {
    // THE ONLY RESTRICTING FOREIGN KEY POINTING INTO ANY OF THIS CONTEXT'S FOUR
    // ROWS, and RESTRICT is not deferred: it refuses even when the referencing
    // row is being deleted in the SAME statement. This case sends exactly the
    // statement a naive implementation would.
    const ancestorId = uuid("31");
    const ancestorTurnId = uuid("32");
    const forkId = uuid("33");
    expect((await harness.stores.threads.createThread(scope, threadOf(chain, ancestorId))).ok).toBe(
      true,
    );
    expect(
      (await harness.stores.turns.createTurn(scope, turnOf(chain, ancestorTurnId, ancestorId, 1)))
        .ok,
    ).toBe(true);
    expect(
      (
        await harness.stores.threads.createThread(
          scope,
          threadOf(chain, forkId, {
            parentThreadId: asConversationsIdentifier<ThreadId>(ancestorId),
            forkedTurnIds: [asConversationsIdentifier<TurnId>(ancestorTurnId)],
            forkedUpToTurnId: asConversationsIdentifier<TurnId>(ancestorTurnId),
          }),
        )
      ).ok,
    ).toBe(true);

    const message = await refusedByDatabase(() =>
      db().$executeRawUnsafe(
        `DELETE FROM "Thread" WHERE "endUserId" = $1::uuid AND "environmentId" = $2::uuid`,
        chain.endUserId,
        scope.environmentId,
      ),
    );
    expect(message).toContain("Thread_forkedUpToTurnId_fkey");
  });

  test("and the link cannot be broken first, because the column is immutable", async () => {
    // `Thread_owner_immutable` lists `forkedUpToTurnId` among the columns
    // `reject_canonical_owner_change` refuses to let an UPDATE change, so the
    // obvious escape — null it, then delete — is refused by a SECOND rule. The
    // ordered delete is the only remaining option, which is why the store does it.
    const message = await refusedByDatabase(() =>
      db().$executeRawUnsafe(
        `UPDATE "Thread" SET "forkedUpToTurnId" = NULL WHERE "id" = $1::uuid`,
        uuid("33"),
      ),
    );
    expect(message).toContain("forkedUpToTurnId");
    expect(message).toContain("immutable");
  });

  test("the store's ordered delete removes the whole lineage", async () => {
    const deleted = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.conversationsErasure.deleteThreadsForEndUser(
        asConversationsIdentifier<EndUserId>(chain.endUserId),
        scope.organizationId,
        transaction,
      ),
    );
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    // THREE: the ancestor, the fork, and the thread the transcript cases seeded.
    // The count comes from the deletes rather than from the plan, so a walk that
    // missed a thread would report fewer rather than claim the plan's number.
    expect(deleted.value).toBe(3);

    const census = await harness.stores.conversationsErasure.censusForEndUser(
      asConversationsIdentifier<EndUserId>(chain.endUserId),
      scope.organizationId,
    );
    expect(census.ok).toBe(true);
    if (!census.ok) return;
    // THE CASCADE WENT WITH IT. `Turn.thread` is `onDelete: Cascade`, so the
    // subject's turns are gone too — which is what makes deleting the thread an
    // erasure of what the subject SAID rather than of the envelope round it.
    expect(census.value).toEqual({
      threadCount: 0,
      turnCount: 0,
      stepCount: 0,
      postmanExecutionCount: 0,
    });
  });
});

describe("findHeldThreads names what the database would refuse, and nothing else", () => {
  test("an ancestor whose fork is INSIDE the erasure is not reported as held", async () => {
    // THE CLAUSE THAT MATTERS is "and that other thread is NOT itself in this
    // erasure". Without it every ancestor of a fork would be named and every plan
    // for a subject who forked would report a block that does not exist. This
    // seeds a real fork and pins the EMPTY answer.
    const ancestorId = uuid("41");
    const ancestorTurnId = uuid("42");
    const forkId = uuid("43");
    expect((await harness.stores.threads.createThread(scope, threadOf(chain, ancestorId))).ok).toBe(
      true,
    );
    expect(
      (await harness.stores.turns.createTurn(scope, turnOf(chain, ancestorTurnId, ancestorId, 1)))
        .ok,
    ).toBe(true);
    expect(
      (
        await harness.stores.threads.createThread(
          scope,
          threadOf(chain, forkId, {
            parentThreadId: asConversationsIdentifier<ThreadId>(ancestorId),
            forkedTurnIds: [asConversationsIdentifier<TurnId>(ancestorTurnId)],
            forkedUpToTurnId: asConversationsIdentifier<TurnId>(ancestorTurnId),
          }),
        )
      ).ok,
    ).toBe(true);

    const held = await harness.stores.conversationsErasure.findHeldThreads(
      asConversationsIdentifier<EndUserId>(chain.endUserId),
      scope.organizationId,
    );
    expect(held).toEqual({ ok: true, value: [] });
  });

  test("`enforce_domain_ancestry` is what makes that set provably empty", async () => {
    // A FORK BELONGING TO ANOTHER SUBJECT IS THE ONLY WAY TO POPULATE IT, and
    // the Thread branch of `enforce_domain_ancestry` refuses one: it requires
    // `parent."endUserId" = u.id`, where `u` is the NEW row's own end user. So
    // this store's answer is a live check of an invariant a trigger maintains
    // rather than a stub — if a migration relaxed the rule, the query would start
    // naming threads and the plan would start reporting a block.
    const foreign = await harness.foreignChain();
    const message = await refusedByDatabase(() =>
      db().$executeRawUnsafe(
        `INSERT INTO "Thread" ("id", "environmentId", "agentId", "endUserId", "status",
                              "parentThreadId", "forkedTurnIds", "forkedUpToTurnId", "createdAt", "updatedAt")
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ACTIVE', $5::uuid,
                 ARRAY[$6::uuid], $6::uuid, now(), now())`,
        uuid("44"),
        scope.environmentId,
        chain.agentId,
        foreign.endUserId,
        uuid("41"),
        uuid("42"),
      ),
    );
    expect(message).toContain("Thread crosses its canonical owner ancestry");
  });
});

describe("PostmanExecution's forensic attribution is immutable", () => {
  test("`actorUserId` cannot be severed — the port's own comment is unhonourable", async () => {
    // THE PORT SAYS "The same severing for an operator subject, on
    // `actorUserId`". THE DATABASE FORBIDS IT THREE TIMES OVER: the column is NOT
    // NULL, its foreign key is `ON DELETE RESTRICT` to `User`, and
    // `prevent_postman_execution_attribution_mutation` raises SQLSTATE 55000 on
    // any UPDATE that changes it. There is no value the store could write.
    //
    // The MECHANISM is settled elsewhere and agrees with the store:
    // `conversations-erasure-target.ts` says "the row is an audit trail and
    // deleting it would erase the record that an operator ran an agent … What
    // goes is the LINK", and `InMemoryConversations.anonymizeExecutionsForActor`
    // nulls `simulatedEndUserId`. Only the one sentence in the port comment is
    // wrong, and it is pinned here rather than quietly reconciled.
    const created = await harness.stores.postman.createExecution(scope, executionOf(chain, "1"));
    expect(created.ok).toBe(true);

    const nulled = await refusedByDatabase(() =>
      db().$executeRawUnsafe(
        `UPDATE "PostmanExecution" SET "actorUserId" = NULL WHERE "id" = $1::uuid`,
        uuid("31"),
      ),
    );
    expect(nulled.toLowerCase()).toContain("null");

    const moved = await refusedByDatabase(() =>
      db().$executeRawUnsafe(
        `UPDATE "PostmanExecution" SET "actorUserId" = $2::uuid WHERE "id" = $1::uuid`,
        uuid("31"),
        "22222222-2222-4222-8222-222222222222",
      ),
    );
    expect(moved).toContain("PostmanExecution forensic attribution is immutable");
  });

  test("what the store DOES sever is the simulated end user, and it counts the rows", async () => {
    const stripped = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.conversationsErasure.anonymizeExecutionsForActor(
        chain.actorUserId,
        scope.organizationId,
        transaction,
      ),
    );
    expect(stripped.ok).toBe(true);
    if (!stripped.ok) return;
    expect(stripped.value).toBeGreaterThanOrEqual(1);

    const survivor = await harness.stores.postman.findExecution(
      scope,
      asConversationsIdentifier<PostmanExecutionId>(uuid("31")),
    );
    expect(survivor.ok).toBe(true);
    if (!survivor.ok || survivor.value === null) throw new Error("the audit row was destroyed");
    // THE ROW SURVIVES, STRIPPED. Who ran it and against which agent is intact;
    // the link to the simulated subject is gone.
    expect(survivor.value.simulatedEndUserId).toBeNull();
    expect(survivor.value.actorUserId).toBe(chain.actorUserId);
  });

  test("`saveExecution` writes none of the seven frozen columns", async () => {
    // The store's update names EIGHT columns and the trigger freezes SEVEN. A
    // caller handing back an execution with a different fingerprint gets the
    // STORED one, because the store never sends the column — proved here by
    // asking for a change the trigger would have raised on.
    const settled = await harness.stores.postman.saveExecution(scope, {
      ...executionOf(chain, "1"),
      requestFingerprint: "d".repeat(64),
      status: "SUCCEEDED" as const,
      completedAt: AT,
      updatedAt: AT,
    });
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.value.status).toBe("SUCCEEDED");
    expect(settled.value.requestFingerprint).toBe("c".repeat(64));
  });
});

describe("Thread_owner_immutable and Thread_subject_immutable", () => {
  test("`saveThread` writes neither the environment, the lineage nor the subject", async () => {
    const threadId = uuid("51");
    expect((await harness.stores.threads.createThread(scope, threadOf(chain, threadId))).ok).toBe(
      true,
    );
    const foreign = await harness.foreignChain();
    const saved = await harness.stores.threads.saveThread(
      scope,
      threadOf(chain, threadId, {
        // A DIFFERENT SUBJECT AND A DIFFERENT LINEAGE, both of which the two
        // triggers would refuse. The store does not send those columns at all,
        // so the write succeeds and the stored row is unchanged in both.
        endUserId: asConversationsIdentifier<EndUserId>(foreign.endUserId),
        parentThreadId: asConversationsIdentifier<ThreadId>(uuid("41")),
        title: "renamed",
        updatedAt: new Date(AT.getTime() + 1_000),
      }),
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value.endUserId).toBe(chain.endUserId);
    expect(saved.value.parentThreadId).toBeNull();
    expect(saved.value.title).toBe("renamed");
  });

  test("the database refuses the same two writes when they are sent", async () => {
    for (const [column, value] of [
      ["endUserId", (await harness.foreignChain()).endUserId],
      ["parentThreadId", uuid("41")],
    ] as const) {
      const message = await refusedByDatabase(() =>
        db().$executeRawUnsafe(
          `UPDATE "Thread" SET "${column}" = $2::uuid WHERE "id" = $1::uuid`,
          uuid("51"),
          value,
        ),
      );
      expect(message).toContain("immutable");
    }
  });
});

describe("Step_price_snapshot — a priced step's billing evidence is immutable", () => {
  test("the rates must match the ModelPrice row exactly", async () => {
    const threadId = uuid("61");
    const turnId = uuid("62");
    expect((await harness.stores.threads.createThread(scope, threadOf(chain, threadId))).ok).toBe(
      true,
    );
    expect(
      (await harness.stores.turns.createTurn(scope, turnOf(chain, turnId, threadId, 1))).ok,
    ).toBe(true);
    // A REAL PRICED STEP, written through the port, so the immutability case
    // below has billing evidence to try to edit. It is written here rather than
    // in its own `beforeAll` because the rate-mismatch refusal that follows must
    // be sent against the SAME card this step was charged at.
    const settled = await harness.stores.turns.saveSettlement(scope, {
      turn: turnOf(chain, turnId, threadId, 1),
      steps: [pricedStep(chain, uuid("64"), turnId)],
    });
    expect(settled.ok).toBe(true);

    const message = await refusedByDatabase(() =>
      db().$executeRawUnsafe(
        `INSERT INTO "Step" ("id", "turnId", "sequence", "model", "status", "costCents", "modelPriceId",
                            "inputRate", "outputRate", "cacheReadRate", "cacheWriteRate",
                            "inputRateSource", "outputRateSource", "cacheReadRateSource", "cacheWriteRateSource",
                            "inputRateObservedAt", "outputRateObservedAt", "cacheReadRateObservedAt",
                            "cacheWriteRateObservedAt", "createdAt")
         VALUES ($1::uuid, $2::uuid, 1, 'anthropic:claude-test', 'SUCCEEDED', 4.5, $3::uuid,
                 0.000009000000, 0.000015000000, 0.000000300000, 0.000003750000,
                 'LITELLM', 'LITELLM', 'LITELLM', 'LITELLM',
                 now(), now(), now(), now())`,
        uuid("63"),
        turnId,
        chain.modelPriceId,
      ),
    );
    // The INPUT RATE is three times the card's. A store that had gone through a
    // `Number` on the way in could drift in the twelfth decimal and be refused
    // here for a value that was right when the caller had it.
    expect(message).toContain("Step price snapshot does not match ModelPrice");
  });

  test("a settlement REPLACES its steps rather than updating them, which the trigger requires", async () => {
    // `enforce_step_price_snapshot` raises "priced Step billing evidence is
    // immutable" on any UPDATE that changes a priced step's twenty-three billing
    // columns. The store deletes and re-inserts, so a settlement that supersedes
    // an earlier one is admitted while an in-place edit of a bill stays
    // impossible — proved by doing the edit the store does not do.
    const message = await refusedByDatabase(() =>
      db().$executeRawUnsafe(
        `UPDATE "Step" SET "costCents" = 9.0 WHERE "turnId" = $1::uuid AND "costCents" IS NOT NULL`,
        uuid("62"),
      ),
    );
    expect(message).toContain("priced Step billing evidence is immutable");
  });
});
