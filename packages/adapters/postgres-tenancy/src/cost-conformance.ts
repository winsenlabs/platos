// One scenario, written once, so `InMemoryBudgetRepository` and this adapter can
// be asked the SAME questions and their answers compared.
//
// Same instrument as `./conformance.ts` and `./identity-conformance.ts`, and the
// same reason: two independently written suites measure two things and agree by
// coincidence. This module drives one sequence of port calls and records what
// came back; a test runs it twice and compares verbatim. A divergence is then a
// named step with a value on each side.
//
// EVERY IDENTIFIER IS SUPPLIED BY THE CALLER, so neither store mints one, and
// every one of them is a real uuid. That is not tidiness: `Budget.id`,
// `AlertChannel.id`, `AlertDelivery.id` and `AlertDelivery.claimToken` are all
// `@db.Uuid`, the context's own `SequenceIdGenerator` mints `id-0001`, and its
// `testBudget` fixture mints `budget-1`. Both satisfy the double and both are
// refused by PostgreSQL. The scenario uses values BOTH stores accept, so a
// divergence here is a behaviour difference rather than a shape difference; the
// shape refusals have their own named cases in the constraints suite.
//
// EVERY REFUSING WRITE IS ALONE IN ITS TRANSACTION, and that is a finding rather
// than a convention. On PostgreSQL, a statement that violates a constraint
// aborts the whole transaction — so a scenario that inserted a duplicate cap and
// then carried on writing in the same unit of work would measure 25P02 rather
// than the refusal it meant to. The three inserts under test avoid raising at
// all (see `cost-budgets.ts`), which is what lets the caller keep its
// transaction; the scenario is still written this way so the property is visible
// rather than assumed.
//
// NOTHING IS NORMALISED. Dates, counts, booleans, ordering, `null`-versus-absent
// and the `Result` errors themselves all compare literally. `Money` is a
// `bigint` and has no JSON form, so the comparison is structural rather than
// serialised — which is the point: a spend that did not survive the store's
// `DOUBLE PRECISION` column shows up as an unequal `microCents`.

import type {
  AlertChannel,
  Budget,
  BudgetRepository,
  EnvironmentScope,
  ThresholdEvent,
  TransactionScope,
} from "@platos/context-cost-monitoring/application/ports/index.js";
import { asCostIdentifier } from "@platos/context-cost-monitoring/application/ports/index.js";

import { runAlertConformance } from "./cost-conformance-alerts.js";

export const AT = new Date("2026-05-01T09:00:00.000Z");
export const LATER = new Date("2026-05-01T10:00:00.000Z");
export const LEASE_UNTIL = new Date("2026-05-01T10:05:00.000Z");
export const AFTER_LEASE = new Date("2026-05-01T10:10:00.000Z");

/** Every identifier the scenario needs. All uuids; both stores use the same. */
export interface CostConformanceIds {
  readonly scopeCapId: string;
  readonly agentCapId: string;
  readonly userCapId: string;
  readonly missingCapId: string;
  readonly firstCrossingId: string;
  readonly duplicateCrossingId: string;
  readonly secondCrossingId: string;
  readonly missingCrossingId: string;
  readonly emailChannelId: string;
  readonly slackChannelId: string;
  readonly clashingChannelId: string;
  readonly missingChannelId: string;
  readonly credentialId: string;
  readonly firstDeliveryId: string;
  readonly secondDeliveryId: string;
  readonly thirdDeliveryId: string;
  readonly probeDeliveryId: string;
  readonly missingDeliveryId: string;
  readonly claimToken: string;
  readonly staleToken: string;
}

export type CostObservation = Record<string, unknown>;

export interface CostConformanceEnvironment {
  readonly repository: BudgetRepository;
  readonly scope: EnvironmentScope;
  readonly ids: CostConformanceIds;
  /** Open one transaction. The fake's double, or the adapter's unit of work. */
  run<Value>(work: (transaction: TransactionScope) => Promise<Value>): Promise<Value>;
  /**
   * Make this environment resolvable by the installation-wide sweep.
   *
   * A no-op on the real store, where `listPendingCrossings` re-derives the chain
   * by joining `Environment` to `Project`. The double has no tree to join, so it
   * is told the scope instead. That asymmetry is the port's own — the sweep runs
   * without a request scope — and it is the only seam this scenario needs.
   */
  knowScope(): void;
}

/** A cap, with everything but the identifier and the subject held fixed. */
export function conformanceBudget(
  scope: EnvironmentScope,
  budgetId: string,
  subject: "scope" | "agent" | "user",
  overrides: Partial<Budget> = {},
): Budget {
  return {
    budgetId: asCostIdentifier(budgetId),
    environmentId: asCostIdentifier(scope.environmentId),
    target: {
      subject,
      targetId: subject === "user" ? "*" : "",
      tier: "llm",
      skillSlug: null,
      // NULL even on the `agent`-subject cap. `Budget_ancestry` demands that a
      // non-null `agentId` name an `Agent` in the environment's project, and an
      // `Agent` is a row this package may not write; the SUBJECT is what
      // `byListingOrder` sorts on, and it is inside the encoded column.
      agentId: null,
      legacyWebhookUrl: null,
      legacyEmails: null,
      overrideBy: null,
    },
    period: "day",
    limitCents: 100_000,
    runsLimit: 0,
    alertThresholds: [50, 80, 100],
    enabled: true,
    overrideUntil: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

export function conformanceChannel(
  scope: EnvironmentScope,
  channelId: string,
  overrides: Partial<AlertChannel> = {},
): AlertChannel {
  return {
    channelId: asCostIdentifier(channelId),
    environmentId: asCostIdentifier(scope.environmentId),
    kind: "EMAIL",
    name: "ops mailbox",
    enabled: true,
    topics: ["BUDGET"],
    deduplicationKey: null,
    operatorSuppliedKey: false,
    configuration: { kind: "EMAIL", email: "ops@example.test" },
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function crossing(
  scope: EnvironmentScope,
  eventId: string,
  budgetId: string,
  threshold: number,
): ThresholdEvent {
  return {
    eventId: asCostIdentifier(eventId),
    environmentId: asCostIdentifier(scope.environmentId),
    budgetId: asCostIdentifier(budgetId),
    windowKey: asCostIdentifier("2026-05-01"),
    threshold,
    // 1234.5 cents exactly. It survives the column's DOUBLE PRECISION and reads
    // back as the same `bigint`, which is what makes this step a comparison of
    // BEHAVIOUR rather than of rounding; the amount that does NOT survive has
    // its own named case in the constraints suite.
    spent: { microCents: 1_234_500_000n, currency: asCostIdentifier("USD") },
    tasks: 7,
    createdAt: AT,
  };
}

async function runBudgets(
  environment: CostConformanceEnvironment,
  observed: CostObservation,
): Promise<void> {
  const { repository, scope, ids } = environment;
  const scopeCap = conformanceBudget(scope, ids.scopeCapId, "scope");
  const agentCap = conformanceBudget(scope, ids.agentCapId, "agent");
  const userCap = conformanceBudget(scope, ids.userCapId, "user");

  observed.listBudgetsEmpty = await repository.listBudgets(scope);
  observed.insertScopeCap = await environment.run((transaction) =>
    repository.insertBudget(scopeCap, transaction),
  );
  // ALONE in its transaction. Nothing is written by it, and on a store that let
  // the unique index raise, nothing after it could be written either.
  observed.insertScopeCapAgain = await environment.run((transaction) =>
    repository.insertBudget(scopeCap, transaction),
  );
  observed.insertAgentCap = await environment.run((transaction) =>
    repository.insertBudget(agentCap, transaction),
  );
  observed.insertUserCap = await environment.run((transaction) =>
    repository.insertBudget(userCap, transaction),
  );

  observed.findScopeCap = await repository.findBudget(scope, asCostIdentifier(ids.scopeCapId));
  observed.findMissingCap = await repository.findBudget(scope, asCostIdentifier(ids.missingCapId));
  // agent < scope < user, and every cap here shares a period, so the order is
  // decided entirely by the subject inside the encoded `scope` column.
  observed.listBudgetsOrdered = await repository.listBudgets(scope);
  observed.firstPage = await repository.pageBudgets(scope, { limit: 2, offset: 0 });
  observed.secondPage = await repository.pageBudgets(scope, { limit: 2, offset: 2 });

  const raised: Budget = { ...scopeCap, limitCents: 250_000, updatedAt: LATER };
  observed.updateScopeCap = await environment.run((transaction) =>
    repository.updateBudget(raised, transaction),
  );
  observed.findRaisedCap = await repository.findBudget(scope, asCostIdentifier(ids.scopeCapId));
  observed.updateMissingCap = await environment.run((transaction) =>
    repository.updateBudget(
      conformanceBudget(scope, ids.missingCapId, "scope"),
      transaction,
    ),
  );

  observed.retireUserCap = await environment.run((transaction) =>
    repository.retireBudget(scope, asCostIdentifier(ids.userCapId), LATER, transaction),
  );
  // The SECOND retire answers false. A store that tombstoned by `enabled` alone
  // would answer true forever, and the caller reads this as "was there a cap to
  // retire" rather than as "is one retired now".
  observed.retireUserCapAgain = await environment.run((transaction) =>
    repository.retireBudget(scope, asCostIdentifier(ids.userCapId), LATER, transaction),
  );
  observed.listBudgetsAfterRetire = await repository.listBudgets(scope);
  observed.findRetiredCap = await repository.findBudget(scope, asCostIdentifier(ids.userCapId));
}

async function runCrossings(
  environment: CostConformanceEnvironment,
  observed: CostObservation,
): Promise<void> {
  const { repository, scope, ids } = environment;
  const first = crossing(scope, ids.firstCrossingId, ids.scopeCapId, 50);

  observed.insertCrossing = await environment.run((transaction) =>
    repository.insertThresholdEvent(first, transaction),
  );
  // A DIFFERENT identifier for the SAME cap, window and threshold. `null`, not
  // an error: it is how "alert exactly once" is realised, and it is the outcome
  // two evaluators racing on one crossing normally produce.
  observed.insertCrossingDuplicate = await environment.run((transaction) =>
    repository.insertThresholdEvent(
      { ...first, eventId: asCostIdentifier(ids.duplicateCrossingId) },
      transaction,
    ),
  );
  observed.insertSecondCrossing = await environment.run((transaction) =>
    repository.insertThresholdEvent(
      crossing(scope, ids.secondCrossingId, ids.scopeCapId, 80),
      transaction,
    ),
  );
  observed.findCrossing = await repository.findThresholdEvent(
    scope,
    asCostIdentifier(ids.firstCrossingId),
  );
  observed.findMissingCrossing = await repository.findThresholdEvent(
    scope,
    asCostIdentifier(ids.missingCrossingId),
  );
  observed.recordedThresholds = await repository.listRecordedThresholds(
    scope,
    asCostIdentifier(ids.scopeCapId),
    asCostIdentifier("2026-05-01"),
  );
  observed.recordedThresholdsOtherWindow = await repository.listRecordedThresholds(
    scope,
    asCostIdentifier(ids.scopeCapId),
    asCostIdentifier("2026-05-02"),
  );
}

/**
 * The whole scenario, in order.
 *
 * The order matters: the alert half fans deliveries out against the crossing the
 * budget half recorded, so the two cannot be run apart and a store that got the
 * crossing wrong fails in the alert half too.
 */
export async function runCostConformance(
  environment: CostConformanceEnvironment,
): Promise<CostObservation> {
  const observed: CostObservation = {};
  environment.knowScope();
  await runBudgets(environment, observed);
  await runCrossings(environment, observed);
  await runAlertConformance(environment, observed);
  return observed;
}
