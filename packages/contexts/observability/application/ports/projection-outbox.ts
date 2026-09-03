// The drain side of the transactional outbox.
//
// WHO WRITES THE QUEUE ROW, AND WHY IT IS NOT THIS CONTEXT.
//
// ADR M0.3 §1's closing note and §7 decision 8 put ONE physical outbox behind
// multiple drains, written ONLY by the kernel outbox adapter. That single-writer
// rule is about the WRITE, not about the decision: this context decides what
// each envelope's outcome is — delivered, retried, parked, ignored, discarded —
// and hands that decision back through this port, and the outbox adapter is the
// one place the row actually changes.
//
// So there is no contradiction between "observability drains the outbox" and
// "observability is not the outbox's writer", and this port is the seam that
// keeps both true. `scripts/arch/table-ownership.mjs` records the same split for
// `ObservabilityOutbox` and `Event`.
//
// THIS PORT IS A PER-CONSUMER VIEW OF A SHARED OUTBOX, AND THAT IS LOAD-BEARING.
//
// One physical outbox behind several drains means the progress of one drain
// CANNOT be a column on the shared row. If it were, this context settling an
// envelope it ignored — one belonging to `eventing` — would mark that envelope
// done for `eventing` too, and the notification would never be routed. So an
// implementation of this port is bound to ONE consumer: `claim` returns
// envelopes this consumer has not yet settled, and `settle` records THIS
// consumer's outcome and no one else's. That is why no method here takes a
// consumer identity — the adapter already is one.
//
// It is also why settling an ignored envelope is correct rather than
// destructive: it advances this drain past an envelope that was never its work,
// and leaves every other drain's position untouched.
//
// CLAIMING IS BY VALUE, NOT BY LEASE. The queue is one envelope per unit of
// work, its ids are stable, and the store collapses a redelivered row — so the
// cost of two drains overlapping is a duplicate insert that dedupes, not a
// double charge. A lease would buy nothing and add a lock nobody can see.

import type { DomainEvent, Result } from "@platos/kernel";

import type { DeliveryOutcome, EnvelopeId, QueueDepth } from "../../domain/index.js";

/** One queued envelope, with the bookkeeping the delivery policy needs. */
export interface QueuedEnvelope {
  readonly envelopeId: EnvelopeId;
  /** Self-describing: name, schema version, scope and payload (M0.4 §1.1). */
  readonly event: DomainEvent;
  /** How many times delivery has already been tried. */
  readonly retryCount: number;
}

export interface ClaimEnvelopesRequest {
  /** Upper bound on envelopes returned. */
  readonly limit: number;
  /** Only envelopes due at or before this instant. */
  readonly asOf: Date;
}

export interface ProjectionOutbox {
  /**
   * One page of due envelopes, oldest first.
   *
   * Oldest first because a queue that reorders under load starves its own tail,
   * and the tail is where an operator's oldest unexplained backlog lives.
   */
  claim(request: ClaimEnvelopesRequest): Promise<Result<readonly QueuedEnvelope[]>>;

  /** Record one envelope's decided outcome. */
  settle(envelopeId: EnvelopeId, outcome: DeliveryOutcome): Promise<Result<void>>;

  /**
   * Destroy envelopes outright.
   *
   * The ONLY removal of an unacknowledged envelope in this context, and it is
   * reserved for envelopes whose subject has been erased: delivering one would
   * re-insert an identity a receipt already says is gone. Every other
   * unsuccessful outcome parks or reschedules.
   */
  discard(envelopeIds: readonly EnvelopeId[]): Promise<Result<number>>;

  /**
   * Drop ACKNOWLEDGED envelopes older than `before`.
   *
   * Acknowledged only. An undelivered envelope ageing out is exactly the silent
   * loss the queue replaced, so nothing here may remove one by age.
   */
  prune(before: Date): Promise<Result<number>>;

  /** Pending and parked counts. Reported after every pass, including empty ones. */
  depth(): Promise<Result<QueueDepth>>;
}
