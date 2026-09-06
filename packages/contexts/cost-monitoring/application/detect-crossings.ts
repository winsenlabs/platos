// Use case: record the threshold crossings a status has reached, and fan the
// recipients out.
//
// ONE TRANSACTION PER CROSSING, AND BOTH WRITES IN IT.
//
// The crossing row and the delivery rows for every subscribed channel are written
// together. If the crossing committed alone, an alert would be permanently owed
// and permanently unsent — the unique constraint would refuse it forever after
// while no delivery row existed to send it. That failure mode is silent, durable
// and exactly the one this design exists to prevent, so the two writes are one
// transaction and there is no path that writes only the first.
//
// A FAN-OUT FAILURE THEREFORE ROLLS BACK, AND `runResult` IS WHAT MAKES IT.
// `UnitOfWork.run`'s contract is exact: it "commits when `work` resolves and
// rolls back when it rejects". Returning an error `Result` from inside the
// callback RESOLVES, so the transaction COMMITS — which is how this file once
// produced the one outcome its own header says it exists to prevent: the
// crossing row committed, no delivery rows beside it, and the unique constraint
// refusing the crossing forever after.
//
// The first fix here was a bespoke `CrossingFanOutFailed` class, thrown inside
// the callback and unwrapped just outside it. It was correct and it was LOCAL:
// the next use case in the next context to write two rows in one transaction
// would have had to know to invent the same class, and the shape is one the
// ordinary reading of both contracts produces rather than one anybody spots. It
// is now `runResult` from the kernel (`ports/unit-of-work.ts`), where the
// failing branch throws before any `return` is reachable — so "commit with an
// error" is not something this file could express even if it tried.
//
// BOTH WRITES NOW ROLL BACK, where the bespoke version treated only the second.
// The old asymmetry was justified — when the threshold-event insert fails
// nothing has been written yet, so committing an empty transaction and rolling
// one back are the same outcome — and it was an argument a reader had to
// re-derive at every call site. Uniform rollback needs no argument at all.
//
// A DUPLICATE IS AN OUTCOME, NOT AN ERROR. Two evaluators racing on one crossing
// is normal; the store's `@@unique([budgetId, windowKey, threshold])` decides
// which one wins and the loser learns it did by receiving `null`. The source
// reaches the same place by catching a driver error code and re-raising anything
// else, which puts the correctness of "alert exactly once" behind a string
// comparison against a vendor's error catalogue.
//
// THE ORDER IS ASCENDING. A cap that jumps from 40% to 90% in one turn records
// 50, then 80, then 90 — so an operator reading their alerts in arrival order
// sees the cap climbing rather than one alarming number with two silent
// predecessors.

import {
  err,
  ok,
  runResult,
  type EnvironmentScope,
  type Result,
} from "@platos/kernel";

import {
  asCostIdentifier,
  budgetIdempotencyKey,
  budgetRecipients,
  crossedThresholds,
  type AlertDelivery,
  type AlertDeliveryId,
  type BudgetStatus,
  type ThresholdEvent,
  type ThresholdEventId,
} from "../domain/index.js";
import type { CostMonitoringDependencies } from "./dependencies.js";

export interface DetectCrossingsCommand {
  readonly scope: EnvironmentScope;
  readonly status: BudgetStatus;
}

/** One crossing that was newly recorded, and how many recipients it reached. */
export interface RecordedCrossing {
  readonly event: ThresholdEvent;
  readonly recipients: number;
}

/**
 * Record every threshold this status has newly crossed.
 *
 * Returns only the NEW ones. A crossing already in the store is not in the
 * answer, because the caller's next step is to dispatch what it was handed and
 * dispatching an already-delivered crossing is how an operator receives the same
 * alert every ten seconds for a week.
 */
export async function detectCrossings(
  dependencies: CostMonitoringDependencies,
  command: DetectCrossingsCommand,
): Promise<Result<readonly RecordedCrossing[]>> {
  const status = command.status;
  const thresholds = crossedThresholds(status);
  if (thresholds.length === 0) return ok([]);

  const channels = await dependencies.repository.listAlertChannels(command.scope, {
    kind: null,
    enabled: true,
    limit: dependencies.policy.maxPageSize,
  });
  if (!channels.ok) return err(channels.error);
  const recipients = budgetRecipients(channels.value);

  const now = dependencies.clock.now();
  const recorded: RecordedCrossing[] = [];
  for (const threshold of thresholds) {
    const draft: ThresholdEvent = {
      eventId: asCostIdentifier<ThresholdEventId>(dependencies.ids.uuid()),
      environmentId: command.scope.environmentId,
      budgetId: status.budget.budgetId,
      windowKey: status.windowKey,
      threshold,
      spent: status.spent,
      tasks: status.reading.tasks,
      createdAt: now,
    };
    const written = await runResult<ThresholdEvent | null>(dependencies.unitOfWork, async (transaction) => {
      const event = await dependencies.repository.insertThresholdEvent(draft, transaction);
      if (!event.ok || event.value === null) return event;
      const deliveries = recipients.map<AlertDelivery>((channel) => ({
        deliveryId: asCostIdentifier<AlertDeliveryId>(dependencies.ids.uuid()),
        environmentId: command.scope.environmentId,
        channelId: channel.channelId,
        eventId: event.value === null ? null : event.value.eventId,
        kind: "BUDGET",
        idempotencyKey: budgetIdempotencyKey(draft.eventId, channel.channelId),
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
      }));
      if (deliveries.length === 0) return event;
      const fanned = await dependencies.repository.insertDeliveries(deliveries, transaction);
      // RETURNING THE ERROR IS NOW THE ROLLBACK. `runResult` throws on this
      // branch before any `return` of its own is reachable, so the crossing
      // written two statements ago is discarded with it.
      if (!fanned.ok) return err(fanned.error);
      return event;
    });
    if (!written.ok) return err(written.error);
    // `null` is the unique constraint saying this crossing already fired. Not an
    // error, and deliberately not in the answer.
    if (written.value === null) continue;
    recorded.push({ event: written.value, recipients: recipients.length });
  }
  return ok(recorded);
}
