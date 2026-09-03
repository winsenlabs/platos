// An in-memory `ProjectionOutbox`.
//
// It carries the queue bookkeeping the real adapter carries — status, retry
// count, availability instant, acknowledgement instant — because the drain's
// most important behaviours are ABOUT that bookkeeping: an envelope not yet due
// is not claimed, a parked envelope is never claimed again, and an unacknowledged
// envelope is never pruned by age. A double that only held a list could not
// disprove any of them.

import { err, ok, type DomainEvent, type Result } from "@platos/kernel";

import {
  queueUnavailable,
  type DeliveryOutcome,
  type DeliveryStatus,
  type EnvelopeId,
  type QueueDepth,
} from "../../domain/index.js";
import type { ClaimEnvelopesRequest, ProjectionOutbox, QueuedEnvelope } from "../ports/index.js";

interface Entry {
  readonly envelopeId: EnvelopeId;
  readonly event: DomainEvent;
  status: DeliveryStatus;
  retryCount: number;
  availableAt: Date;
  deliveredAt: Date | null;
  lastErrorCode: string | null;
}

export class InMemoryProjectionOutbox implements ProjectionOutbox {
  private readonly entries: Entry[] = [];
  private sequence = 0;

  /** Set to make every claim refuse. */
  claimFails = false;
  /** Set to make every settle refuse — the aborted-pass path. */
  settleFails = false;
  /** Set to make every depth read refuse, so a report must omit the depth. */
  depthFails = false;
  /** Set to make prune refuse. */
  pruneFails = false;

  /** Enqueue one envelope, due now unless a later instant is given. */
  enqueue(event: DomainEvent, options: { availableAt?: Date; retryCount?: number } = {}): EnvelopeId {
    this.sequence += 1;
    const envelopeId = `envelope-${String(this.sequence).padStart(4, "0")}` as EnvelopeId;
    this.entries.push({
      envelopeId,
      event,
      status: "PENDING",
      retryCount: options.retryCount ?? 0,
      availableAt: options.availableAt ?? new Date(0),
      deliveredAt: null,
      lastErrorCode: null,
    });
    return envelopeId;
  }

  find(envelopeId: EnvelopeId): Readonly<Entry> | undefined {
    return this.entries.find((entry) => entry.envelopeId === envelopeId);
  }

  all(): readonly Readonly<Entry>[] {
    return this.entries;
  }

  get size(): number {
    return this.entries.length;
  }

  async claim(request: ClaimEnvelopesRequest): Promise<Result<readonly QueuedEnvelope[]>> {
    if (this.claimFails) return err(queueUnavailable("claim refused"));
    const due = this.entries
      .filter((entry) => entry.status === "PENDING" && entry.availableAt.getTime() <= request.asOf.getTime())
      .sort((left, right) => left.availableAt.getTime() - right.availableAt.getTime())
      .slice(0, request.limit);
    return ok(
      due.map((entry) => ({
        envelopeId: entry.envelopeId,
        event: entry.event,
        retryCount: entry.retryCount,
      })),
    );
  }

  async settle(envelopeId: EnvelopeId, outcome: DeliveryOutcome): Promise<Result<void>> {
    if (this.settleFails) return err(queueUnavailable("settle refused"));
    const entry = this.entries.find((candidate) => candidate.envelopeId === envelopeId);
    if (entry === undefined) return err(queueUnavailable(`no such envelope ${envelopeId}`));
    entry.status = outcome.status;
    entry.retryCount = outcome.retryCount;
    // A settled or parked envelope keeps its last availability instant rather
    // than gaining a null: "when it was last due" is more useful to an operator
    // than a reset clock, and the real column is NOT NULL.
    if (outcome.availableAt !== null) entry.availableAt = outcome.availableAt;
    entry.deliveredAt = outcome.deliveredAt;
    entry.lastErrorCode = outcome.lastErrorCode;
    return ok(undefined);
  }

  async discard(envelopeIds: readonly EnvelopeId[]): Promise<Result<number>> {
    let removed = 0;
    for (const envelopeId of envelopeIds) {
      const index = this.entries.findIndex((entry) => entry.envelopeId === envelopeId);
      if (index >= 0) {
        this.entries.splice(index, 1);
        removed += 1;
      }
    }
    return ok(removed);
  }

  async prune(before: Date): Promise<Result<number>> {
    if (this.pruneFails) return err(queueUnavailable("prune refused"));
    let removed = 0;
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry === undefined) continue;
      // Acknowledged only, and only by its acknowledgement instant.
      if (entry.status !== "DELIVERED" || entry.deliveredAt === null) continue;
      if (entry.deliveredAt.getTime() >= before.getTime()) continue;
      this.entries.splice(index, 1);
      removed += 1;
    }
    return ok(removed);
  }

  async depth(): Promise<Result<QueueDepth>> {
    if (this.depthFails) return err(queueUnavailable("depth refused"));
    return ok({
      pending: this.entries.filter((entry) => entry.status === "PENDING").length,
      failed: this.entries.filter((entry) => entry.status === "FAILED").length,
    });
  }
}
