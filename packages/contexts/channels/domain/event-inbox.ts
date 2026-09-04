// `ChannelEventInbox` — durable, idempotent admission for verified channel
// events, and the lease that makes processing them exactly-once-ish.
//
// THE PROBLEM. Providers retry aggressively and give no delivery guarantee
// beyond at-least-once, several workers may poll the same inbox, and a worker
// can die mid-turn holding a row. Nothing here may run a turn twice for one
// provider event.
//
// THE TWO MECHANISMS.
//
//   ADMISSION is idempotent on `[appId, eventId]` — the provider's own event id
//   is the idempotency key, so a redelivery collides with the row already there
//   instead of creating a second one.
//
//   PROCESSING is leased. A claim stamps an owner and an expiry and BUMPS
//   `leaseGeneration`. Every later write re-asserts owner AND generation, so a
//   worker whose lease expired — and whose row another worker has since claimed,
//   bumping the generation — cannot complete, fail or discard it. That is the
//   fence: a slow worker coming back from a GC pause writes nothing.
//
// WHY GENERATION AND NOT JUST OWNER. The same worker can legitimately reclaim a
// row it previously lost. With only `leaseOwner` the fence would pass and the
// stale retry would commit. The generation is monotonic per row, so the old
// retry is distinguishable from the new one even when the owner is identical.
//
// EXPIRY IS STRICTLY `<`. A lease that expires exactly now is still held. The
// claim predicate and the fence must agree on that boundary or a row is briefly
// claimable by two workers at once.

import { err, ok, type Result } from "@platos/kernel";

import { eventLeaseLost, eventNotClaimable } from "./errors.js";
import type {
  ChannelAppId,
  ChannelEventInboxId,
  LeaseOwner,
  ProviderEventId,
  TurnId,
} from "./identifiers.js";

/** The inbox lifecycle. These strings are the persisted `status` values. */
export const CHANNEL_EVENT_STATUSES = Object.freeze([
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "DISCARDED",
] as const);

export type ChannelEventStatus = (typeof CHANNEL_EVENT_STATUSES)[number];

/**
 * The encrypted provider payload, and the two versions needed to read it back.
 *
 * The payload is encrypted BEFORE insertion and request signatures and headers
 * are never persisted. Both versions travel with the ciphertext because a row
 * admitted today must stay decodable after the key rotates and after the
 * envelope format changes: a key id alone cannot tell a reader how to parse what
 * it decrypts.
 */
export interface SealedEventPayload {
  readonly formatVersion: number;
  readonly keyVersion: number;
  readonly ciphertext: string;
}

export interface ChannelEvent {
  readonly inboxId: ChannelEventInboxId;
  readonly appId: ChannelAppId;
  /** The PROVIDER's event id. Immutable, and the idempotency key. */
  readonly eventId: ProviderEventId;
  readonly payload: SealedEventPayload;
  readonly status: ChannelEventStatus;
  /** Retries made, including the one in flight. Bumped on every claim. */
  readonly retryCount: number;
  /** Not claimable before this instant. Backoff is expressed by moving it. */
  readonly availableAt: Date;
  readonly leaseOwner: LeaseOwner | null;
  readonly leaseExpiresAt: Date | null;
  /** Monotonic per row. The fence. */
  readonly leaseGeneration: number;
  /** The turn this event produced, once one exists. Unique across the table. */
  readonly turnId: TurnId | null;
  readonly deliveryCompletedAt: Date | null;
  readonly lastErrorCode: string | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
}

/** A worker's proof it holds the lease. Both halves are checked, always. */
export interface LeaseHold {
  readonly leaseOwner: LeaseOwner;
  readonly leaseGeneration: number;
}

export interface AdmitChannelEventInput {
  readonly inboxId: ChannelEventInboxId;
  readonly appId: ChannelAppId;
  readonly eventId: ProviderEventId;
  readonly payload: SealedEventPayload;
  readonly now: Date;
}

/** A freshly admitted row: immediately claimable, never yet retried. */
export function admitEvent(input: AdmitChannelEventInput): ChannelEvent {
  return Object.freeze({
    inboxId: input.inboxId,
    appId: input.appId,
    eventId: input.eventId,
    payload: input.payload,
    status: "PENDING" as const,
    retryCount: 0,
    availableAt: input.now,
    leaseOwner: null,
    leaseExpiresAt: null,
    leaseGeneration: 0,
    turnId: null,
    deliveryCompletedAt: null,
    lastErrorCode: null,
    completedAt: null,
    createdAt: input.now,
  });
}

/**
 * Whether `event` may be claimed at `now`.
 *
 * Two disjoint ways in: a row waiting its turn (`PENDING`/`FAILED` whose backoff
 * has elapsed), or a row whose holder went away (`PROCESSING` past its expiry).
 * `COMPLETED` and `DISCARDED` are terminal and never claimable — that is what
 * makes admission plus completion an exactly-once pair.
 */
export function isClaimable(event: ChannelEvent, now: Date): boolean {
  if (event.status === "PENDING" || event.status === "FAILED") {
    return event.availableAt.getTime() <= now.getTime();
  }
  if (event.status === "PROCESSING") {
    return event.leaseExpiresAt !== null && event.leaseExpiresAt.getTime() < now.getTime();
  }
  return false;
}

/**
 * Take the lease. Bumps `retryCount` and `leaseGeneration` together: a try
 * and a fence value are the same event, and incrementing one without the other
 * is how a stolen row becomes indistinguishable from a retried one.
 */
export function claimEvent(
  event: ChannelEvent,
  leaseOwner: LeaseOwner,
  leaseMilliseconds: number,
  now: Date,
): Result<{ readonly event: ChannelEvent; readonly hold: LeaseHold }> {
  if (!isClaimable(event, now)) return err(eventNotClaimable(event.inboxId, event.status));

  const leaseGeneration = event.leaseGeneration + 1;
  return ok({
    event: Object.freeze({
      ...event,
      status: "PROCESSING" as const,
      retryCount: event.retryCount + 1,
      leaseOwner,
      leaseExpiresAt: new Date(now.getTime() + leaseMilliseconds),
      leaseGeneration,
    }),
    hold: Object.freeze({ leaseOwner, leaseGeneration }),
  });
}

/**
 * The fence every post-claim write passes through.
 *
 * `completedAt` is checked too, not only the status: a row that reached a
 * terminal state has nothing left to write, and checking it here means every
 * caller inherits that guarantee instead of remembering it.
 */
export function holdsLease(event: ChannelEvent, hold: LeaseHold): boolean {
  return (
    event.status === "PROCESSING" &&
    event.leaseOwner === hold.leaseOwner &&
    event.leaseGeneration === hold.leaseGeneration &&
    event.completedAt === null
  );
}

/** Extend a held lease for a turn that is still running. */
export function renewLease(
  event: ChannelEvent,
  hold: LeaseHold,
  leaseMilliseconds: number,
  now: Date,
): Result<ChannelEvent> {
  if (!holdsLease(event, hold)) return err(eventLeaseLost(event.inboxId));
  return ok(Object.freeze({ ...event, leaseExpiresAt: new Date(now.getTime() + leaseMilliseconds) }));
}

/** Record the turn this event produced, without releasing the lease. */
export function attachTurn(event: ChannelEvent, hold: LeaseHold, turnId: TurnId): Result<ChannelEvent> {
  if (!holdsLease(event, hold)) return err(eventLeaseLost(event.inboxId));
  return ok(Object.freeze({ ...event, turnId }));
}

/**
 * Terminal success. The lease is released by nulling the owner and expiry so a
 * completed row can never look claimable, whatever the clock does afterwards.
 */
export function completeEvent(event: ChannelEvent, hold: LeaseHold, now: Date): Result<ChannelEvent> {
  if (!holdsLease(event, hold)) return err(eventLeaseLost(event.inboxId));
  return ok(
    Object.freeze({
      ...event,
      status: "COMPLETED" as const,
      completedAt: now,
      deliveryCompletedAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
    }),
  );
}

/**
 * Retryable failure. The row goes back to the queue behind a backoff and keeps
 * its `retryCount`, so a caller deciding whether to give up has the count.
 */
export function failEvent(
  event: ChannelEvent,
  hold: LeaseHold,
  errorCode: string,
  retryDelayMilliseconds: number,
  now: Date,
): Result<ChannelEvent> {
  if (!holdsLease(event, hold)) return err(eventLeaseLost(event.inboxId));
  return ok(
    Object.freeze({
      ...event,
      status: "FAILED" as const,
      availableAt: new Date(now.getTime() + retryDelayMilliseconds),
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: errorCode,
    }),
  );
}

/**
 * Terminal failure — a poison event that must not be retried. Distinct from
 * `COMPLETED` so an operator can tell a delivered event from an abandoned one.
 */
export function discardEvent(
  event: ChannelEvent,
  hold: LeaseHold,
  errorCode: string,
  now: Date,
): Result<ChannelEvent> {
  if (!holdsLease(event, hold)) return err(eventLeaseLost(event.inboxId));
  return ok(
    Object.freeze({
      ...event,
      status: "DISCARDED" as const,
      completedAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: errorCode,
    }),
  );
}

/**
 * Claim order: oldest-available first, then oldest-created.
 *
 * `createdAt` is the tie-break rather than an incidental one because
 * `availableAt` is coarse — every freshly admitted row in the same millisecond
 * shares it — and without a stable second key a row can be starved indefinitely
 * while its neighbours are reordered on each poll.
 */
export function byClaimOrder(left: ChannelEvent, right: ChannelEvent): number {
  const available = left.availableAt.getTime() - right.availableAt.getTime();
  return available !== 0 ? available : left.createdAt.getTime() - right.createdAt.getTime();
}
