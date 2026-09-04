// `AlertDelivery` and `AlertDeliveryRetry` — the durable outbound ledger.
//
// One delivery row per (threshold event, channel). Its life is a small state
// machine, and every transition in it exists because of a way a naive dispatcher
// double-sends or silently drops.
//
//   PENDING     the row was created with the event, before anything was sent.
//   PROCESSING  a dispatcher has CLAIMED it.
//   SUCCEEDED   terminal. Never re-sent, by anyone, ever.
//   FAILED      retryable. Visible, with the reason, until it succeeds.
//
// THE CLAIM IS THE WHOLE DESIGN, AND IT IS A LEASE RATHER THAN A LOCK.
//
// A claim writes three things at once: a fresh `claimToken`, an incremented
// `claimGeneration`, and an `availableAt` pushed into the future. The push is
// what makes it a LEASE — a dispatcher that dies mid-send holds nothing, and the
// row becomes claimable again when the lease expires rather than staying stuck
// forever behind a lock nobody will release.
//
// The token and the generation are what make FINALISATION safe. A dispatcher
// finalises by naming the exact token and generation it claimed with; a slow
// dispatcher whose lease expired, and whose row was re-claimed and already
// finalised by someone else, names a stale pair and writes NOTHING. Without that
// check the slow one's `FAILED` would overwrite the fresh one's `SUCCEEDED` and
// the alert would be sent a third time. `finaliseClaim` returns null for exactly
// this case, and every caller treats null as "not mine any more", not as an
// error.
//
// A SUCCEEDED ROW IS IMMUTABLE FROM THE DISPATCHER'S SIDE. It is skipped before
// any claim is written, so a redelivery of a threshold event with four
// recipients — three already delivered — sends exactly one message.
//
// TWO INCOMPATIBLE FINALISERS IN THE SOURCE ARE RESOLVED INTO THIS ONE.
// `BudgetService.finishDeliveryRetry` finalises under a claim; the alert-channel
// test surface has its own `finishDelivery` that reads the current retry count,
// adds one, and writes with no claim at all. Two live dispatchers over one table
// with different concurrency assumptions is how a test send and a budget alert
// come to write the same retry number. Here a claim is a parameter, and the
// unclaimed path is named as what it is: a synchronous send whose result nobody
// is racing for.

import { err, ok, type EnvironmentId, type Result } from "@platos/kernel";

import { deliveryUnavailable } from "./errors.js";
import {
  asCostIdentifier,
  type AlertChannelId,
  type AlertDeliveryId,
  type ClaimToken,
  type IdempotencyKey,
  type ThresholdEventId,
} from "./identifiers.js";

export const DELIVERY_STATUSES = ["PENDING", "PROCESSING", "SUCCEEDED", "FAILED"] as const;

export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** Why a delivery exists. `BUDGET` is fanned out; `TEST` is operator-initiated. */
export const DELIVERY_KINDS = ["BUDGET", "TEST"] as const;

export type DeliveryKind = (typeof DELIVERY_KINDS)[number];

export interface AlertDelivery {
  readonly deliveryId: AlertDeliveryId;
  readonly environmentId: EnvironmentId;
  readonly channelId: AlertChannelId;
  /** Null for a `TEST`: a test send belongs to no threshold crossing. */
  readonly eventId: ThresholdEventId | null;
  readonly kind: DeliveryKind;
  readonly idempotencyKey: IdempotencyKey;
  readonly status: DeliveryStatus;
  readonly retryCount: number;
  readonly claimGeneration: number;
  readonly claimToken: ClaimToken | null;
  /** Not claimable before this instant. The lease expiry and the backoff, in one field. */
  readonly availableAt: Date;
  readonly lastRetryAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly lastStatusCode: number | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** One recorded send, success or failure. Append-only; nothing edits one. */
export interface AlertDeliveryRetry {
  readonly deliveryId: AlertDeliveryId;
  readonly environmentId: EnvironmentId;
  readonly retryNumber: number;
  readonly status: Extract<DeliveryStatus, "SUCCEEDED" | "FAILED">;
  readonly responseStatus: number | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
}

/**
 * What one send produced.
 *
 * THREE DECLARATIONS OF THIS SHAPE IN THE SOURCE BECOME ONE. `AlertDeliveryResult`
 * lives beside the budget dispatcher, `AlertEmailDeliveryResult` beside the email
 * transport, and the test surface passes the same four values as loose positional
 * parameters. All three mean "ok, plus a status code, plus a stable failure token,
 * plus operator-facing text", and the loose one is the reason a caller can and did
 * put the message where the code belonged.
 */
export interface DeliveryOutcome {
  readonly ok: boolean;
  readonly statusCode: number | null;
  /** A stable token an operator can group on. Never free text. */
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export function delivered(statusCode: number | null = null): DeliveryOutcome {
  return { ok: true, statusCode, errorCode: null, errorMessage: null };
}

export function notDelivered(
  errorCode: string,
  errorMessage: string,
  statusCode: number | null = null,
): DeliveryOutcome {
  return { ok: false, statusCode, errorCode, errorMessage };
}

/**
 * The failure tokens this context itself produces, before any transport runs.
 *
 * A `Notifier` adapter contributes its own on top; these are the ones decided
 * here, so the states a channel can be in without any network call are a closed
 * set an operator can be shown.
 */
export const LOCAL_DELIVERY_FAILURES = {
  channelDisabled: "channel_disabled",
  missingConfiguration: "missing_configuration",
  deliveryUnavailable: "delivery_unavailable",
  staleClaim: "stale_claim",
} as const;

/** The idempotency key for a budget fan-out. Unique per event per channel. */
export function budgetIdempotencyKey(
  eventId: ThresholdEventId,
  channelId: AlertChannelId,
): IdempotencyKey {
  return asCostIdentifier<IdempotencyKey>(`budget:${eventId}:${channelId}`);
}

/** The idempotency key for a test send. Unique per invocation, never reused. */
export function testIdempotencyKey(channelId: AlertChannelId, nonce: string): IdempotencyKey {
  return asCostIdentifier<IdempotencyKey>(`test:${channelId}:${nonce}`);
}

/** Terminal. Never claimed, never re-sent. */
export function isSettled(delivery: AlertDelivery): boolean {
  return delivery.status === "SUCCEEDED";
}

/**
 * May this row be claimed at `at`?
 *
 * `PROCESSING` is claimable once its lease has expired — that is what recovers a
 * delivery whose dispatcher died. `SUCCEEDED` never is.
 */
export function isClaimable(delivery: AlertDelivery, at: Date): boolean {
  if (isSettled(delivery)) return false;
  return delivery.availableAt.getTime() <= at.getTime();
}

export interface ClaimTerms {
  /** How long the claim holds the row before another dispatcher may take it. */
  readonly leaseSeconds: number;
  /** How long a failed row waits before it is offered again. */
  readonly retryBackoffSeconds: number;
}

/**
 * Take the row.
 *
 * The retry count is incremented AT CLAIM TIME, not at finalisation. That is the
 * source's ordering and it is the safe one: a dispatcher that claims and then
 * vanishes has still consumed a retry, so a channel whose transport hangs cannot
 * be retried without limit while appearing never to have been tried at all.
 */
export function claim(
  delivery: AlertDelivery,
  token: ClaimToken,
  terms: ClaimTerms,
  at: Date,
): Result<AlertDelivery> {
  if (isSettled(delivery)) {
    return err(deliveryUnavailable(delivery.deliveryId, "already delivered"));
  }
  if (!isClaimable(delivery, at)) {
    return err(deliveryUnavailable(delivery.deliveryId, LOCAL_DELIVERY_FAILURES.deliveryUnavailable));
  }
  return ok({
    ...delivery,
    status: "PROCESSING",
    claimToken: token,
    claimGeneration: delivery.claimGeneration + 1,
    retryCount: delivery.retryCount + 1,
    availableAt: new Date(at.getTime() + terms.leaseSeconds * 1000),
    lastRetryAt: at,
    updatedAt: at,
  });
}

/** The exact pair a finaliser must present. */
export interface ClaimProof {
  readonly token: ClaimToken;
  readonly generation: number;
  readonly retryNumber: number;
}

export function proofOf(delivery: AlertDelivery): Result<ClaimProof> {
  if (delivery.claimToken === null) {
    return err(deliveryUnavailable(delivery.deliveryId, "not claimed"));
  }
  return ok({
    token: delivery.claimToken,
    generation: delivery.claimGeneration,
    retryNumber: delivery.retryCount,
  });
}

/**
 * Finalise a CLAIMED row, or refuse because the claim is stale.
 *
 * Returns `null` — not an error — when the proof does not match. A stale claim is
 * a normal outcome of a lease expiring under a slow transport, and the caller
 * records it as a skip rather than a failure. Raising here would turn a recovered
 * delivery into a reported one.
 */
export function finaliseClaim(
  delivery: AlertDelivery,
  proof: ClaimProof,
  outcome: DeliveryOutcome,
  terms: ClaimTerms,
  at: Date,
): AlertDelivery | null {
  if (
    delivery.status !== "PROCESSING" ||
    delivery.claimToken !== proof.token ||
    delivery.claimGeneration !== proof.generation ||
    delivery.retryCount !== proof.retryNumber
  ) {
    return null;
  }
  return settle(delivery, outcome, terms, at);
}

/**
 * Finalise an UNCLAIMED row — a synchronous test send.
 *
 * The retry number is taken from the row and incremented here, because nothing
 * claimed it. Legal only for `TEST`: a budget fan-out has concurrent
 * dispatchers and must go through the claim.
 */
export function finaliseDirect(
  delivery: AlertDelivery,
  outcome: DeliveryOutcome,
  terms: ClaimTerms,
  at: Date,
): Result<AlertDelivery> {
  if (delivery.kind !== "TEST") {
    return err(deliveryUnavailable(delivery.deliveryId, "a budget delivery must be claimed"));
  }
  return ok(settle({ ...delivery, retryCount: delivery.retryCount + 1 }, outcome, terms, at));
}

function settle(
  delivery: AlertDelivery,
  outcome: DeliveryOutcome,
  terms: ClaimTerms,
  at: Date,
): AlertDelivery {
  return {
    ...delivery,
    status: outcome.ok ? "SUCCEEDED" : "FAILED",
    claimToken: null,
    // A success is available immediately — it will never be offered again, and
    // dating it in the future would only confuse a reader of the row. A failure
    // waits out its backoff.
    availableAt: outcome.ok ? at : new Date(at.getTime() + terms.retryBackoffSeconds * 1000),
    lastRetryAt: at,
    deliveredAt: outcome.ok ? at : null,
    lastStatusCode: outcome.statusCode,
    lastErrorCode: outcome.errorCode,
    lastErrorMessage: outcome.errorMessage,
    updatedAt: at,
  };
}

/** The append-only record of the send just finished. */
export function retryRecord(delivery: AlertDelivery, outcome: DeliveryOutcome, at: Date): AlertDeliveryRetry {
  return {
    deliveryId: delivery.deliveryId,
    environmentId: delivery.environmentId,
    retryNumber: delivery.retryCount,
    status: outcome.ok ? "SUCCEEDED" : "FAILED",
    responseStatus: outcome.statusCode,
    errorCode: outcome.errorCode,
    errorMessage: outcome.errorMessage,
    startedAt: at,
    finishedAt: at,
  };
}

/** What a caller reports back after dispatching one threshold event. */
export interface DeliverySummary {
  readonly delivered: number;
  readonly failed: number;
  readonly skipped: number;
  readonly rows: readonly DeliveryReport[];
}

export interface DeliveryReport {
  readonly deliveryId: AlertDeliveryId;
  readonly channelId: AlertChannelId;
  readonly kind: string;
  readonly status: "SUCCEEDED" | "FAILED" | "SKIPPED";
  readonly statusCode: number | null;
  readonly errorCode: string | null;
}

export const EMPTY_SUMMARY: DeliverySummary = Object.freeze({
  delivered: 0,
  failed: 0,
  skipped: 0,
  rows: Object.freeze([]),
});

/** Fold one report into a summary. */
export function withReport(summary: DeliverySummary, report: DeliveryReport): DeliverySummary {
  return {
    delivered: summary.delivered + (report.status === "SUCCEEDED" ? 1 : 0),
    failed: summary.failed + (report.status === "FAILED" ? 1 : 0),
    skipped: summary.skipped + (report.status === "SKIPPED" ? 1 : 0),
    rows: [...summary.rows, report],
  };
}
