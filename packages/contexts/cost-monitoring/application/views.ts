// Domain values, as the published contract renders them.
//
// Three rules, and each one is a thing this surface deliberately does NOT hand
// out.
//
//   NO CREDENTIAL REFERENCE, EVER. A channel view says WHETHER a secret is
//   configured and never which one. A reference is a handle into another
//   context's vault, and handing one out invites a caller to try to use it. The
//   source's own redactor does this; here it is the type, so a future field
//   cannot be added without deciding.
//
//   NO EXACT AMOUNT AS A NUMBER. Spend is `Decimal(18, 6)` and leaves as a
//   canonical decimal STRING, because a JSON number cannot carry it. A caller
//   that sums a month of these keeps every digit.
//
//   NO BRANDED IDENTIFIER. They leave as plain strings: a brand is a
//   compile-time property of this package's internals, and exporting one obliges
//   every consumer to import this context's identifier module to name a value it
//   already has.
//
// Percentages leave as BASIS POINTS — hundredths of one percent, as integers. A
// float percentage would reintroduce, at the boundary, exactly the rounding this
// context removed from the comparison.

import type {
  AlertChannel,
  AlertDelivery,
  Budget,
  BudgetStatus,
  ChannelKind,
  ConsumptionSummary,
  DeliveryStatus,
  ThresholdEvent,
} from "../domain/index.js";
import { spendToCentsString } from "../domain/index.js";

export interface BudgetView {
  readonly budgetId: string;
  readonly environmentId: string;
  readonly subject: string;
  readonly targetId: string;
  readonly tier: string;
  readonly skillSlug: string | null;
  readonly agentId: string | null;
  readonly period: string;
  readonly limitCents: number;
  readonly runsLimit: number;
  readonly alertThresholds: readonly number[];
  readonly enabled: boolean;
  readonly overrideUntil: Date | null;
  readonly overrideBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function toBudgetView(budget: Budget): BudgetView {
  return {
    budgetId: budget.budgetId,
    environmentId: budget.environmentId,
    subject: budget.target.subject,
    targetId: budget.target.targetId,
    tier: budget.target.tier,
    skillSlug: budget.target.skillSlug,
    agentId: budget.target.agentId,
    period: budget.period,
    limitCents: budget.limitCents,
    runsLimit: budget.runsLimit,
    alertThresholds: budget.alertThresholds,
    enabled: budget.enabled,
    overrideUntil: budget.overrideUntil,
    overrideBy: budget.target.overrideBy,
    createdAt: budget.createdAt,
    updatedAt: budget.updatedAt,
  };
}

export interface BudgetStatusView {
  readonly budget: BudgetView;
  readonly windowKey: string;
  /** Canonical `Decimal(18, 6)` cents. Never a number. */
  readonly spentCents: string;
  readonly reservedCents: string;
  readonly tasks: number;
  /** Hundredths of one percent, as an integer. */
  readonly percentBasisPoints: number;
  readonly runsPercentBasisPoints: number;
  readonly breached: boolean;
  readonly blocked: boolean;
  readonly overrideActive: boolean;
}

export function toBudgetStatusView(status: BudgetStatus): BudgetStatusView {
  return {
    budget: toBudgetView(status.budget),
    windowKey: status.windowKey,
    spentCents: spendToCentsString(status.spent),
    reservedCents: spendToCentsString(status.reading.reserved),
    tasks: status.reading.tasks,
    percentBasisPoints: status.percentBasisPoints,
    runsPercentBasisPoints: status.runsPercentBasisPoints,
    breached: status.breached,
    blocked: status.blocked,
    overrideActive: status.overrideActive,
  };
}

/** What a channel looks like from outside. Addresses, never material. */
export interface AlertChannelView {
  readonly channelId: string;
  readonly environmentId: string;
  readonly kind: ChannelKind;
  readonly name: string;
  readonly enabled: boolean;
  readonly topics: readonly string[];
  readonly deduplicationKey: string | null;
  readonly operatorSuppliedKey: boolean;
  readonly address: ChannelAddressView;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The per-kind address, with `hasSecret` in place of any reference. */
export type ChannelAddressView =
  | { readonly kind: "EMAIL"; readonly email: string }
  | {
      readonly kind: "SLACK";
      readonly channelId: string;
      readonly channelName: string;
      readonly integrationId: string | null;
      readonly hasSecret: boolean;
    }
  | { readonly kind: "WEBHOOK"; readonly url: string; readonly hasSecret: boolean };

export function toAlertChannelView(channel: AlertChannel): AlertChannelView {
  const configuration = channel.configuration;
  const address: ChannelAddressView =
    configuration.kind === "EMAIL"
      ? { kind: "EMAIL", email: configuration.email }
      : configuration.kind === "SLACK"
        ? {
            kind: "SLACK",
            channelId: configuration.channelId,
            channelName: configuration.channelName,
            integrationId: configuration.integrationId,
            hasSecret: configuration.credential !== null,
          }
        : { kind: "WEBHOOK", url: configuration.url, hasSecret: true };
  return {
    channelId: channel.channelId,
    environmentId: channel.environmentId,
    kind: channel.kind,
    name: channel.name,
    enabled: channel.enabled,
    topics: channel.topics,
    deduplicationKey: channel.deduplicationKey,
    operatorSuppliedKey: channel.operatorSuppliedKey,
    address,
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
  };
}

export interface AlertDeliveryView {
  readonly deliveryId: string;
  readonly channelId: string;
  readonly eventId: string | null;
  readonly kind: string;
  readonly status: DeliveryStatus;
  readonly retryCount: number;
  readonly availableAt: Date;
  readonly deliveredAt: Date | null;
  readonly lastStatusCode: number | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
}

export function toAlertDeliveryView(delivery: AlertDelivery): AlertDeliveryView {
  return {
    deliveryId: delivery.deliveryId,
    channelId: delivery.channelId,
    eventId: delivery.eventId,
    kind: delivery.kind,
    status: delivery.status,
    retryCount: delivery.retryCount,
    availableAt: delivery.availableAt,
    deliveredAt: delivery.deliveredAt,
    lastStatusCode: delivery.lastStatusCode,
    lastErrorCode: delivery.lastErrorCode,
    lastErrorMessage: delivery.lastErrorMessage,
  };
}

export interface ThresholdEventView {
  readonly eventId: string;
  readonly budgetId: string;
  readonly windowKey: string;
  readonly threshold: number;
  /** Canonical `Decimal(18, 6)` cents, snapshotted at the crossing. */
  readonly spentCents: string;
  readonly tasks: number;
  readonly createdAt: Date;
}

export function toThresholdEventView(event: ThresholdEvent): ThresholdEventView {
  return {
    eventId: event.eventId,
    budgetId: event.budgetId,
    windowKey: event.windowKey,
    threshold: event.threshold,
    spentCents: spendToCentsString(event.spent),
    tasks: event.tasks,
    createdAt: event.createdAt,
  };
}

export interface ConsumptionSummaryView {
  readonly userId: string;
  readonly blocked: boolean;
  readonly reason: string | null;
  readonly caps: readonly BudgetStatusView[];
  readonly rateLimited: boolean;
  readonly fetchedAt: Date;
}

export function toConsumptionSummaryView(summary: ConsumptionSummary): ConsumptionSummaryView {
  return {
    userId: summary.userId,
    blocked: summary.blocked,
    reason: summary.reason,
    caps: summary.caps.map(toBudgetStatusView),
    rateLimited: summary.rateLimited,
    fetchedAt: summary.fetchedAt,
  };
}
