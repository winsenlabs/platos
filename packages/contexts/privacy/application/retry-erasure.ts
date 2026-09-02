// Retrying an erasure — finishing what did not settle, without overstating it.
//
// RE-RUNS ONLY THE UNSETTLED TARGETS. Re-running a settled one would re-issue
// deletes against data already gone: harmless, but the record would then report
// fresh counts for work that finished hours earlier, which misleads whoever
// reads it as evidence.
//
// THE SUBJECT ID IS RE-SUPPLIED, AND THAT IS NOT AN OVERSIGHT. The first pass
// destroyed the rows that resolve it — that is what it was for — so a retry
// driven from the record alone could address only what the record still names,
// which is less than the first pass addressed. A narrower pass that then
// VERIFIED over its own narrower question would find no survivors and report a
// pass it never earned: rounding an unknown up to "gone", from a new direction.
//
// So a retry that cannot resolve the subject is REFUSED rather than run narrow.
// The consequence is deliberate: an operation whose subject can no longer be
// resolved is finished by an operator supplying the id, not by the queue.
// Between "the queue can self-heal" and "the record never overstates", the
// second wins.
//
// EVERY PASS RUNS UNDER A LEASE, so two concurrent resumes cannot both sweep. A
// pass whose process died leaves an expiring lease the next pass reclaims,
// rather than a row nobody dares touch.

import { asIdentifier, err, ok, type Result } from "@platos/kernel";

import {
  canRetry,
  isExhausted,
  leaseUntil,
  operationNotFound,
  operationStoreUnavailable,
  projectOperation,
  retryBudgetExhausted,
  retryNotPermitted,
  subjectNotResolved,
  targetsNeedingRetry,
  leaseHeld,
  type ErasureOperationRecord,
  type LeaseToken,
  type PersistedErasureOperation,
} from "../domain/index.js";
import { PRIVACY_EVENT_NAMES } from "../contracts/events.js";
import type { RetryErasureCommand } from "../contracts/index.js";
import { resolveTargets, type PrivacyDependencies } from "./dependencies.js";
import { appendPrivacyEvent, refusedEvent, requestedEvent } from "./erasure-events.js";
import { recordPass } from "./record-pass.js";
import { resolveSubjectContext, type ResolvedSubjectContext } from "./resolve-subject.js";
import { runErasurePass } from "./run-erasure-pass.js";
import { sealSubject } from "./seal-subject.js";

async function refuse(
  dependencies: PrivacyDependencies,
  args: {
    readonly row: PersistedErasureOperation;
    readonly context: ResolvedSubjectContext | null;
    readonly refusal: string;
  },
): Promise<void> {
  await dependencies.unitOfWork.run((transaction) =>
    appendPrivacyEvent(dependencies, {
      name: PRIVACY_EVENT_NAMES.erasureRefused,
      organizationId: args.row.organizationId,
      payload: refusedEvent({
        subjectKeyHash: args.row.subjectKeyHash,
        refusal: args.refusal,
        operationId: args.row.operationId,
        policyVersion: args.row.policyVersion,
        legalHoldPolicyId: args.row.legalHoldPolicyId,
      }),
      handles: args.context?.handles ?? [],
      transaction,
    }),
  );
}

/** Take the lease, or report that another pass holds it. */
async function claim(
  dependencies: PrivacyDependencies,
  row: PersistedErasureOperation,
): Promise<Result<void>> {
  const now = dependencies.clock.now();
  const token = asIdentifier<LeaseToken>(dependencies.ids.uuid());
  const claimed = await dependencies.unitOfWork.run((transaction) =>
    dependencies.repository.claimLease(
      row.organizationId,
      row.operationId,
      { token, expiresAt: leaseUntil(now, dependencies.policy.retry) },
      now,
      transaction,
    ),
  );
  if (!claimed.ok) return err(operationStoreUnavailable(claimed.error.code));
  if (!claimed.value) {
    return err(leaseHeld(row.operationId, row.leaseExpiresAt?.toISOString() ?? "unknown"));
  }
  return ok(undefined);
}

export async function retryErasure(
  dependencies: PrivacyDependencies,
  command: RetryErasureCommand,
): Promise<Result<ErasureOperationRecord>> {
  const required = dependencies.policy.erasure.requiredTargets;
  const found = await dependencies.repository.findOperation(command.organizationId, command.operationId);
  if (!found.ok) return err(operationStoreUnavailable(found.error.code));
  if (found.value === null) return err(operationNotFound(command.operationId));
  const row = found.value;

  const record = projectOperation(row, required);
  const permitted = canRetry(record);
  if (!permitted.allowed) {
    await refuse(dependencies, { row, context: null, refusal: "PRIVACY_RETRY_NOT_PERMITTED" });
    return err(retryNotPermitted(permitted.reason ?? "retry is not permitted"));
  }
  if (isExhausted(row.retryCount, dependencies.policy.retry)) {
    await refuse(dependencies, { row, context: null, refusal: "PRIVACY_RETRY_BUDGET_EXHAUSTED" });
    return err(retryBudgetExhausted(row.retryCount, dependencies.policy.retry.maxRetries));
  }

  const context = await resolveSubjectContext(dependencies, {
    organizationId: command.organizationId,
    externalUserId: command.externalUserId,
  });
  if (!context.ok) return err(context.error);
  // A retry the record cannot be pointed at is refused, not narrowed. See above.
  if (context.value.subjects.length === 0) {
    await refuse(dependencies, {
      row,
      context: context.value,
      refusal: "PRIVACY_SUBJECT_NOT_RESOLVED",
    });
    return err(subjectNotResolved(row.subjectKeyHash));
  }
  // The re-supplied handle must name the same person the operation was opened
  // for. Without this, an operator could point a finished receipt at a different
  // subject and have the retry certify them.
  if (context.value.subjectKeyHash !== row.subjectKeyHash) {
    await refuse(dependencies, {
      row,
      context: context.value,
      refusal: "PRIVACY_IDEMPOTENCY_KEY_CONFLICT",
    });
    return err(subjectNotResolved(row.subjectKeyHash));
  }

  const leased = await claim(dependencies, row);
  if (!leased.ok) return err(leased.error);

  const roster = resolveTargets(dependencies).map((entry) => entry.name);
  const only = targetsNeedingRetry(record, roster);
  if (only.length === 0) return ok(record);

  const cause = command.cause ?? "operator-retry";
  const intent = await dependencies.unitOfWork.run((transaction) =>
    appendPrivacyEvent(dependencies, {
      name: PRIVACY_EVENT_NAMES.erasureRequested,
      organizationId: row.organizationId,
      payload: requestedEvent({
        operation: record,
        cause,
        targets: only,
        resolvedSubjects: context.value.subjects.length,
      }),
      handles: context.value.handles,
      transaction,
    }),
  );
  if (!intent.ok) return err(intent.error);

  // Re-seal before re-destroying. The tombstones from the first pass may have
  // been sealed with an older expiry; extending them keeps the barrier closed
  // for the whole of this pass rather than for the remainder of the first one's
  // window.
  const sealed = await sealSubject(dependencies, {
    organizationId: row.organizationId,
    operationId: row.operationId,
    aliases: context.value.aliases,
  });
  if (!sealed.ok) return err(sealed.error);

  const pass = await runErasurePass(dependencies, { subjects: context.value.subjects, only });
  return recordPass(dependencies, {
    operation: row,
    outcomes: pass.outcomes,
    cause,
    handles: context.value.handles,
    legalHold: false,
  });
}
