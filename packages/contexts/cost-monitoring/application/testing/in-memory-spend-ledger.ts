// An in-memory `SpendLedger`.
//
// It keeps the shape the real counter store has — daily buckets, a parallel
// reservation series, string-valued fields — because those are the properties
// the arithmetic depends on. A double that returned numbers would hide the
// string parsing every real read goes through, and a double with one bucket per
// window would hide the fold a weekly cap does over seven.
//
// THE KEY DERIVATION IS THE DOUBLE'S, AND THAT IS THE POINT. The port
// deliberately does not fix a key shape (see its note), so this file gets to
// choose one — and the fact that it can choose freely, and every use case still
// passes, is the evidence that no key shape leaked out of the adapter.

import { err, ok, zero, type EnvironmentScope, type Money, type Result } from "@platos/kernel";

import { ledgerUnavailable } from "../../domain/index.js";
import type { DayStamp, SpendCounters } from "../../domain/index.js";
import type {
  ReservationHandle,
  SpendLedger,
  SpendSubject,
  SpendWindowBuckets,
  SpendWindowQuery,
} from "../ports/index.js";

interface Bucket {
  costCents: number;
  costWithCacheCents: number | null;
  tasks: number;
}

function emptyBucket(): Bucket {
  return { costCents: 0, costWithCacheCents: null, tasks: 0 };
}

/** What a caller seeds one bucket with. Both cost fields, so the preference is testable. */
export interface SeededSpend {
  readonly costCents?: number;
  readonly costWithCacheCents?: number | null;
  readonly tasks?: number;
}

export class InMemorySpendLedger implements SpendLedger {
  private readonly settled = new Map<string, Bucket>();
  private readonly reserved = new Map<string, Bucket>();
  private readonly handles = new Map<string, string>();
  private sequence = 0;

  /** Windows this double was asked to read. Proves which series a cap used. */
  readonly reads: SpendWindowQuery[] = [];
  /** Set to make every read fail, for the fail-open tests. */
  unavailable = false;

  seed(
    scope: EnvironmentScope,
    subject: SpendSubject,
    day: DayStamp,
    spend: SeededSpend,
  ): void {
    const bucket = this.settled.get(keyOf(scope, subject, day)) ?? emptyBucket();
    bucket.costCents += spend.costCents ?? 0;
    if (spend.costWithCacheCents !== undefined) {
      bucket.costWithCacheCents = spend.costWithCacheCents;
    }
    bucket.tasks += spend.tasks ?? 0;
    this.settled.set(keyOf(scope, subject, day), bucket);
  }

  seedReserved(
    scope: EnvironmentScope,
    subject: SpendSubject,
    day: DayStamp,
    spend: SeededSpend,
  ): void {
    const bucket = this.reserved.get(keyOf(scope, subject, day)) ?? emptyBucket();
    bucket.costCents += spend.costCents ?? 0;
    if (spend.costWithCacheCents !== undefined) {
      bucket.costWithCacheCents = spend.costWithCacheCents;
    }
    this.reserved.set(keyOf(scope, subject, day), bucket);
  }

  async readWindow(query: SpendWindowQuery): Promise<Result<SpendWindowBuckets>> {
    this.reads.push(query);
    if (this.unavailable) {
      return err(ledgerUnavailable("in-memory ledger was told to fail"));
    }
    const settled: SpendCounters[] = [];
    const reserved: SpendCounters[] = [];
    for (const day of query.days) {
      const key = keyOf(query.scope, query.subject, day);
      settled.push(render(this.settled.get(key)));
      if (query.includeReserved) reserved.push(render(this.reserved.get(key)));
    }
    return ok({ settled, reserved });
  }

  async recordTurn(
    scope: EnvironmentScope,
    subject: SpendSubject,
    day: DayStamp,
  ): Promise<Result<void>> {
    const key = keyOf(scope, subject, day);
    const bucket = this.settled.get(key) ?? emptyBucket();
    bucket.tasks += 1;
    this.settled.set(key, bucket);
    return ok(undefined);
  }

  async reserve(
    scope: EnvironmentScope,
    subject: SpendSubject,
    day: DayStamp,
    estimate: Money,
  ): Promise<Result<ReservationHandle>> {
    const key = keyOf(scope, subject, day);
    const bucket = this.reserved.get(key) ?? emptyBucket();
    bucket.costWithCacheCents = (bucket.costWithCacheCents ?? 0) + toCents(estimate);
    this.reserved.set(key, bucket);
    this.sequence += 1;
    const handle = { reservationId: `res-${this.sequence}` };
    this.handles.set(handle.reservationId, key);
    return ok(handle);
  }

  async settle(handle: ReservationHandle, actual: Money): Promise<Result<void>> {
    const key = this.handles.get(handle.reservationId);
    if (key === undefined) return err(ledgerUnavailable("no such reservation"));
    // One operation, never a release followed by a charge: between the two there
    // is an instant in which the spend is invisible to every concurrent guard.
    this.reserved.delete(key);
    const bucket = this.settled.get(key) ?? emptyBucket();
    bucket.costWithCacheCents = (bucket.costWithCacheCents ?? 0) + toCents(actual);
    this.settled.set(key, bucket);
    this.handles.delete(handle.reservationId);
    return ok(undefined);
  }

  async release(handle: ReservationHandle): Promise<Result<void>> {
    const key = this.handles.get(handle.reservationId);
    if (key !== undefined) this.reserved.delete(key);
    this.handles.delete(handle.reservationId);
    return ok(undefined);
  }
}

function render(bucket: Bucket | undefined): SpendCounters {
  // A MISSING bucket is an empty one, not an error: most days in a monthly
  // window have no spend at all.
  if (bucket === undefined) return {};
  return {
    costCents: String(bucket.costCents),
    // `null` is genuinely absent, so the cache-aware preference falls back.
    // `0` is genuinely zero and must not.
    costWithCacheCents: bucket.costWithCacheCents === null ? null : String(bucket.costWithCacheCents),
    tasks: String(bucket.tasks),
  };
}

function toCents(amount: Money): number {
  return Number(amount.microCents) / 1_000_000;
}

function keyOf(scope: EnvironmentScope, subject: SpendSubject, day: DayStamp): string {
  const series =
    subject.kind === "environment"
      ? "environment"
      : subject.kind === "agent"
        ? `agent:${subject.agentId}`
        : subject.kind === "user"
          ? `user:${subject.userId}`
          : `tier:${subject.tier}:${subject.skillSlug}:${subject.agentId}`;
  return `${scope.environmentId}|${series}|${day}`;
}

/** Zero, for a caller that wants the empty amount without importing the kernel. */
export const NO_SPEND: Money = zero();
