// The `ThreadRepository` — `Thread`, and the two serialisation primitives that
// hang off it.
//
// ---------------------------------------------------------------------------
// THE SEQUENCE ALLOCATION IS THE REASON THIS PORT HAS A LOCK IN IT AT ALL
// ---------------------------------------------------------------------------
//
// `allocateTurnSequence` promises "a sequence nobody else will be given", and
// `@@unique([threadId, sequence])` turns a broken promise into a constraint
// violation that aborts the caller's whole transaction. The extraction source
// takes `SELECT id FROM "Thread" WHERE id = $1 FOR UPDATE` before reading the
// highest sequence, and that is exactly right: the lock is on the THREAD row,
// not on the turns, because the number being allocated does not exist yet and a
// lock can only be taken on a row that does.
//
// TWO STATEMENTS, AND THE FIRST ONE IS THE LOCK. It projects
// `id AS "lockedThreadId"` rather than `1`, and that spelling is deliberate:
// WIN-258 T3's advisory lock projected `SELECT 1`, which is precisely the shape
// the statement-count suites strip to discard the driver's connection probe, so
// the lock was measured at ZERO statements and a mutation deleting it survived
// the sweep. A projection nothing filters cannot be discarded by the thing
// measuring it.
//
// THE LOCK IS HELD BY THE CALLER'S TRANSACTION, not by this method. `atomic()`
// JOINS an open unit of work rather than opening a second one, so when
// `run-turn.ts` allocates and then inserts inside one transaction the lock
// spans both — which is what makes the promise true. A caller that allocates in
// one transaction and inserts in another gets no protection, and cannot: the
// lock ends where its transaction does. `createTurn` treats the resulting clash
// as an outcome for that reason.
//
// ---------------------------------------------------------------------------
// THE COMPACTION LOCK IS ONE STATEMENT, AND THAT IS THE WHOLE MECHANISM
// ---------------------------------------------------------------------------
//
// `acquireCompactionLock` moves IDLE to IN_PROGRESS "atomically" and answers
// false when it was already IN_PROGRESS. A read-then-write would be two callers
// both reading IDLE; a conditional UPDATE whose WHERE names the state it expects
// is decided by the database's own row lock, and the row count IS the answer.
//
// ---------------------------------------------------------------------------
// `measureForkDepth` IS A RECURSIVE CTE BECAUSE THE OBVIOUS SHAPE IS AN N+1
// ---------------------------------------------------------------------------
//
// The double walks `parentThreadId` in a loop, which is one query per ancestor
// against a real store — invisible on a fixture of two and quadratic on a
// conversation forked twenty times. One statement walks the chain in the
// database. It is static SQL with bound parameters, which is also what keeps it
// attributable to a table under the ADR M0.3 §5.2 sole-writer lint; SQL
// assembled at run time is refused there as unattributable, and rightly.

import {
  err,
  ok,
  threadNotFound,
  type EnvironmentScope,
  type Result,
  type Thread,
  type ThreadId,
  type ThreadPage,
  type ThreadPageQuery,
  type ThreadRepository,
  type Turn,
  type TurnId,
} from "@platos/context-conversations/application/ports/index.js";

import { nullableJson } from "./client.js";
import { guardThreadWrite } from "./conversations-guards.js";
import { refuse } from "./conversations-refusal.js";
import {
  readThread,
  readTurn,
  scopedWhere,
  turnScopedWhere,
  type ThreadRow,
  type TurnRow,
} from "./conversations-rows.js";
import { TURN_COLUMNS } from "./conversations-turns.js";
import type { TenancyTransactions } from "./transaction.js";

/** Every column `readThread` reads. One place, so no read is wider. */
const THREAD_COLUMNS = {
  id: true,
  agentId: true,
  endUserId: true,
  clusterId: true,
  parentThreadId: true,
  forkedUpToTurnId: true,
  forkedTurnIds: true,
  compactedUpToTurnId: true,
  title: true,
  status: true,
  summary: true,
  compactionState: true,
  compactedAt: true,
  sessionContext: true,
  tags: true,
  pinnedAt: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * The columns a thread WRITE sets, other than the ones only an insert may set.
 *
 * `environmentId`, `parentThreadId`, `forkedUpToTurnId` and `forkedTurnIds` are
 * absent, and that is `Thread_owner_immutable` rather than a choice:
 * `reject_canonical_owner_change` fires BEFORE UPDATE over exactly those four
 * and raises 23514 if any of them differs. `endUserId` is absent for the same
 * reason under a second rule, `Thread_subject_immutable`. Writing them back
 * unchanged would pass — the rule compares OLD to NEW — but it would also
 * make a caller that DID change one look like a caller that did not, and the
 * refusal would arrive from the database instead of from the store.
 */
function threadUpdate(thread: Thread): Record<string, unknown> {
  return {
    agentId: thread.agentId,
    clusterId: thread.clusterId,
    compactedUpToTurnId: thread.compactedUpToTurnId,
    title: thread.title,
    status: thread.status,
    summary: thread.summary,
    compactionState: thread.compactionState,
    compactedAt: thread.compactedAt,
    sessionContext: nullableJson(thread.sessionContext),
    tags: [...thread.tags],
    pinnedAt: thread.pinnedAt,
    archivedAt: thread.archivedAt,
    // EXPLICIT, though the column is `@updatedAt`. The context owns its clock
    // (`ConversationsDependencies.clock`) so that a compaction window and a
    // turn's latency can be pinned to the millisecond; a column that stamped
    // itself would make the stored instant depend on when the statement reached
    // the database rather than on when the decision was made.
    updatedAt: thread.updatedAt,
  };
}

interface LockedThreadRow {
  readonly lockedThreadId: string;
}

interface HighestSequenceRow {
  readonly highest: number | null;
}

interface ForkDepthRow {
  readonly depth: number;
}

export function createThreadRepository(transactions: TenancyTransactions): ThreadRepository {
  return {
    async findThread(scope: EnvironmentScope, threadId: ThreadId): Promise<Result<Thread | null>> {
      return refuse(async () => {
        const row = await transactions.reader().thread.findFirst({
          where: { id: threadId, ...scopedWhere(scope) },
          select: THREAD_COLUMNS,
        });
        return ok(row === null ? null : readThread(row as unknown as ThreadRow));
      }, "threads findThread");
    },

    async pageThreads(query: ThreadPageQuery): Promise<Result<ThreadPage>> {
      return refuse(async () => {
        const where = {
          ...scopedWhere(query.scope),
          ...(query.endUserId === null ? {} : { endUserId: query.endUserId }),
          ...(query.includeArchived ? {} : { archivedAt: null }),
        };
        const reader = transactions.reader();
        // TWO statements, and the same two for one thread or ten thousand. A
        // `findMany` cannot report the count of the rows it did not return, so
        // the total is its own statement; neither is per row.
        const rows = await reader.thread.findMany({
          where,
          select: THREAD_COLUMNS,
          // `updatedAt` descending is the order `Thread_environmentId_endUserId_updatedAt_idx`
          // exists for, and `id` breaks the tie so the order is TOTAL. The column
          // is `timestamp(3)`, so two threads touched in the same millisecond tie
          // — and a paged listing whose order is not total repeats rows on one
          // page and drops them from the next.
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          skip: query.offset,
          take: query.limit,
        });
        const total = await reader.thread.count({ where });
        return ok({
          items: rows.map((row) => readThread(row as unknown as ThreadRow)),
          total,
        });
      }, "threads pageThreads");
    },

    async createThread(scope: EnvironmentScope, thread: Thread): Promise<Result<Thread>> {
      return refuse(async () => {
        guardThreadWrite(thread);
        const row = await transactions.reader().thread.create({
          data: {
            id: thread.threadId,
            environmentId: scope.environmentId,
            agentId: thread.agentId,
            endUserId: thread.endUserId,
            clusterId: thread.clusterId,
            parentThreadId: thread.parentThreadId,
            forkedUpToTurnId: thread.forkedUpToTurnId,
            forkedTurnIds: [...thread.forkedTurnIds],
            compactedUpToTurnId: thread.compactedUpToTurnId,
            title: thread.title,
            status: thread.status,
            summary: thread.summary,
            compactionState: thread.compactionState,
            compactedAt: thread.compactedAt,
            sessionContext: nullableJson(thread.sessionContext),
            tags: [...thread.tags],
            pinnedAt: thread.pinnedAt,
            archivedAt: thread.archivedAt,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
          },
          select: THREAD_COLUMNS,
        });
        return ok(readThread(row as unknown as ThreadRow));
      }, "threads createThread");
    },

    async saveThread(scope: EnvironmentScope, thread: Thread): Promise<Result<Thread>> {
      return refuse(async () => {
        guardThreadWrite(thread);
        return transactions.atomic(async (client) => {
          // `updateMany` rather than `update`, because the SCOPE has to be in the
          // WHERE and a unique-`where` update cannot carry a second predicate. A
          // thread in another environment matches nothing and writes nothing,
          // which is the refusal a cross-tenant save should get — and it is
          // reported as `CONVERSATIONS_THREAD_NOT_FOUND`, the same code an
          // absent thread gets, because a caller must not be able to tell "not
          // yours" from "not there".
          const updated = await client.thread.updateMany({
            where: { id: thread.threadId, ...scopedWhere(scope) },
            data: threadUpdate(thread),
          });
          if (updated.count === 0) return err(threadNotFound(thread.threadId));
          const row = await client.thread.findFirst({
            where: { id: thread.threadId, ...scopedWhere(scope) },
            select: THREAD_COLUMNS,
          });
          if (row === null) return err(threadNotFound(thread.threadId));
          return ok(readThread(row as unknown as ThreadRow));
        });
      }, "threads saveThread");
    },

    async countForks(scope: EnvironmentScope, threadId: ThreadId): Promise<Result<number>> {
      return refuse(async () => {
        const total = await transactions.reader().thread.count({
          where: { parentThreadId: threadId, ...scopedWhere(scope) },
        });
        return ok(total);
      }, "threads countForks");
    },

    async measureForkDepth(scope: EnvironmentScope, threadId: ThreadId): Promise<Result<number>> {
      return refuse(async () => {
        // ONE statement, walking `parentThreadId` upward. The seed row is the
        // thread itself at depth 0, so a thread with no parent answers 0 and a
        // thread that does not exist answers 0 as well — which is what the
        // double does, and what the fork ceiling needs: an unknown thread has no
        // ancestry to exceed a ceiling with.
        //
        // The recursion is CONFINED TO ONE ENVIRONMENT. `Thread_ancestry` already
        // requires a parent to share its child's environment, so the clause adds
        // nothing to a consistent database and everything to an inconsistent
        // one: without it a depth could be counted through a row this scope may
        // not read.
        const rows = await transactions.reader().$queryRaw<readonly ForkDepthRow[]>`
          WITH RECURSIVE ancestry("id", "parentThreadId", "depth") AS (
            SELECT thread."id", thread."parentThreadId", 0
              FROM "Thread" thread
             WHERE thread."id" = ${threadId}::uuid
               AND thread."environmentId" = ${scope.environmentId}::uuid
            UNION ALL
            SELECT parent."id", parent."parentThreadId", ancestry."depth" + 1
              FROM ancestry
              JOIN "Thread" parent ON parent."id" = ancestry."parentThreadId"
             WHERE parent."environmentId" = ${scope.environmentId}::uuid
          )
          SELECT COALESCE(MAX("depth"), 0)::int AS "depth" FROM ancestry
        `;
        return ok(rows[0]?.depth ?? 0);
      }, "threads measureForkDepth");
    },

    async countTurns(scope: EnvironmentScope, threadId: ThreadId): Promise<Result<number>> {
      return refuse(async () => {
        const total = await transactions.reader().turn.count({
          where: { threadId, ...turnScopedWhere(scope) },
        });
        return ok(total);
      }, "threads countTurns");
    },

    async allocateTurnSequence(
      scope: EnvironmentScope,
      threadId: ThreadId,
    ): Promise<Result<number>> {
      return refuse(async () => {
        return transactions.atomic(async (client) => {
          // THE LOCK. `FOR UPDATE` on the thread row serialises every other
          // allocator for this thread until the caller's transaction ends. The
          // projection is `id AS "lockedThreadId"` and never `1`; see the header.
          const locked = await client.$queryRaw<readonly LockedThreadRow[]>`
            SELECT thread."id" AS "lockedThreadId"
              FROM "Thread" thread
             WHERE thread."id" = ${threadId}::uuid
               AND thread."environmentId" = ${scope.environmentId}::uuid
            FOR UPDATE
          `;
          if (locked.length !== 1) return err(threadNotFound(threadId));
          // `=== 1`, not `> 0`: the primary key makes more than one row
          // impossible, and saying so is how a reader knows this is an
          // existence check and not a truthiness test.
          const highest = await client.$queryRaw<readonly HighestSequenceRow[]>`
            SELECT MAX(turn."sequence")::int AS "highest"
              FROM "Turn" turn
             WHERE turn."threadId" = ${threadId}::uuid
          `;
          return ok((highest[0]?.highest ?? 0) + 1);
        });
      }, "threads allocateTurnSequence");
    },

    async acquireCompactionLock(
      scope: EnvironmentScope,
      threadId: ThreadId,
    ): Promise<Result<boolean>> {
      return refuse(async () => {
        // ONE conditional UPDATE. `compactionState: "IDLE"` in the WHERE is the
        // whole lock: the database takes the row lock, re-checks the predicate
        // and reports how many rows it moved, so two callers racing produce one
        // count of 1 and one of 0 with no window between the read and the write.
        //
        // A THREAD THAT DOES NOT EXIST ANSWERS FALSE rather than refusing, and
        // that matches the double: the port says losing this race is a normal
        // outcome for scheduled work, and a compaction sweep that met a
        // just-erased thread should skip it rather than fail the sweep.
        //
        // RAW SQL, AND THE REASON IS `updatedAt`. `Thread.updatedAt` is
        // `@updatedAt`, which is a CLIENT feature rather than a database default:
        // the ORM stamps the column on every update it issues unless the caller
        // supplies a value, and this method has none to supply. Taking a
        // compaction lock is not a user-visible change to a conversation, and
        // `Thread_environmentId_endUserId_updatedAt_idx` is the index a user's
        // thread list is ordered by — so a background sweep that touched the
        // column would silently reorder every list it passed over. This
        // statement names the two columns it means to write and no others, and
        // `conversations-conformance.integration.test.ts` caught the bump the
        // first time round.
        //
        // It is static text with bound parameters, which is what keeps it
        // attributable to `Thread` under the ADR M0.3 §5.2 sole-writer lint; SQL
        // assembled at run time is refused there as unattributable, and rightly.
        const moved = await transactions.reader().$executeRaw`
          UPDATE "Thread"
             SET "compactionState" = 'IN_PROGRESS'
           WHERE "id" = ${threadId}::uuid
             AND "environmentId" = ${scope.environmentId}::uuid
             AND "compactionState" = 'IDLE'
        `;
        return ok(moved === 1);
      }, "threads acquireCompactionLock");
    },

    async findInheritedTurns(
      scope: EnvironmentScope,
      turnIds: readonly TurnId[],
    ): Promise<Result<readonly Turn[]>> {
      return refuse(async () => {
        if (turnIds.length === 0) return ok([]);
        const rows = await transactions.reader().turn.findMany({
          where: { id: { in: [...turnIds] }, ...turnScopedWhere(scope) },
          select: TURN_COLUMNS,
        });
        // RESOLVED IN `forkedTurnIds` ORDER, which the port asks for in as many
        // words. The database returns rows in whatever order suits it, and a
        // fork's inherited transcript read out of order is a conversation whose
        // question follows its answer. A turn the scope cannot see is DROPPED
        // rather than left as a hole, which is what the double does.
        const byId = new Map(rows.map((row) => [row.id, row as unknown as TurnRow]));
        const ordered: Turn[] = [];
        for (const turnId of turnIds) {
          const row = byId.get(turnId);
          if (row !== undefined) ordered.push(readTurn(row));
        }
        return ok(ordered);
      }, "threads findInheritedTurns");
    },
  };
}
