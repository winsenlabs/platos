// The TENANT BOUNDARY, and the three rules that freeze a row once it exists.
//
// SPLIT OUT OF `conversations-rules.integration.test.ts` BECAUSE `max-file-lines`
// BIT AT THE HARD ERROR, and the seam it pointed at is real: that file is about
// what happens when rows are DESTROYED, and this one is about what a caller may
// not reach and may not change. Both are behaviour no write guard restates and
// the in-memory double cannot see.
//
// ---------------------------------------------------------------------------
// THE SCOPE PREDICATE IS THE ONLY THING BETWEEN TWO TENANTS
// ---------------------------------------------------------------------------
//
// None of these rows is protected by a database rule once a caller has an id:
// `Thread.id`, `Turn.id`, `PostmanExecution.id` and
// `PostmanExecution.contextHandle` are unique INSTALLATION-WIDE, so a store that
// dropped `environmentId` from a `where` would answer another tenant's row to
// whoever held the identifier — and the handle is a CAPABILITY, which is exactly
// the kind of string that gets handed around. `InMemoryConversations` takes the
// scope parameter on every method and ignores it, so this whole class of defect
// is structurally invisible to the conformance differential.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  asConversationsIdentifier,
  money,
  type EndUserId,
  type EnvironmentScope,
  type ModelPriceId,
  type ThreadId,
  type TurnId,
} from "@platos/context-conversations/application/ports/index.js";

import {
  AT,
  executionOf,
  fullRates,
  pricedStep,
  rawClient,
  refusedByDatabase,
  threadOf,
  turnOf,
} from "./conversations-fixtures.js";
import type { ConversationsHarness, PeerChain } from "./conversations-harness.js";
import {
  RATE_OBSERVED_AT,
  RATE_SOURCE_REF,
  startConversationsHarness,
} from "./conversations-harness.js";

let harness: ConversationsHarness;
let chain: PeerChain;
let scope: EnvironmentScope;

const uuid = (tail: string) => `c5000000-0000-4000-8000-${tail.padStart(12, "0")}`;
const executionIds = (tail: string) => ({
  executionId: uuid(`3${tail}`),
  requestId: uuid(`4${tail}`),
  contextHandle: uuid(`5${tail}`),
});

beforeAll(async () => {
  harness = await startConversationsHarness();
  scope = await harness.freshScope();
  chain = await harness.seedChain(scope);
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

describe("PostmanExecution's forensic attribution is immutable", () => {
  test("`actorUserId` cannot be severed — the port's own comment is unhonourable", async () => {
    // THE PORT SAYS "The same severing for an operator subject, on
    // `actorUserId`". THE DATABASE FORBIDS IT FOUR TIMES OVER: the column is NOT
    // NULL, its foreign key is `ON DELETE RESTRICT` to `User`,
    // `prevent_postman_execution_attribution_mutation` raises SQLSTATE 55000 on
    // any UPDATE that changes it, and `PostmanExecution_ancestry` joins
    // `"User" actor ON actor.id = NEW."actorUserId"` — which is the one that
    // fires FIRST on a null, and so the message a caller actually reads. There is
    // no value the store could write.
    //
    // The MECHANISM is settled elsewhere and agrees with the store:
    // `conversations-erasure-target.ts` says "the row is an audit trail and
    // deleting it would erase the record that an operator ran an agent … What
    // goes is the LINK", and `InMemoryConversations.anonymizeExecutionsForActor`
    // nulls `simulatedEndUserId`. Only the one sentence in the port comment is
    // wrong, and it is pinned here rather than quietly reconciled.
    const created = await harness.stores.postman.createExecution(
      scope,
      executionOf(chain, executionIds("1")),
    );
    expect(created.ok).toBe(true);

    const nulled = await refusedByDatabase(() =>
      rawClient(harness).$executeRawUnsafe(
        `UPDATE "PostmanExecution" SET "actorUserId" = NULL WHERE "id" = $1::uuid`,
        uuid("31"),
      ),
    );
    expect(nulled).toContain("PostmanExecution crosses its canonical owner ancestry");

    const moved = await refusedByDatabase(() =>
      rawClient(harness).$executeRawUnsafe(
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
      asConversationsIdentifier(uuid("31")),
    );
    expect(survivor.ok).toBe(true);
    if (!survivor.ok || survivor.value === null) throw new Error("the audit row was destroyed");
    // THE ROW SURVIVES, STRIPPED. Who ran it and against which agent is intact;
    // the link to the simulated subject is gone.
    expect(survivor.value.simulatedEndUserId).toBeNull();
    expect(survivor.value.actorUserId).toBe(chain.actorUserId);
  });

  test("`saveExecution` writes none of the seven frozen columns", async () => {
    // The store's update names EIGHT columns and the rule freezes SEVEN. A
    // caller handing back an execution with a different fingerprint gets the
    // STORED one, because the store never sends the column — proved here by
    // asking for a change the rule would have raised on.
    const settled = await harness.stores.postman.saveExecution(scope, {
      ...executionOf(chain, executionIds("1")),
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
        // rules would refuse. The store does not send those columns at all,
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
    // BOTH TARGETS ARE CHOSEN SO THAT `Thread_ancestry` PASSES, and that is the
    // whole care in this case. The second subject shares this ORGANIZATION and
    // the sibling thread shares this environment, agent and subject, so the
    // ancestry rule — which runs BEFORE the immutability rules and refuses
    // first when it can — has nothing to object to. What is left is
    // `Thread_subject_immutable` and `Thread_owner_immutable`, which is what this
    // case is about. Pointing either at a foreign row would have measured the
    // ancestry rule instead, and the first draft of this case did exactly that.
    const siblingId = uuid("52");
    expect((await harness.stores.threads.createThread(scope, threadOf(chain, siblingId))).ok).toBe(
      true,
    );
    for (const [column, value] of [
      ["endUserId", chain.secondEndUserId],
      ["parentThreadId", siblingId],
    ] as const) {
      const message = await refusedByDatabase(() =>
        rawClient(harness).$executeRawUnsafe(
          `UPDATE "Thread" SET "${column}" = $2::uuid WHERE "id" = $1::uuid`,
          uuid("51"),
          value,
        ),
      );
      expect(message).toContain("immutable");
      expect(message).toContain(column);
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
    // below has billing evidence to try to edit.
    const settled = await harness.stores.turns.saveSettlement(scope, {
      turn: turnOf(chain, turnId, threadId, 1),
      steps: [pricedStep(chain, uuid("64"), turnId)],
    });
    expect(settled.ok).toBe(true);

    const message = await refusedByDatabase(() =>
      rawClient(harness).$executeRawUnsafe(
        `INSERT INTO "Step" ("id", "turnId", "sequence", "model", "status", "costCents", "modelPriceId",
                            "inputRate", "outputRate", "cacheReadRate", "cacheWriteRate",
                            "inputRateSource", "outputRateSource", "cacheReadRateSource", "cacheWriteRateSource",
                            "inputRateObservedAt", "outputRateObservedAt", "cacheReadRateObservedAt",
                            "cacheWriteRateObservedAt",
                            "inputRateSourceRef", "outputRateSourceRef", "cacheReadRateSourceRef",
                            "cacheWriteRateSourceRef", "createdAt")
         VALUES ($1::uuid, $2::uuid, 2, 'anthropic:claude-test', 'SUCCEEDED', 4.5, $3::uuid,
                 0.000009000000, 0.000015000000, 0.000000300000, 0.000003750000,
                 'LITELLM', 'LITELLM', 'LITELLM', 'LITELLM',
                 $4, $4, $4, $4,
                 $5, $5, $5, $5, now())`,
        uuid("63"),
        turnId,
        chain.modelPriceId,
        RATE_OBSERVED_AT,
        RATE_SOURCE_REF,
      ),
    );
    // The INPUT RATE is three times the card's. A store that had gone through a
    // `Number` on the way in could drift in the twelfth decimal and be refused
    // here for a value that was right when the caller had it.
    expect(message).toContain("Step price snapshot does not match ModelPrice");
  });

  test("a settlement REPLACES its steps rather than updating them, which the rule requires", async () => {
    // `enforce_step_price_snapshot` raises "priced Step billing evidence is
    // immutable" on any UPDATE that changes a priced step's twenty-three billing
    // columns. The store deletes and re-inserts, so a settlement that supersedes
    // an earlier one is admitted while an in-place edit of a bill stays
    // impossible — proved by doing the edit the store does not do.
    const message = await refusedByDatabase(() =>
      rawClient(harness).$executeRawUnsafe(
        `UPDATE "Step" SET "costCents" = 9.0 WHERE "turnId" = $1::uuid AND "costCents" IS NOT NULL`,
        uuid("62"),
      ),
    );
    expect(message).toContain("priced Step billing evidence is immutable");
  });
});

describe("tenant isolation: every read and every write carries its scope", () => {
  test("a foreign thread, turn and execution are all invisible through this scope", async () => {
    const foreign = await harness.foreignChain();
    const foreignThreadId = uuid("71");
    const foreignTurnId = uuid("72");
    expect(
      (await harness.stores.threads.createThread(foreign.scope, threadOf(foreign, foreignThreadId)))
        .ok,
    ).toBe(true);
    expect(
      (
        await harness.stores.turns.createTurn(
          foreign.scope,
          turnOf(foreign, foreignTurnId, foreignThreadId, 1),
        )
      ).ok,
    ).toBe(true);
    const execution = executionOf(foreign, executionIds("7"));
    expect((await harness.stores.postman.createExecution(foreign.scope, execution)).ok).toBe(true);

    // THIS scope, THEIR identifiers. Every one answers null.
    expect(
      await harness.stores.threads.findThread(
        scope,
        asConversationsIdentifier<ThreadId>(foreignThreadId),
      ),
    ).toEqual({ ok: true, value: null });
    expect(
      await harness.stores.turns.findTurn(scope, asConversationsIdentifier<TurnId>(foreignTurnId)),
    ).toEqual({ ok: true, value: null });
    expect(await harness.stores.postman.findExecution(scope, execution.executionId)).toEqual({
      ok: true,
      value: null,
    });
    // THE HANDLE IS THE SHARPEST OF THE FOUR. `contextHandle` is `@unique`
    // installation-wide and is a CAPABILITY — whoever holds it can name that
    // execution — so a lookup without the environment in its WHERE is a
    // cross-tenant read for anyone who has ever been handed one.
    expect(await harness.stores.postman.findByHandle(scope, execution.contextHandle)).toEqual({
      ok: true,
      value: null,
    });

    const listed = await harness.stores.threads.pageThreads({
      scope,
      endUserId: asConversationsIdentifier<EndUserId>(foreign.endUserId),
      limit: 10,
      offset: 0,
      includeArchived: true,
    });
    expect(listed.ok && listed.value.total).toBe(0);
  });

  test("a saveThread addressed across the boundary writes nothing and says so", async () => {
    const foreign = await harness.foreignChain();
    const foreignThreadId = uuid("79");
    expect(
      (await harness.stores.threads.createThread(foreign.scope, threadOf(foreign, foreignThreadId)))
        .ok,
    ).toBe(true);

    const refused = await harness.stores.threads.saveThread(
      scope,
      threadOf(foreign, foreignThreadId, { title: "stolen" }),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_THREAD_NOT_FOUND");

    const untouched = await harness.stores.threads.findThread(
      foreign.scope,
      asConversationsIdentifier<ThreadId>(foreignThreadId),
    );
    expect(untouched.ok && untouched.value?.title).toBeNull();
  });

  test("a settlement addressed across the boundary writes nothing and says so", async () => {
    const foreign = await harness.foreignChain();
    const foreignThreadId = uuid("73");
    const foreignTurnId = uuid("74");
    expect(
      (await harness.stores.threads.createThread(foreign.scope, threadOf(foreign, foreignThreadId)))
        .ok,
    ).toBe(true);
    expect(
      (
        await harness.stores.turns.createTurn(
          foreign.scope,
          turnOf(foreign, foreignTurnId, foreignThreadId, 1),
        )
      ).ok,
    ).toBe(true);

    const refused = await harness.stores.turns.saveSettlement(scope, {
      turn: turnOf(foreign, foreignTurnId, foreignThreadId, 1, { outputText: "stolen" }),
      steps: [],
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    // `TURN_NOT_FOUND`, deliberately, and NOT the sequence-clash code: a caller
    // must not be able to tell "not yours" from "not there", and those are two
    // different mistakes with two different retries.
    expect(refused.error.code).toBe("CONVERSATIONS_TURN_NOT_FOUND");

    const untouched = await harness.stores.turns.findTurn(
      foreign.scope,
      asConversationsIdentifier<TurnId>(foreignTurnId),
    );
    expect(untouched.ok && untouched.value?.outputText).toBeNull();
  });

  test("a settlement REPLACES its steps, so a second one does not accumulate", async () => {
    const threadId = uuid("75");
    const turnId = uuid("76");
    expect((await harness.stores.threads.createThread(scope, threadOf(chain, threadId))).ok).toBe(
      true,
    );
    expect(
      (await harness.stores.turns.createTurn(scope, turnOf(chain, turnId, threadId, 1))).ok,
    ).toBe(true);

    for (const stepId of [uuid("77"), uuid("78")]) {
      const settled = await harness.stores.turns.saveSettlement(scope, {
        turn: turnOf(chain, turnId, threadId, 1),
        steps: [pricedStep(chain, stepId, turnId)],
      });
      expect(settled.ok).toBe(true);
    }

    const read = await harness.stores.turns.findTurnWithSteps(
      scope,
      asConversationsIdentifier<TurnId>(turnId),
    );
    expect(read.ok).toBe(true);
    if (!read.ok || read.value === null) throw new Error("the turn went missing");
    // ONE step, and it is the SECOND one. A store that merged would leave two
    // rows at the same `[turnId, sequence]` — which the unique index forbids —
    // or, worse, one row from a previous try inside a rollup it was never part
    // of. The turn's cost follows the surviving step and nothing else.
    expect(read.value.steps.map((step) => step.stepId)).toEqual([uuid("78")]);
    expect(read.value.turn.cost.stepCount).toBe(1);
    // AND THE ROLLUP IS THE SURVIVING STEP'S, which is the money half of the
    // same fact: a merged settlement would have doubled it.
    expect(read.value.turn.cost.amount.microCents).toBe(money(4_500_000n).microCents);
    expect(read.value.steps[0]?.modelPriceId).toBe(
      asConversationsIdentifier<ModelPriceId>(chain.modelPriceId),
    );
    expect(read.value.steps[0]?.rates.cacheWrite?.usdPerToken).toBe(
      fullRates().cacheWrite?.usdPerToken,
    );
  });
});
