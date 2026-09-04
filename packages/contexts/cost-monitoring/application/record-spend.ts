// Use cases: put spend into the near-line counters.
//
// THIS CONTEXT WRITES THE TURN COUNTER AND NOTHING ELSE.
//
// That sentence is the correction of a measured defect, and it is worth the
// space. The extraction source's `recordUserSpend` used to increment the COST
// field on the very key the pricing path had just incremented with the same
// charge. Two writers, one field: every per-user cost surface read exactly twice
// the real figure while the cache-aware total, written once, read correctly. So
// the two disagreed by a factor of two, both were arithmetically defensible on
// their own terms, and nobody could say which was right.
//
// The rule that came out of it is that a counter has ONE writer. Cost is written
// by the path that priced the work; this context writes turns, which nothing else
// writes, and reads everything.
//
// RESERVATIONS ARE WHY A CAP HOLDS UNDER CONCURRENCY. Two turns from one
// principal starting at the same instant both read the same window, both see room,
// and both proceed — unless the first one's estimate is already in the window when
// the second reads it. `reserveSpend` puts it there; `settleSpend` replaces it with
// the real figure in ONE operation, because between a release and a charge there
// is an instant in which the spend is invisible to every concurrent guard.

import { err, ok, type EnvironmentScope, type Money, type Result } from "@platos/kernel";

import { dayStamp } from "../domain/index.js";
import type { CostMonitoringDependencies } from "./dependencies.js";
import type { ReservationHandle, SpendSubject } from "./ports/index.js";

export interface RecordTurnCommand {
  readonly scope: EnvironmentScope;
  readonly subject: SpendSubject;
}

export interface ReserveSpendCommand {
  readonly scope: EnvironmentScope;
  readonly subject: SpendSubject;
  readonly estimate: Money;
}

export interface SettleSpendCommand {
  readonly handle: ReservationHandle;
  readonly actual: Money;
}

/**
 * Record one completed turn.
 *
 * A turn, never a model call. Embedding, compaction and thread naming all make
 * model calls, and counting those as turns is what once reported an agent that
 * searched, read three documents and replied as five billable units instead of
 * one.
 */
export async function recordTurn(
  dependencies: CostMonitoringDependencies,
  command: RecordTurnCommand,
): Promise<Result<void>> {
  return dependencies.ledger.recordTurn(
    command.scope,
    command.subject,
    dayStamp(dependencies.clock.now()),
  );
}

/** Hold an estimate against the window while a turn runs. */
export async function reserveSpend(
  dependencies: CostMonitoringDependencies,
  command: ReserveSpendCommand,
): Promise<Result<ReservationHandle>> {
  return dependencies.ledger.reserve(
    command.scope,
    command.subject,
    dayStamp(dependencies.clock.now()),
    command.estimate,
  );
}

/**
 * Replace a reservation with what the work actually cost.
 *
 * The exact reconcile ADR §7 decision 3(b) puts off the outbox: the guard runs on
 * an estimate, and this is where the estimate becomes the truth.
 */
export async function settleSpend(
  dependencies: CostMonitoringDependencies,
  command: SettleSpendCommand,
): Promise<Result<void>> {
  return dependencies.ledger.settle(command.handle, command.actual);
}

/** Give a reservation back — the turn never ran. */
export async function releaseSpend(
  dependencies: CostMonitoringDependencies,
  handle: ReservationHandle,
): Promise<Result<void>> {
  return dependencies.ledger.release(handle);
}

/**
 * Settle a reservation with a figure `providers` priced.
 *
 * The convenience the runtime actually wants: it holds a token count, not an
 * amount, and the amount is `providers`' to compute. Kept here rather than in the
 * caller so there is one place the two contexts meet on a settled turn, and so a
 * pricing failure settles nothing rather than settling zero.
 */
export async function settlePricedSpend(
  dependencies: CostMonitoringDependencies,
  command: { readonly handle: ReservationHandle; readonly amount: Result<Money> },
): Promise<Result<void>> {
  if (!command.amount.ok) return err(command.amount.error);
  const settled = await dependencies.ledger.settle(command.handle, command.amount.value);
  if (!settled.ok) return err(settled.error);
  return ok(undefined);
}
