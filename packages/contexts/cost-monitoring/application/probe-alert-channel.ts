// Use case: prove a channel works, and leave the proof on the ledger.
//
// An operator who has just configured a webhook wants to know it reaches them
// BEFORE their budget runs out. That is the whole feature, and the interesting
// part is that it writes to the same ledger a budget alert does.
//
// WHY A TEST SEND IS A REAL `AlertDelivery` ROW.
//
// It could have been a fire-and-forget call whose result was returned and
// forgotten. It is not, and the reason is that the failure an operator most needs
// to see is the one that happened five minutes ago in a browser tab they have
// since closed. A durable row means the channel listing can show "last delivery:
// FAILED, url_blocked, four minutes ago" without anyone having been watching.
//
// IT IS NEVER CLAIMED. `kind = "TEST"` and `finaliseDirect` — a synchronous send
// whose result nobody is racing for. The claim exists to arbitrate between
// concurrent dispatchers of one budget crossing; a test send has exactly one
// dispatcher, the operator who asked, and putting it through a lease would let a
// second click silently return "someone else is sending" instead of sending.
//
// ITS IDEMPOTENCY KEY IS UNIQUE PER CLICK. A budget delivery's key is
// `budget:<event>:<channel>` precisely so a redelivery finds the same row; a
// test's carries a fresh nonce, because two clicks are two questions and the
// second must actually send.

import { err, ok, runResult, type Result } from "@platos/kernel";

import {
  LOCAL_DELIVERY_FAILURES,
  alertChannelNotFound,
  asCostIdentifier,
  finaliseDirect,
  notDelivered,
  retryRecord,
  testIdempotencyKey,
  type AlertChannel,
  type AlertChannelId,
  type AlertDelivery,
  type AlertDeliveryId,
  type DeliveryOutcome,
} from "../domain/index.js";
import { authorize } from "./authorization.js";
import { notifierFor, type CostMonitoringDependencies } from "./dependencies.js";
import { targetFor } from "./notification-target.js";

/** Ceiling on the operator's message. The source's, kept. */
export const MAX_PROBE_MESSAGE_LENGTH = 500;

const DEFAULT_PROBE_MESSAGE = "Test notification from Platos";

export interface ProbeAlertChannelCommand {
  readonly authorization: unknown;
  readonly channelId: AlertChannelId;
  readonly message?: string;
}

export interface ProbeResult {
  readonly delivery: AlertDelivery;
  readonly outcome: DeliveryOutcome;
}

export async function probeAlertChannel(
  dependencies: CostMonitoringDependencies,
  command: ProbeAlertChannelCommand,
): Promise<Result<ProbeResult>> {
  const granted = authorize(dependencies, command.authorization, "secret:mutate");
  if (!granted.ok) return err(granted.error);

  const scope = granted.value.scope;
  const found = await dependencies.repository.findAlertChannel(scope, command.channelId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(alertChannelNotFound(command.channelId));

  const now = dependencies.clock.now();
  const draft: AlertDelivery = {
    deliveryId: asCostIdentifier<AlertDeliveryId>(dependencies.ids.uuid()),
    environmentId: scope.environmentId,
    channelId: found.value.channelId,
    eventId: null,
    kind: "TEST",
    idempotencyKey: testIdempotencyKey(found.value.channelId, dependencies.ids.ulid()),
    status: "PENDING",
    retryCount: 0,
    claimGeneration: 0,
    claimToken: null,
    availableAt: now,
    lastRetryAt: null,
    deliveredAt: null,
    lastStatusCode: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: now,
    updatedAt: now,
  };
  const opened = await runResult(dependencies.unitOfWork, (transaction) =>
    dependencies.repository.insertDelivery(draft, transaction),
  );
  if (!opened.ok) return err(opened.error);

  const message = (command.message ?? DEFAULT_PROBE_MESSAGE).slice(0, MAX_PROBE_MESSAGE_LENGTH);
  const outcome = await send(dependencies, found.value, opened.value.deliveryId, message);

  const finishedAt = dependencies.clock.now();
  const settled = finaliseDirect(opened.value, outcome, dependencies.policy.delivery, finishedAt);
  if (!settled.ok) return err(settled.error);

  const written = await runResult(dependencies.unitOfWork, (transaction) =>
    dependencies.repository.settleDelivery(
      settled.value,
      retryRecord(settled.value, outcome, finishedAt),
      transaction,
    ),
  );
  if (!written.ok) return err(written.error);
  return ok({ delivery: written.value, outcome });
}

/**
 * Hand the probe to the transport that serves its kind.
 *
 * A disabled channel is recorded as a failed delivery rather than refused
 * outright. The operator asked "does this work?", and "it is switched off" is an
 * answer to that question which belongs on the ledger beside the others.
 */
async function send(
  dependencies: CostMonitoringDependencies,
  channel: AlertChannel,
  deliveryId: string,
  message: string,
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
  const sent = await notifier.probe({
    target,
    idempotencyKey: deliveryId,
    message,
    channelName: channel.name,
    sentAt: dependencies.clock.now(),
  });
  return sent.ok ? sent.value : notDelivered(sent.error.code, sent.error.message);
}
