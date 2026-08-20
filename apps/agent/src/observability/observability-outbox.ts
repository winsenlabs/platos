/**
 * Outbox delivery policy.
 *
 * Pure decisions, no I/O: what a failed delivery becomes, when it may be tried
 * again, and when it stops being tried. Kept separate from the service because
 * these are the rules that have to be right and the service is glue.
 *
 * THE RULE THIS FILE ENFORCES: A ROW IS NEVER DROPPED SILENTLY. A delivery
 * either succeeds, or is scheduled for another attempt, or is PARKED as FAILED
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
  attempts: number;
}

/** The shape the payload column is expected to hold. Bumped when rows change. */
export const OBSERVABILITY_PAYLOAD_VERSION = 1;

/** Retained this long after acknowledgement, for replay and for debugging. */
export const DELIVERED_RETENTION_DAYS = 7;

/**
 * Back-off for the next attempt.
 *
 * Exponential from 30 seconds, capped at an hour. Capped rather than unbounded
 * because the drain runs on a schedule an operator reads: a row whose next
 * attempt is nine hours out looks indistinguishable from a row that is stuck.
 */
export function retryDelayMs(attempts: number): number {
  const bounded = Math.max(1, Math.min(32, Math.floor(attempts)));
  return Math.min(3_600_000, 30_000 * 2 ** (bounded - 1));
}

export interface DeliveryOutcome {
  status: OutboxStatus;
  attempts: number;
  /** When the row may next be attempted; null once it is settled or parked. */
  availableAt: Date | null;
  deliveredAt: Date | null;
  lastErrorCode: string | null;
}

export function deliverySucceeded(row: OutboxRow, now: Date): DeliveryOutcome {
  return {
    status: "DELIVERED",
    attempts: row.attempts + 1,
    availableAt: null,
    deliveredAt: now,
    lastErrorCode: null,
  };
}

/**
 * A delivery that did not land.
 *
 * Past `maxAttempts` the row is PARKED, not deleted: the payload stays queryable
 * and the FAILED count is the number an operator has to explain. Parking is the
 * loud version of giving up, and giving up quietly is the failure mode this
 * whole design is a reaction to.
 */
export function deliveryFailed(
  row: OutboxRow,
  now: Date,
  maxAttempts: number,
  errorCode: string,
): DeliveryOutcome {
  const attempts = row.attempts + 1;
  const exhausted = attempts >= maxAttempts;
  return {
    status: exhausted ? "FAILED" : "PENDING",
    attempts,
    availableAt: exhausted ? null : new Date(now.getTime() + retryDelayMs(attempts)),
    deliveredAt: null,
    lastErrorCode: errorCode.slice(0, 200),
  };
}

/**
 * A payload the current writer cannot interpret.
 *
 * Parked immediately rather than retried: a shape mismatch does not heal with
 * time, and burning ten attempts on it delays every well-formed row behind it.
 */
export function deliveryUndeliverable(row: OutboxRow, reason: string): DeliveryOutcome {
  return {
    status: "FAILED",
    attempts: row.attempts + 1,
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
  /** Parked as FAILED — attempts exhausted or payload undeliverable. */
  parked: number;
  /** Delivered rows pruned past their retention window. */
  pruned: number;
  /** Why the pass did nothing, when it did nothing. */
  skipped?: string;
}

export function emptyDrainSummary(skipped?: string): DrainSummary {
  return { claimed: 0, delivered: 0, retried: 0, parked: 0, pruned: 0, ...(skipped ? { skipped } : {}) };
}
