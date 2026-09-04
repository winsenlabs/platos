// The store behind `Thread` — the row this context is sole writer of.
//
// EVERY METHOD IS SCOPED, AND THE SCOPE IS A PARAMETER RATHER THAN A FIELD. An
// adapter that held the scope would have one instance per tenant or a mutable
// one; both are how a cross-tenant read happens. Passing it makes every call
// site show which environment it is reading, and makes a call that forgot fail
// to compile.
//
// THE SEQUENCE ALLOCATION IS A METHOD ON THIS PORT AND NOT A USE CASE. The
// source takes `SELECT id FROM "Thread" WHERE id = $1 FOR UPDATE` before reading
// the highest turn sequence, because `@@unique([threadId, sequence])` turns a
// race into a constraint violation and the lock is what stops the race. A lock
// is a store concept — a context that named one would be naming a vendor — so
// `allocateTurnSequence` is the port's promise: it answers a sequence nobody
// else will be given, and how it keeps that promise is the adapter's business.
//
// COUNTS ARE THEIR OWN METHODS BECAUSE THE CEILINGS NEED THEM CHEAPLY. Loading a
// thread's ten thousand turns to find out there are ten thousand is how a
// ceiling becomes more expensive than the thing it bounds.

import type { EnvironmentScope, Result } from "@platos/kernel";

import type {
  EndUserId,
  Thread,
  ThreadId,
  Turn,
  TurnId,
} from "../../domain/index.js";

export interface ThreadPageQuery {
  readonly scope: EnvironmentScope;
  /** Null reads every end user's threads. Only an operator grant may pass null. */
  readonly endUserId: EndUserId | null;
  readonly limit: number;
  readonly offset: number;
  readonly includeArchived: boolean;
}

export interface ThreadPage {
  readonly items: readonly Thread[];
  readonly total: number;
}

export interface ThreadRepository {
  findThread(scope: EnvironmentScope, threadId: ThreadId): Promise<Result<Thread | null>>;
  pageThreads(query: ThreadPageQuery): Promise<Result<ThreadPage>>;
  /** Insert. The caller has already admitted the draft. */
  createThread(scope: EnvironmentScope, thread: Thread): Promise<Result<Thread>>;
  /** Whole-row replace. Optimistic concurrency is the adapter's business. */
  saveThread(scope: EnvironmentScope, thread: Thread): Promise<Result<Thread>>;

  /** How many forks hang off this thread. The fan-out ceiling reads it. */
  countForks(scope: EnvironmentScope, threadId: ThreadId): Promise<Result<number>>;
  /** How far up the fork chain this thread sits. The depth ceiling reads it. */
  measureForkDepth(scope: EnvironmentScope, threadId: ThreadId): Promise<Result<number>>;
  countTurns(scope: EnvironmentScope, threadId: ThreadId): Promise<Result<number>>;

  /**
   * Reserve the next turn sequence for this thread.
   *
   * MUST be serialized against every other caller for the same thread. Two
   * callers receiving one number is a `@@unique([threadId, sequence])` violation
   * at best and an overwritten turn at worst.
   */
  allocateTurnSequence(scope: EnvironmentScope, threadId: ThreadId): Promise<Result<number>>;

  /**
   * Take the compaction lock by moving IDLE to IN_PROGRESS, atomically.
   *
   * Answers false when the thread was already IN_PROGRESS. A `Result<boolean>`
   * rather than a refusal because losing a race is a normal outcome for work
   * that runs on a schedule, and the use case decides what to say about it.
   */
  acquireCompactionLock(scope: EnvironmentScope, threadId: ThreadId): Promise<Result<boolean>>;

  /** The turns a fork inherited, resolved in `forkedTurnIds` order. */
  findInheritedTurns(
    scope: EnvironmentScope,
    turnIds: readonly TurnId[],
  ): Promise<Result<readonly Turn[]>>;
}
