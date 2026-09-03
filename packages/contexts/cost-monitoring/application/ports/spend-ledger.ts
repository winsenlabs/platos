// The `SpendLedger` port — the near-line spend counters.
//
// Enforcement cannot read the canonical Turn/Step ledger. A cap has to be
// checked BEFORE a turn runs and again during it, and the canonical rows are not
// written until it finishes. So there is a second, faster, coarser record: daily
// buckets per subject, incremented as work completes, expiring after a retention
// window. That record is what this port is.
//
// WHAT IT IS AND IS NOT.
//
//   It is APPEND-ONLY and NOT idempotent. A replayed turn double-counts. The
//   canonical Postgres ledger remains the source of truth for billing; these
//   buckets are the fast path for enforcement, and the source says so in as many
//   words. A port that promised idempotence here would be promising something no
//   counter store delivers cheaply.
//
//   It is BUCKETED BY DAY, always, whatever the cap's period. A weekly cap reads
//   seven buckets and a monthly cap reads up to thirty-one. Storing a bucket per
//   period instead would need every period's counter incremented on every write,
//   and a new period would be unbackfillable.
//
//   It carries RESERVATIONS as a parallel set of buckets. A turn reserves an
//   estimate when it starts and settles the real figure when it ends. Without
//   that, two concurrent turns from one principal both read "under cap" and both
//   proceed — which is the exact defect the reserved buckets were added for.
//
// THE KEY SHAPES ARE THE ADAPTER'S BUSINESS, not this port's. A key is derived
// from a scope, a subject and a day; naming the derivation here would fix a
// particular store's namespace in the domain and make the tier-aware reader and
// the writer able to disagree about it — which they did, in the source, over the
// placeholder used for an absent dimension.

import type { EnvironmentScope, Money, Result } from "@platos/kernel";

import type { BudgetTier, DayStamp, SpendCounters } from "../../domain/index.js";

/** Which counter series a read or a write addresses. */
export type SpendSubject =
  | { readonly kind: "environment" }
  | { readonly kind: "agent"; readonly agentId: string }
  | { readonly kind: "user"; readonly userId: string }
  | {
      readonly kind: "tier";
      readonly tier: BudgetTier;
      /** Empty string, not a sentinel, when the dimension is absent. */
      readonly skillSlug: string;
      readonly agentId: string;
    };

export interface SpendWindowQuery {
  readonly scope: EnvironmentScope;
  readonly subject: SpendSubject;
  /** The daily buckets to fold, newest first. */
  readonly days: readonly DayStamp[];
  /** Whether to fold the parallel reservation buckets too. */
  readonly includeReserved: boolean;
}

/** What one window read returned, before the domain folds it. */
export interface SpendWindowBuckets {
  readonly settled: readonly SpendCounters[];
  readonly reserved: readonly SpendCounters[];
}

export interface SpendLedger {
  /**
   * Read a window's buckets.
   *
   * A MISSING bucket is an empty one, not an error: most days in a monthly
   * window have no spend, and a store that errored on a missing key would make
   * every read of a new environment fail.
   */
  readWindow(query: SpendWindowQuery): Promise<Result<SpendWindowBuckets>>;

  /**
   * Record one completed turn against a subject's counter.
   *
   * This context writes the TURN counter and nothing else. The cost fields have
   * a different sole writer, and the source records what happened when that was
   * not true: this method also incremented the cost field its sibling had just
   * incremented with the same charge, so every per-user cost surface read
   * exactly twice the real figure while the cache-aware total read once.
   */
  recordTurn(scope: EnvironmentScope, subject: SpendSubject, day: DayStamp): Promise<Result<void>>;

  /**
   * Reserve an estimated amount for a turn that is starting.
   *
   * The returned handle settles or releases it. A reservation with no handle
   * would have to be matched by amount, and two identical concurrent turns
   * would release each other's.
   */
  reserve(
    scope: EnvironmentScope,
    subject: SpendSubject,
    day: DayStamp,
    estimate: Money,
  ): Promise<Result<ReservationHandle>>;

  /**
   * Replace a reservation with the settled figure.
   *
   * One operation, not a release followed by a charge: between the two there is
   * an instant in which the spend is invisible to every concurrent guard.
   */
  settle(handle: ReservationHandle, actual: Money): Promise<Result<void>>;

  /** Give a reservation back — the turn never ran. */
  release(handle: ReservationHandle): Promise<Result<void>>;
}

/** Opaque: it names a reservation, and carries no store detail. */
export interface ReservationHandle {
  readonly reservationId: string;
}
