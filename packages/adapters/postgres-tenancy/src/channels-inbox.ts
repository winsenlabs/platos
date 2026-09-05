// `ChannelEventInbox` — durable, idempotent admission plus the processing lease.
//
// THE UNIQUE IS THE MECHANISM, SO THE INSERT MUST FAIL RATHER THAN UPSERT. The
// port is explicit: `insertEvent` "fails rather than upserts ... the unique is
// the idempotency mechanism, and an upsert would overwrite the in-flight state
// of a row already being processed". A redelivery therefore collides with
// `ChannelEventInbox_appId_eventId_key` and comes back as `CHANNELS_EVENT_
// DUPLICATE`, which is the same answer the in-memory double gives and the reason
// the conformance transcripts can be compared verbatim.
//
// THERE ARE TWO UNIQUES ON THIS TABLE AND THEY MEAN DIFFERENT THINGS. The second
// is on `turnId`, and the domain says why it is there: "the turn this event
// produced ... Unique across the table". A second event pointing at one turn is
// not a redelivery — it is two channel messages that have been made to share one
// turn — so it is refused with its OWN code. The in-memory double has no such
// index and accepts it silently, which is the whole reason this distinction is
// pinned rather than assumed.
//
// THE UPDATE BRANCH OF `saveEvent` CARRIES NO IDENTITY AND NO PAYLOAD. The
// migrations install a database rule that refuses any UPDATE moving `appId`,
// `eventId`, the two payload versions or the ciphertext, with SQLSTATE 23514.
// Nothing in `schema.prisma` says so. A store that wrote those columns on every
// save would take that refusal on the FIRST lease renewal of every event, so the
// omission is not an optimisation: it is the difference between a working inbox
// and one that cannot advance a single row.
//
// THE CLAIM PREDICATE IS THE DOMAIN'S, NOT A SECOND COPY OF IT. `isClaimable`
// separates a row waiting its turn from one whose holder went away, and it makes
// expiry STRICTLY `<` — "a lease that expires exactly now is still held" —
// because the claim predicate and the fence must agree on that boundary or a row
// is briefly claimable by two workers at once. The `where` below is that
// function's two disjuncts, and the ordering below is `byClaimOrder`'s two keys.
// They are pinned against the domain in the conformance run rather than trusted.

import type {
  ChannelAppId,
  ChannelEvent,
  ChannelEventInboxId,
  ProviderEventId,
  Result,
  TransactionScope,
} from "@platos/context-channels/application/ports/index.js";
import {
  err,
  eventDuplicate,
  ok,
  repositoryUnavailable,
} from "@platos/context-channels/application/ports/index.js";

import { isUniqueViolation } from "./client.js";
import type { EventRow } from "./channels-rows.js";
import { readEventRow } from "./channels-rows.js";
import {
  firstRefusal,
  guarded,
  requireEventStatus,
  requireGeneration,
  requireLeaseCoherence,
  requireOptionalUuid,
  requireSealedPayload,
  requireUuid,
} from "./channels-guards.js";
import type { TenancyTransactions } from "./transaction.js";

/** A second inbox row was pointed at a turn that already has one. */
export const TURN_ALREADY_LINKED = "turn_already_linked";

/** `findClaimableEvents` was given a page size that is not a positive count. */
export const CLAIM_LIMIT_INVALID = "claim_limit_invalid";

/** The claim order the domain fixes: oldest-available first, oldest-created next. */
const CLAIM_ORDER = [{ availableAt: "asc" }, { createdAt: "asc" }] as const;

const EVENT_COLUMNS = {
  id: true,
  appId: true,
  eventId: true,
  payloadFormatVersion: true,
  payloadKeyVersion: true,
  encryptedPayload: true,
  status: true,
  retryCount: true,
  availableAt: true,
  leaseOwner: true,
  leaseExpiresAt: true,
  leaseGeneration: true,
  turnId: true,
  deliveryCompletedAt: true,
  lastErrorCode: true,
  completedAt: true,
  createdAt: true,
} as const;

export interface ChannelEventInboxStore {
  findEvent(inboxId: ChannelEventInboxId): Promise<Result<ChannelEvent | null>>;
  findEventByProviderId(
    appId: ChannelAppId,
    eventId: ProviderEventId,
  ): Promise<Result<ChannelEvent | null>>;
  insertEvent(event: ChannelEvent, transaction: TransactionScope): Promise<Result<ChannelEvent>>;
  saveEvent(event: ChannelEvent, transaction: TransactionScope): Promise<Result<ChannelEvent>>;
  findClaimableEvents(
    appId: ChannelAppId,
    now: Date,
    limit: number,
  ): Promise<Result<readonly ChannelEvent[]>>;
}

/** Which unique a collision landed on, as the driver reports the target. */
function collidedOnEventId(error: unknown): boolean {
  const meta = (error as { readonly meta?: { readonly target?: unknown } }).meta;
  const target = meta?.target;
  const text = Array.isArray(target) ? target.join(",") : String(target ?? "");
  return text.includes("eventId");
}

export function createChannelEventInboxStore(
  transactions: TenancyTransactions,
): ChannelEventInboxStore {
  function checkEvent(operation: string, event: ChannelEvent): Result<ChannelEvent> {
    return firstRefusal(event, [
      requireUuid<ChannelEvent>(operation, "inboxId", event.inboxId),
      requireUuid<ChannelEvent>(operation, "appId", event.appId),
      requireOptionalUuid<ChannelEvent>(operation, "turnId", event.turnId),
      requireEventStatus<ChannelEvent>(operation, event.status),
      requireLeaseCoherence<ChannelEvent>(
        operation,
        event.status,
        event.leaseOwner,
        event.leaseExpiresAt,
      ),
      requireSealedPayload<ChannelEvent>(
        operation,
        event.payload.formatVersion,
        event.payload.keyVersion,
        event.payload.ciphertext,
      ),
      requireGeneration<ChannelEvent>(operation, "retryCount", event.retryCount),
      requireGeneration<ChannelEvent>(operation, "leaseGeneration", event.leaseGeneration),
    ]);
  }

  function readOne(row: EventRow | null): Result<ChannelEvent | null> {
    if (row === null) return ok(null);
    const read = readEventRow(row);
    return read.ok ? ok(read.value) : err(read.error);
  }

  return {
    async findEvent(inboxId) {
      const operation = "findEvent";
      const malformed = requireUuid<ChannelEvent | null>(operation, "inboxId", inboxId);
      if (malformed !== null) return malformed;
      return guarded(operation, async () => {
        const row = await transactions.reader().channelEventInbox.findUnique({
          where: { id: inboxId },
          select: EVENT_COLUMNS,
        });
        return readOne(row);
      });
    },

    async findEventByProviderId(appId, eventId) {
      const operation = "findEventByProviderId";
      const malformed = requireUuid<ChannelEvent | null>(operation, "appId", appId);
      if (malformed !== null) return malformed;
      return guarded(operation, async () => {
        // THE IDEMPOTENCY PROBE, through the same unique the insert collides on.
        // Keyed on both halves because a provider's event id is scoped to one
        // app: two apps can be delivered the same id and they are two events.
        const row = await transactions.reader().channelEventInbox.findUnique({
          where: { appId_eventId: { appId, eventId } },
          select: EVENT_COLUMNS,
        });
        return readOne(row);
      });
    },

    async insertEvent(event, transaction) {
      const operation = "insertEvent";
      const checked = checkEvent(operation, event);
      if (!checked.ok) return checked;
      return guarded(operation, async () => {
        try {
          await transactions.writer(transaction).channelEventInbox.create({
            data: {
              id: event.inboxId,
              appId: event.appId,
              eventId: event.eventId,
              payloadFormatVersion: event.payload.formatVersion,
              payloadKeyVersion: event.payload.keyVersion,
              encryptedPayload: event.payload.ciphertext,
              status: event.status,
              retryCount: event.retryCount,
              availableAt: event.availableAt,
              leaseOwner: event.leaseOwner,
              leaseExpiresAt: event.leaseExpiresAt,
              leaseGeneration: event.leaseGeneration,
              turnId: event.turnId,
              deliveryCompletedAt: event.deliveryCompletedAt,
              lastErrorCode: event.lastErrorCode,
              completedAt: event.completedAt,
              createdAt: event.createdAt,
            },
            select: { id: true },
          });
          return ok(event);
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          return collidedOnEventId(error)
            ? err(eventDuplicate(event.eventId))
            : err(repositoryUnavailable(`${operation}:${TURN_ALREADY_LINKED}`));
        }
      });
    },

    async saveEvent(event, transaction) {
      const operation = "saveEvent";
      const checked = checkEvent(operation, event);
      if (!checked.ok) return checked;
      return guarded(operation, async () => {
        try {
          await transactions.writer(transaction).channelEventInbox.upsert({
            where: { id: event.inboxId },
            create: {
              id: event.inboxId,
              appId: event.appId,
              eventId: event.eventId,
              payloadFormatVersion: event.payload.formatVersion,
              payloadKeyVersion: event.payload.keyVersion,
              encryptedPayload: event.payload.ciphertext,
              status: event.status,
              retryCount: event.retryCount,
              availableAt: event.availableAt,
              leaseOwner: event.leaseOwner,
              leaseExpiresAt: event.leaseExpiresAt,
              leaseGeneration: event.leaseGeneration,
              turnId: event.turnId,
              deliveryCompletedAt: event.deliveryCompletedAt,
              lastErrorCode: event.lastErrorCode,
              completedAt: event.completedAt,
              createdAt: event.createdAt,
            },
            update: {
              status: event.status,
              retryCount: event.retryCount,
              availableAt: event.availableAt,
              leaseOwner: event.leaseOwner,
              leaseExpiresAt: event.leaseExpiresAt,
              leaseGeneration: event.leaseGeneration,
              turnId: event.turnId,
              deliveryCompletedAt: event.deliveryCompletedAt,
              lastErrorCode: event.lastErrorCode,
              completedAt: event.completedAt,
            },
            select: { id: true },
          });
          return ok(event);
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          return collidedOnEventId(error)
            ? err(eventDuplicate(event.eventId))
            : err(repositoryUnavailable(`${operation}:${TURN_ALREADY_LINKED}`));
        }
      });
    },

    async findClaimableEvents(appId, now, limit) {
      const operation = "findClaimableEvents";
      const malformed = requireUuid<readonly ChannelEvent[]>(operation, "appId", appId);
      if (malformed !== null) return malformed;
      if (!Number.isInteger(limit) || limit <= 0) {
        // A NEGATIVE `take` REVERSES the client's page rather than emptying it,
        // so an unchecked limit does not fail — it hands a poller the NEWEST
        // rows and starves the oldest for as long as the defect lives.
        return err(repositoryUnavailable(`${operation}:${CLAIM_LIMIT_INVALID}:${String(limit)}`));
      }
      return guarded(operation, async () => {
        const rows = await transactions.reader().channelEventInbox.findMany({
          where: {
            appId,
            OR: [
              { status: { in: ["PENDING", "FAILED"] }, availableAt: { lte: now } },
              { status: "PROCESSING", leaseExpiresAt: { lt: now } },
            ],
          },
          orderBy: [...CLAIM_ORDER],
          take: limit,
          select: EVENT_COLUMNS,
        });
        const events: ChannelEvent[] = [];
        for (const row of rows) {
          const read = readEventRow(row);
          if (!read.ok) return err(read.error);
          events.push(read.value);
        }
        return ok(events);
      });
    },
  };
}
