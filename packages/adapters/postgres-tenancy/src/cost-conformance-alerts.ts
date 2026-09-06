// The alert half of the conformance scenario: channels, the outbound ledger, and
// the claim.
//
// SPLIT FROM `cost-conformance.ts` FOR ADR M0.3 §6's FILE BUDGET, exactly as
// `identity-conformance-scoped.ts` is split from its own half, and run in one
// sequence by the caller so the two cannot drift apart. The fan-out below
// addresses the crossing the budget half recorded, so a store that got the
// crossing wrong fails here as well as there.
//
// THE CLAIM IS WHERE THIS SCENARIO EARNS ITS KEEP. Four steps in a row measure
// the same row: a claim that wins, a second claim at the same instant that must
// LOSE because the lease has not expired, a finalisation naming a STALE token
// that must write nothing at all, and one naming the real token that must
// settle. A store that read the row and decided in application code passes the
// first and the fourth and fails the second and the third, and only against a
// real database — the double models the lease, so agreement here is agreement
// about concurrency rather than about shape.

import type {
  AlertDelivery,
  AlertDeliveryRetry,
  CredentialRef,
  DeduplicationKey,
  ThresholdEventId,
} from "@platos/context-cost-monitoring/application/ports/index.js";
import { asCostIdentifier } from "@platos/context-cost-monitoring/application/ports/index.js";
import { runResult } from "@platos/kernel";

import type { CostConformanceEnvironment, CostObservation } from "./cost-conformance.js";
import { AFTER_LEASE, AT, LATER, LEASE_UNTIL, conformanceChannel } from "./cost-conformance.js";

const SECOND_LEASE = new Date("2026-05-01T10:15:00.000Z");

/** A fan-out row. The idempotency key is the source's `budget:<event>:<channel>`. */
function delivery(
  environmentId: string,
  deliveryId: string,
  channelId: string,
  eventId: string | null,
  createdAt: Date,
  availableAt: Date,
): AlertDelivery {
  return {
    deliveryId: asCostIdentifier(deliveryId),
    environmentId: asCostIdentifier(environmentId),
    channelId: asCostIdentifier(channelId),
    eventId: eventId === null ? null : asCostIdentifier<ThresholdEventId>(eventId),
    kind: eventId === null ? "TEST" : "BUDGET",
    idempotencyKey: asCostIdentifier(
      eventId === null ? `test:${channelId}:probe` : `budget:${eventId}:${channelId}`,
    ),
    status: "PENDING",
    retryCount: 0,
    claimGeneration: 0,
    claimToken: null,
    availableAt,
    lastRetryAt: null,
    deliveredAt: null,
    lastStatusCode: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt,
    updatedAt: createdAt,
  };
}

/** The row a settled send leaves behind. Never edited; the table refuses it. */
function sendRecord(
  environmentId: string,
  deliveryId: string,
  retryNumber: number,
  at: Date,
): AlertDeliveryRetry {
  return {
    deliveryId: asCostIdentifier(deliveryId),
    environmentId: asCostIdentifier(environmentId),
    retryNumber,
    status: "SUCCEEDED",
    responseStatus: 200,
    errorCode: null,
    errorMessage: null,
    startedAt: at,
    finishedAt: at,
  };
}

/** The delivery a successful send produces, per `domain/alert-delivery.ts`. */
function settled(claimed: AlertDelivery, at: Date): AlertDelivery {
  return {
    ...claimed,
    status: "SUCCEEDED",
    claimToken: null,
    availableAt: at,
    lastRetryAt: at,
    deliveredAt: at,
    lastStatusCode: 200,
    lastErrorCode: null,
    lastErrorMessage: null,
    updatedAt: at,
  };
}

async function runChannels(
  environment: CostConformanceEnvironment,
  observed: CostObservation,
): Promise<void> {
  const { repository, scope, ids } = environment;
  const email = conformanceChannel(scope, ids.emailChannelId, {
    deduplicationKey: asCostIdentifier<DeduplicationKey>("ops-mailbox"),
    operatorSuppliedKey: true,
  });
  const slack = conformanceChannel(scope, ids.slackChannelId, {
    kind: "SLACK",
    name: "ops room",
    createdAt: LATER,
    updatedAt: LATER,
    configuration: {
      kind: "SLACK",
      channelId: "C-OPS",
      channelName: "#ops",
      integrationId: null,
      credential: asCostIdentifier<CredentialRef>(ids.credentialId),
    },
  });

  observed.listChannelsEmpty = await repository.listAlertChannels(scope, {
    kind: null,
    enabled: null,
    limit: 10,
  });
  observed.insertEmailChannel = await runResult(environment, (transaction) =>
    repository.insertAlertChannel(email, transaction),
  );
  observed.insertSlackChannel = await runResult(environment, (transaction) =>
    repository.insertAlertChannel(slack, transaction),
  );
  // The SAME operator-supplied deduplication key on a different channel. The
  // index that refuses it is not partial, which is why `retireChannel` clears
  // the key rather than leaving it on a tombstoned row.
  observed.insertClashingChannel = await runResult(environment, (transaction) =>
    repository.insertAlertChannel(
      conformanceChannel(scope, ids.clashingChannelId, {
        name: "second mailbox",
        deduplicationKey: asCostIdentifier<DeduplicationKey>("ops-mailbox"),
        operatorSuppliedKey: true,
        configuration: { kind: "EMAIL", email: "second@example.test" },
      }),
      transaction,
    ),
  );

  observed.findEmailChannel = await repository.findAlertChannel(
    scope,
    asCostIdentifier(ids.emailChannelId),
  );
  observed.findMissingChannel = await repository.findAlertChannel(
    scope,
    asCostIdentifier(ids.missingChannelId),
  );
  // Newest first: the slack channel was created an hour after the mailbox.
  observed.listChannels = await repository.listAlertChannels(scope, {
    kind: null,
    enabled: null,
    limit: 10,
  });
  observed.listEmailChannels = await repository.listAlertChannels(scope, {
    kind: "EMAIL",
    enabled: null,
    limit: 10,
  });
  observed.listDisabledChannels = await repository.listAlertChannels(scope, {
    kind: null,
    enabled: false,
    limit: 10,
  });

  observed.countCredentialHolders = await repository.countChannelsUsingCredential(
    scope,
    ids.credentialId,
  );
  // Switched off, and the count drops. That is the whole reason the delete path
  // asks before it tells the vault to revoke: a second channel still switched on
  // would be broken by the revoke, and a switched-off one would not.
  observed.disableSlackChannel = await runResult(environment, (transaction) =>
    repository.updateAlertChannel({ ...slack, enabled: false, updatedAt: AFTER_LEASE }, transaction),
  );
  observed.countCredentialHoldersAfterDisable = await repository.countChannelsUsingCredential(
    scope,
    ids.credentialId,
  );
  observed.enableSlackChannel = await runResult(environment, (transaction) =>
    repository.updateAlertChannel({ ...slack, updatedAt: AFTER_LEASE }, transaction),
  );
  observed.countCredentialHoldersRestored = await repository.countChannelsUsingCredential(
    scope,
    ids.credentialId,
  );
  observed.countUnknownCredentialHolders = await repository.countChannelsUsingCredential(
    scope,
    ids.missingChannelId,
  );
  // A reference that is not a uuid AT ALL, which the line above is not:
  // `ids.missingChannelId` is a well-formed uuid that names no row.
  // `AlertChannelConfiguration.credentialId` is `@db.Uuid`, so the real store
  // has to ANSWER zero rather than send it — the comparison raises 22P02, and a
  // driver error is not one of the outcomes this port publishes. The double
  // answers zero because nothing matches. WIN-258 T5's mutation sweep added this
  // observation: the guard that refuses the value had nothing that could turn
  // red, because every credential named anywhere in this scenario was a uuid.
  observed.countMalformedCredentialHolders = await repository.countChannelsUsingCredential(
    scope,
    "not-a-uuid",
  );
  observed.updateMissingChannel = await runResult(environment, (transaction) =>
    repository.updateAlertChannel(
      conformanceChannel(scope, ids.missingChannelId),
      transaction,
    ),
  );
  observed.findSlackChannelAfterUpdate = await repository.findAlertChannel(
    scope,
    asCostIdentifier(ids.slackChannelId),
  );
}

async function runDeliveries(
  environment: CostConformanceEnvironment,
  observed: CostObservation,
): Promise<void> {
  const { repository, scope, ids } = environment;
  const environmentId = scope.environmentId;
  const first = delivery(environmentId, ids.firstDeliveryId, ids.emailChannelId, ids.firstCrossingId, AT, AT);
  const second = delivery(
    environmentId,
    ids.secondDeliveryId,
    ids.slackChannelId,
    ids.firstCrossingId,
    LATER,
    AT,
  );
  const third = delivery(
    environmentId,
    ids.thirdDeliveryId,
    ids.emailChannelId,
    ids.secondCrossingId,
    AFTER_LEASE,
    LATER,
  );

  observed.fanOut = await runResult(environment, (transaction) =>
    repository.insertDeliveries([first, second], transaction),
  );
  // A RE-fan-out of the same crossing writes nothing for the row that exists and
  // one for the row that does not. The skip is the store's uniqueness rule, not
  // a read the caller did first.
  observed.refanOut = await runResult(environment, (transaction) =>
    repository.insertDeliveries([first, third], transaction),
  );
  observed.deliveriesForCrossing = await repository.listDeliveriesForEvent(
    scope,
    asCostIdentifier(ids.firstCrossingId),
  );
  observed.findDelivery = await repository.findDelivery(
    scope,
    asCostIdentifier(ids.firstDeliveryId),
  );
  observed.findMissingDelivery = await repository.findDelivery(
    scope,
    asCostIdentifier(ids.missingDeliveryId),
  );
  observed.pendingCrossingsBefore = await repository.listPendingCrossings(["PENDING"], LATER, 10);
}

async function runClaims(
  environment: CostConformanceEnvironment,
  observed: CostObservation,
): Promise<void> {
  const { repository, scope, ids } = environment;
  const claimed = await repository.claimDelivery(
    scope,
    asCostIdentifier(ids.firstDeliveryId),
    asCostIdentifier(ids.claimToken),
    LEASE_UNTIL,
    LATER,
  );
  observed.claimFirst = claimed;
  // The lease has NOT expired, so the second claim loses. A store that decided
  // this after a read would let both dispatchers through and send twice.
  observed.claimFirstAgain = await repository.claimDelivery(
    scope,
    asCostIdentifier(ids.firstDeliveryId),
    asCostIdentifier(ids.staleToken),
    SECOND_LEASE,
    LATER,
  );

  if (!claimed.ok || claimed.value === null) {
    observed.finaliseStale = "unreached: the first claim did not win";
    observed.finaliseFirst = "unreached: the first claim did not win";
    return;
  }
  const holder = claimed.value;
  const done = settled(holder, LATER);
  const record = sendRecord(scope.environmentId, ids.firstDeliveryId, holder.retryCount, LATER);

  // A STALE token. Nothing is written: not the row, and not the send record.
  observed.finaliseStale = await runResult(environment, (transaction) =>
    repository.finaliseDelivery(
      done,
      record,
      { token: asCostIdentifier(ids.staleToken), generation: 1, retryNumber: 1 },
      transaction,
    ),
  );
  observed.finaliseFirst = await runResult(environment, (transaction) =>
    repository.finaliseDelivery(
      done,
      record,
      {
        token: asCostIdentifier(ids.claimToken),
        generation: holder.claimGeneration,
        retryNumber: holder.retryCount,
      },
      transaction,
    ),
  );
  observed.findSettledDelivery = await repository.findDelivery(
    scope,
    asCostIdentifier(ids.firstDeliveryId),
  );
  // SUCCEEDED is terminal: it is skipped before any claim is written, which is
  // what stops a redelivery of a crossing re-sending a message already sent.
  observed.claimSettledDelivery = await repository.claimDelivery(
    scope,
    asCostIdentifier(ids.firstDeliveryId),
    asCostIdentifier(ids.claimToken),
    SECOND_LEASE,
    AFTER_LEASE,
  );

  // The lease recovery: a dispatcher took this row and vanished, and once the
  // lease expires the row is claimable again with a fresh generation.
  observed.claimSecondEarly = await repository.claimDelivery(
    scope,
    asCostIdentifier(ids.secondDeliveryId),
    asCostIdentifier(ids.claimToken),
    LEASE_UNTIL,
    LATER,
  );
  observed.claimSecondDuringLease = await repository.claimDelivery(
    scope,
    asCostIdentifier(ids.secondDeliveryId),
    asCostIdentifier(ids.staleToken),
    SECOND_LEASE,
    LATER,
  );
  observed.claimSecondAfterLease = await repository.claimDelivery(
    scope,
    asCostIdentifier(ids.secondDeliveryId),
    asCostIdentifier(ids.staleToken),
    SECOND_LEASE,
    AFTER_LEASE,
  );
}

async function runProbe(
  environment: CostConformanceEnvironment,
  observed: CostObservation,
): Promise<void> {
  const { repository, scope, ids } = environment;
  const probe = delivery(
    scope.environmentId,
    ids.probeDeliveryId,
    ids.emailChannelId,
    null,
    LATER,
    LATER,
  );
  observed.insertProbe = await runResult(environment, (transaction) =>
    repository.insertDelivery(probe, transaction),
  );
  // NOBODY claimed it — the port calls this "a synchronous test send" and the
  // domain refuses it for a `BUDGET` row, because a fan-out has concurrent
  // dispatchers this predicate could not tell apart.
  observed.settleProbe = await runResult(environment, (transaction) =>
    repository.settleDelivery(
      settled({ ...probe, retryCount: 1 }, AFTER_LEASE),
      sendRecord(scope.environmentId, ids.probeDeliveryId, 1, AFTER_LEASE),
      transaction,
    ),
  );
  observed.findSettledProbe = await repository.findDelivery(
    scope,
    asCostIdentifier(ids.probeDeliveryId),
  );
  // ONE row per crossing, oldest deadline first, and the settled and claimed
  // rows are gone from it.
  observed.pendingCrossingsAfter = await repository.listPendingCrossings(
    ["PENDING"],
    AFTER_LEASE,
    10,
  );
}

export async function runAlertConformance(
  environment: CostConformanceEnvironment,
  observed: CostObservation,
): Promise<void> {
  await runChannels(environment, observed);
  await runDeliveries(environment, observed);
  await runClaims(environment, observed);
  await runProbe(environment, observed);
}
