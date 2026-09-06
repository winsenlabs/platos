// Writing down what a pass did — the phase that must survive everything else.
//
// The operation row is EVIDENCE, not destruction, so it is written in its own
// transaction after the destructive one has settled or been discarded. An
// operation that crashes leaving no record is indistinguishable from one that
// was never requested, and a receipt that rolled back with the sweep would leave
// the operator with a completed deletion and nothing to show for it.
//
// The finished event is appended in that same transaction, so the row and the
// audit trail cannot disagree.
//
// A RETRY MAY NOT SOFTEN AN EARLIER VERIFICATION FAILURE. That rule is applied
// here, at the fold, because it is a statement about two passes rather than
// about one — and because this is the only place both are in scope.

import { err, ok, runResult, type Result } from "@platos/kernel";

import {
  deriveStatus,
  mergeOutcomes,
  operationStoreUnavailable,
  preserveVerificationFailure,
  projectOperation,
  scheduleAfterPass,
  toWorkStatus,
  type ErasureOperationRecord,
  type PersistedErasureOperation,
  type TargetOutcome,
} from "../domain/index.js";
import type { ErasureCause } from "../contracts/events.js";
import type { PrivacyDependencies } from "./dependencies.js";
import { appendPrivacyEvent, finishedEvent } from "./erasure-events.js";
import { PRIVACY_EVENT_NAMES } from "../contracts/events.js";

export interface RecordPassCommand {
  /** The operation as it stood BEFORE this pass. */
  readonly operation: PersistedErasureOperation;
  readonly outcomes: readonly TargetOutcome[];
  readonly cause: ErasureCause;
  /** Raw handles the guard searches the event for. Never persisted. */
  readonly handles: readonly string[];
  readonly legalHold: boolean;
}

/**
 * Fold this pass's outcomes into the record, derive the status, schedule the
 * next pass, and persist all three with the finished event.
 */
export async function recordPass(
  dependencies: PrivacyDependencies,
  command: RecordPassCommand,
): Promise<Result<ErasureOperationRecord>> {
  const now = dependencies.clock.now();
  const required = dependencies.policy.erasure.requiredTargets;

  const previous = new Map(command.operation.outcomes.map((outcome) => [outcome.target, outcome]));
  const guarded = command.outcomes.map((outcome) =>
    preserveVerificationFailure(previous.get(outcome.target), outcome),
  );
  const merged = mergeOutcomes(command.operation.outcomes, guarded);

  const status = deriveStatus(merged, {
    legalHold: command.legalHold,
    started: true,
    requiredTargets: required,
  });
  const retryCount = command.operation.retryCount + 1;
  const schedule = scheduleAfterPass({ status, retryCount }, now, dependencies.policy.retry);

  const progress = {
    workStatus: toWorkStatus(status),
    outcomes: merged,
    legalHoldPolicyId: command.operation.legalHoldPolicyId,
    retryCount,
    startedAt: command.operation.startedAt ?? now,
    completedAt: status === "completed" ? now : command.operation.completedAt,
    nextRetryAt: schedule.nextRetryAt,
    // The lease is released whatever the outcome: holding it past the pass would
    // pin a failed operation until the TTL expired, which is the failure mode the
    // lease exists to shorten rather than to cause.
    leaseToken: null,
    leaseExpiresAt: null,
  };

  return runResult(dependencies.unitOfWork, async (transaction) => {
    const written = await dependencies.repository.updateProgress(
      command.operation.organizationId,
      command.operation.operationId,
      progress,
      transaction,
    );
    if (!written.ok) return err(operationStoreUnavailable(written.error.code));

    const record = projectOperation(written.value, required);
    const appended = await appendPrivacyEvent(dependencies, {
      name: PRIVACY_EVENT_NAMES.erasureFinished,
      organizationId: record.organizationId,
      payload: finishedEvent({ operation: record, cause: command.cause }),
      handles: command.handles,
      transaction,
    });
    if (!appended.ok) return err(appended.error);
    return ok(record);
  });
}
