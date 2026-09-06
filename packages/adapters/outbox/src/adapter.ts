// THE single writer of the `Event` row — the kernel `OutboxWriter` (ADR M0.3
// §1 closing note, §7 decision 8).
//
// WHERE THE VENDOR CLIENT IS. Not here, and the generated header this file
// replaced said it would be. ADR M0.3 §15 gives the ORM exactly one home,
// `packages/adapters/postgres-tenancy`, with the client imported in one file; a
// second import here would be a second home and would make that rule unwritable.
// So this adapter owns the DECISIONS — the identifier, the instant, the
// envelope, every refusal — and hands a prepared row of primitives across the
// `OutboxEventStore` seam in `./store.js`. The single-writer property is
// unchanged and is still enforced mechanically: `scripts/arch/table-ownership.mjs`
// gives `Event` the `<kernel-outbox-adapter>` owner and grants that owner the
// one directory entitled to write it.
//
// WHY `append` TAKES THE TRANSACTION AND NOTHING ELSE OPENS ONE. The port's own
// comment is the contract: "Append an event in the SAME transaction that wrote
// the state it describes ... there is no window in which the row exists and the
// event does not." An outbox that opened a transaction of its own would create
// that window in both directions — an event for a settlement that rolled back,
// and a settlement with no event. `conversations` shipped the first of those two
// this week, because its test double was not in the unit of work's snapshot set
// and an event appended inside a rolled-back transaction SURVIVED, certifying a
// turn that never landed. The store this adapter writes through resolves the
// scope to the open transaction and refuses three distinct ways when it cannot,
// and `outbox-transaction.integration.test.ts` proves the row is gone by making
// a later write fail against a real database and then looking for it.

import type {
  Clock,
  CorrelationSource,
  DomainEventDraft,
  EventId,
  JsonValue,
  OutboxWriter,
  TransactionScope,
} from "@platos/kernel";
import { asIdentifier } from "@platos/kernel";

import type { DrainedEvent } from "./envelope.js";
import { decodeEnvelope, encodeEnvelope, environmentOf } from "./envelope.js";
import type { EventIdMinter, RandomBytes } from "./event-id.js";
import { createEventIdMinter } from "./event-id.js";
import type { OutboxCursor, OutboxEventStore } from "./store.js";

/** A page of drained events and the cursor that resumes after it. */
export interface OutboxDrainPage {
  readonly events: readonly DrainedEvent[];
  /** Null only when the page is empty; then the caller keeps its own cursor. */
  readonly cursor: OutboxCursor | null;
}

/** Refused when a drain is asked for a page size that is not a whole count. */
export const DRAIN_LIMIT_INVALID = "outbox.drain.limit_invalid";

export class OutboxDrainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OutboxDrainError";
    this.code = code;
  }
}

export interface OutboxAdapter extends OutboxWriter {
  readonly adapterName: "outbox";
  /**
   * One ordered page of appended events, oldest first, strictly after `cursor`.
   *
   * ADR M0.3 §7 decision 8: one physical outbox, several drains. `observability`
   * projects the table to the column store and `eventing` routes notifications,
   * and each holds its own cursor over the same rows — which is why this returns
   * a position rather than marking anything delivered.
   */
  drain(cursor: OutboxCursor | null, limit: number): Promise<OutboxDrainPage>;
}

export interface OutboxAdapterOptions {
  readonly store: OutboxEventStore;
  readonly clock: Clock;
  /** Defaults to the platform CSPRNG. Injectable so a suite can pin the tail. */
  readonly randomBytes?: RandomBytes;
  /**
   * Where the request identifier comes from when the producer did not name one.
   *
   * WIN-260 (M2.5). `DomainEvent.requestId` has always been in the envelope and
   * every one of the eight drafts the tree appends supplied `null`, because no
   * use case takes a `RequestScope` and none of them should: ADR M0.3 §2 gives a
   * use case what it DECIDES with, and no context decides anything with a
   * correlation id. So the envelope's correlation was a field that existed and
   * was never populated, which is worse than not having it — a drain reading
   * `requestId: null` cannot tell "this event belongs to no request" from
   * "nobody remembered".
   *
   * Optional, and absent means the previous behaviour exactly: whatever the
   * producer named, including null.
   */
  readonly correlation?: CorrelationSource;
}

/** Build the adapter over an already-wired store. */
export function buildOutboxAdapter(options: OutboxAdapterOptions): OutboxAdapter {
  const minter: EventIdMinter = createEventIdMinter(
    options.randomBytes ?? defaultRandomBytes,
  );
  const { store, clock } = options;
  const correlation = options.correlation ?? null;

  /**
   * Stamp the request in flight onto a draft that named none.
   *
   * A DRAFT THAT NAMED ONE KEEPS IT, and that is the whole reason this is a
   * fallback rather than an overwrite. An event appended while REPLAYING work on
   * behalf of an earlier request belongs to that earlier request, and a stamp
   * that overwrote it would relabel history with whatever happened to be in
   * flight — which is exactly the drift a correlation identifier exists to make
   * impossible.
   */
  const correlated = <Payload extends JsonValue>(
    draft: DomainEventDraft<Payload>,
  ): DomainEventDraft<Payload> => {
    if (draft.requestId !== null) return draft;
    const reference = correlation?.current() ?? null;
    if (reference === null) return draft;
    return { ...draft, requestId: reference.requestId };
  };

  return {
    adapterName: "outbox",

    async append<Payload extends JsonValue>(
      event: DomainEventDraft<Payload>,
      transaction: TransactionScope,
    ): Promise<EventId> {
      // The envelope is built BEFORE the identifier so a refused draft never
      // consumes a counter slot: a minted-and-discarded identifier leaves a gap
      // that looks, to anyone reading ordered identifiers, like a lost event.
      const envelope = encodeEnvelope(correlated(event));
      const environmentId = environmentOf(event.scope);
      const minted = minter.mint(clock.now());
      await store.insertOutboxEvent(
        {
          eventId: minted.eventId,
          environmentId,
          eventType: event.name,
          subjectId: null,
          envelope,
          createdAt: minted.at,
        },
        transaction,
      );
      return asIdentifier<EventId>(minted.eventId);
    },

    async drain(cursor: OutboxCursor | null, limit: number): Promise<OutboxDrainPage> {
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new OutboxDrainError(
          DRAIN_LIMIT_INVALID,
          `a drain page size must be a positive whole number; received ${String(limit)}`,
        );
      }
      const rows = await store.readOutboxEventsAfter(cursor, limit);
      const events = rows.map((row) => decodeEnvelope(row));
      const last = rows.at(-1);
      return {
        events,
        cursor: last === undefined ? null : { createdAt: last.createdAt, eventId: last.eventId },
      };
    },
  };
}

/**
 * The default random tail.
 *
 * `crypto.getRandomValues` rather than `node:crypto`, because it is the same
 * call on every runtime this adapter can be hosted on and needs no import.
 */
function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}
