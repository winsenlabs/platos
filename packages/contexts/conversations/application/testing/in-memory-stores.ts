// In-memory implementations of the four ports this context owns.
//
// A DOUBLE THAT DOES NOT BEHAVE LIKE THE REAL THING CERTIFIES A BUG. Four live
// defects shipped in this programme this week for exactly that reason: a unit of
// work with nothing to roll back, so an error `Result` returned from inside it
// COMMITTED; a double that did not cascade a foreign key, so a suite certified
// that a measurement outlives the row it hangs off; stores that enforced the
// constraint the guard under test was meant to, so deleting the guard changed
// nothing; and a pricing fixture with no rates, which left a whole money path
// unexecuted while every case stayed green.
//
// SO THESE MODEL THE SCHEMA, INCLUDING `onDelete`:
//
//   `Step.turn` is `onDelete: Cascade`      — deleting a turn deletes its steps.
//   `Turn.thread` is `onDelete: Cascade`    — deleting a thread deletes its
//                                             turns, and their steps with them.
//   `PostmanExecution.simulatedEndUser` is `onDelete: SetNull` — the row
//                                             survives with the link severed,
//                                             which is what "anonymize" means
//                                             on the erasure plan.
//   `@@unique([threadId, sequence])` and `@@unique([turnId, sequence])` are
//                                             enforced, because a race the guard
//                                             cannot see must still be a
//                                             conflict.
//
// AND THE ONE CONSTRAINT THEY DELIBERATELY DO NOT ENFORCE IS THE IDEMPOTENCY
// PAIR. `@@unique([threadId, idempotencyKey])` exists in the schema, but the
// GUARD under test is the use case's pre-check, and a store that refused first
// would produce an identical refusal with an identical code — leaving
// `admitTurn`'s idempotency branch untestable, which is precisely the M13/M26
// defect the governance ledger records. `findTurnByIdempotencyKey` answers
// truthfully and `createTurn` accepts, so what distinguishes the pre-check is
// WHERE the refusal happens, and the suites assert it.

import { err, ok, type EnvironmentScope, type Result, type TransactionScope } from "@platos/kernel";

import {
  repositoryUnavailable,
  stepSequenceTaken,
  turnSequenceTaken,
  type EndUserId,
  type IdempotencyKey,
  type PostmanContextHandle,
  type PostmanExecution,
  type PostmanExecutionId,
  type PostmanTemplateId,
  type Step,
  type Thread,
  type ThreadId,
  type Turn,
  type TurnId,
} from "../../domain/index.js";
import type {
  ConversationsErasureStore,
  ErasureCensus,
  PostmanPage,
  PostmanPageQuery,
  PostmanRepository,
  ThreadPage,
  ThreadPageQuery,
  ThreadRepository,
  TurnPage,
  TurnPageQuery,
  TurnRepository,
  TurnWithSteps,
} from "../ports/index.js";

/** One store behind all four ports, because the four share a foreign-key graph. */
export class InMemoryConversations
  implements ThreadRepository, TurnRepository, PostmanRepository, ConversationsErasureStore
{
  readonly threads = new Map<string, Thread>();
  readonly turns = new Map<string, Turn>();
  readonly steps = new Map<string, Step[]>();
  readonly executions = new Map<string, PostmanExecution>();
  readonly toolCalls = new Map<string, number>();
  readonly heldThreads = new Set<string>();

  /** Every sequence this store handed out, so a test can assert it never repeats. */
  readonly allocated: number[] = [];
  /** How many times the compaction lock was taken. Two callers, one success. */
  lockTaken = 0;

  private failure: string | null = null;

  failWith(reason: string | null): void {
    this.failure = reason;
  }

  private guard<Value>(value: Value): Result<Value> {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    return ok(value);
  }

  seedThread(thread: Thread): Thread {
    this.threads.set(thread.threadId, thread);
    return thread;
  }

  seedTurn(turn: Turn, steps: readonly Step[] = []): Turn {
    this.turns.set(turn.turnId, turn);
    this.steps.set(turn.turnId, [...steps]);
    return turn;
  }

  seedExecution(execution: PostmanExecution): PostmanExecution {
    this.executions.set(execution.executionId, execution);
    return execution;
  }

  hold(threadId: ThreadId): void {
    this.heldThreads.add(threadId);
  }

  // ---- ThreadRepository ---------------------------------------------------

  findThread: ThreadRepository["findThread"] = async (_scope, threadId) =>
    this.guard(this.threads.get(threadId) ?? null);

  pageThreads: ThreadRepository["pageThreads"] = async (query: ThreadPageQuery) => {
    const all = [...this.threads.values()].filter(
      (thread) =>
        (query.endUserId === null || thread.endUserId === query.endUserId) &&
        (query.includeArchived || thread.archivedAt === null),
    );
    const page: ThreadPage = {
      items: all.slice(query.offset, query.offset + query.limit),
      total: all.length,
    };
    return this.guard(page);
  };

  createThread: ThreadRepository["createThread"] = async (_scope, thread) => {
    const guarded = this.guard(thread);
    if (!guarded.ok) return guarded;
    this.threads.set(thread.threadId, thread);
    return ok(thread);
  };

  saveThread: ThreadRepository["saveThread"] = async (_scope, thread) => {
    const guarded = this.guard(thread);
    if (!guarded.ok) return guarded;
    this.threads.set(thread.threadId, thread);
    return ok(thread);
  };

  countForks: ThreadRepository["countForks"] = async (_scope, threadId) =>
    this.guard([...this.threads.values()].filter((t) => t.parentThreadId === threadId).length);

  measureForkDepth: ThreadRepository["measureForkDepth"] = async (_scope, threadId) => {
    let depth = 0;
    let current = this.threads.get(threadId);
    while (current?.parentThreadId != null) {
      depth += 1;
      current = this.threads.get(current.parentThreadId);
    }
    return this.guard(depth);
  };

  countTurns: ThreadRepository["countTurns"] = async (_scope, threadId) =>
    this.guard([...this.turns.values()].filter((turn) => turn.threadId === threadId).length);

  allocateTurnSequence: ThreadRepository["allocateTurnSequence"] = async (_scope, threadId) => {
    const highest = [...this.turns.values()]
      .filter((turn) => turn.threadId === threadId)
      .reduce((max, turn) => Math.max(max, turn.sequence), 0);
    const next = highest + 1;
    this.allocated.push(next);
    return this.guard(next);
  };

  acquireCompactionLock: ThreadRepository["acquireCompactionLock"] = async (_scope, threadId) => {
    const thread = this.threads.get(threadId);
    if (thread === undefined) return this.guard(false);
    if (thread.compactionState === "IN_PROGRESS") return this.guard(false);
    this.lockTaken += 1;
    this.threads.set(threadId, { ...thread, compactionState: "IN_PROGRESS" });
    return this.guard(true);
  };

  findInheritedTurns: ThreadRepository["findInheritedTurns"] = async (_scope, turnIds) => {
    const resolved = turnIds
      .map((turnId) => this.turns.get(turnId))
      .filter((turn): turn is Turn => turn !== undefined);
    return this.guard(resolved);
  };

  // ---- TurnRepository -----------------------------------------------------

  findTurn: TurnRepository["findTurn"] = async (_scope, turnId) =>
    this.guard(this.turns.get(turnId) ?? null);

  findTurnWithSteps: TurnRepository["findTurnWithSteps"] = async (_scope, turnId) => {
    const turn = this.turns.get(turnId);
    if (turn === undefined) return this.guard(null);
    return this.guard({ turn, steps: this.steps.get(turnId) ?? [] });
  };

  pageTurns: TurnRepository["pageTurns"] = async (query: TurnPageQuery) => {
    const all = [...this.turns.values()]
      .filter(
        (turn) =>
          turn.threadId === query.threadId &&
          (query.includeSubThreads || turn.parentTurnId === null),
      )
      .sort((left, right) => left.sequence - right.sequence);
    const page: TurnPage = {
      items: all.slice(query.offset, query.offset + query.limit),
      total: all.length,
    };
    return this.guard(page);
  };

  readTranscriptTurns: TurnRepository["readTranscriptTurns"] = async (
    _scope,
    threadId,
    afterSequence,
    limit,
  ) => {
    const all = [...this.turns.values()]
      .filter((turn) => turn.threadId === threadId && turn.sequence > afterSequence)
      .sort((left, right) => left.sequence - right.sequence);
    return this.guard(all.slice(0, limit));
  };

  findTurnByIdempotencyKey: TurnRepository["findTurnByIdempotencyKey"] = async (
    _scope,
    threadId: ThreadId,
    key: IdempotencyKey,
  ) => {
    const found =
      [...this.turns.values()].find(
        (turn) => turn.threadId === threadId && turn.idempotencyKey === key,
      ) ?? null;
    return this.guard(found);
  };

  createTurn: TurnRepository["createTurn"] = async (_scope, turn) => {
    const guarded = this.guard(turn);
    if (!guarded.ok) return guarded;
    const clash = [...this.turns.values()].some(
      (existing) => existing.threadId === turn.threadId && existing.sequence === turn.sequence,
    );
    if (clash) return err(turnSequenceTaken(turn.threadId, turn.sequence));
    this.turns.set(turn.turnId, turn);
    this.steps.set(turn.turnId, []);
    return ok(turn);
  };

  saveSettlement: TurnRepository["saveSettlement"] = async (_scope, settlement: TurnWithSteps) => {
    const guarded = this.guard(settlement);
    if (!guarded.ok) return guarded;
    const seen = new Set<number>();
    for (const step of settlement.steps) {
      if (seen.has(step.sequence)) return err(stepSequenceTaken(step.turnId, step.sequence));
      seen.add(step.sequence);
    }
    this.turns.set(settlement.turn.turnId, settlement.turn);
    this.steps.set(settlement.turn.turnId, [...settlement.steps]);
    return ok(settlement);
  };

  countToolCalls: TurnRepository["countToolCalls"] = async (_scope, turnIds) => {
    const counts = new Map<TurnId, number>();
    for (const turnId of turnIds) counts.set(turnId, this.toolCalls.get(turnId) ?? 0);
    return this.guard(counts as ReadonlyMap<TurnId, number>);
  };

  // ---- PostmanRepository --------------------------------------------------

  findExecution: PostmanRepository["findExecution"] = async (
    _scope,
    executionId: PostmanExecutionId,
  ) => this.guard(this.executions.get(executionId) ?? null);

  findByRequest: PostmanRepository["findByRequest"] = async (
    _scope,
    templateId: PostmanTemplateId | null,
    requestId: string,
  ) => {
    if (templateId === null) return this.guard(null);
    const found =
      [...this.executions.values()].find(
        (execution) => execution.templateId === templateId && execution.requestId === requestId,
      ) ?? null;
    return this.guard(found);
  };

  findByHandle: PostmanRepository["findByHandle"] = async (
    _scope,
    handle: PostmanContextHandle,
  ) => {
    const found =
      [...this.executions.values()].find((execution) => execution.contextHandle === handle) ?? null;
    return this.guard(found);
  };

  pageExecutions: PostmanRepository["pageExecutions"] = async (query: PostmanPageQuery) => {
    const all = [...this.executions.values()].filter(
      (execution) => query.actorUserId === null || execution.actorUserId === query.actorUserId,
    );
    const page: PostmanPage = {
      items: all.slice(query.offset, query.offset + query.limit),
      total: all.length,
    };
    return this.guard(page);
  };

  createExecution: PostmanRepository["createExecution"] = async (_scope, execution) => {
    const guarded = this.guard(execution);
    if (!guarded.ok) return guarded;
    this.executions.set(execution.executionId, execution);
    return ok(execution);
  };

  saveExecution: PostmanRepository["saveExecution"] = async (_scope, execution) => {
    const guarded = this.guard(execution);
    if (!guarded.ok) return guarded;
    this.executions.set(execution.executionId, execution);
    return ok(execution);
  };

  // ---- ConversationsErasureStore -----------------------------------------

  private censusOf(threadIds: readonly string[], executionCount: number): ErasureCensus {
    const turns = [...this.turns.values()].filter((turn) => threadIds.includes(turn.threadId));
    const stepCount = turns.reduce((total, turn) => total + (this.steps.get(turn.turnId)?.length ?? 0), 0);
    return {
      threadCount: threadIds.length,
      turnCount: turns.length,
      stepCount,
      postmanExecutionCount: executionCount,
    };
  }

  censusForEndUser: ConversationsErasureStore["censusForEndUser"] = async (subjectId) => {
    const threadIds = [...this.threads.values()]
      .filter((thread) => thread.endUserId === subjectId)
      .map((thread) => thread.threadId as string);
    const executions = [...this.executions.values()].filter(
      (execution) => execution.simulatedEndUserId === subjectId,
    ).length;
    return this.guard(this.censusOf(threadIds, executions));
  };

  censusForActor: ConversationsErasureStore["censusForActor"] = async (subjectId) => {
    const executions = [...this.executions.values()].filter(
      (execution) => execution.actorUserId === subjectId,
    ).length;
    return this.guard(this.censusOf([], executions));
  };

  /**
   * Delete a subject's threads AND CASCADE, exactly as the schema does.
   *
   * `Turn.thread` and `Step.turn` are both `onDelete: Cascade`, so a double that
   * removed the thread and left the turns would let a suite certify that a
   * subject's words outlive their conversation. That is the `governance` M55
   * defect in this context's shape, and it is the reason these three deletions
   * are one method.
   */
  deleteThreadsForEndUser: ConversationsErasureStore["deleteThreadsForEndUser"] = async (
    subjectId: EndUserId,
    _organizationId: string,
    _transaction: TransactionScope,
  ) => {
    const guarded = this.guard(0);
    if (!guarded.ok) return guarded;
    const doomed = [...this.threads.values()].filter((thread) => thread.endUserId === subjectId);
    for (const thread of doomed) {
      for (const turn of [...this.turns.values()].filter((t) => t.threadId === thread.threadId)) {
        this.steps.delete(turn.turnId);
        this.turns.delete(turn.turnId);
      }
      this.threads.delete(thread.threadId);
    }
    return ok(doomed.length);
  };

  /** `onDelete: SetNull` on `simulatedEndUserId`. The ROW survives. */
  anonymizeExecutionsForEndUser: ConversationsErasureStore["anonymizeExecutionsForEndUser"] =
    async (subjectId: EndUserId) => {
      const guarded = this.guard(0);
      if (!guarded.ok) return guarded;
      let stripped = 0;
      for (const [id, execution] of this.executions) {
        if (execution.simulatedEndUserId !== subjectId) continue;
        this.executions.set(id, { ...execution, simulatedEndUserId: null });
        stripped += 1;
      }
      return ok(stripped);
    };

  anonymizeExecutionsForActor: ConversationsErasureStore["anonymizeExecutionsForActor"] = async (
    subjectId: string,
  ) => {
    const guarded = this.guard(0);
    if (!guarded.ok) return guarded;
    let stripped = 0;
    for (const [id, execution] of this.executions) {
      if (execution.actorUserId !== subjectId) continue;
      this.executions.set(id, { ...execution, simulatedEndUserId: null });
      stripped += 1;
    }
    return ok(stripped);
  };

  findHeldThreads: ConversationsErasureStore["findHeldThreads"] = async (subjectId: EndUserId) => {
    const held = [...this.threads.values()]
      .filter((thread) => thread.endUserId === subjectId && this.heldThreads.has(thread.threadId))
      .map((thread) => thread.threadId);
    return this.guard(held);
  };
}

/** A scope every fixture in this package shares. */
export function testScope(): EnvironmentScope {
  return {
    level: "environment",
    organizationId: "org-1",
    projectId: "proj-1",
    environmentId: "env-1",
  } as EnvironmentScope;
}
