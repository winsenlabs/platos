// Compacting a long conversation, and where the summarising itself happens.
//
// TWO USE CASES, AND THE SPLIT IS THE POINT.
//
//   `planConversationCompaction` takes the lock, decides what to compact, and
//   hands the work to `jobs`. It returns immediately.
//   `completeConversationCompaction` is what the durable job calls back with:
//   the summary, the cursor, and the release of the lock.
//
// THE SUMMARY IS PRODUCED BY A MODEL AND THEREFORE BY A JOB. It is another
// inference call — minutes of latency at the tail, a provider that can be down,
// a cost of its own — and running it inside the request that noticed the thread
// was long makes an end user wait for housekeeping. ADR M0.3 §1 row 16 says
// every fan-out leaves as an event or a durable job; this is the clearest case
// of the second, and it is the one the source already reaches for a durable
// dispatch to do, falling back to an in-process call when the runtime is not
// configured. There is no fallback here: an installation without the durable
// seam does not compact, which is a visible absence rather than a silent
// difference in where the latency lands.
//
// THE LOCK IS TAKEN BY THE STORE, ATOMICALLY, AND THE USE CASE ONLY ASKS.
// `acquireCompactionLock` moves IDLE to IN_PROGRESS in one statement and answers
// false if it did not. Reading the state and then writing it would be two
// statements with a race between them, and the race loses turns: two
// compactions each summarise a prefix and the second moves the cursor past turns
// the first already replaced.
//
// AND THE CURSOR IS CHECKED SEPARATELY FROM THE LOCK. Holding the lock says
// nothing about whether the cursor a caller brings back is ahead of where the
// thread already is — a replayed job, a late callback. Two guards, two codes.

import { err, ok, type EnvironmentScope, type Result } from "@platos/kernel";

import {
  beginCompaction,
  compactionInProgress,
  completeCompaction,
  planCompaction,
  releaseCompaction,
  threadNotFound,
  type CompactionPlan,
  type Thread,
  type ThreadId,
  type TurnId,
} from "../domain/index.js";
import { verifyOperator } from "./authorization.js";
import type { ConversationsDependencies } from "./dependencies.js";

/**
 * The job key the durable seam dispatches on.
 *
 * A constant rather than a literal at the call site: `jobs` takes an opaque
 * `body`, so the only thing that makes this dispatch findable from either side
 * is the two of them agreeing on one string, and a string in two places is a
 * string that drifts.
 */
export const COMPACTION_JOB_KEY = "conversations.compaction";

export interface CompactThreadCommand {
  readonly authorization: unknown;
  readonly scope: EnvironmentScope;
  readonly threadId: ThreadId;
  /** How many recent turns stay verbatim. The agent's own context limit. */
  readonly contextLimit: number;
}

export interface CompactionQueued {
  readonly threadId: ThreadId;
  /** Null when there was nothing worth compacting; the lock is released. */
  readonly plan: CompactionPlan | null;
}

export async function planConversationCompaction(
  dependencies: ConversationsDependencies,
  command: CompactThreadCommand,
): Promise<Result<CompactionQueued>> {
  const grant = verifyOperator(dependencies, command.authorization, command.scope);
  if (!grant.ok) return err(grant.error);

  const found = await dependencies.threads.findThread(command.scope, command.threadId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(threadNotFound(command.threadId));

  const locked = await dependencies.threads.acquireCompactionLock(command.scope, command.threadId);
  if (!locked.ok) return err(locked.error);
  if (!locked.value) return err(compactionInProgress(command.threadId));

  const turns = await dependencies.turns.readTranscriptTurns(
    command.scope,
    command.threadId,
    0,
    dependencies.policy.thread.maxPageSize,
  );
  if (!turns.ok) return err(turns.error);

  const plan = planCompaction(turns.value, command.contextLimit, dependencies.policy.compaction);
  if (plan === null) {
    const released = await dependencies.threads.saveThread(
      command.scope,
      releaseCompaction(found.value),
    );
    if (!released.ok) return err(released.error);
    return ok({ threadId: command.threadId, plan: null });
  }

  const marked = beginCompaction(found.value);
  if (!marked.ok) return err(marked.error);
  const saved = await dependencies.threads.saveThread(command.scope, marked.value);
  if (!saved.ok) return err(saved.error);

  const queued = await dependencies.jobs.execute({
    scope: command.scope,
    body: {
      job: COMPACTION_JOB_KEY,
      threadId: command.threadId,
      cursorTurnId: plan.cursorTurnId,
      turnCount: plan.turns.length,
    },
  });
  if (!queued.ok) return err(queued.error);

  return ok({ threadId: command.threadId, plan });
}

export interface CompleteCompactionCommand {
  readonly authorization: unknown;
  readonly scope: EnvironmentScope;
  readonly threadId: ThreadId;
  readonly summary: string;
  readonly cursorTurnId: TurnId;
  readonly cursorSequence: number;
}

export async function completeConversationCompaction(
  dependencies: ConversationsDependencies,
  command: CompleteCompactionCommand,
): Promise<Result<Thread>> {
  const grant = verifyOperator(dependencies, command.authorization, command.scope);
  if (!grant.ok) return err(grant.error);

  const found = await dependencies.threads.findThread(command.scope, command.threadId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(threadNotFound(command.threadId));

  const previous =
    found.value.compactedUpToTurnId === null
      ? 0
      : await previousCursorSequence(dependencies, command.scope, found.value);

  const completed = completeCompaction(
    found.value,
    {
      summary: command.summary,
      cursorTurnId: command.cursorTurnId,
      cursorSequence: command.cursorSequence,
      previousCursorSequence: previous,
      at: dependencies.clock.now(),
    },
    dependencies.policy.compaction,
  );
  if (!completed.ok) return err(completed.error);

  return dependencies.unitOfWork.run(async (transaction) => {
    const saved = await dependencies.threads.saveThread(command.scope, completed.value);
    if (!saved.ok) return err(saved.error);
    await dependencies.outbox.append(
      {
        name: "conversations.thread.compacted",
        schemaVersion: 1,
        scope: command.scope,
        requestId: null,
        payload: {
          threadId: saved.value.threadId,
          cursorTurnId: command.cursorTurnId,
          cursorSequence: command.cursorSequence,
          summaryLength: command.summary.length,
        },
      },
      transaction,
    );
    return ok(saved.value);
  });
}

async function previousCursorSequence(
  dependencies: ConversationsDependencies,
  scope: EnvironmentScope,
  thread: Thread,
): Promise<number> {
  if (thread.compactedUpToTurnId === null) return 0;
  const found = await dependencies.turns.findTurn(scope, thread.compactedUpToTurnId);
  return found.ok && found.value !== null ? found.value.sequence : 0;
}
