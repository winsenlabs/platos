// The canonical `Event` row, written on the kernel outbox adapter's behalf.
//
// WHY THE OUTBOX'S ROW IS WRITTEN FROM THIS DIRECTORY. ADR M0.3 §1 gives `Event`
// the `<kernel-outbox-adapter>` owner and §15 gives the ORM exactly one home,
// which is this package — one PostgreSQL database behind one client, imported in
// `./client.js` and nowhere else. Those two sentences meet here.
// `CANONICAL_STORE_ADAPTERS` in `scripts/arch/table-ownership.mjs` records the
// delegation by hand, and `scripts/arch/sole-writer.mjs` judges every write in
// this file against it: a write to any row the outbox owner does not own still
// fails, and a write to `Event` from anywhere else still fails. Single-writer is
// unchanged; what moved is which directory holds the statement.
//
// WHAT IS NOT HERE, DELIBERATELY. No identifier is minted, no clock is read, no
// envelope is built and no event name is judged. All of that is the outbox
// adapter's, in `packages/adapters/outbox`, and this file takes a row that has
// already been decided. That is what keeps the two halves testable apart: the
// envelope has a pure suite with no database, and this file has an integration
// suite with no envelope logic to get wrong.
//
// THE TRANSACTION IS THE POINT. `insertOutboxEvent` resolves its client through
// `transactions.writer(scope)` — tranche 1's machinery, unchanged — so the row is
// written on the connection that holds the open transaction and disappears with
// it. `conversations` shipped the opposite this week: its outbox double sat
// outside the unit of work's snapshot set, an event appended inside a rolled-back
// transaction survived, and a turn was certified settled against a settlement
// that never landed. `outbox-transaction.integration.test.ts` makes the second
// write of a transaction fail against a real database and then looks for the row.

import type { TransactionScope } from "@platos/context-tenancy/application/ports/index.js";

import type { TenancyJsonInput } from "./client.js";
import { isForeignKeyViolation, isUniqueViolation } from "./client.js";
import type { TenancyTransactions } from "./transaction.js";

/**
 * The event identifier is already taken.
 *
 * The in-memory double in `packages/adapters/outbox` raises the SAME code from
 * its own duplicate check. The two packages cannot share a constant — an adapter
 * may not import another adapter — so the agreement is proven by the shared
 * conformance transcript rather than by a shared declaration: a store that
 * refused with a code of its own would produce a transcript that no longer
 * matches the committed one.
 */
export const EVENT_ID_TAKEN = "outbox.store.event_id_taken";

/** The environment the event names does not exist. A distinct fact, distinct code. */
export const ENVIRONMENT_UNKNOWN = "outbox.store.environment_unknown";

/** `Event.payload` does not hold the object root its CHECK pins. */
export const PAYLOAD_NOT_AN_OBJECT = "outbox.store.payload_not_an_object";

export class OutboxStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OutboxStoreError";
    this.code = code;
  }
}

/**
 * `Event.payload`, as the object root `Event_payload_json_root` pins it to.
 *
 * WIN-258 T7. The drain used to cast this column to `unknown` and hand it on, so
 * a payload that was not an envelope reached whichever projection the event type
 * routes to and failed THERE — inside somebody else's stack, on every pass over
 * the same row, for as long as the row is in the outbox. The drain is a loop over
 * rows nobody is watching, which is exactly where an unnamed shape hides longest.
 * The CHECK makes the refusal unreachable through a committed write, and
 * `json-columns.integration.test.ts` proves that by having the database refuse
 * the out-of-band write; the reader stands so the drain names the row rather than
 * a projection naming a field.
 */
export function readOutboxPayload(eventId: string, value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OutboxStoreError(
      PAYLOAD_NOT_AN_OBJECT,
      `event ${eventId} carries a payload that is not a JSON object`,
    );
  }
  return value;
}

/**
 * The six columns the drain reads.
 *
 * WIN-258 T7. The drain is a paged loop over EVERY event in the outbox, so an
 * unprojected read is the one whose cost grows with the table rather than with a
 * tenant. `payload` is JSONB and is the point of the read; the other five are the
 * cursor and the routing. Nothing else on `Event` is wanted, and naming that is
 * what stops the next column joining every page.
 */
const EVENT_SELECT = {
  id: true,
  environmentId: true,
  eventType: true,
  subjectId: true,
  payload: true,
  createdAt: true,
} as const;

/** A prepared row. Primitives only; see the seam's own note for why. */
export interface OutboxInsertRow {
  readonly eventId: string;
  readonly environmentId: string;
  readonly eventType: string;
  readonly subjectId: string | null;
  readonly envelope: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
}

/** Where a drain has read up to: the pair `(createdAt, id)`, never the time alone. */
export interface OutboxReadCursor {
  readonly createdAt: Date;
  readonly eventId: string;
}

/** One `Event` row as the database holds it. */
export interface OutboxReadRow {
  readonly eventId: string;
  readonly environmentId: string;
  readonly eventType: string;
  readonly subjectId: string | null;
  readonly payload: unknown;
  readonly createdAt: Date;
}

/**
 * The two members the kernel outbox adapter reaches this store through.
 *
 * PROPERTIES, NOT METHODS, to match the seam they answer to. TypeScript checks a
 * method's parameters bivariantly even under `strict`, so with method syntax a
 * widened or narrowed parameter here would still satisfy `OutboxEventStore` and
 * the composition root's compile-time proof would pass over a real disagreement.
 * As function-typed properties they are checked contravariantly and the proof
 * bites.
 */
export interface OutboxEventStorePort {
  readonly insertOutboxEvent: (
    row: OutboxInsertRow,
    transaction: TransactionScope,
  ) => Promise<void>;
  readonly readOutboxEventsAfter: (
    cursor: OutboxReadCursor | null,
    limit: number,
  ) => Promise<readonly OutboxReadRow[]>;
}

export function createOutboxEventStore(transactions: TenancyTransactions): OutboxEventStorePort {
  return {
    async insertOutboxEvent(row: OutboxInsertRow, transaction: TransactionScope): Promise<void> {
      const client = transactions.writer(transaction);
      try {
        await client.event.create({
          data: {
            id: row.eventId,
            environmentId: row.environmentId,
            eventType: row.eventType,
            subjectId: row.subjectId,
            payload: row.envelope as TenancyJsonInput,
            createdAt: row.createdAt,
          },
        });
      } catch (error) {
        // TWO DRIVER FAILURES, TWO CODES. A taken identifier means this event is
        // already in the outbox and the caller is retrying; an unknown
        // environment means the event names a tenant that does not exist and no
        // retry will help. One shared code would make an operator read the
        // second as the first and wait for it to clear.
        if (isUniqueViolation(error)) {
          throw new OutboxStoreError(EVENT_ID_TAKEN, `event ${row.eventId} is already in the outbox`);
        }
        if (isForeignKeyViolation(error)) {
          throw new OutboxStoreError(
            ENVIRONMENT_UNKNOWN,
            `event ${row.eventId} names environment ${row.environmentId}, which does not exist`,
          );
        }
        throw error;
      }
    },

    async readOutboxEventsAfter(
      cursor: OutboxReadCursor | null,
      limit: number,
    ): Promise<readonly OutboxReadRow[]> {
      // ONE STATEMENT, AND A COMPOUND CURSOR RATHER THAN `skip`. An offset walks
      // the rows it skips, so a drain's cost would grow with everything it had
      // already read; the pair predicate below reads the index. It is spelled as
      // an `OR` of two arms because `Event.createdAt` is `TIMESTAMP(3)` and the
      // rows of one millisecond share a value: the second arm is what stops the
      // page either re-reading them or stepping over them.
      const rows = await transactions.reader().event.findMany({
        select: EVENT_SELECT,
        where:
          cursor === null
            ? {}
            : {
                OR: [
                  { createdAt: { gt: cursor.createdAt } },
                  { AND: [{ createdAt: cursor.createdAt }, { id: { gt: cursor.eventId } }] },
                ],
              },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: limit,
      });
      return rows.map((row) => ({
        eventId: row.id,
        environmentId: row.environmentId,
        eventType: row.eventType,
        subjectId: row.subjectId,
        payload: readOutboxPayload(row.id, row.payload),
        createdAt: row.createdAt,
      }));
    },
  };
}
