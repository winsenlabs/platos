// Forking a conversation at a point.
//
// A FORK COPIES NOTHING, AND THAT IS THE WHOLE DESIGN. `thread-fork.ts` gives
// the argument in full; the short version is that cloning the ancestor turns
// would duplicate billable ledger rows and the duplicate would be
// indistinguishable from money genuinely spent. So this use case writes ONE row
// — a new thread carrying `parentThreadId`, `forkedUpToTurnId` and an ordered
// array of ancestor turn ids — and nothing else.
//
// THE BOUNDARY TURN IS RESOLVED FROM THE PARENT'S OWN TURNS, NOT LOOKED UP BY
// ID. That is what makes `CONVERSATIONS_FORK_TURN_FOREIGN` reachable: a caller
// naming a turn from another thread finds it absent from the list, rather than
// finding it in the database and having it accepted. `Thread.forkedUpToTurn` is
// `onDelete: Restrict`, so an accepted foreign id would pin an unrelated
// thread's row alive forever.
//
// THE CHILD INHERITS THE PARENT'S AGENT AND END USER AND MAY CHANGE NEITHER.
// There is no parameter for either. A fork onto a different agent is a new
// conversation with borrowed history, and giving it the parent's ancestry array
// would attribute another agent's turns to it on every later read.

import { err, ok, runResult, type EnvironmentScope, type Result } from "@platos/kernel";

import {
  applyFork,
  openThread,
  planFork,
  requireWritable,
  type EndUserId,
  type Thread,
  type ThreadId,
  type TurnId,
} from "../domain/index.js";
import { requireOwnedThread, verifyRuntime, type SecretsRuntimeGrant } from "./authorization.js";
import type { ConversationsDependencies } from "./dependencies.js";

export interface ForkThreadCommand {
  readonly authorization: SecretsRuntimeGrant;
  readonly scope: EnvironmentScope;
  readonly threadId: ThreadId;
  readonly endUserId: EndUserId;
  readonly forkedUpToTurnId: TurnId;
  readonly title?: string | null;
}

export async function forkConversation(
  dependencies: ConversationsDependencies,
  command: ForkThreadCommand,
): Promise<Result<Thread>> {
  const grant = verifyRuntime(command.authorization, command.scope);
  if (!grant.ok) return err(grant.error);

  const found = await dependencies.threads.findThread(command.scope, command.threadId);
  if (!found.ok) return err(found.error);
  const owned = requireOwnedThread(found.value, command.threadId, command.endUserId);
  if (!owned.ok) return err(owned.error);
  const writable = requireWritable(owned.value);
  if (!writable.ok) return err(writable.error);

  const parentTurns = await dependencies.turns.readTranscriptTurns(
    command.scope,
    command.threadId,
    0,
    dependencies.policy.thread.maxPageSize,
  );
  if (!parentTurns.ok) return err(parentTurns.error);

  const forkCount = await dependencies.threads.countForks(command.scope, command.threadId);
  if (!forkCount.ok) return err(forkCount.error);
  const depth = await dependencies.threads.measureForkDepth(command.scope, command.threadId);
  if (!depth.ok) return err(depth.error);

  const plan = planFork(
    {
      parent: writable.value,
      parentTurns: parentTurns.value,
      forkedUpToTurnId: command.forkedUpToTurnId,
      existingForkCount: forkCount.value,
      parentDepth: depth.value,
    },
    dependencies.policy.thread,
  );
  if (!plan.ok) return err(plan.error);

  const at = dependencies.clock.now();
  const drafted = openThread(
    {
      threadId: dependencies.ids.uuid() as unknown as ThreadId,
      agentId: writable.value.agentId,
      endUserId: writable.value.endUserId,
      clusterId: writable.value.clusterId,
      title: command.title ?? writable.value.title,
      tags: writable.value.tags,
      sessionContext: writable.value.sessionContext,
      at,
    },
    dependencies.policy.thread,
  );
  if (!drafted.ok) return err(drafted.error);

  const child = applyFork(drafted.value, plan.value);
  return runResult(dependencies.unitOfWork, async (transaction) => {
    const created = await dependencies.threads.createThread(command.scope, child);
    if (!created.ok) return err(created.error);
    await dependencies.outbox.append(
      {
        name: "conversations.thread.forked",
        schemaVersion: 1,
        scope: command.scope,
        requestId: null,
        payload: {
          threadId: created.value.threadId,
          parentThreadId: plan.value.parentThreadId,
          forkedUpToTurnId: plan.value.forkedUpToTurnId,
          inheritedTurnCount: plan.value.forkedTurnIds.length,
          depth: plan.value.depth,
        },
      },
      transaction,
    );
    return ok(created.value);
  });
}
