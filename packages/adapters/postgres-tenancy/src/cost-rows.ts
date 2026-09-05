// `cost-monitoring`'s six rows in both directions: column shape to domain value,
// and domain value to the columns a write names.
//
// THE READ DIRECTION IS TOTAL OR IT REFUSES, and it never guesses. Four columns
// carry a value this binary might not recognise — a `period` a later release
// added, a thresholds array holding something that is not a whole percentage, a
// channel whose per-kind configuration row is missing, and one whose
// configuration contradicts its kind — and each gets its own code. A mapper that
// substituted a default for any of them would present an operator with a cap or
// a channel that is not the one the table holds.
//
// THE ONE EXCEPTION IS `Budget.scope`, AND IT IS THE DOMAIN'S EXCEPTION RATHER
// THAN THIS FILE'S. `domain/budget-scope.ts` says in as many words that an
// unreadable `scope` column decodes to an environment-wide `llm` cap, that this
// is "not error handling" but the statement that a row written by an older
// release still governs the whole environment rather than governing nothing, and
// that the rule belongs in the domain precisely so an adapter cannot choose
// differently. So this file calls `decodeBudgetTarget` and does not second-guess
// it.
//
// FOUR COLUMNS ARE CARRIED BY THE TABLE AND NOT BY THE DOMAIN, and each is
// handled by the expand/contract rule rather than by silence:
//
//   `Budget.deletedAt` and `AlertChannel.deletedAt` are the tombstones. The
//   domain has no field for either, so a read FILTERS on them and a write sets
//   `Budget.deletedAt` only through `retireBudget`, whose port comment says the
//   row survives with it set. `AlertChannel.deletedAt` has no port method that
//   can set it at all; see `cost-channels.ts` for what follows from that.
//
//   `AlertChannelConfiguration.integrationProvider` and `.externalOrganizationId`
//   are written by an older surface and read by nothing here. They are left
//   untouched on update and written as null on insert, so a row that has them
//   keeps them and a row this adapter creates does not invent them.

import type {
  AgentId,
  AlertChannel,
  AlertDelivery,
  AlertDeliveryRetry,
  Budget,
  BudgetPeriod,
  ChannelConfiguration,
  ChannelKind,
  ClaimToken,
  CredentialRef,
  DeduplicationKey,
  DeliveryKind,
  DeliveryStatus,
  EnvironmentScope,
  ThresholdEvent,
  ThresholdEventId,
} from "@platos/context-cost-monitoring/application/ports/index.js";
import {
  asCostIdentifier,
  centsToMoney,
  decodeBudgetTarget,
  encodeBudgetTarget,
  moneyToCentsString,
} from "@platos/context-cost-monitoring/application/ports/index.js";

import {
  requireChannelName,
  requireCrossingValues,
  requireDeduplication,
  requireDeliveryKindShape,
  requireDeliveryState,
  requireIntegerLimit,
  requireRepresentableSpend,
  requireRetryRecord,
  requireThresholds,
  requireTopics,
  requireUuid,
  requireUuidOrNull,
} from "./cost-guards.js";
import { UnreadableRowError } from "./mapping.js";

/** `Budget.period` holds a value this binary has no window arithmetic for. */
export const UNKNOWN_BUDGET_PERIOD = "cost.row.unknown_budget_period";

/** `Budget.alertThresholds` is not an array of whole percentages. */
export const UNREADABLE_ALERT_THRESHOLDS = "cost.row.unreadable_alert_thresholds";

/** An `AlertChannel` with no `AlertChannelConfiguration` row beside it. */
export const CHANNEL_CONFIGURATION_ABSENT = "cost.row.channel_configuration_absent";

/** A configuration whose columns do not address the kind its channel declares. */
export const CHANNEL_CONFIGURATION_INCOHERENT = "cost.row.channel_configuration_incoherent";

/**
 * `BudgetThresholdEvent.spentCents` holds a figure with no exact `Money` form.
 *
 * A DISTINCT code from the write-side refusal, because they are opposite
 * directions of the same narrowing and have opposite fixes: the write refusal
 * says an amount cannot be recorded, this one says an amount already recorded
 * cannot be read. Sharing a code would make the second look like the first and
 * send a reader to the caller instead of to the row.
 */
export const UNREADABLE_CROSSING_SPEND = "cost.row.unreadable_crossing_spend";

const PERIODS: readonly string[] = ["day", "week", "month"];

/** The columns a `Budget` read selects. Named so a suite can build one. */
export interface BudgetRow {
  readonly id: string;
  readonly environmentId: string;
  readonly agentId: string | null;
  readonly scope: string;
  readonly period: string;
  readonly limitCents: number;
  readonly turnsLimit: number | null;
  readonly alertThresholds: unknown;
  readonly enabled: boolean;
  readonly overrideUntil: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CrossingRow {
  readonly id: string;
  readonly environmentId: string;
  readonly budgetId: string;
  readonly windowKey: string;
  readonly threshold: number;
  readonly spentCents: number;
  readonly runs: number;
  readonly createdAt: Date;
}

export interface ChannelConfigurationRow {
  readonly email: string | null;
  readonly webhookUrl: string | null;
  readonly slackChannelId: string | null;
  readonly slackChannelName: string | null;
  readonly integrationId: string | null;
  readonly credentialId: string | null;
}

export interface ChannelRow {
  readonly id: string;
  readonly environmentId: string;
  readonly type: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly alertTypes: readonly string[];
  readonly deduplicationKey: string | null;
  readonly userProvidedDeduplicationKey: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly configuration: ChannelConfigurationRow | null;
}

export interface DeliveryRow {
  readonly id: string;
  readonly environmentId: string;
  readonly channelId: string;
  readonly budgetThresholdEventId: string | null;
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly status: string;
  readonly retryCount: number;
  readonly claimGeneration: number;
  readonly claimToken: string | null;
  readonly availableAt: Date;
  readonly lastRetryAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly lastStatusCode: number | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function readPeriod(value: string): BudgetPeriod {
  if (!PERIODS.includes(value)) {
    throw new UnreadableRowError(UNKNOWN_BUDGET_PERIOD, "Budget.period", value);
  }
  return value as BudgetPeriod;
}

/**
 * The thresholds column, read exactly.
 *
 * `Budget_alertThresholds_json_root` guarantees the ROOT is an array and says
 * nothing about the elements, so a row written by a migration or by hand can
 * hold `[50, "80", null]` and satisfy every constraint the table has. Reading
 * that as `[50, NaN, 0]` would produce a cap that fires at a percentage no
 * operator asked for, so it is refused instead.
 */
function readThresholds(value: unknown): readonly number[] {
  if (!Array.isArray(value)) {
    throw new UnreadableRowError(
      UNREADABLE_ALERT_THRESHOLDS,
      "Budget.alertThresholds",
      JSON.stringify(value) ?? "undefined",
    );
  }
  const thresholds: number[] = [];
  for (const element of value as readonly unknown[]) {
    if (typeof element !== "number" || !Number.isInteger(element)) {
      throw new UnreadableRowError(
        UNREADABLE_ALERT_THRESHOLDS,
        "Budget.alertThresholds",
        JSON.stringify(element) ?? "undefined",
      );
    }
    thresholds.push(element);
  }
  return thresholds;
}

export function readBudget(row: BudgetRow): Budget {
  return {
    budgetId: asCostIdentifier(row.id),
    environmentId: asCostIdentifier(row.environmentId),
    // `agentId` is NOT in the encoded column — it is its own indexed foreign key
    // — so the decoder takes it as a separate parameter rather than inventing it.
    target: decodeBudgetTarget(
      row.scope,
      row.agentId === null ? null : asCostIdentifier<AgentId>(row.agentId),
    ),
    period: readPeriod(row.period),
    limitCents: row.limitCents,
    // A null turn ceiling is "turns are not capped", which the domain spells as
    // zero. `domain/budget.ts` reads "zero or below means completed turns are
    // not capped", so the two forms already mean the same thing.
    runsLimit: row.turnsLimit ?? 0,
    alertThresholds: readThresholds(row.alertThresholds),
    enabled: row.enabled,
    overrideUntil: row.overrideUntil,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Every column a `Budget` write names, guarded. */
export function writeBudget(budget: Budget): {
  readonly id: string;
  readonly environmentId: string;
  readonly agentId: string | null;
  readonly scope: string;
  readonly period: string;
  readonly limitCents: number;
  readonly turnsLimit: number;
  readonly alertThresholds: readonly number[];
  readonly enabled: boolean;
  readonly overrideUntil: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
} {
  return {
    id: requireUuid("Budget.id", budget.budgetId),
    environmentId: requireUuid("Budget.environmentId", budget.environmentId),
    agentId: requireUuidOrNull("Budget.agentId", budget.target.agentId),
    scope: encodeBudgetTarget(budget.target),
    period: budget.period,
    limitCents: requireIntegerLimit("Budget.limitCents", budget.limitCents),
    turnsLimit: requireIntegerLimit("Budget.turnsLimit", budget.runsLimit),
    alertThresholds: requireThresholds(budget.alertThresholds),
    enabled: budget.enabled,
    overrideUntil: budget.overrideUntil,
    createdAt: budget.createdAt,
    updatedAt: budget.updatedAt,
  };
}

export function readCrossing(row: CrossingRow): ThresholdEvent {
  const spent = centsToMoney(row.spentCents);
  if (!spent.ok) {
    throw new UnreadableRowError(
      UNREADABLE_CROSSING_SPEND,
      "BudgetThresholdEvent.spentCents",
      String(row.spentCents),
    );
  }
  return {
    eventId: asCostIdentifier(row.id),
    environmentId: asCostIdentifier(row.environmentId),
    budgetId: asCostIdentifier(row.budgetId),
    windowKey: asCostIdentifier(row.windowKey),
    threshold: row.threshold,
    spent: spent.value,
    tasks: row.runs,
    createdAt: row.createdAt,
  };
}

export function writeCrossing(event: ThresholdEvent): {
  readonly id: string;
  readonly environmentId: string;
  readonly budgetId: string;
  readonly windowKey: string;
  readonly threshold: number;
  readonly spentCents: number;
  readonly runs: number;
  readonly createdAt: Date;
} {
  // The exact amount first, then the column's narrower form, then the proof that
  // the second reads back as the first. Doing the conversion before the checks
  // would let a spend that cannot be recorded exactly reach the row.
  const spentCents = requireRepresentableSpend(
    event.spent.microCents,
    Number(moneyToCentsString(event.spent)),
  );
  requireCrossingValues({
    threshold: event.threshold,
    spentCents,
    runs: event.tasks,
    windowKey: event.windowKey,
  });
  return {
    id: requireUuid("BudgetThresholdEvent.id", event.eventId),
    environmentId: requireUuid("BudgetThresholdEvent.environmentId", event.environmentId),
    budgetId: requireUuid("BudgetThresholdEvent.budgetId", event.budgetId),
    windowKey: event.windowKey,
    threshold: event.threshold,
    spentCents,
    runs: event.tasks,
    createdAt: event.createdAt,
  };
}

/**
 * The per-kind configuration, read against the kind its channel declares.
 *
 * `AlertChannelConfiguration_shape_check` already forces the columns to match
 * the `type` column, so a coherent row is the normal case — but the check binds
 * the CONFIGURATION's own `type`, and the channel's `type` is a different column
 * on a different table. The foreign key is `[channelId, environmentId, type]`,
 * which is what keeps the two in step; this read is what turns a break in that
 * agreement into a named refusal rather than a `null` address a transport would
 * dial.
 */
function readConfiguration(kind: ChannelKind, row: ChannelConfigurationRow): ChannelConfiguration {
  if (kind === "EMAIL") {
    if (row.email === null) {
      throw new UnreadableRowError(
        CHANNEL_CONFIGURATION_INCOHERENT,
        "AlertChannelConfiguration.email",
        "null",
      );
    }
    return { kind: "EMAIL", email: row.email };
  }
  if (kind === "SLACK") {
    if (row.slackChannelId === null || row.slackChannelName === null) {
      throw new UnreadableRowError(
        CHANNEL_CONFIGURATION_INCOHERENT,
        "AlertChannelConfiguration.slackChannelId",
        JSON.stringify([row.slackChannelId, row.slackChannelName]),
      );
    }
    return {
      kind: "SLACK",
      channelId: row.slackChannelId,
      channelName: row.slackChannelName,
      integrationId: row.integrationId,
      credential: row.credentialId === null ? null : asCostIdentifier<CredentialRef>(row.credentialId),
    };
  }
  // A webhook is never sent unsigned: the domain requires the credential and the
  // shape check requires the column, so a row missing it is unreadable rather
  // than a webhook this adapter would hand to a transport without a signature.
  if (row.webhookUrl === null || row.credentialId === null) {
    throw new UnreadableRowError(
      CHANNEL_CONFIGURATION_INCOHERENT,
      "AlertChannelConfiguration.webhookUrl",
      JSON.stringify([row.webhookUrl, row.credentialId]),
    );
  }
  return {
    kind: "WEBHOOK",
    url: row.webhookUrl,
    credential: asCostIdentifier<CredentialRef>(row.credentialId),
  };
}

export function readChannel(row: ChannelRow): AlertChannel {
  if (row.configuration === null) {
    throw new UnreadableRowError(CHANNEL_CONFIGURATION_ABSENT, "AlertChannel.configuration", row.id);
  }
  const kind = row.type as ChannelKind;
  return {
    channelId: asCostIdentifier(row.id),
    environmentId: asCostIdentifier(row.environmentId),
    kind,
    name: row.name,
    enabled: row.enabled,
    topics: [...row.alertTypes],
    deduplicationKey:
      row.deduplicationKey === null ? null : asCostIdentifier<DeduplicationKey>(row.deduplicationKey),
    operatorSuppliedKey: row.userProvidedDeduplicationKey,
    configuration: readConfiguration(kind, row.configuration),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The configuration columns a write names, per kind. Nulls are explicit. */
export function writeConfiguration(configuration: ChannelConfiguration): ChannelConfigurationRow {
  if (configuration.kind === "EMAIL") {
    return {
      email: configuration.email,
      webhookUrl: null,
      slackChannelId: null,
      slackChannelName: null,
      integrationId: null,
      credentialId: null,
    };
  }
  if (configuration.kind === "SLACK") {
    return {
      email: null,
      webhookUrl: null,
      slackChannelId: configuration.channelId,
      slackChannelName: configuration.channelName,
      integrationId: configuration.integrationId,
      credentialId: requireUuidOrNull(
        "AlertChannelConfiguration.credentialId",
        configuration.credential,
      ),
    };
  }
  return {
    email: null,
    webhookUrl: configuration.url,
    slackChannelId: null,
    slackChannelName: null,
    integrationId: null,
    credentialId: requireUuid("AlertChannelConfiguration.credentialId", configuration.credential),
  };
}

/** The `AlertChannel` columns a write names, guarded. */
export function writeChannel(channel: AlertChannel): {
  readonly id: string;
  readonly environmentId: string;
  readonly type: ChannelKind;
  readonly name: string;
  readonly enabled: boolean;
  readonly alertTypes: readonly string[];
  readonly deduplicationKey: string | null;
  readonly userProvidedDeduplicationKey: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
} {
  requireDeduplication(channel.deduplicationKey, channel.operatorSuppliedKey);
  return {
    id: requireUuid("AlertChannel.id", channel.channelId),
    environmentId: requireUuid("AlertChannel.environmentId", channel.environmentId),
    type: channel.kind,
    name: requireChannelName(channel.name),
    enabled: channel.enabled,
    alertTypes: requireTopics(channel.topics),
    deduplicationKey: channel.deduplicationKey,
    userProvidedDeduplicationKey: channel.operatorSuppliedKey,
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
  };
}

export function readDelivery(row: DeliveryRow): AlertDelivery {
  return {
    deliveryId: asCostIdentifier(row.id),
    environmentId: asCostIdentifier(row.environmentId),
    channelId: asCostIdentifier(row.channelId),
    eventId:
      row.budgetThresholdEventId === null
        ? null
        : asCostIdentifier<ThresholdEventId>(row.budgetThresholdEventId),
    kind: row.kind as DeliveryKind,
    idempotencyKey: asCostIdentifier(row.idempotencyKey),
    status: row.status as DeliveryStatus,
    retryCount: row.retryCount,
    claimGeneration: row.claimGeneration,
    claimToken: row.claimToken === null ? null : asCostIdentifier<ClaimToken>(row.claimToken),
    availableAt: row.availableAt,
    lastRetryAt: row.lastRetryAt,
    deliveredAt: row.deliveredAt,
    lastStatusCode: row.lastStatusCode,
    lastErrorCode: row.lastErrorCode,
    lastErrorMessage: row.lastErrorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The `AlertDelivery` columns a write names, guarded. */
export function writeDelivery(delivery: AlertDelivery): {
  readonly id: string;
  readonly environmentId: string;
  readonly channelId: string;
  readonly budgetThresholdEventId: string | null;
  readonly kind: DeliveryKind;
  readonly idempotencyKey: string;
  readonly status: DeliveryStatus;
  readonly retryCount: number;
  readonly claimGeneration: number;
  readonly claimToken: string | null;
  readonly availableAt: Date;
  readonly lastRetryAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly lastStatusCode: number | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
} {
  requireDeliveryKindShape(delivery.kind, delivery.eventId);
  requireDeliveryState(delivery);
  return {
    id: requireUuid("AlertDelivery.id", delivery.deliveryId),
    environmentId: requireUuid("AlertDelivery.environmentId", delivery.environmentId),
    channelId: requireUuid("AlertDelivery.channelId", delivery.channelId),
    budgetThresholdEventId: requireUuidOrNull(
      "AlertDelivery.budgetThresholdEventId",
      delivery.eventId,
    ),
    kind: delivery.kind,
    idempotencyKey: delivery.idempotencyKey,
    status: delivery.status,
    retryCount: delivery.retryCount,
    claimGeneration: delivery.claimGeneration,
    // The claim token is `@db.Uuid` too, and it is the column most likely to be
    // handed a readable placeholder: the domain brands it a `ClaimToken` and a
    // dispatcher mints it, so nothing between the two says it is a uuid.
    claimToken: requireUuidOrNull("AlertDelivery.claimToken", delivery.claimToken),
    availableAt: delivery.availableAt,
    lastRetryAt: delivery.lastRetryAt,
    deliveredAt: delivery.deliveredAt,
    lastStatusCode: delivery.lastStatusCode,
    lastErrorCode: delivery.lastErrorCode,
    lastErrorMessage: delivery.lastErrorMessage,
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
  };
}

/** The append-only send record's columns, guarded. */
export function writeRetry(retry: AlertDeliveryRetry): {
  readonly environmentId: string;
  readonly deliveryId: string;
  readonly retryNumber: number;
  readonly status: "SUCCEEDED" | "FAILED";
  readonly responseStatus: number | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly startedAt: Date;
  readonly finishedAt: Date;
} {
  const finishedAt = requireRetryRecord(retry);
  return {
    environmentId: requireUuid("AlertDeliveryRetry.environmentId", retry.environmentId),
    deliveryId: requireUuid("AlertDeliveryRetry.deliveryId", retry.deliveryId),
    retryNumber: retry.retryNumber,
    status: retry.status,
    responseStatus: retry.responseStatus,
    errorCode: retry.errorCode,
    errorMessage: retry.errorMessage,
    startedAt: retry.startedAt,
    // The column is NOT NULL and the domain's field is nullable. The instant
    // comes back FROM the guard that proved it present, so nothing here can
    // substitute a different one.
    finishedAt,
  };
}

/**
 * The ancestry predicate every scoped read carries.
 *
 * NOT `environmentId` ALONE, and that is the whole point. `EnvironmentScope`
 * names an organization, a project and an environment, and a caller holding a
 * grant for one tenant can hand an environment id belonging to another: the id
 * would match, the rows would be returned, and cross-scope denial — the property
 * ADR M0.3 §4 says this programme cannot get wrong — would have been decided by
 * whichever id the caller happened to supply. Spelled as a relation filter it
 * costs no extra statement: the driver folds it into the same SELECT.
 *
 * `InMemoryBudgetRepository` compares `environmentId` and stops, so this adapter
 * is STRICTER than the double it is checked against. That divergence is
 * deliberate, is not reachable from the shared conformance scenario (which uses
 * a consistent scope throughout), and has its own named case in
 * `cost-constraints.integration.test.ts`.
 */
export function scopedWhere(scope: EnvironmentScope): {
  readonly environmentId: string;
  readonly environment: {
    readonly projectId: string;
    readonly project: { readonly organizationId: string };
  };
} {
  return {
    environmentId: scope.environmentId,
    environment: {
      projectId: scope.projectId,
      project: { organizationId: scope.organizationId },
    },
  };
}
