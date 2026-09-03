// Delivery policy: what a failed delivery becomes, when it may be tried again,
// and when it stops being tried.
//
// Pure decisions, no I/O. Kept apart from the drain use case because these are
// the rules that have to be right and the use case is sequencing.
//
// THE RULE THIS FILE ENFORCES: A QUEUED PROJECTION IS NEVER DROPPED SILENTLY. A
// delivery either succeeds, or is scheduled for another try, or is PARKED where
// a human can see it and a count can report it. There is exactly ONE branch that
// removes an unacknowledged envelope — `discard`, below — and it exists because
// delivering that envelope would put an erased identity back. It is counted,
// never silent.
//
// The alternative this replaced could lose telemetry and report nothing, which
// is why "parked" is loud and why the queue depth travels with every report even
// when the pass did nothing.

import type { DomainError } from "@platos/kernel";

import type { EnvelopeId } from "./identifiers.js";

export const DELIVERY_STATUSES = ["PENDING", "DELIVERED", "FAILED"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** Retained this long after acknowledgement, for replay and for debugging. */
export const DELIVERED_RETENTION_DAYS = 7;

/** Default number of tries before an envelope is parked. */
export const DEFAULT_MAX_RETRIES = 10;

/** Envelopes read per claim. */
export const DEFAULT_CLAIM_BATCH_SIZE = 500;

/** Envelopes one drain CALL may deliver, across as many claims as it takes. */
export const DEFAULT_DRAIN_MAX_ROWS = 50_000;

/** Wall clock a single drain may spend delivering. */
export const DEFAULT_DRAIN_DEADLINE_MS = 45_000;

/** Back-off floor and ceiling. */
const RETRY_BASE_MS = 30_000;
const RETRY_CEILING_MS = 3_600_000;
const RETRY_EXPONENT_CAP = 32;

export interface DrainBudget {
  /** Envelopes this call may deliver in total. */
  readonly maxRows: number;
  /** Envelopes read per claim. */
  readonly claimBatchSize: number;
  /** Tries allowed before an envelope is parked. */
  readonly maxRetries: number;
  /** Wall clock the call may spend. */
  readonly deadlineMs: number;
}

export const DEFAULT_DRAIN_BUDGET: DrainBudget = Object.freeze({
  maxRows: DEFAULT_DRAIN_MAX_ROWS,
  claimBatchSize: DEFAULT_CLAIM_BATCH_SIZE,
  maxRetries: DEFAULT_MAX_RETRIES,
  deadlineMs: DEFAULT_DRAIN_DEADLINE_MS,
});

/**
 * Back-off for the next try.
 *
 * Exponential from thirty seconds, capped at an hour. CAPPED rather than
 * unbounded because the drain runs on a schedule an operator reads: an envelope
 * whose next try is nine hours out is indistinguishable, on that schedule, from
 * an envelope that is stuck. The exponent is bounded before it is used so a
 * corrupt counter cannot overflow the shift into `Infinity`.
 */
export function retryDelayMs(retryCount: number): number {
  const bounded = Math.max(1, Math.min(RETRY_EXPONENT_CAP, Math.floor(retryCount)));
  return Math.min(RETRY_CEILING_MS, RETRY_BASE_MS * 2 ** (bounded - 1));
}

/** One queued envelope's bookkeeping, as the drain sees it. */
export interface EnvelopeState {
  readonly envelopeId: EnvelopeId;
  readonly retryCount: number;
}

export interface DeliveryOutcome {
  readonly status: DeliveryStatus;
  readonly retryCount: number;
  /** When it may next be tried; null once it is settled or parked. */
  readonly availableAt: Date | null;
  readonly deliveredAt: Date | null;
  /** Error CODE only. A store quotes the failing statement in its bodies. */
  readonly lastErrorCode: string | null;
}

export function deliverySucceeded(state: EnvelopeState, now: Date): DeliveryOutcome {
  return {
    status: "DELIVERED",
    retryCount: state.retryCount + 1,
    availableAt: null,
    deliveredAt: now,
    lastErrorCode: null,
  };
}

/**
 * A delivery that did not land.
 *
 * At `maxRetries` the envelope is PARKED, not deleted: the payload stays
 * queryable and the parked count is the number an operator has to explain.
 * Parking is the loud version of giving up, and giving up quietly is the failure
 * mode this whole design is a reaction to.
 */
export function deliveryFailed(
  state: EnvelopeState,
  now: Date,
  maxRetries: number,
  error: DomainError,
): DeliveryOutcome {
  const retryCount = state.retryCount + 1;
  const exhausted = retryCount >= maxRetries;
  return {
    status: exhausted ? "FAILED" : "PENDING",
    retryCount,
    availableAt: exhausted ? null : new Date(now.getTime() + retryDelayMs(retryCount)),
    deliveredAt: null,
    lastErrorCode: error.code,
  };
}

/**
 * A payload this drain cannot interpret.
 *
 * Parked immediately rather than retried: a shape mismatch and a version this
 * binary is too old to read do not heal with time, and burning ten tries on one
 * delays every well-formed envelope behind it.
 */
export function deliveryUndeliverable(state: EnvelopeState, error: DomainError): DeliveryOutcome {
  return {
    status: "FAILED",
    retryCount: state.retryCount + 1,
    availableAt: null,
    deliveredAt: null,
    lastErrorCode: error.code,
  };
}

/** True when the outcome leaves the envelope eligible for another try. */
export function willBeRetried(outcome: DeliveryOutcome): boolean {
  return outcome.status === "PENDING";
}

/** True when the outcome parks the envelope for a human. */
export function wasParked(outcome: DeliveryOutcome): boolean {
  return outcome.status === "FAILED";
}

export interface QueueDepth {
  readonly pending: number;
  readonly failed: number;
}

export interface DrainReport {
  /** Envelopes read from the queue this pass. */
  readonly claimed: number;
  readonly delivered: number;
  /** Failed but rescheduled. */
  readonly retried: number;
  /** Parked — tries exhausted, or the payload is undeliverable. */
  readonly parked: number;
  /**
   * Acknowledged without being written, because the envelope is not ours.
   *
   * ADR M0.3 §7 decision 8 puts ONE outbox behind multiple drains, so this drain
   * necessarily sees envelopes belonging to `eventing`. M0.4 §1.1 has a reader
   * ignore an unknown event NAME rather than fail on it — so an unrecognised
   * name is settled and counted here, and is emphatically NOT parked. Parking
   * another drain's envelopes would fill the failed count with events that were
   * never this context's to deliver.
   */
  readonly ignored: number;
  /** Acknowledged envelopes pruned past their retention window. */
  readonly pruned: number;
  /**
   * Envelopes destroyed because their subject was erased before delivery.
   *
   * The one branch that removes an unacknowledged envelope, and it is not a
   * loss: an erasure has legally destroyed the thing it describes, so delivering
   * it would put the identity BACK. Counted rather than silent.
   */
  readonly discarded: number;
  /** Claims the pass worked through. One drain is a loop, not a single read. */
  readonly passes: number;
  /**
   * Queue depth AFTER the pass — the number nobody could see before.
   *
   * `parked` counts envelopes parked during THIS pass, so one parked at 09:00
   * was announced once and every later pass reported zero. Absent when the depth
   * could not be read: a missing count is not the same claim as zero.
   */
  readonly depth: QueueDepth | null;
  /** Why the pass stopped, or did nothing. */
  readonly stoppedBecause: string | null;
}

export function emptyDrainReport(stoppedBecause: string | null = null): DrainReport {
  return {
    claimed: 0,
    delivered: 0,
    retried: 0,
    parked: 0,
    ignored: 0,
    pruned: 0,
    discarded: 0,
    passes: 0,
    depth: null,
    stoppedBecause,
  };
}

/**
 * Every envelope the pass claimed is accounted for by exactly one outcome.
 *
 * The conservation law this queue exists to uphold, stated as a predicate so a
 * test can assert it rather than an operator having to notice. `pruned` is NOT
 * in it: pruning removes already-acknowledged envelopes from earlier passes and
 * has nothing to do with what this pass claimed.
 */
export function reportIsConserved(report: DrainReport): boolean {
  return (
    report.delivered + report.retried + report.parked + report.ignored + report.discarded ===
    report.claimed
  );
}

/** A budget a caller asked for, or a reason it is not one. */
export function resolveDrainBudget(
  requested: Partial<DrainBudget> | undefined,
  defaults: DrainBudget = DEFAULT_DRAIN_BUDGET,
): DrainBudget {
  const positive = (value: number | undefined, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
  return {
    maxRows: positive(requested?.maxRows, defaults.maxRows),
    claimBatchSize: positive(requested?.claimBatchSize, defaults.claimBatchSize),
    maxRetries: positive(requested?.maxRetries, defaults.maxRetries),
    deadlineMs: positive(requested?.deadlineMs, defaults.deadlineMs),
  };
}

/** The cut-off before which an acknowledged envelope may be pruned. */
export function retentionCutoff(now: Date, days: number = DELIVERED_RETENTION_DAYS): Date {
  return new Date(now.getTime() - days * 86_400_000);
}
