// The seam between the kernel outbox adapter and the canonical PostgreSQL row.
//
// WHY THIS PORT EXISTS AT ALL, given that an adapter is supposed to be the sole
// holder of its own vendor client. The `Event` row lives in the canonical
// tenancy database, and ADR M0.3 §15 puts the ORM in exactly one directory:
// `packages/adapters/postgres-tenancy`, one client imported in one file. So the
// package that OWNS the outbox port cannot be the package that issues its
// INSERT. Two rules meet here and both are right — "the outbox adapter is the
// single writer of Event" and "the ORM has one home" — and the shape that
// satisfies both is this one: the envelope, the identifier and every refusal
// are decided HERE, and a prepared row of primitives crosses to the one package
// entitled to speak to the database.
//
// EVERY FIELD BELOW IS A PRIMITIVE, ON PURPOSE. ADR M0.3 §5.1 rule (j2) says an
// adapter may not import another adapter, so the two halves of this seam cannot
// share a declaration file. They agree STRUCTURALLY instead, and the agreement
// is proven by the compiler at the composition root — the one place entitled to
// name both packages — where `OUTBOX_STORE_SATISFACTION` in
// `apps/core-api/src/composition/adapter-bindings.ts` resolves
// `PostgresTenancyAdapter extends OutboxEventStore`. Branded identifiers and
// the kernel's `JsonValue` would each pull a declaration across that line, so
// the row carries `string`, `Date` and `unknown`, and this package brands and
// decodes what comes back. That is also the honest layering: a row read out of a
// database is untrusted input until something parses it.

import type { TransactionScope } from "@platos/kernel";

/** A prepared `Event` row. Every value is already validated and stamped. */
export interface OutboxInsert {
  /** `Event.id`. A UUIDv7, so byte order is append order (see `event-id.ts`). */
  readonly eventId: string;
  /** `Event.environmentId`. NOT NULL in the frozen baseline, with a live FK. */
  readonly environmentId: string;
  /** `Event.eventType`. The dotted domain-event name. */
  readonly eventType: string;
  /** `Event.subjectId`. Always null here; see `envelope.ts` for why. */
  readonly subjectId: string | null;
  /** `Event.payload`. An OBJECT root, which a CHECK constraint requires. */
  readonly envelope: Readonly<Record<string, unknown>>;
  /** `Event.createdAt`. The same instant the identifier was minted from. */
  readonly createdAt: Date;
}

/**
 * Where a drain has read up to.
 *
 * A PAIR, not a timestamp. `Event.createdAt` is `TIMESTAMP(3)`, so two events
 * appended inside one millisecond carry the same value and a cursor made of the
 * timestamp alone would either re-deliver both or skip one. The identifier
 * breaks the tie, and because it is a UUIDv7 minted from that same instant with
 * a within-millisecond counter, breaking the tie by identifier IS breaking it by
 * append order.
 */
export interface OutboxCursor {
  readonly createdAt: Date;
  readonly eventId: string;
}

/** One `Event` row as the database holds it. `payload` is untrusted. */
export interface OutboxStoredRow {
  readonly eventId: string;
  readonly environmentId: string;
  readonly eventType: string;
  readonly subjectId: string | null;
  readonly payload: unknown;
  readonly createdAt: Date;
}

/**
 * THE TWO MEMBERS ARE PROPERTIES, NOT METHODS, AND THAT IS LOAD-BEARING.
 *
 * TypeScript checks a METHOD's parameters bivariantly even under `strict`, so a
 * store declaring `subjectId: string` where this seam says `string | null` would
 * still satisfy it — and the compile-time proof at the composition root would
 * pass while the two halves disagreed about a nullable column. Declared as
 * function-typed properties, `strictFunctionTypes` checks them contravariantly
 * and that same change fails the build. The first draft of this file used method
 * syntax; the widening was applied to the other half deliberately, the build
 * stayed green, and that is how the hole was found.
 */
export interface OutboxEventStore {
  /**
   * Append one prepared row inside the transaction `transaction` names.
   *
   * The scope is passed rather than a client handle because ADR M0.3 §3 forbids
   * a vendor transaction handle from crossing a port. The implementation
   * correlates the token to the open transaction and refuses three distinct
   * ways — no transaction, a finished one, another live one — which is what
   * makes "the event cannot outlive a rolled-back transaction" a property of
   * the store rather than a hope about the caller.
   */
  readonly insertOutboxEvent: (row: OutboxInsert, transaction: TransactionScope) => Promise<void>;

  /**
   * One ordered page of rows strictly after `cursor`, oldest first.
   *
   * CURSOR-PAGED RATHER THAN STATUS-FLAGGED. The frozen `Event` row has no
   * `deliveredAt` and no `status` column, and ADR M0.3 §7 decision 8 chose ONE
   * physical outbox with SEVERAL drains — `observability` projecting it and
   * `eventing` routing it. A status column would have made those two drains
   * fight over one flag; a cursor gives each drain its own position over the
   * same rows, which is the shape the table already has.
   */
  readonly readOutboxEventsAfter: (
    cursor: OutboxCursor | null,
    limit: number,
  ) => Promise<readonly OutboxStoredRow[]>;
}
