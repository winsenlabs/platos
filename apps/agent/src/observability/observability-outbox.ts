/**
 * Outbox delivery policy.
 *
 * Pure decisions, no I/O: what a failed delivery becomes, when it may be tried
 * again, and when it stops being tried. Kept separate from the service because
 * these are the rules that have to be right and the service is glue.
 *
 * THE RULE THIS FILE ENFORCES: A ROW IS NEVER DROPPED SILENTLY. A delivery
 * either succeeds, or is scheduled for another retry, or is PARKED as FAILED
 * where a human can see it and a metric can count it. There is no branch that
 * removes an unacknowledged row, because the entire reason the outbox exists is
 * that the previous design — fire-and-forget with a best-effort Redis list —
 * could lose telemetry and report nothing.
 */

export type OutboxStatus = "PENDING" | "DELIVERED" | "FAILED";

export interface OutboxRow {
  id: string;
  turnId: string;
  organizationId: string;
  payloadVersion: number;
  payload: unknown;
  status: OutboxStatus;
  retryCount: number;
}

/** The shape the payload column is expected to hold. Bumped when rows change. */
export const OBSERVABILITY_PAYLOAD_VERSION = 1;

/** Retained this long after acknowledgement, for replay and for debugging. */
export const DELIVERED_RETENTION_DAYS = 7;

/**
 * Back-off for the next retry.
 *
 * Exponential from 30 seconds, capped at an hour. Capped rather than unbounded
 * because the drain runs on a schedule an operator reads: a row whose next
 * retry is nine hours out looks indistinguishable from a row that is stuck.
 */
export function retryDelayMs(retryCount: number): number {
  const bounded = Math.max(1, Math.min(32, Math.floor(retryCount)));
  return Math.min(3_600_000, 30_000 * 2 ** (bounded - 1));
}

export interface DeliveryOutcome {
  status: OutboxStatus;
  retryCount: number;
  /** When the row may next be retried; null once it is settled or parked. */
  availableAt: Date | null;
  deliveredAt: Date | null;
  lastErrorCode: string | null;
}

export function deliverySucceeded(row: OutboxRow, now: Date): DeliveryOutcome {
  return {
    status: "DELIVERED",
    retryCount: row.retryCount + 1,
    availableAt: null,
    deliveredAt: now,
    lastErrorCode: null,
  };
}

/**
 * A delivery that did not land.
 *
 * At `maxRetries` the row is PARKED, not deleted: the payload stays queryable
 * and the FAILED count is the number an operator has to explain. Parking is the
 * loud version of giving up, and giving up quietly is the failure mode this
 * whole design is a reaction to.
 */
export function deliveryFailed(
  row: OutboxRow,
  now: Date,
  maxRetries: number,
  errorCode: string,
): DeliveryOutcome {
  const retryCount = row.retryCount + 1;
  const exhausted = retryCount >= maxRetries;
  return {
    status: exhausted ? "FAILED" : "PENDING",
    retryCount,
    availableAt: exhausted ? null : new Date(now.getTime() + retryDelayMs(retryCount)),
    deliveredAt: null,
    lastErrorCode: errorCode.slice(0, 200),
  };
}

/**
 * A payload the current writer cannot interpret.
 *
 * Parked immediately rather than retried: a shape mismatch does not heal with
 * time, and burning ten retries on it delays every well-formed row behind it.
 */
export function deliveryUndeliverable(row: OutboxRow, reason: string): DeliveryOutcome {
  return {
    status: "FAILED",
    retryCount: row.retryCount + 1,
    availableAt: null,
    deliveredAt: null,
    lastErrorCode: reason.slice(0, 200),
  };
}

/** Rows this writer understands. A newer payload belongs to a newer writer. */
export function isDeliverableVersion(row: OutboxRow): boolean {
  return row.payloadVersion === OBSERVABILITY_PAYLOAD_VERSION;
}

export interface DrainSummary {
  /** Rows read from the queue this pass. */
  claimed: number;
  delivered: number;
  /** Failed but rescheduled. */
  retried: number;
  /** Parked as FAILED — retries exhausted or payload undeliverable. */
  parked: number;
  /** Delivered rows pruned past their retention window. */
  pruned: number;
  /**
   * Rows destroyed because their subject was erased before they were delivered.
   *
   * The one branch that removes an unacknowledged row, and it is not a loss: an
   * erasure has legally destroyed the thing the row describes, so delivering it
   * would put the identity BACK. Counted rather than silent, per this file's
   * rule.
   */
  discarded: number;
  /** Batches the pass worked through. One drain is a loop, not a single read. */
  passes: number;
  /**
   * Queue depth AFTER the pass — the number nobody could see before.
   *
   * `parked` counts rows parked during THIS pass, so a row parked at 09:00 was
   * announced once and every later pass reported zero. Absent when the depth
   * could not be read; a missing count is not the same claim as zero.
   */
  queue?: { pending: number; failed: number };
  /** Why the pass did nothing, when it did nothing. */
  skipped?: string;
  /** The pass failed outright. A drain that threw is never reported as `ok`. */
  failure?: string;
}

export function emptyDrainSummary(skipped?: string): DrainSummary {
  return {
    claimed: 0,
    delivered: 0,
    retried: 0,
    parked: 0,
    pruned: 0,
    discarded: 0,
    passes: 0,
    ...(skipped ? { skipped } : {}),
  };
}

/**
 * A drain that threw.
 *
 * Distinct from `skipped`, which is the honest answer for an absent or
 * unreachable sink — a state the runtime is designed for and reports at warn.
 * Folding a thrown drain into the same field made a persistently failing drain
 * indistinguishable from "no observability sink configured", which produced no
 * error-level signal anywhere and a green scheduled run.
 */
export function failedDrainSummary(failure: string): DrainSummary {
  return { ...emptyDrainSummary(), failure };
}
