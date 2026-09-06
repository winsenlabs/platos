// The second half of the conformance scenario: the OPERATOR'S execution and the
// ERASURE that severs it.
//
// SPLIT FROM `conversations-conformance.ts` BECAUSE `max-file-lines` BIT AT THE
// HARD ERROR, and the seam it pointed at is real. The first half is a
// CONVERSATION — threads, turns, steps, the compaction lock, the paged listings
// — and this half is the row this context writes on an OPERATOR's behalf and the
// destruction of everything an end user said. They share a subject and nothing
// else.
//
// BOTH HALVES WRITE INTO ONE OBSERVATION MAP, keyed by step name, so the
// differential still compares one object per store. The projections live here
// rather than being imported from the first half for the reason that half gives
// of its own: a second projection written beside the first is how two halves of
// one transcript come to disagree about what "an error" looks like — so this
// module owns the two shapes only it records, and nothing else.

import {
  asConversationsIdentifier,
  type ActorId,
  type AgentId,
  type EndUserId,
  type PostmanContextHandle,
  type PostmanExecution,
  type PostmanExecutionId,
  type PostmanTemplateId,
  type Result,
  type ThreadId,
  type TurnId,
} from "@platos/context-conversations/application/ports/index.js";

import type {
  ConversationsConformanceEnvironment,
  ConversationsConformanceIds,
  ConversationsObservation,
} from "./conversations-conformance.js";

const AT = new Date("2026-05-01T09:00:00.000Z");

function at(offsetMs: number): Date {
  return new Date(AT.getTime() + offsetMs);
}

/** A `Result`, reduced to what compares across two stores. */
function outcome<Value>(
  result: Result<Value>,
  project: (value: Value) => unknown,
): ConversationsObservation {
  if (result.ok) return { ok: true, value: project(result.value) };
  return { ok: false, code: result.error.code, category: result.error.category };
}

function conformanceExecution(ids: ConversationsConformanceIds): PostmanExecution {
  return Object.freeze({
    executionId: asConversationsIdentifier<PostmanExecutionId>(ids.executionId),
    agentId: asConversationsIdentifier<AgentId>(ids.agentId),
    templateId: asConversationsIdentifier<PostmanTemplateId>(ids.templateId),
    requestId: ids.requestId,
    // 64 lowercase hex, because `PostmanExecution_requestFingerprint_check` says
    // so and the double would take any string at all.
    requestFingerprint: "a".repeat(64),
    actorUserId: asConversationsIdentifier<ActorId>(ids.actorUserId),
    simulatedEndUserId: asConversationsIdentifier<EndUserId>(ids.endUserId),
    contextHandle: asConversationsIdentifier<PostmanContextHandle>(ids.contextHandle),
    contextExpiresAt: at(3_600_000),
    status: "PENDING" as const,
    threadId: null,
    turnId: null,
    completedAt: null,
    createdAt: at(20_000),
    updatedAt: at(20_000),
  });
}

function projectExecution(execution: PostmanExecution | null): unknown {
  if (execution === null) return null;
  return {
    executionId: execution.executionId,
    agentId: execution.agentId,
    templateId: execution.templateId,
    requestId: execution.requestId,
    requestFingerprint: execution.requestFingerprint,
    actorUserId: execution.actorUserId,
    simulatedEndUserId: execution.simulatedEndUserId,
    contextHandle: execution.contextHandle,
    status: execution.status,
    threadId: execution.threadId,
    turnId: execution.turnId,
    createdAt: execution.createdAt.toISOString(),
  };
}

/**
 * A thread and a turn, reduced to the FACTS THE ERASURE IS ABOUT.
 *
 * NARROWER THAN THE FIRST HALF'S PROJECTIONS, on purpose. After an erasure the
 * only questions are whether the row is gone and whether its cascade went with
 * it; recording a full thread here would be a second copy of a shape the other
 * module owns, and the two would drift.
 */
function projectThread(thread: { readonly threadId: string } | null): unknown {
  return thread === null ? null : { threadId: thread.threadId };
}

function projectTurn(turn: { readonly turnId: string } | null): unknown {
  return turn === null ? null : { turnId: turn.turnId };
}

/** Drive the operator half and the erasure, recording into `observed`. */
export async function runErasureConformance(
  environment: ConversationsConformanceEnvironment,
  observed: ConversationsObservation,
): Promise<void> {
  const { stores, scope, ids } = environment;
  const threadId = asConversationsIdentifier<ThreadId>(ids.threadId);
  const secondThreadId = asConversationsIdentifier<ThreadId>(ids.secondThreadId);
  const firstTurnId = asConversationsIdentifier<TurnId>(ids.firstTurnId);

  observed["findByRequest.nullTemplate"] = outcome(
    await stores.postman.findByRequest(scope, null, ids.requestId),
    projectExecution,
  );
  observed["createExecution"] = outcome(
    await stores.postman.createExecution(scope, conformanceExecution(ids)),
    projectExecution,
  );
  observed["findExecution"] = outcome(
    await stores.postman.findExecution(
      scope,
      asConversationsIdentifier<PostmanExecutionId>(ids.executionId),
    ),
    projectExecution,
  );
  observed["findByRequest.replay"] = outcome(
    await stores.postman.findByRequest(
      scope,
      asConversationsIdentifier<PostmanTemplateId>(ids.templateId),
      ids.requestId,
    ),
    projectExecution,
  );
  observed["findByHandle.hit"] = outcome(
    await stores.postman.findByHandle(
      scope,
      asConversationsIdentifier<PostmanContextHandle>(ids.contextHandle),
    ),
    projectExecution,
  );
  observed["findByHandle.miss"] = outcome(
    await stores.postman.findByHandle(
      scope,
      asConversationsIdentifier<PostmanContextHandle>(ids.absentId),
    ),
    projectExecution,
  );
  observed["saveExecution.settled"] = outcome(
    await stores.postman.saveExecution(scope, {
      ...conformanceExecution(ids),
      status: "SUCCEEDED" as const,
      threadId,
      turnId: firstTurnId,
      completedAt: at(50_000),
      updatedAt: at(50_000),
    }),
    projectExecution,
  );
  observed["pageExecutions.byActor"] = outcome(
    await stores.postman.pageExecutions({
      scope,
      actorUserId: asConversationsIdentifier<ActorId>(ids.actorUserId),
      limit: 10,
      offset: 0,
    }),
    (page) => ({ total: page.total, ids: page.items.map((one) => one.executionId) }),
  );
  observed["pageExecutions.everyActor"] = outcome(
    await stores.postman.pageExecutions({ scope, actorUserId: null, limit: 10, offset: 0 }),
    (page) => ({ total: page.total, ids: page.items.map((one) => one.executionId) }),
  );

  // ---- the erasure --------------------------------------------------------

  const subject = asConversationsIdentifier<EndUserId>(ids.endUserId);
  observed["censusForEndUser"] = outcome(
    await stores.conversationsErasure.censusForEndUser(subject, scope.organizationId),
    (census) => ({ ...census }),
  );
  observed["censusForActor"] = outcome(
    await stores.conversationsErasure.censusForActor(ids.actorUserId, scope.organizationId),
    (census) => ({ ...census }),
  );
  observed["findHeldThreads"] = outcome(
    await stores.conversationsErasure.findHeldThreads(subject, scope.organizationId),
    (held) => [...held],
  );

  observed["erase"] = await environment.run(async (transaction) => {
    const stripped = await stores.conversationsErasure.anonymizeExecutionsForEndUser(
      subject,
      scope.organizationId,
      transaction,
    );
    const threads = await stores.conversationsErasure.deleteThreadsForEndUser(
      subject,
      scope.organizationId,
      transaction,
    );
    return {
      stripped: outcome(stripped, (n) => n),
      threads: outcome(threads, (n) => n),
    };
  });

  observed["censusForEndUser.afterErasure"] = outcome(
    await stores.conversationsErasure.censusForEndUser(subject, scope.organizationId),
    (census) => ({ ...census }),
  );
  // A NARROWER PROJECTION THAN EVERY OTHER EXECUTION STEP, and the two fields it
  // leaves out are a FIFTH place the double is wrong rather than different.
  // `PostmanExecution.thread` and `.turn` are both `onDelete: SetNull`, so the
  // real store answers a row whose `threadId` and `turnId` are gone with the
  // thread they named; `InMemoryConversations` has no cascade for either column
  // and keeps them pointing at a thread it has just deleted. What the erasure is
  // ABOUT is compared here — the row SURVIVED, its operator is intact, its
  // subject link is severed — and the nulling is pinned against the real
  // database in `conversations-rules.integration.test.ts`.
  observed["findExecution.afterErasure"] = outcome(
    await stores.postman.findExecution(
      scope,
      asConversationsIdentifier<PostmanExecutionId>(ids.executionId),
    ),
    (execution) =>
      execution === null
        ? null
        : {
            executionId: execution.executionId,
            actorUserId: execution.actorUserId,
            simulatedEndUserId: execution.simulatedEndUserId,
            requestFingerprint: execution.requestFingerprint,
            status: execution.status,
          },
  );
  // THE CASCADE. `Turn.thread` and `Step.turn` are both `onDelete: Cascade`, so
  // the subject's turns went with their thread. A store that deleted the thread
  // and left the turns would answer a turn here, and a double that did not model
  // the cascade would agree with it.
  observed["findTurn.afterErasure"] = outcome(
    await stores.turns.findTurn(scope, firstTurnId),
    projectTurn,
  );
  observed["findThread.afterErasure"] = outcome(
    await stores.threads.findThread(scope, threadId),
    projectThread,
  );
  observed["findThread.secondAfterErasure"] = outcome(
    await stores.threads.findThread(scope, secondThreadId),
    projectThread,
  );

}
