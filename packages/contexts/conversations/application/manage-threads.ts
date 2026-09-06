// Opening a thread, and reading threads and turns back.
//
// TWO CALLERS, TWO AUTHORIZATION PATHS, AND THEY ANSWER DIFFERENTLY ON PURPOSE.
// An END USER reaches these through a runtime grant and sees only their own
// threads: a thread that is somebody else's is `not_found`, indistinguishable
// from one that does not exist, because an end user able to tell those apart can
// enumerate a tenant's threads by id. An OPERATOR reaches them through a tenancy
// grant and may read the whole environment; a thread that exists and is another
// end user's is `forbidden`, because the grant already entitles them to know the
// row is there. `authorization.ts` holds both checks and
// `authorization.test.ts` asserts the same thread answers differently to the
// two.
//
// THE PAGE CEILING IS ENFORCED, NOT SUGGESTED. The source's `listThreads` takes
// `options.limit ?? 20` with NO upper bound, so a caller asking for a million
// gets a million rows; `getMessages` clamps to 500 three files away. One rule,
// here, applied to both, and a request over it is refused with a `fields`
// violation naming the parameter rather than silently clamped — a caller that
// asked for 10,000 and received 500 has no way to know the answer is partial.
//
// OPENING A THREAD EMITS AN EVENT AND WRITES NOTHING ELSE. `conversations.thread
// .opened` is how the observability projection learns; the source calls the
// projection service inline, from inside the transaction, and wraps it in a
// try/catch whose own comment explains that a projection failure must not roll
// back a committed turn. An outbox append inside the transaction has that
// property by construction rather than by rescue.

import { err, ok, runResult, type EnvironmentScope, type Result } from "@platos/kernel";

import {
  openThread,
  pageRequestInvalid,
  turnNotFound,
  type AgentId,
  type ClusterId,
  type EndUserId,
  type SessionContext,
  type Step,
  type Thread,
  type ThreadId,
  type Turn,
  type TurnId,
} from "../domain/index.js";
import {
  requireOwnedThread,
  requireVisibleThread,
  verifyOperator,
  verifyRuntime,
  type SecretsRuntimeGrant,
} from "./authorization.js";
import type { ConversationsDependencies } from "./dependencies.js";
import type { ThreadPage, TurnPage } from "./ports/index.js";

export interface OpenThreadCommand {
  readonly authorization: SecretsRuntimeGrant;
  readonly scope: EnvironmentScope;
  readonly agentId: AgentId;
  readonly endUserId: EndUserId;
  readonly clusterId?: ClusterId | null;
  readonly title?: string | null;
  readonly tags?: readonly string[];
  readonly sessionContext?: SessionContext | null;
}

export async function openConversation(
  dependencies: ConversationsDependencies,
  command: OpenThreadCommand,
): Promise<Result<Thread>> {
  const grant = verifyRuntime(command.authorization, command.scope);
  if (!grant.ok) return err(grant.error);

  const at = dependencies.clock.now();
  const drafted = openThread(
    {
      threadId: dependencies.ids.uuid() as unknown as ThreadId,
      agentId: command.agentId,
      endUserId: command.endUserId,
      clusterId: command.clusterId ?? null,
      title: command.title ?? null,
      tags: command.tags ?? [],
      sessionContext: command.sessionContext ?? null,
      at,
    },
    dependencies.policy.thread,
  );
  if (!drafted.ok) return err(drafted.error);

  return runResult(dependencies.unitOfWork, async (transaction) => {
    const created = await dependencies.threads.createThread(command.scope, drafted.value);
    if (!created.ok) return err(created.error);
    await dependencies.outbox.append(
      {
        name: "conversations.thread.opened",
        schemaVersion: 1,
        scope: command.scope,
        requestId: null,
        payload: {
          threadId: created.value.threadId,
          agentId: created.value.agentId,
          endUserId: created.value.endUserId,
        },
      },
      transaction,
    );
    return ok(created.value);
  });
}

export interface DescribeThreadQuery {
  readonly authorization: SecretsRuntimeGrant;
  readonly scope: EnvironmentScope;
  readonly threadId: ThreadId;
  readonly endUserId: EndUserId;
}

/** The end user's read. A thread that is not theirs is not there. */
export async function describeConversation(
  dependencies: ConversationsDependencies,
  query: DescribeThreadQuery,
): Promise<Result<Thread>> {
  const grant = verifyRuntime(query.authorization, query.scope);
  if (!grant.ok) return err(grant.error);
  const found = await dependencies.threads.findThread(query.scope, query.threadId);
  if (!found.ok) return err(found.error);
  return requireOwnedThread(found.value, query.threadId, query.endUserId);
}

export interface InspectThreadQuery {
  readonly authorization: unknown;
  readonly scope: EnvironmentScope;
  readonly threadId: ThreadId;
  /** Null reads any end user's thread. Only an operator may pass null. */
  readonly endUserId: EndUserId | null;
}

/** The operator's read. Present-but-foreign is `forbidden`, not `not_found`. */
export async function inspectConversation(
  dependencies: ConversationsDependencies,
  query: InspectThreadQuery,
): Promise<Result<Thread>> {
  const grant = verifyOperator(dependencies, query.authorization, query.scope);
  if (!grant.ok) return err(grant.error);
  const found = await dependencies.threads.findThread(query.scope, query.threadId);
  if (!found.ok) return err(found.error);
  return requireVisibleThread(found.value, query.threadId, query.endUserId);
}

export interface PageThreadsQuery {
  readonly authorization: unknown;
  readonly scope: EnvironmentScope;
  readonly endUserId: EndUserId | null;
  readonly limit: number;
  readonly offset: number;
  readonly includeArchived?: boolean;
}

/**
 * Admit a page request, or refuse it by the field that is wrong.
 *
 * A shared code with a `fields` violation, because the remedy for a bad offset
 * and a bad limit is the same — fix the request — and the payload says which.
 */
export function admitPage(
  limit: number,
  offset: number,
  maximum: number,
): Result<{ readonly limit: number; readonly offset: number }> {
  if (!Number.isInteger(offset) || offset < 0) {
    const message = "offset must be a non-negative integer";
    return err(pageRequestInvalid(message, [{ field: "offset", code: "NEGATIVE", message }]));
  }
  if (!Number.isInteger(limit) || limit < 1) {
    const message = "limit must be a positive integer";
    return err(pageRequestInvalid(message, [{ field: "limit", code: "NOT_POSITIVE", message }]));
  }
  if (limit > maximum) {
    const message = `limit may be at most ${maximum}`;
    return err(pageRequestInvalid(message, [{ field: "limit", code: "TOO_LARGE", message }]));
  }
  return ok({ limit, offset });
}

export async function pageConversations(
  dependencies: ConversationsDependencies,
  query: PageThreadsQuery,
): Promise<Result<ThreadPage>> {
  const grant = verifyOperator(dependencies, query.authorization, query.scope);
  if (!grant.ok) return err(grant.error);
  const page = admitPage(query.limit, query.offset, dependencies.policy.thread.maxPageSize);
  if (!page.ok) return err(page.error);
  return dependencies.threads.pageThreads({
    scope: query.scope,
    endUserId: query.endUserId,
    limit: page.value.limit,
    offset: page.value.offset,
    includeArchived: query.includeArchived ?? false,
  });
}

export interface PageTurnsQuery {
  readonly authorization: unknown;
  readonly scope: EnvironmentScope;
  readonly threadId: ThreadId;
  readonly endUserId: EndUserId | null;
  readonly limit: number;
  readonly offset: number;
  readonly includeSubThreads?: boolean;
}

/**
 * A thread's turns, for an operator.
 *
 * The thread is resolved FIRST and through the same visibility check as
 * `inspectConversation`, so a caller cannot page the turns of a thread it may
 * not read by naming the thread id directly. That ordering is the guard; the
 * repository method itself takes a scope and would happily answer.
 */
export async function pageConversationTurns(
  dependencies: ConversationsDependencies,
  query: PageTurnsQuery,
): Promise<Result<TurnPage>> {
  const thread = await inspectConversation(dependencies, {
    authorization: query.authorization,
    scope: query.scope,
    threadId: query.threadId,
    endUserId: query.endUserId,
  });
  if (!thread.ok) return err(thread.error);

  const page = admitPage(query.limit, query.offset, dependencies.policy.thread.maxPageSize);
  if (!page.ok) return err(page.error);

  return dependencies.turns.pageTurns({
    scope: query.scope,
    threadId: query.threadId,
    limit: page.value.limit,
    offset: page.value.offset,
    includeSubThreads: query.includeSubThreads ?? false,
  });
}

export interface DescribeTurnQuery {
  readonly authorization: unknown;
  readonly scope: EnvironmentScope;
  readonly turnId: TurnId;
}

export interface TurnTrace {
  readonly turn: Turn;
  readonly steps: readonly Step[];
}

/**
 * One turn and every step it produced, for an operator inspecting a trace.
 *
 * A turn in another environment answers `not_found` rather than `forbidden`: the
 * repository is scoped, so a foreign turn is genuinely absent from this
 * operator's environment and there is nothing to forbid.
 */
export async function describeConversationTurn(
  dependencies: ConversationsDependencies,
  query: DescribeTurnQuery,
): Promise<Result<TurnTrace>> {
  const grant = verifyOperator(dependencies, query.authorization, query.scope);
  if (!grant.ok) return err(grant.error);
  const found = await dependencies.turns.findTurnWithSteps(query.scope, query.turnId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(turnNotFound(query.turnId));
  return ok(found.value);
}
