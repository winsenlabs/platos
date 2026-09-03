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

import { asIdentifier, err, ok, type DomainError, type Result } from "@platos/kernel";

import {
  canRetry,
  isExhausted,
  leaseUntil,
  operationNotFound,
  operationStoreUnavailable,
  projectOperation,
  retryBudgetExhausted,
  retryNotPermitted,
  subjectMismatch,
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

/**
 * Record the refusal, then hand back the very error that was recorded.
 *
 * THE LABEL IS THE RETURNED ERROR'S OWN CODE, not a string beside it. The
 * refused event is what an auditor reads to learn why an erasure did not
 * happen, and for as long as the two were written separately they could
 * disagree — the subject-mismatch branch spent its whole life emitting
 * `PRIVACY_IDEMPOTENCY_KEY_CONFLICT` while returning
 * `PRIVACY_SUBJECT_NOT_RESOLVED`, so the record named a cause the caller was
 * never told. Composing them from one value is what makes that class of drift
 * unrepresentable rather than merely tested for.
 */
async function refuse(
  dependencies: PrivacyDependencies,
  args: {
    readonly row: PersistedErasureOperation;
    readonly context: ResolvedSubjectContext | null;
    readonly refusal: DomainError;
  },
): Promise<Result<never>> {
  await dependencies.unitOfWork.run((transaction) =>
    appendPrivacyEvent(dependencies, {
      name: PRIVACY_EVENT_NAMES.erasureRefused,
      organizationId: args.row.organizationId,
      payload: refusedEvent({
        subjectKeyHash: args.row.subjectKeyHash,
        refusal: args.refusal.code,
        operationId: args.row.operationId,
        policyVersion: args.row.policyVersion,
        legalHoldPolicyId: args.row.legalHoldPolicyId,
      }),
      handles: args.context?.handles ?? [],
      transaction,
    }),
  );
  return err(args.refusal);
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
    return refuse(dependencies, {
      row,
      context: null,
      refusal: retryNotPermitted(permitted.reason ?? "retry is not permitted"),
    });
  }
  if (isExhausted(row.retryCount, dependencies.policy.retry)) {
    return refuse(dependencies, {
      row,
      context: null,
      refusal: retryBudgetExhausted(row.retryCount, dependencies.policy.retry.maxRetries),
    });
  }

  const context = await resolveSubjectContext(dependencies, {
    organizationId: command.organizationId,
    externalUserId: command.externalUserId,
  });
  if (!context.ok) return err(context.error);
  // A retry the record cannot be pointed at is refused, not narrowed. See above.
  //
  // THIS IS THE ORDINARY CASE ON A SECOND PASS, not an exotic one: the first
  // pass destroyed the identity rows that resolve the handle, so the SAME
  // externalUserId that opened the operation is exactly the handle most likely
  // to resolve to nobody now. Running narrow here would sweep the empty set and
  // certify it.
  if (context.value.subjects.length === 0) {
    return refuse(dependencies, {
      row,
      context: context.value,
      refusal: subjectNotResolved(row.subjectKeyHash),
    });
  }
  // The re-supplied handle must name the same person the operation was opened
  // for. Without this, an operator could point a finished receipt at a different
  // subject and have the retry certify them.
  //
  // A DIFFERENT CODE from the guard above, and the difference is load-bearing.
  // The two say opposite things about the directory — "it found nobody" against
  // "it found the wrong person" — and while they shared one code, neither could
  // be proved: a test asserting it could not say which guard answered.
  if (context.value.subjectKeyHash !== row.subjectKeyHash) {
    return refuse(dependencies, {
      row,
      context: context.value,
      refusal: subjectMismatch(row.operationId, row.subjectKeyHash),
    });
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
