// Compaction, through the two use cases: the lock, the durable hand-off, and
// the cursor.
//
// Mutations M-CT1 (the atomic lock), M-CT2 (the durable dispatch — deleting it
// makes the fan-out happen in the request), M-CT3 (the cursor comparison),
// M-CT4 (releasing the lock when there is nothing to do).

import { describe, expect, it } from "vitest";
import { asIdentifier, type EnvironmentScope } from "@platos/kernel";

import {
  COMPACTION_JOB_KEY,
  completeConversationCompaction,
  planConversationCompaction,
} from "./compact-thread.js";
import {
  buildConversationsTestContext,
  THREAD_ID,
  threadFixture,
  turnFixture,
} from "./testing/index.js";
import type { TurnId } from "../domain/index.js";

const SCOPE = {
  level: "environment",
  organizationId: "org-1",
  projectId: "proj-1",
  environmentId: "env-1",
} as EnvironmentScope;

function seedTurns(context: ReturnType<typeof buildConversationsTestContext>, count: number): void {
  context.store.seedThread(threadFixture());
  for (let sequence = 1; sequence <= count; sequence += 1) {
    context.store.seedTurn(
      turnFixture({ turnId: asIdentifier<TurnId>(`turn-${sequence}`), sequence }),
    );
  }
}

describe("planConversationCompaction", () => {
  it("takes the lock, plans the prefix and hands the work to `jobs`", async () => {
    const context = buildConversationsTestContext();
    seedTurns(context, 20);

    const queued = await planConversationCompaction(context.dependencies, {
      authorization: context.tenancy.grant(),
      scope: SCOPE,
      threadId: THREAD_ID,
      contextLimit: 8,
    });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(queued.value.plan?.turns).toHaveLength(12);
    expect(queued.value.plan?.cursorTurnId).toBe("turn-12");
    expect(context.store.threads.get(THREAD_ID)?.compactionState).toBe("IN_PROGRESS");
  });

  it("dispatches the summarising as a DURABLE job, never inside the request", async () => {
    const context = buildConversationsTestContext();
    seedTurns(context, 20);

    await planConversationCompaction(context.dependencies, {
      authorization: context.tenancy.grant(),
      scope: SCOPE,
      threadId: THREAD_ID,
      contextLimit: 8,
    });
    expect(context.jobs.dispatched).toHaveLength(1);
    const body = context.jobs.dispatched[0] as Record<string, unknown>;
    expect(body.job).toBe(COMPACTION_JOB_KEY);
    expect(body.threadId).toBe(THREAD_ID);
    // Another inference call, minutes of tail latency, a cost of its own — and
    // no summary comes back from this call at all.
    expect(context.providers.generated).toHaveLength(0);
  });

  it("refuses a SECOND compaction while one is running", async () => {
    const context = buildConversationsTestContext();
    seedTurns(context, 20);
    const grant = context.tenancy.grant();

    const first = await planConversationCompaction(context.dependencies, {
      authorization: grant,
      scope: SCOPE,
      threadId: THREAD_ID,
      contextLimit: 8,
    });
    expect(first.ok).toBe(true);

    const second = await planConversationCompaction(context.dependencies, {
      authorization: grant,
      scope: SCOPE,
      threadId: THREAD_ID,
      contextLimit: 8,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    // THE LOCK'S OWN CODE, not the domain's. `beginCompaction` refuses a
    // snapshot that already says IN_PROGRESS with
    // CONVERSATIONS_COMPACTION_IN_PROGRESS; this refusal comes from the
    // repository losing the conditional update, and while the two shared one
    // code deleting the lock check left this case green.
    expect(second.error.code).toBe("CONVERSATIONS_COMPACTION_LOCK_HELD");
    // The lock was taken once. Two callers, one winner.
    expect(context.store.lockTaken).toBe(1);
    expect(context.jobs.dispatched).toHaveLength(1);
  });

  it("RELEASES the lock and dispatches nothing when there is too little to compact", async () => {
    const context = buildConversationsTestContext();
    seedTurns(context, 6);

    const queued = await planConversationCompaction(context.dependencies, {
      authorization: context.tenancy.grant(),
      scope: SCOPE,
      threadId: THREAD_ID,
      contextLimit: 5,
    });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(queued.value.plan).toBeNull();
    expect(context.store.threads.get(THREAD_ID)?.compactionState).toBe("IDLE");
    expect(context.jobs.dispatched).toHaveLength(0);
  });

  it("refuses an absent thread", async () => {
    const context = buildConversationsTestContext();
    const refused = await planConversationCompaction(context.dependencies, {
      authorization: context.tenancy.grant(),
      scope: SCOPE,
      threadId: THREAD_ID,
      contextLimit: 8,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_THREAD_NOT_FOUND");
  });

  it("refuses without a minted operator grant", async () => {
    const context = buildConversationsTestContext();
    seedTurns(context, 20);
    const refused = await planConversationCompaction(context.dependencies, {
      authorization: { looks: "right" },
      scope: SCOPE,
      threadId: THREAD_ID,
      contextLimit: 8,
    });
    expect(refused.ok).toBe(false);
    expect(context.store.lockTaken).toBe(0);
  });
});

describe("completeConversationCompaction", () => {
  it("stores the summary, advances the cursor, releases the lock and emits", async () => {
    const context = buildConversationsTestContext();
    seedTurns(context, 20);
    const grant = context.tenancy.grant();
    await planConversationCompaction(context.dependencies, {
      authorization: grant,
      scope: SCOPE,
      threadId: THREAD_ID,
      contextLimit: 8,
    });

    const done = await completeConversationCompaction(context.dependencies, {
      authorization: grant,
      scope: SCOPE,
      threadId: THREAD_ID,
      summary: "twelve turns, summarised",
      cursorTurnId: asIdentifier<TurnId>("turn-12"),
      cursorSequence: 12,
    });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.value.summary).toBe("twelve turns, summarised");
    expect(done.value.compactedUpToTurnId).toBe("turn-12");
    expect(done.value.compactionState).toBe("IDLE");
    expect(context.outbox.names()).toEqual(["conversations.thread.compacted"]);
  });

  it("REFUSES a cursor that moved backwards, which a replayed job would bring", async () => {
    const context = buildConversationsTestContext();
    seedTurns(context, 20);
    const grant = context.tenancy.grant();
    await planConversationCompaction(context.dependencies, {
      authorization: grant,
      scope: SCOPE,
      threadId: THREAD_ID,
      contextLimit: 8,
    });
    await completeConversationCompaction(context.dependencies, {
      authorization: grant,
      scope: SCOPE,
      threadId: THREAD_ID,
      summary: "first pass",
      cursorTurnId: asIdentifier<TurnId>("turn-12"),
      cursorSequence: 12,
    });

    const replayed = await completeConversationCompaction(context.dependencies, {
      authorization: grant,
      scope: SCOPE,
      threadId: THREAD_ID,
      summary: "a late callback",
      cursorTurnId: asIdentifier<TurnId>("turn-5"),
      cursorSequence: 5,
    });
    expect(replayed.ok).toBe(false);
    if (replayed.ok) return;
    expect(replayed.error.code).toBe("CONVERSATIONS_COMPACTION_CURSOR_REGRESSED");
    // The first summary survives; re-exposing turns it stands for would show
    // the model the prefix twice.
    expect(context.store.threads.get(THREAD_ID)?.summary).toBe("first pass");
  });

  it("refuses an over-long summary and writes nothing", async () => {
    const context = buildConversationsTestContext();
    seedTurns(context, 20);
    const grant = context.tenancy.grant();
    const refused = await completeConversationCompaction(context.dependencies, {
      authorization: grant,
      scope: SCOPE,
      threadId: THREAD_ID,
      summary: "z".repeat(100_000),
      cursorTurnId: asIdentifier<TurnId>("turn-12"),
      cursorSequence: 12,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_COMPACTION_SUMMARY_TOO_LONG");
    expect(context.outbox.appended).toHaveLength(0);
  });
});
