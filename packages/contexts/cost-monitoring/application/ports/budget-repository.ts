// The `BudgetRepository` port — the canonical store, seen only as an interface.
//
// ADR M0.3 §1 row 13 makes this context the SOLE WRITER of `Budget`,
// `BudgetThresholdEvent`, `AlertChannel`, `AlertChannelConfiguration`,
// `AlertDelivery` and `AlertDeliveryRetry`. This port is where that ownership is
// expressed: every mutation of those six tables passes through a method below,
// and there is deliberately no generic `save(row)` or `query(where)` escape hatch
// another context could reach sideways.
//
// EVERY READ TAKES AN `EnvironmentScope`. All six tables are environment-scoped;
// none of them has an installation-global sibling. An implementation MUST return
// `null` — never a row from another environment — when an id exists elsewhere.
// There is no `findBudget(id)`: making the scope a parameter is what stops a
// scope-less lookup from compiling.
//
// EVERY MUTATION TAKES A `TransactionScope`. The kernel's handle is opaque by
// construction (ADR M0.3 §3: no context passes a vendor transaction handle
// across a port), which is what lets a threshold event and its delivery rows be
// written atomically without either side naming the other's technology.
//
// EVERY METHOD RETURNS `Result`. A rejected promise is a defect, not an outcome.
//
// TWO METHODS ARE CONSTRAINT-SHAPED AND THEIR CONTRACTS ARE BINDING:
//
//   `insertThresholdEvent` MUST surface a `@@unique([budgetId, windowKey,
//   threshold])` violation as `null` rather than as an error. A duplicate is the
//   NORMAL outcome of two evaluators racing on one crossing, and it is the
//   mechanism by which an alert fires exactly once. An implementation that
//   converted it into an update, or shifted the window key to the next free
//   value, would send the alert twice.
//
//   `claimDelivery` MUST be a single conditional write. An implementation that
//   reads the row, decides in application code and then writes has a window
//   between the read and the write in which a second dispatcher can claim the
//   same row, and both will send.

import type { EnvironmentScope, Result, TransactionScope } from "@platos/kernel";

import type {
  AlertChannel,
  AlertChannelId,
  AlertDelivery,
  AlertDeliveryId,
  AlertDeliveryRetry,
  Budget,
  BudgetId,
  ClaimToken,
  ChannelKind,
  DeliveryStatus,
  ThresholdEvent,
  ThresholdEventId,
  WindowKey,
} from "../../domain/index.js";

/** One page of a listing, with the total the surface renders beside it. */
export interface BudgetPage {
  readonly items: readonly Budget[];
  readonly total: number;
}

export interface BudgetQuery {
  readonly limit: number;
  readonly offset: number;
}

export interface AlertChannelQuery {
  readonly kind: ChannelKind | null;
  readonly enabled: boolean | null;
  readonly limit: number;
}

/** A delivery joined to the channel it addresses. The dispatcher's unit of work. */
export interface DeliveryTarget {
  readonly delivery: AlertDelivery;
  readonly channel: AlertChannel;
}

/**
 * A crossing joined to the cap that produced it, and to where it lives.
 *
 * The `scope` is the RE-DERIVED ancestry of the crossing's environment, not
 * three ids the caller supplied — the reconciliation pass runs installation-wide
 * and has no request scope of its own, so the store is the only thing that can
 * say which organization and project a crossing belongs to. An implementation
 * MUST resolve it by joining the tenant chain, exactly as the source's query
 * does, and MUST NOT reconstruct it from the environment id alone.
 */
export interface PendingCrossing {
  readonly scope: EnvironmentScope;
  readonly event: ThresholdEvent;
  readonly budget: Budget;
}

export interface BudgetRepository {
  // --- Budget ---------------------------------------------------------------

  listBudgets(scope: EnvironmentScope): Promise<Result<readonly Budget[]>>;

  /**
   * One page, in `byListingOrder`. An implementation MUST apply that exact
   * order, including its final id tie-break: a paged listing whose order is not
   * total silently drops and repeats rows across pages.
   */
  pageBudgets(scope: EnvironmentScope, query: BudgetQuery): Promise<Result<BudgetPage>>;

  findBudget(scope: EnvironmentScope, budgetId: BudgetId): Promise<Result<Budget | null>>;

  insertBudget(budget: Budget, transaction: TransactionScope): Promise<Result<Budget>>;

  updateBudget(budget: Budget, transaction: TransactionScope): Promise<Result<Budget>>;

  /**
   * Tombstone a cap. Soft: the row survives with `deletedAt` set, because a
   * threshold event points at it and an operator reading last month's alert
   * needs the cap it was about.
   */
  retireBudget(
    scope: EnvironmentScope,
    budgetId: BudgetId,
    at: Date,
    transaction: TransactionScope,
  ): Promise<Result<boolean>>;

  // --- BudgetThresholdEvent -------------------------------------------------

  /**
   * Append one crossing, or report that it is already recorded.
   *
   * `null` means the unique constraint refused it — the alert has already
   * fired for this cap, window and threshold. That is a normal outcome and must
   * not be an error.
   */
  insertThresholdEvent(
    event: ThresholdEvent,
    transaction: TransactionScope,
  ): Promise<Result<ThresholdEvent | null>>;

  findThresholdEvent(
    scope: EnvironmentScope,
    eventId: ThresholdEventId,
  ): Promise<Result<ThresholdEvent | null>>;

  /** Which of these thresholds already have an event for this cap and window. */
  listRecordedThresholds(
    scope: EnvironmentScope,
    budgetId: BudgetId,
    windowKey: WindowKey,
  ): Promise<Result<readonly number[]>>;

  // --- AlertChannel + AlertChannelConfiguration -----------------------------

  listAlertChannels(
    scope: EnvironmentScope,
    query: AlertChannelQuery,
  ): Promise<Result<readonly AlertChannel[]>>;

  findAlertChannel(
    scope: EnvironmentScope,
    channelId: AlertChannelId,
  ): Promise<Result<AlertChannel | null>>;

  /** Writes the channel and its configuration in one transaction. */
  insertAlertChannel(channel: AlertChannel, transaction: TransactionScope): Promise<Result<AlertChannel>>;

  updateAlertChannel(channel: AlertChannel, transaction: TransactionScope): Promise<Result<AlertChannel>>;

  /**
   * How many LIVE channels still reference this credential.
   *
   * The delete path asks before it tells the vault to revoke: two channels can
   * share one signing secret, and revoking on the first delete would silently
   * break the second. A count, not a boolean, because the refusal reports it.
   */
  countChannelsUsingCredential(
    scope: EnvironmentScope,
    credential: string,
  ): Promise<Result<number>>;

  // --- AlertDelivery + AlertDeliveryRetry -----------------------------------

  /**
   * Create one delivery per recipient for a crossing, skipping any that already
   * exist. Idempotent by `@@unique([environmentId, idempotencyKey])`.
   */
  insertDeliveries(
    deliveries: readonly AlertDelivery[],
    transaction: TransactionScope,
  ): Promise<Result<number>>;

  insertDelivery(delivery: AlertDelivery, transaction: TransactionScope): Promise<Result<AlertDelivery>>;

  /** Every delivery for one crossing, joined to its channel, oldest first. */
  listDeliveriesForEvent(
    scope: EnvironmentScope,
    eventId: ThresholdEventId,
  ): Promise<Result<readonly DeliveryTarget[]>>;

  findDelivery(
    scope: EnvironmentScope,
    deliveryId: AlertDeliveryId,
  ): Promise<Result<DeliveryTarget | null>>;

  /**
   * Claim a delivery, as ONE conditional write.
   *
   * `null` means the row was not claimable — someone else holds it, its lease
   * has not expired, or it has already succeeded. Not an error: it is the answer.
   */
  claimDelivery(
    scope: EnvironmentScope,
    deliveryId: AlertDeliveryId,
    token: ClaimToken,
    leaseUntil: Date,
    at: Date,
  ): Promise<Result<AlertDelivery | null>>;

  /**
   * Finalise a delivery and append its retry record, atomically.
   *
   * `null` means the claim was stale and nothing was written. The two writes
   * MUST be one transaction: a finalised row with no retry record loses the
   * failure reason an operator needs, and a retry record with no finalised row
   * leaves the delivery claimable and re-sends.
   */
  finaliseDelivery(
    delivery: AlertDelivery,
    retry: AlertDeliveryRetry,
    expected: { readonly token: ClaimToken; readonly generation: number; readonly retryNumber: number },
    transaction: TransactionScope,
  ): Promise<Result<AlertDelivery | null>>;

  /** Finalise a delivery nobody claimed — a synchronous test send. */
  settleDelivery(
    delivery: AlertDelivery,
    retry: AlertDeliveryRetry,
    transaction: TransactionScope,
  ): Promise<Result<AlertDelivery>>;

  /**
   * Crossings with work outstanding, one per crossing, oldest deadline first.
   *
   * DISTINCT ON THE CROSSING, not on the delivery: the dispatcher's unit of work
   * is a whole crossing, and returning four rows for one crossing would have four
   * dispatchers race over the same four deliveries instead of one handling them
   * in order.
   */
  listPendingCrossings(
    statuses: readonly DeliveryStatus[],
    dueAt: Date,
    limit: number,
  ): Promise<Result<readonly PendingCrossing[]>>;
}
