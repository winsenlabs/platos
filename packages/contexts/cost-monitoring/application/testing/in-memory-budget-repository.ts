// An in-memory `BudgetRepository`.
//
// IT ENFORCES THE CONSTRAINTS, NOT JUST THE SHAPES. A double that stored rows in
// a map and answered every question yes would let a use case pass here and fail
// in production on the first race. So this one holds:
//
//   `@@unique([budgetId, windowKey, threshold])` — a duplicate crossing returns
//   `null`, which is how "alert exactly once" is actually tested.
//   `@@unique([environmentId, idempotencyKey])` — a re-fan-out inserts nothing.
//   THE CLAIM, as one atomic decision, including the lease-expiry rule that lets
//   a dead dispatcher's row be recovered.
//   THE STALE-PROOF CHECK, so a finalisation whose lease expired writes nothing.
//   ENVIRONMENT SCOPING on every read, so a cross-tenant lookup returns null here
//   exactly as it must in the store.
//
// The `TransactionScope` is recorded and not honoured: there is nothing to roll
// back in a map, and pretending otherwise would test a simulation rather than the
// use case. What IS tested is that a mutation was handed one at all.

import { err, ok, type EnvironmentScope, type Result, type TransactionScope } from "@platos/kernel";

import {
  byListingOrder,
  isClaimable,
  isSettled,
  repositoryUnavailable,
  thresholdEventKey,
  type AlertChannel,
  type AlertChannelId,
  type AlertDelivery,
  type AlertDeliveryId,
  type AlertDeliveryRetry,
  type Budget,
  type BudgetId,
  type ClaimToken,
  type DeliveryStatus,
  type ThresholdEvent,
  type ThresholdEventId,
  type WindowKey,
} from "../../domain/index.js";
import type {
  AlertChannelQuery,
  BudgetPage,
  BudgetQuery,
  BudgetRepository,
  DeliveryTarget,
  PendingCrossing,
} from "../ports/index.js";

export class InMemoryBudgetRepository implements BudgetRepository {
  private readonly budgets = new Map<string, Budget>();
  private readonly retiredBudgets = new Set<string>();
  private readonly crossings = new Map<string, ThresholdEvent>();
  private readonly channels = new Map<string, AlertChannel>();
  private readonly deliveries = new Map<string, AlertDelivery>();

  /** Every retry ever appended, in order. Read by the delivery tests. */
  readonly retries: AlertDeliveryRetry[] = [];
  /** Every transaction a mutation was handed. Proves nothing wrote outside one. */
  readonly transactions: TransactionScope[] = [];
  /** Scopes whose crossings this double can resolve an ancestry for. */
  private readonly scopes = new Map<string, EnvironmentScope>();

  /**
   * Method names that should answer "unavailable" instead of answering.
   *
   * A named set rather than a hand-built object with one stubbed method: a
   * partial stand-in silently drops every method it did not list, so a use case
   * that started calling a second one would fail for the wrong reason and the
   * test would still look like it was exercising an outage.
   */
  readonly failOn = new Set<keyof BudgetRepository>();

  /** Make an environment resolvable by the installation-wide sweep. */
  knowScope(scope: EnvironmentScope): void {
    this.scopes.set(scope.environmentId, scope);
  }

  seedBudget(budget: Budget): Budget {
    this.budgets.set(budget.budgetId, budget);
    return budget;
  }

  seedChannel(channel: AlertChannel): AlertChannel {
    this.channels.set(channel.channelId, channel);
    return channel;
  }

  seedDelivery(delivery: AlertDelivery): AlertDelivery {
    this.deliveries.set(delivery.deliveryId, delivery);
    return delivery;
  }

  seedCrossing(event: ThresholdEvent): ThresholdEvent {
    this.crossings.set(thresholdEventKey(event.budgetId, event.windowKey, event.threshold), event);
    return event;
  }

  /** Every delivery currently held, oldest first. */
  allDeliveries(): readonly AlertDelivery[] {
    return [...this.deliveries.values()].sort(
      (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
    );
  }

  allCrossings(): readonly ThresholdEvent[] {
    return [...this.crossings.values()];
  }

  // --- Budget ---------------------------------------------------------------

  async listBudgets(scope: EnvironmentScope): Promise<Result<readonly Budget[]>> {
    if (this.failOn.has("listBudgets")) return err(repositoryUnavailable("told to fail"));
    return ok(this.liveBudgets(scope).sort(byListingOrder));
  }

  async pageBudgets(scope: EnvironmentScope, query: BudgetQuery): Promise<Result<BudgetPage>> {
    const all = this.liveBudgets(scope).sort(byListingOrder);
    return ok({ items: all.slice(query.offset, query.offset + query.limit), total: all.length });
  }

  async findBudget(scope: EnvironmentScope, budgetId: BudgetId): Promise<Result<Budget | null>> {
    return ok(this.liveBudgets(scope).find((budget) => budget.budgetId === budgetId) ?? null);
  }

  async insertBudget(budget: Budget, transaction: TransactionScope): Promise<Result<Budget>> {
    this.transactions.push(transaction);
    if (this.budgets.has(budget.budgetId)) {
      return err(repositoryUnavailable("budget id already exists"));
    }
    this.budgets.set(budget.budgetId, budget);
    return ok(budget);
  }

  async updateBudget(budget: Budget, transaction: TransactionScope): Promise<Result<Budget>> {
    this.transactions.push(transaction);
    if (!this.budgets.has(budget.budgetId)) return err(repositoryUnavailable("no such budget"));
    this.budgets.set(budget.budgetId, budget);
    return ok(budget);
  }

  async retireBudget(
    scope: EnvironmentScope,
    budgetId: BudgetId,
    at: Date,
    transaction: TransactionScope,
  ): Promise<Result<boolean>> {
    this.transactions.push(transaction);
    const held = this.liveBudgets(scope).find((budget) => budget.budgetId === budgetId);
    if (held === undefined) return ok(false);
    this.retiredBudgets.add(budgetId);
    this.budgets.set(budgetId, { ...held, enabled: false, updatedAt: at });
    return ok(true);
  }

  // --- BudgetThresholdEvent -------------------------------------------------

  async insertThresholdEvent(
    event: ThresholdEvent,
    transaction: TransactionScope,
  ): Promise<Result<ThresholdEvent | null>> {
    this.transactions.push(transaction);
    const key = thresholdEventKey(event.budgetId, event.windowKey, event.threshold);
    // The unique constraint. `null`, not an error: a duplicate is the normal
    // outcome of two evaluators racing, and it is what makes an alert fire once.
    if (this.crossings.has(key)) return ok(null);
    this.crossings.set(key, event);
    return ok(event);
  }

  async findThresholdEvent(
    scope: EnvironmentScope,
    eventId: ThresholdEventId,
  ): Promise<Result<ThresholdEvent | null>> {
    return ok(
      [...this.crossings.values()].find(
        (event) => event.eventId === eventId && event.environmentId === scope.environmentId,
      ) ?? null,
    );
  }

  async listRecordedThresholds(
    scope: EnvironmentScope,
    budgetId: BudgetId,
    windowKey: WindowKey,
  ): Promise<Result<readonly number[]>> {
    return ok(
      [...this.crossings.values()]
        .filter(
          (event) =>
            event.environmentId === scope.environmentId &&
            event.budgetId === budgetId &&
            event.windowKey === windowKey,
        )
        .map((event) => event.threshold)
        .sort((left, right) => left - right),
    );
  }

  // --- AlertChannel ---------------------------------------------------------

  async listAlertChannels(
    scope: EnvironmentScope,
    query: AlertChannelQuery,
  ): Promise<Result<readonly AlertChannel[]>> {
    const matches = [...this.channels.values()]
      .filter((channel) => channel.environmentId === scope.environmentId)
      .filter((channel) => query.kind === null || channel.kind === query.kind)
      .filter((channel) => query.enabled === null || channel.enabled === query.enabled)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    return ok(matches.slice(0, query.limit));
  }

  async findAlertChannel(
    scope: EnvironmentScope,
    channelId: AlertChannelId,
  ): Promise<Result<AlertChannel | null>> {
    const held = this.channels.get(channelId);
    return ok(held !== undefined && held.environmentId === scope.environmentId ? held : null);
  }

  async insertAlertChannel(
    channel: AlertChannel,
    transaction: TransactionScope,
  ): Promise<Result<AlertChannel>> {
    this.transactions.push(transaction);
    const clash = [...this.channels.values()].some(
      (held) =>
        held.environmentId === channel.environmentId &&
        held.deduplicationKey !== null &&
        held.deduplicationKey === channel.deduplicationKey,
    );
    if (clash) return err(repositoryUnavailable("deduplication key already used"));
    this.channels.set(channel.channelId, channel);
    return ok(channel);
  }

  async updateAlertChannel(
    channel: AlertChannel,
    transaction: TransactionScope,
  ): Promise<Result<AlertChannel>> {
    this.transactions.push(transaction);
    if (!this.channels.has(channel.channelId)) return err(repositoryUnavailable("no such channel"));
    this.channels.set(channel.channelId, channel);
    return ok(channel);
  }

  async countChannelsUsingCredential(
    scope: EnvironmentScope,
    credential: string,
  ): Promise<Result<number>> {
    const count = [...this.channels.values()].filter((channel) => {
      if (channel.environmentId !== scope.environmentId || !channel.enabled) return false;
      const configuration = channel.configuration;
      if (configuration.kind === "EMAIL") return false;
      return configuration.credential === credential;
    }).length;
    return ok(count);
  }

  // --- AlertDelivery --------------------------------------------------------

  async insertDeliveries(
    deliveries: readonly AlertDelivery[],
    transaction: TransactionScope,
  ): Promise<Result<number>> {
    this.transactions.push(transaction);
    let written = 0;
    for (const delivery of deliveries) {
      // `@@unique([environmentId, idempotencyKey])` — the row already exists, so
      // a re-fan-out of one crossing writes nothing and sends nothing twice.
      const taken = [...this.deliveries.values()].some(
        (held) =>
          held.environmentId === delivery.environmentId &&
          held.idempotencyKey === delivery.idempotencyKey,
      );
      if (taken) continue;
      this.deliveries.set(delivery.deliveryId, delivery);
      written += 1;
    }
    return ok(written);
  }

  async insertDelivery(
    delivery: AlertDelivery,
    transaction: TransactionScope,
  ): Promise<Result<AlertDelivery>> {
    this.transactions.push(transaction);
    this.deliveries.set(delivery.deliveryId, delivery);
    return ok(delivery);
  }

  async listDeliveriesForEvent(
    scope: EnvironmentScope,
    eventId: ThresholdEventId,
  ): Promise<Result<readonly DeliveryTarget[]>> {
    const targets: DeliveryTarget[] = [];
    for (const delivery of this.allDeliveries()) {
      if (delivery.environmentId !== scope.environmentId || delivery.eventId !== eventId) continue;
      const channel = this.channels.get(delivery.channelId);
      if (channel === undefined) continue;
      targets.push({ delivery, channel });
    }
    return ok(targets);
  }

  async findDelivery(
    scope: EnvironmentScope,
    deliveryId: AlertDeliveryId,
  ): Promise<Result<DeliveryTarget | null>> {
    const delivery = this.deliveries.get(deliveryId);
    if (delivery === undefined || delivery.environmentId !== scope.environmentId) return ok(null);
    const channel = this.channels.get(delivery.channelId);
    return ok(channel === undefined ? null : { delivery, channel });
  }

  async claimDelivery(
    scope: EnvironmentScope,
    deliveryId: AlertDeliveryId,
    token: ClaimToken,
    leaseUntil: Date,
    at: Date,
  ): Promise<Result<AlertDelivery | null>> {
    const held = this.deliveries.get(deliveryId);
    if (held === undefined || held.environmentId !== scope.environmentId) return ok(null);
    // One atomic decision, exactly as the conditional write the port demands.
    if (isSettled(held) || !isClaimable(held, at)) return ok(null);
    const claimed: AlertDelivery = {
      ...held,
      status: "PROCESSING",
      claimToken: token,
      claimGeneration: held.claimGeneration + 1,
      retryCount: held.retryCount + 1,
      availableAt: leaseUntil,
      lastRetryAt: at,
      updatedAt: at,
    };
    this.deliveries.set(deliveryId, claimed);
    return ok(claimed);
  }

  async finaliseDelivery(
    delivery: AlertDelivery,
    retry: AlertDeliveryRetry,
    expected: { readonly token: ClaimToken; readonly generation: number; readonly retryNumber: number },
    transaction: TransactionScope,
  ): Promise<Result<AlertDelivery | null>> {
    this.transactions.push(transaction);
    const held = this.deliveries.get(delivery.deliveryId);
    if (held === undefined) return ok(null);
    // The stale-proof check. A dispatcher whose lease expired, and whose row was
    // re-claimed and finalised by someone else, writes NOTHING.
    if (
      held.status !== "PROCESSING" ||
      held.claimToken !== expected.token ||
      held.claimGeneration !== expected.generation ||
      held.retryCount !== expected.retryNumber
    ) {
      return ok(null);
    }
    this.deliveries.set(delivery.deliveryId, delivery);
    this.retries.push(retry);
    return ok(delivery);
  }

  async settleDelivery(
    delivery: AlertDelivery,
    retry: AlertDeliveryRetry,
    transaction: TransactionScope,
  ): Promise<Result<AlertDelivery>> {
    this.transactions.push(transaction);
    this.deliveries.set(delivery.deliveryId, delivery);
    this.retries.push(retry);
    return ok(delivery);
  }

  async listPendingCrossings(
    statuses: readonly DeliveryStatus[],
    dueAt: Date,
    limit: number,
  ): Promise<Result<readonly PendingCrossing[]>> {
    if (this.failOn.has("listPendingCrossings")) return err(repositoryUnavailable("told to fail"));
    const seen = new Set<string>();
    const pending: PendingCrossing[] = [];
    for (const delivery of this.allDeliveries()) {
      if (delivery.kind !== "BUDGET" || delivery.eventId === null) continue;
      if (!statuses.includes(delivery.status)) continue;
      if (delivery.availableAt.getTime() > dueAt.getTime()) continue;
      // DISTINCT on the crossing: the dispatcher's unit of work is a whole
      // crossing, and four rows for one crossing would race four dispatchers.
      if (seen.has(delivery.eventId)) continue;
      const event = [...this.crossings.values()].find((held) => held.eventId === delivery.eventId);
      if (event === undefined) continue;
      const budget = this.budgets.get(event.budgetId);
      const scope = this.scopes.get(event.environmentId);
      if (budget === undefined || scope === undefined) continue;
      seen.add(delivery.eventId);
      pending.push({ scope, event, budget });
      if (pending.length >= limit) break;
    }
    return ok(pending);
  }

  private liveBudgets(scope: EnvironmentScope): Budget[] {
    return [...this.budgets.values()].filter(
      (budget) =>
        budget.environmentId === scope.environmentId && !this.retiredBudgets.has(budget.budgetId),
    );
  }
}
