// The rules the DATABASE keeps around an ERASURE, and the three places the
// in-memory double is WRONG rather than different.
//
// `conversations-constraints.integration.test.ts` stands each write guard beside
// the CHECK it restates, and `conversations-isolation.integration.test.ts`
// carries the immutability triggers and the tenant boundary. This file is about
// what happens when rows are DESTROYED — which is where the real database
// contradicted this store twice — and about the one read whose contract the
// double does not implement.
//
// THE THREE DOUBLE DIVERGENCES HERE:
//
//   `readTranscriptTurns` is documented as SUCCEEDED-only and
//   `InMemoryConversations` does not filter on status at all.
//
//   Every erasure method takes an `organizationId` and the double ignores it,
//   filtering on the subject alone — which is a cross-tenant erasure.
//
//   The deletion order and the `SetNull` cascades are referential integrity the
//   double does not have: it deletes from a `Map`.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  asConversationsIdentifier,
  type EndUserId,
  type EnvironmentScope,
  type ThreadId,
  type TurnId,
} from "@platos/context-conversations/application/ports/index.js";

import {
  executionOf,
  rawClient,
  refusedByDatabase,
  threadOf,
  turnOf,
} from "./conversations-fixtures.js";
import type { ConversationsHarness, PeerChain } from "./conversations-harness.js";
import { startConversationsHarness } from "./conversations-harness.js";

let harness: ConversationsHarness;
let chain: PeerChain;
let scope: EnvironmentScope;

const uuid = (tail: string) => `c2000000-0000-4000-8000-${tail.padStart(12, "0")}`;
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

  test("censusForActor is scoped to ONE organization too", async () => {
    // MEASURED BEFORE AND AFTER, because the actor is genuinely the same `User`
    // in both tenants — the shared fixture seeds one operator and
    // `PostmanExecution_ancestry` does not scope the actor at all, which is
    // exactly what makes this predicate load-bearing rather than incidental.
    const foreign = await harness.foreignChain();
    const before = await harness.stores.conversationsErasure.censusForActor(
      foreign.actorUserId,
      scope.organizationId,
    );
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    expect(
      (await harness.stores.postman.createExecution(foreign.scope, executionOf(foreign, executionIds("8"))))
        .ok,
    ).toBe(true);

    const after = await harness.stores.conversationsErasure.censusForActor(
      foreign.actorUserId,
      scope.organizationId,
    );
    const there = await harness.stores.conversationsErasure.censusForActor(
      foreign.actorUserId,
      foreign.scope.organizationId,
    );
    expect(there.ok && there.value.postmanExecutionCount).toBe(1);
    // THIS organization's count is UNMOVED by a row written in another one.
    expect(after.ok && after.value.postmanExecutionCount).toBe(before.value.postmanExecutionCount);
  });
});

describe("Thread_forkedUpToTurnId_fkey blocks a LOOP and not a single statement", () => {
  test("deleting the ancestor ALONE is refused while its fork is still there", async () => {
    // TWO RULES STAND BETWEEN A PER-THREAD DELETE AND SUCCESS, and the one a
    // caller MEETS is not the one the column names suggest.
    //
    // `Thread.parentThreadId` is `onDelete: SetNull`, so deleting the ancestor
    // makes PostgreSQL UPDATE the fork's `parentThreadId` to NULL — and
    // `Thread_ancestry` fires BEFORE UPDATE, where its lineage clause requires a
    // parent to exist whenever `forkedTurnIds` is non-empty. That refusal
    // arrives FIRST, with `Thread crosses its canonical owner ancestry`.
    // `Thread_forkedUpToTurnId_fkey`'s RESTRICT is behind it, waiting for the
    // cascade to reach `Turn`.
    //
    // Either way a per-thread loop fails on the first ancestor it reaches — and
    // a per-thread loop is what the first draft of this store used. The case
    // below it shows the single statement is admitted.
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
      rawClient(harness).$executeRawUnsafe(
        `DELETE FROM "Thread" WHERE "id" = $1::uuid`,
        ancestorId,
      ),
    );
    expect(message).toContain("Thread crosses its canonical owner ancestry");
  });

  test("and the link cannot be broken first: two rules refuse the nulling", async () => {
    // THE OBVIOUS ESCAPE — null the boundary, then delete — is refused twice
    // over. `Thread_owner_immutable` lists `forkedUpToTurnId` among the four
    // columns `reject_canonical_owner_change` freezes, and `Thread_ancestry`
    // ALSO refuses the row, because its lineage clause requires the boundary and
    // the array to be empty together and `forkedTurnIds` still names a turn. The
    // ancestry rule fires first, so it is its message a caller reads — which is
    // exactly the sort of thing only a run against the real database says.
    const message = await refusedByDatabase(() =>
      rawClient(harness).$executeRawUnsafe(
        `UPDATE "Thread" SET "forkedUpToTurnId" = NULL WHERE "id" = $1::uuid`,
        uuid("33"),
      ),
    );
    expect(message).toContain("Thread crosses its canonical owner ancestry");
  });

  test("the store's SINGLE delete removes the whole lineage", async () => {
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
    // ONE statement took all three, ancestor and fork together — which is the
    // half of the finding the case above cannot show: PostgreSQL removes every
    // `Thread` row the statement names before the cascade reaches `Turn`, so by
    // the time the RESTRICT is checked nothing references the boundary turn.
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
      rawClient(harness).$executeRawUnsafe(
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

  test("measureForkDepth counts EVERY ancestor, not the nearest", async () => {
    // A CHAIN OF THREE, so the deepest answers 2 and the nearest would answer 1.
    // The first mutation sweep found `MAX(depth)` unfalsifiable because every
    // earlier case measured a ROOT thread, where the maximum and the minimum are
    // both zero.
    const rootId = uuid("81");
    const rootTurnId = uuid("82");
    expect((await harness.stores.threads.createThread(scope, threadOf(chain, rootId))).ok).toBe(
      true,
    );
    expect(
      (await harness.stores.turns.createTurn(scope, turnOf(chain, rootTurnId, rootId, 1))).ok,
    ).toBe(true);

    let parentId = rootId;
    for (const forkId of [uuid("83"), uuid("84")]) {
      const written = await harness.stores.threads.createThread(
        scope,
        threadOf(chain, forkId, {
          parentThreadId: asConversationsIdentifier<ThreadId>(parentId),
          forkedTurnIds: [asConversationsIdentifier<TurnId>(rootTurnId)],
          forkedUpToTurnId: asConversationsIdentifier<TurnId>(rootTurnId),
        }),
      );
      expect(written.ok).toBe(true);
      parentId = forkId;
    }

    expect(
      await harness.stores.threads.measureForkDepth(
        scope,
        asConversationsIdentifier<ThreadId>(uuid("84")),
      ),
    ).toEqual({ ok: true, value: 2 });
    expect(
      await harness.stores.threads.measureForkDepth(
        scope,
        asConversationsIdentifier<ThreadId>(rootId),
      ),
    ).toEqual({ ok: true, value: 0 });
  });

  test("findInheritedTurns answers in the CALLER'S order, not the database's", async () => {
    // DESCENDING, which is not the order a `WHERE id IN (...)` returns rows in.
    // The first sweep found the re-ordering unfalsifiable because the earlier
    // case asked for two turns the planner happened to return in that order; a
    // fork's inherited transcript read out of order is a conversation whose
    // question follows its answer.
    const threadId = uuid("85");
    const turnIds = [uuid("86"), uuid("87"), uuid("88")];
    expect((await harness.stores.threads.createThread(scope, threadOf(chain, threadId))).ok).toBe(
      true,
    );
    for (const [index, turnId] of turnIds.entries()) {
      const written = await harness.stores.turns.createTurn(
        scope,
        turnOf(chain, turnId, threadId, index + 1),
      );
      expect(written.ok).toBe(true);
    }

    const descending = [...turnIds].reverse().map((id) => asConversationsIdentifier<TurnId>(id));
    const resolved = await harness.stores.threads.findInheritedTurns(scope, descending);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.map((turn) => turn.turnId)).toEqual(descending);
  });
});
