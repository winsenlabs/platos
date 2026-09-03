// The published surface of the `cost-monitoring` context.
//
// ADR M0.3 §2: another context may import THIS entrypoint and nothing else —
// never `domain/`, never `application/`, never an adapter. The §1 DAG gives it
// exactly one consumer, `conversations`, plus the composition root.
//
// The driven `Notifier` port is NOT re-exported here. It is adapter-facing, not
// context-facing, and it is published from `application/ports/index.js` where its
// two adapters import it (ADR M0.3 §13). Neither is `BudgetRepository`,
// `SpendLedger` or `BudgetCapCache`, for the same reason.
//
// WHAT THIS SURFACE DELIBERATELY WITHHOLDS.
//
//   * NO CREDENTIAL REFERENCE, ANYWHERE. A channel view says WHETHER a secret is
//     configured and never which one. A reference is a handle into another
//     context's vault, and handing one out invites a caller to try to use it.
//
//   * NO EXACT AMOUNT AS A NUMBER. Spend is `Decimal(18, 6)` and leaves as a
//     canonical decimal STRING; utilisation leaves as integer BASIS POINTS. A
//     float percentage at the boundary would reintroduce exactly the rounding
//     this context removed from the threshold comparison.
//
//   * NO WAY TO WRITE A SPEND FIGURE FROM OUTSIDE. `recordTurn`, `reserveSpend`
//     and `settleSpend` write the turn counter and the reservation series, and
//     there is no method that sets a cost. Cost has one writer, which is the
//     rule the doubled per-user figure in the extraction source came from
//     breaking.
//
// THE GUARD IS THE HOT-PATH METHOD, and it is deliberately the only one that
// takes a scope instead of an authorization. A turn is not an operator action and
// has no operator grant; making it fabricate one is the shape that eventually
// gets a fabricated grant accepted somewhere it should not be.

import type { Money, Result } from "@platos/kernel";

import type {
  BreachedCap,
  DeliverySummary,
  GuardVerdict,
  RateLimitReading,
} from "../domain/index.js";

// The identifier vocabulary a caller needs to build a command. Branded types, so
// a `budgetId` cannot reach an `alertChannelId` parameter across the boundary any
// more than it can inside it.
export type {
  ActorId,
  AgentId,
  AlertChannelId,
  AlertDeliveryId,
  BudgetId,
  EndUserId,
  SkillSlug,
  ThresholdEventId,
  WindowKey,
} from "../domain/index.js";

// The vocabulary a caller reads answers with.
export type {
  BudgetPeriod,
  BudgetSubject,
  BudgetTier,
  ChannelKind,
  DeliveryKind,
  DeliveryStatus,
  GuardVerdict,
  SpendIntent,
} from "../domain/index.js";

export {
  BUDGET_PERIODS,
  BUDGET_SUBJECTS,
  BUDGET_TIERS,
  BUDGET_TOPIC,
  CHANNEL_KINDS,
  COST_MONITORING_ERROR_CODES,
  DEFAULT_ALERT_THRESHOLDS,
  DELIVERY_KINDS,
  DELIVERY_STATUSES,
  EVERY_USER,
} from "../domain/index.js";

// Policy, published so the composition root can move a lease or a cache window
// without reaching into this package for the shape of one.
export type { CostMonitoringPolicy, DeliveryPolicy, GuardPolicy } from "../domain/index.js";
export { DEFAULT_COST_MONITORING_POLICY } from "../domain/index.js";

import type { CostMonitoringDependencies } from "../application/index.js";
import * as useCases from "../application/index.js";
import type {
  AlertChannelView,
  AlertDeliveryView,
  BudgetPage,
  BudgetStatusView,
  BudgetView,
  ConsumptionSummaryView,
} from "../application/index.js";

// --- read models -------------------------------------------------------------

export type {
  AlertChannelView,
  AlertDeliveryView,
  BudgetStatusView,
  BudgetView,
  ChannelAddressView,
  ConsumptionSummaryView,
  ThresholdEventView,
} from "../application/index.js";

export interface BudgetPageView {
  readonly items: readonly BudgetView[];
  readonly total: number;
}

/** What an evaluation says about a whole scope. */
export interface BudgetVerdictView {
  readonly caps: readonly BudgetStatusView[];
  readonly blocked: boolean;
  /** The refusal an operator reads, or null. Rendered once, in the domain. */
  readonly reason: string | null;
}

/** A probe's durable row and what the transport said. */
export interface ProbeResultView {
  readonly delivery: AlertDeliveryView;
  readonly ok: boolean;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

/** A retired channel, and the vault entry the caller may now revoke. */
export interface RetiredAlertChannelView {
  readonly channel: AlertChannelView;
  /** Null when the channel had none, or another live channel still uses it. */
  readonly releasableCredential: string | null;
}

// --- commands and queries ----------------------------------------------------

export type {
  ConfigureBudgetCommand,
  CreateAlertChannelCommand,
  DeliverCrossingCommand,
  DescribeAlertChannelQuery,
  DescribeBudgetQuery,
  DetectCrossingsCommand,
  EstimateSpendQuery,
  EvaluateBudgetsQuery,
  GuardSpendCommand,
  OverrideBudgetCommand,
  PageBudgetsQuery,
  ProbeAlertChannelCommand,
  ReadAlertChannelsQuery,
  ReadBudgetsQuery,
  ReconcileDeliveriesCommand,
  ReconciliationReport,
  RecordTurnCommand,
  RemoveAlertChannelCommand,
  RemoveBudgetCommand,
  RecordedCrossing,
  ReserveSpendCommand,
  SettleSpendCommand,
  SpendContext,
  SpendSubject,
  SummariseConsumptionQuery,
  SweepBreachesQuery,
  UpdateAlertChannelCommand,
} from "../application/index.js";

export type { BreachedCap, DeliverySummary, RateLimitReading } from "../domain/index.js";
export type { ReservationHandle } from "../application/index.js";
export type { CostMonitoringDependencies } from "../application/index.js";

/**
 * The `cost-monitoring` capability, as every other context sees it.
 *
 * Every method returns the kernel's `Result`: a failure a caller must handle is
 * visible in the type, and no vendor exception crosses this boundary.
 */
export interface CostMonitoringContract {
  readonly name: "cost-monitoring";

  // ---- budgets: metadata (operator grant, `metadata`) ---------------------
  listBudgets(query: useCases.ReadBudgetsQuery): Promise<Result<readonly BudgetView[]>>;
  pageBudgets(query: useCases.PageBudgetsQuery): Promise<Result<BudgetPageView>>;
  describeBudget(query: useCases.DescribeBudgetQuery): Promise<Result<BudgetView>>;

  // ---- budgets: mutation (operator grant, `metadata`) ---------------------
  /** Create or replace the cap at a collision tuple. Idempotent by declaration. */
  configureBudget(command: useCases.ConfigureBudgetCommand): Promise<Result<BudgetView>>;
  removeBudget(command: useCases.RemoveBudgetCommand): Promise<Result<BudgetView>>;
  /** Let a breached cap through for N minutes, recording who authorised it. */
  overrideBudget(command: useCases.OverrideBudgetCommand): Promise<Result<BudgetView>>;

  // ---- enforcement -------------------------------------------------------
  /** Where every cap in a scope stands. The operator-facing evaluation. */
  evaluateBudgets(query: useCases.EvaluateBudgetsQuery): Promise<Result<BudgetVerdictView>>;
  /**
   * `BudgetGuard` — may this dispatch proceed?
   *
   * The seam `conversations` reaches for, on the hot path. Caps come from the
   * cache and spend is read live (ADR §7 decision 3, option b).
   */
  guardSpend(command: useCases.GuardSpendCommand): Promise<Result<GuardVerdict>>;
  /** What a piece of work will cost, priced by `providers`. */
  estimateSpend(query: useCases.EstimateSpendQuery): Promise<Result<Money>>;

  // ---- the spend ledger --------------------------------------------------
  recordTurn(command: useCases.RecordTurnCommand): Promise<Result<void>>;
  reserveSpend(command: useCases.ReserveSpendCommand): Promise<Result<useCases.ReservationHandle>>;
  /** The exact reconcile ADR §7 decision 3(b) puts off the outbox. */
  settleSpend(command: useCases.SettleSpendCommand): Promise<Result<void>>;
  releaseSpend(handle: useCases.ReservationHandle): Promise<Result<void>>;

  // ---- alerting ----------------------------------------------------------
  /** Record the crossings a status has reached and fan the recipients out. */
  detectCrossings(command: useCases.DetectCrossingsCommand): Promise<Result<readonly useCases.RecordedCrossing[]>>;
  /** Send one crossing to every recipient still owed it. */
  deliverCrossing(command: useCases.DeliverCrossingCommand): Promise<Result<DeliverySummary>>;
  /** The durable backstop: sweep for alerts owed and not yet sent. */
  reconcileDeliveries(
    command?: useCases.ReconcileDeliveriesCommand,
  ): Promise<Result<useCases.ReconciliationReport>>;

  // ---- alert channels (operator grant, `secret:mutate` to mutate) ---------
  listAlertChannels(query: useCases.ReadAlertChannelsQuery): Promise<Result<readonly AlertChannelView[]>>;
  describeAlertChannel(query: useCases.DescribeAlertChannelQuery): Promise<Result<AlertChannelView>>;
  createAlertChannel(command: useCases.CreateAlertChannelCommand): Promise<Result<AlertChannelView>>;
  updateAlertChannel(command: useCases.UpdateAlertChannelCommand): Promise<Result<AlertChannelView>>;
  /** Retire a channel, and say whether its credential may now be revoked. */
  removeAlertChannel(
    command: useCases.RemoveAlertChannelCommand,
  ): Promise<Result<RetiredAlertChannelView>>;
  /** Send a synthetic message and leave the proof on the ledger. */
  probeAlertChannel(command: useCases.ProbeAlertChannelCommand): Promise<Result<ProbeResultView>>;

  // ---- operator reads ----------------------------------------------------
  summariseConsumption(
    query: useCases.SummariseConsumptionQuery,
  ): Promise<Result<ConsumptionSummaryView>>;
  /** Every (cap, subject) pair at or past its cap, overrides excluded. */
  sweepBreaches(query: useCases.SweepBreachesQuery): Promise<Result<readonly BreachedCap[]>>;
}

/** The integration events this context publishes through the kernel outbox. */
export const COST_MONITORING_EVENT_NAMES = [
  "cost.budget.configured",
  "cost.budget.removed",
  "cost.budget.overridden",
  "cost.budget.threshold_crossed",
  "cost.budget.blocked",
  "cost.alert_channel.created",
  "cost.alert_channel.updated",
  "cost.alert_channel.removed",
  "cost.alert_delivery.succeeded",
  "cost.alert_delivery.failed",
] as const;

export type CostMonitoringEventName = (typeof COST_MONITORING_EVENT_NAMES)[number];

/**
 * Retained from the generated skeleton so no sibling placeholder breaks. The
 * "aggregate" this context hands out is a cap's standing, not a row.
 */
export type CostMonitoringAggregate = BudgetStatusView;

function budgetPage(page: BudgetPage): BudgetPageView {
  return { items: page.items.map(useCases.toBudgetView), total: page.total };
}

/**
 * Bind the use cases into the driving port.
 *
 * The composition root builds the dependency bundle from adapters and calls this
 * once. Nothing here holds state: it is a lookup table from a contract method to
 * the one use case that implements it, which is what keeps the contract from
 * quietly growing behaviour of its own.
 */
export function costMonitoringContract(
  dependencies: CostMonitoringDependencies,
): CostMonitoringContract {
  const map = <Value, View>(
    result: Result<Value>,
    view: (value: Value) => View,
  ): Result<View> => (result.ok ? { ok: true, value: view(result.value) } : result);

  const contract: CostMonitoringContract = {
    name: "cost-monitoring",

    listBudgets: async (query) =>
      map(await useCases.listBudgets(dependencies, query), (budgets) =>
        budgets.map(useCases.toBudgetView),
      ),
    pageBudgets: async (query) => map(await useCases.pageBudgets(dependencies, query), budgetPage),
    describeBudget: async (query) =>
      map(await useCases.describeBudget(dependencies, query), useCases.toBudgetView),

    configureBudget: async (command) =>
      map(await useCases.configureBudget(dependencies, command), useCases.toBudgetView),
    removeBudget: async (command) =>
      map(await useCases.removeBudget(dependencies, command), useCases.toBudgetView),
    overrideBudget: async (command) =>
      map(await useCases.overrideBudget(dependencies, command), useCases.toBudgetView),

    evaluateBudgets: async (query) =>
      map(await useCases.evaluateBudgets(dependencies, query), (verdict) => ({
        caps: verdict.caps.map(useCases.toBudgetStatusView),
        blocked: verdict.blocked,
        reason: verdict.reason,
      })),
    guardSpend: (command) => useCases.guardSpend(dependencies, command),
    estimateSpend: (query) => useCases.estimateSpend(dependencies, query),

    recordTurn: (command) => useCases.recordTurn(dependencies, command),
    reserveSpend: (command) => useCases.reserveSpend(dependencies, command),
    settleSpend: (command) => useCases.settleSpend(dependencies, command),
    releaseSpend: (handle) => useCases.releaseSpend(dependencies, handle),

    detectCrossings: (command) => useCases.detectCrossings(dependencies, command),
    deliverCrossing: (command) => useCases.deliverCrossing(dependencies, command),
    reconcileDeliveries: (command) => useCases.reconcileDeliveries(dependencies, command),

    listAlertChannels: async (query) =>
      map(await useCases.listAlertChannels(dependencies, query), (channels) =>
        channels.map(useCases.toAlertChannelView),
      ),
    describeAlertChannel: async (query) =>
      map(await useCases.describeAlertChannel(dependencies, query), useCases.toAlertChannelView),
    createAlertChannel: async (command) =>
      map(await useCases.createAlertChannel(dependencies, command), useCases.toAlertChannelView),
    updateAlertChannel: async (command) =>
      map(await useCases.updateAlertChannel(dependencies, command), useCases.toAlertChannelView),
    removeAlertChannel: async (command) =>
      map(await useCases.removeAlertChannel(dependencies, command), (retired) => ({
        channel: useCases.toAlertChannelView(retired.channel),
        releasableCredential: retired.releasableCredential,
      })),
    probeAlertChannel: async (command) =>
      map(await useCases.probeAlertChannel(dependencies, command), (probed) => ({
        delivery: useCases.toAlertDeliveryView(probed.delivery),
        ok: probed.outcome.ok,
        errorCode: probed.outcome.errorCode,
        errorMessage: probed.outcome.errorMessage,
      })),

    summariseConsumption: async (query) =>
      map(
        await useCases.summariseConsumption(dependencies, query),
        useCases.toConsumptionSummaryView,
      ),
    sweepBreaches: (query) => useCases.sweepBreaches(dependencies, query),
  };
  return Object.freeze(contract);
}

