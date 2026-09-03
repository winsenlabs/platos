// Use case: send one threshold crossing to every recipient that is owed it.
//
// THE ORDER OF OPERATIONS IS THE CORRECTNESS ARGUMENT, so it is written out:
//
//   1. A delivery already `SUCCEEDED` is SKIPPED before anything is written. A
//      redelivery of a crossing with four recipients, three already delivered,
//      sends exactly one message.
//   2. The row is CLAIMED — one conditional write that takes a fresh token,
//      bumps the generation, consumes a retry and pushes the lease out. Losing
//      the claim is a skip, not a failure: someone else has it.
//   3. The transport runs OUTSIDE any transaction. A network call inside one
//      holds a database connection for the length of a stranger's timeout.
//   4. The row is FINALISED against the exact token and generation it was
//      claimed with. A stale proof writes nothing and is reported as a skip,
//      which is what recovers a dispatcher whose lease expired mid-send.
//
// A FAILED RECIPIENT DOES NOT ABORT THE BATCH. Every recipient is attended to,
// then the summary decides. The source raises after the loop for the same
// reason: aborting on the first failure leaves the remaining channels unsent and
// makes the retry re-send the ones that already worked.
//
// AND THE WHOLE THING FAILS AT THE END WHEN ANYTHING FAILED, so the durable
// caller retries. The ledger is what makes that safe — the retry skips the rows
// that succeeded.

import { err, ok, type EnvironmentScope, type Result } from "@platos/kernel";

import {
  EMPTY_SUMMARY,
  LOCAL_DELIVERY_FAILURES,
  asCostIdentifier,
  deliveryFailed,
  describeTarget,
  finaliseClaim,
  isSettled,
  notDelivered,
  proofOf,
  retryRecord,
  thresholdEventUnavailable,
  withReport,
  type AlertChannel,
  type AlertDelivery,
  type Budget,
  type BudgetAlert,
  type ClaimToken,
  type DeliveryOutcome,
  type DeliveryReport,
  type DeliverySummary,
  type ThresholdEvent,
  type ThresholdEventId,
} from "../domain/index.js";
import { notifierFor, type CostMonitoringDependencies } from "./dependencies.js";
import { targetFor } from "./notification-target.js";

export interface DeliverCrossingCommand {
  readonly scope: EnvironmentScope;
  readonly eventId: ThresholdEventId;
}

export async function deliverCrossing(
  dependencies: CostMonitoringDependencies,
  command: DeliverCrossingCommand,
): Promise<Result<DeliverySummary>> {
  const found = await dependencies.repository.findThresholdEvent(command.scope, command.eventId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(thresholdEventUnavailable(command.eventId));

  const budget = await dependencies.repository.findBudget(command.scope, found.value.budgetId);
  if (!budget.ok) return err(budget.error);
  if (budget.value === null) return err(thresholdEventUnavailable(command.eventId));

  const targets = await dependencies.repository.listDeliveriesForEvent(command.scope, command.eventId);
  if (!targets.ok) return err(targets.error);

  const alert = alertFor(command.scope, found.value, budget.value, dependencies.clock.now());
  let summary = EMPTY_SUMMARY;
  for (const target of targets.value) {
    summary = withReport(summary, await sendOne(dependencies, command.scope, target, alert));
  }
  if (summary.failed > 0) return err(deliveryFailed(summary.failed, summary.delivered));
  return ok(summary);
}

async function sendOne(
  dependencies: CostMonitoringDependencies,
  scope: EnvironmentScope,
  target: { readonly delivery: AlertDelivery; readonly channel: AlertChannel },
  alert: BudgetAlert,
): Promise<DeliveryReport> {
  const { delivery, channel } = target;
  const skip = (errorCode: string | null) => ({
    deliveryId: delivery.deliveryId,
    channelId: delivery.channelId,
    kind: channel.kind,
    status: "SKIPPED" as const,
    statusCode: delivery.lastStatusCode,
    errorCode,
  });

  // Terminal. Never re-sent, by anyone, ever.
  if (isSettled(delivery)) return skip(null);

  const now = dependencies.clock.now();
  const claimed = await dependencies.repository.claimDelivery(
    scope,
    delivery.deliveryId,
    asCostIdentifier<ClaimToken>(dependencies.ids.uuid()),
    new Date(now.getTime() + dependencies.policy.delivery.leaseSeconds * 1000),
    now,
  );
  if (!claimed.ok) return skip(LOCAL_DELIVERY_FAILURES.deliveryUnavailable);
  if (claimed.value === null) return skip(LOCAL_DELIVERY_FAILURES.deliveryUnavailable);

  const proof = proofOf(claimed.value);
  if (!proof.ok) return skip(LOCAL_DELIVERY_FAILURES.staleClaim);

  // The transport runs here, outside any transaction.
  const outcome = await dispatch(dependencies, channel, delivery.deliveryId, alert);

  const finishedAt = dependencies.clock.now();
  const settled = finaliseClaim(
    claimed.value,
    proof.value,
    outcome,
    dependencies.policy.delivery,
    finishedAt,
  );
  if (settled === null) return skip(LOCAL_DELIVERY_FAILURES.staleClaim);

  const written = await dependencies.unitOfWork.run((transaction) =>
    dependencies.repository.finaliseDelivery(
      settled,
      retryRecord(settled, outcome, finishedAt),
      proof.value,
      transaction,
    ),
  );
  // `null` from the store is the same stale-claim answer the domain gives, and
  // it is reached the same way: another dispatcher finalised this row while the
  // transport was running. Reporting it as a failure would make a recovered
  // delivery look like a lost one.
  if (!written.ok || written.value === null) return skip(LOCAL_DELIVERY_FAILURES.staleClaim);

  return {
    deliveryId: delivery.deliveryId,
    channelId: delivery.channelId,
    kind: channel.kind,
    status: outcome.ok ? "SUCCEEDED" : "FAILED",
    statusCode: outcome.statusCode,
    errorCode: outcome.errorCode,
  };
}

/**
 * Hand one message to the transport that serves its kind.
 *
 * Every refusal decided HERE — before the network — is one of the closed set in
 * `LOCAL_DELIVERY_FAILURES`, so the states a channel can be in without a call
 * having been made are enumerable and an operator can be shown all of them.
 */
async function dispatch(
  dependencies: CostMonitoringDependencies,
  channel: AlertChannel,
  deliveryId: string,
  alert: BudgetAlert,
): Promise<DeliveryOutcome> {
  if (!channel.enabled) {
    return notDelivered(LOCAL_DELIVERY_FAILURES.channelDisabled, "Channel is disabled");
  }
  const target = targetFor(channel);
  if (target === null) {
    return notDelivered(
      LOCAL_DELIVERY_FAILURES.missingConfiguration,
      "Channel configuration is incomplete",
    );
  }
  const notifier = notifierFor(dependencies, channel.kind);
  if (notifier === null) {
    return notDelivered(
      LOCAL_DELIVERY_FAILURES.missingConfiguration,
      "No notifier is composed for this channel kind",
    );
  }
  const sent = await notifier.deliver({ target, idempotencyKey: deliveryId, alert });
  // A notifier that returns an error rather than an outcome is a defect on its
  // side; it becomes a recorded failure rather than a thrown one, because the
  // ledger is what the retry reads and an exception writes nothing to it.
  return sent.ok ? sent.value : notDelivered(sent.error.code, sent.error.message);
}

/** Assemble the alert from the crossing and the cap that produced it. */
export function alertFor(
  scope: EnvironmentScope,
  event: ThresholdEvent,
  budget: Budget,
  firedAt: Date,
): BudgetAlert {
  return {
    eventId: event.eventId,
    budgetId: budget.budgetId,
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    subject: budget.target.subject,
    targetId: budget.target.targetId,
    subjectLabel: describeTarget(budget.target),
    period: budget.period,
    threshold: event.threshold,
    limitCents: budget.limitCents,
    // The SNAPSHOT taken at the crossing, never recomputed. Re-reading the
    // counters at delivery time would report a figure the threshold was not
    // crossed at, and a retry hours later would report a different one again.
    spent: event.spent,
    tasks: event.tasks,
    runsLimit: budget.runsLimit,
    windowKey: event.windowKey,
    firedAt,
  };
}
