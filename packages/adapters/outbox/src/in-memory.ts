// The in-memory `OutboxEventStore`, and the unit of work it rolls back with.
//
// THIS DOUBLE EXISTS BECAUSE THE LAST ONE DID NOT ROLL BACK. `conversations`
// shipped a `TestOutbox` that was not in its unit of work's snapshot set, so an
// event appended inside a rolled-back transaction SURVIVED the rollback and a
// turn was certified as settled when no settlement had landed. Every test was
// green. A double whose transaction semantics are weaker than the store's is not
// a cheaper store, it is a different one, and the difference is invisible until
// production — so this one snapshots its rows on the way into a transaction and
// restores them when the callback rejects, and the shared conformance scenario
// in `./conformance.js` asks it and the real PostgreSQL store the same questions
// and compares the two transcripts value by value.
//
// THE REFUSAL CODES ARE THE CANONICAL STORE'S CODES, DELIBERATELY. They read
// `tenancy.transaction.*` because the `Event` row lives in the canonical tenancy
// database and the real store resolves its transaction through that adapter's
// machinery. A double with codes of its own would still pass its own suite and
// would diverge from the store on the one axis an operator reads first; here the
// transcript comparison fails the moment the two disagree.

import type { TransactionId, TransactionScope, UnitOfWork } from "@platos/kernel";
import { asIdentifier } from "@platos/kernel";

import type { OutboxCursor, OutboxEventStore, OutboxInsert, OutboxStoredRow } from "./store.js";

/** A write was issued with no open transaction around it. */
export const TRANSACTION_NOT_OPEN = "tenancy.transaction.not_open";

/** The token names a transaction that has already committed or rolled back. */
export const TRANSACTION_SCOPE_UNKNOWN = "tenancy.transaction.scope_unknown";

/** The token names a DIFFERENT live transaction than the one being run in. */
export const TRANSACTION_SCOPE_FOREIGN = "tenancy.transaction.scope_foreign";

/** The row's primary key is already taken. The real store gets this from a unique index. */
export const EVENT_ID_TAKEN = "outbox.store.event_id_taken";

export class InMemoryOutboxError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "InMemoryOutboxError";
    this.code = code;
  }
}

export interface InMemoryOutbox {
  readonly store: OutboxEventStore;
  readonly unitOfWork: UnitOfWork;
  /** Every committed row, in insertion order. For assertions, not for the port. */
  rows(): readonly OutboxStoredRow[];
}

function ordered(rows: readonly OutboxStoredRow[]): readonly OutboxStoredRow[] {
  return [...rows].sort((left, right) => {
    const byTime = left.createdAt.getTime() - right.createdAt.getTime();
    if (byTime !== 0) return byTime;
    return left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0;
  });
}

function after(row: OutboxStoredRow, cursor: OutboxCursor): boolean {
  const byTime = row.createdAt.getTime() - cursor.createdAt.getTime();
  if (byTime !== 0) return byTime > 0;
  return row.eventId > cursor.eventId;
}

/**
 * A store and a unit of work that share one row list.
 *
 * They are built together for the reason the real adapter ships its repository
 * and its unit of work together: they are one connection. Handing a caller a
 * store from one factory and a transaction from another is how a double ends up
 * outside the snapshot set.
 */
export function createInMemoryOutbox(): InMemoryOutbox {
  let rows: OutboxStoredRow[] = [];
  let open: TransactionScope | null = null;
  const finished = new Set<string>();
  let counter = 0;

  const requireWritable = (scope: TransactionScope): void => {
    if (open === null) {
      throw new InMemoryOutboxError(
        TRANSACTION_NOT_OPEN,
        "an outbox append must run inside UnitOfWork.run; no transaction is open",
      );
    }
    if (finished.has(scope.transactionId)) {
      throw new InMemoryOutboxError(
        TRANSACTION_SCOPE_UNKNOWN,
        `transaction ${scope.transactionId} is not open; it has already finished or never existed`,
      );
    }
    if (scope.transactionId !== open.transactionId) {
      throw new InMemoryOutboxError(
        TRANSACTION_SCOPE_FOREIGN,
        `transaction ${scope.transactionId} is open but is not the one this write is running inside`,
      );
    }
  };

  const unitOfWork: UnitOfWork = {
    async run<Value>(work: (transaction: TransactionScope) => Promise<Value>): Promise<Value> {
      if (open !== null) return work(open);
      counter += 1;
      const scope: TransactionScope = {
        transactionId: asIdentifier<TransactionId>(`memory-txn-${String(counter)}`),
      };
      // THE SNAPSHOT. Taken before the callback runs and restored when it
      // rejects, so an append inside a failed transaction leaves nothing behind.
      const snapshot = [...rows];
      open = scope;
      try {
        return await work(scope);
      } catch (error) {
        rows = snapshot;
        throw error;
      } finally {
        open = null;
        finished.add(scope.transactionId);
      }
    },
  };

  const store: OutboxEventStore = {
    async insertOutboxEvent(row: OutboxInsert, transaction: TransactionScope): Promise<void> {
      requireWritable(transaction);
      if (rows.some((existing) => existing.eventId === row.eventId)) {
        throw new InMemoryOutboxError(
          EVENT_ID_TAKEN,
          `event ${row.eventId} is already in the outbox`,
        );
      }
      rows.push({
        eventId: row.eventId,
        environmentId: row.environmentId,
        eventType: row.eventType,
        subjectId: row.subjectId,
        // Copied through JSON so a caller holding the object it passed cannot
        // reach into a stored row, which is what a database would give it.
        payload: JSON.parse(JSON.stringify(row.envelope)) as unknown,
        createdAt: new Date(row.createdAt.getTime()),
      });
      return Promise.resolve();
    },

    async readOutboxEventsAfter(
      cursor: OutboxCursor | null,
      limit: number,
    ): Promise<readonly OutboxStoredRow[]> {
      const visible = ordered(rows).filter((row) => cursor === null || after(row, cursor));
      return Promise.resolve(visible.slice(0, limit));
    },
  };

  return { store, unitOfWork, rows: () => ordered(rows) };
}
