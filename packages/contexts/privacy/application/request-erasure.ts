// Requesting an erasure — the order of operations, and why it is that order.
//
//   1. IDEMPOTENCY FIRST, before anything is resolved. A duplicate request must
//      return the first answer rather than start a second destruction, and a key
//      bound to a DIFFERENT subject is refused and recorded: that is what
//      someone targeting person B with person A's key looks like.
//   2. RESOLVE AND ADJUDICATE. The alias set, then the hold register, then the
//      decision. Both before the row exists, so a held subject leaves no
//      half-started operation.
//   3. OPEN THE ROW, leased and scheduled from birth, and append the INTENT
//      event in the same transaction. If this process dies between the two,
//      neither happened.
//   4. SEAL, in its own transaction. Barrier before destruction.
//   5. DESTROY, then RECORD.
//
// INTENT BEFORE DESTRUCTION, AND IT RAISES RATHER THAN DEGRADING. If the intent
// record cannot be appended, the erasure does not run and the caller is told.
// The ROW is deliberately kept — pending, leased and already due — so the queue
// picks the operation up once the outbox is healthy and the retry appends the
// intent it owes. An irreversible deletion nobody can attribute is worse than a
// deletion that has not happened yet; a row with no event yet is worse than
// neither only if nothing ever comes back for it, and something does.
//
// A HELD SUBJECT AND AN UNRESOLVED ONE BOTH LEAVE A ROW. A refused request is
// itself an event the operator has to be able to evidence later, and a request
// that resolved nobody is the case most worth keeping — it usually means the
// handle names something this installation does not key on.

import { asIdentifier, err, ok, runResult, type Result } from "@platos/kernel";

import {
  idempotencyKeyConflict,
  isEmptySubjectStatus,
  leaseUntil,
  operationStoreUnavailable,
  projectOperation,
  toWorkStatus,
  type ErasureOperationId,
  type LeaseToken,
  type PersistedErasureOperation,
} from "../domain/index.js";
import { PRIVACY_EVENT_NAMES } from "../contracts/events.js";
import type { RequestErasureCommand } from "../contracts/index.js";
import type { PrivacyDependencies } from "./dependencies.js";
import { appendPrivacyEvent, refusedEvent, requestedEvent } from "./erasure-events.js";
import { resolveTargets } from "./dependencies.js";
import { recordPass } from "./record-pass.js";
import { resolveSubjectContext, type ResolvedSubjectContext } from "./resolve-subject.js";
import { runErasurePass } from "./run-erasure-pass.js";
import { sealSubject } from "./seal-subject.js";
import type { ErasureOperationRecord } from "../domain/index.js";

/** Open the row and append the intent record, atomically. */
async function openOperation(
  dependencies: PrivacyDependencies,
  command: RequestErasureCommand,
  context: ResolvedSubjectContext,
  blocked: boolean,
  refusal: string | null,
): Promise<Result<PersistedErasureOperation>> {
  const now = dependencies.clock.now();
  const operationId = asIdentifier<ErasureOperationId>(dependencies.ids.uuid());
  const leaseToken = asIdentifier<LeaseToken>(dependencies.ids.uuid());
  const targets = resolveTargets(dependencies).map((entry) => entry.name);
  const status = blocked
    ? "blocked_legal_hold"
    : refusal !== null
      ? isEmptySubjectStatus()
      : "pending";
  const settled = blocked || refusal !== null;

  const row: PersistedErasureOperation = {
    operationId,
    organizationId: command.organizationId,
    idempotencyKey: command.idempotencyKey,
    subjectKeyHash: context.subjectKeyHash,
    workStatus: toWorkStatus(status),
    scopes: context.scopes,
    outcomes: [],
    policyVersion: dependencies.policy.version,
    legalHoldPolicyId: blocked ? context.legalHoldPolicyId : null,
    retryCount: 0,
    requestedAt: now,
    startedAt: settled ? now : null,
    completedAt: null,
    // Leased and scheduled from birth. If this process dies between the create
    // and the outcomes, the row does not sit at pending forever: the lease
    // expires and `nextRetryAt` has already made it due.
    nextRetryAt: settled ? null : now,
    leaseToken: settled ? null : leaseToken,
    leaseExpiresAt: settled ? null : leaseUntil(now, dependencies.policy.retry),
  };

  return runResult(dependencies.unitOfWork, async (transaction) => {
    const inserted = await dependencies.repository.insertOperation(row, transaction);
    if (!inserted.ok) return err(inserted.error);

    const record = projectOperation(inserted.value, dependencies.policy.erasure.requiredTargets);
    const appended =
      settled
        ? await appendPrivacyEvent(dependencies, {
            name: PRIVACY_EVENT_NAMES.erasureRefused,
            organizationId: record.organizationId,
            payload: refusedEvent({
              subjectKeyHash: record.subjectKeyHash,
              refusal: refusal ?? "PRIVACY_LEGAL_HOLD_IN_FORCE",
              operationId: record.operationId,
              policyVersion: record.policyVersion,
              legalHoldPolicyId: record.legalHoldPolicyId,
            }),
            handles: context.handles,
            transaction,
          })
        : await appendPrivacyEvent(dependencies, {
            name: PRIVACY_EVENT_NAMES.erasureRequested,
            organizationId: record.organizationId,
            payload: requestedEvent({
              operation: record,
              cause: "request",
              targets,
              resolvedSubjects: context.subjects.length,
            }),
            handles: context.handles,
            transaction,
          });
    if (!appended.ok) return err(appended.error);
    return ok(inserted.value);
  });
}

/** The idempotent answer, or the refusal a rebound key earns. */
async function existingAnswer(
  dependencies: PrivacyDependencies,
  command: RequestErasureCommand,
  row: PersistedErasureOperation,
): Promise<Result<ErasureOperationRecord>> {
  const digest = (
    await resolveSubjectContext(dependencies, {
      organizationId: command.organizationId,
      externalUserId: command.externalUserId,
    })
  );
  if (!digest.ok) return err(digest.error);
  if (row.subjectKeyHash === digest.value.subjectKeyHash) {
    return ok(projectOperation(row, dependencies.policy.erasure.requiredTargets));
  }

  const refusal = idempotencyKeyConflict(row.operationId);
  await runResult(dependencies.unitOfWork, (transaction) =>
    appendPrivacyEvent(dependencies, {
      name: PRIVACY_EVENT_NAMES.erasureRefused,
      organizationId: command.organizationId,
      payload: refusedEvent({
        subjectKeyHash: digest.value.subjectKeyHash,
        refusal: refusal.code,
        operationId: row.operationId,
        policyVersion: row.policyVersion,
      }),
      handles: digest.value.handles,
      transaction,
    }),
  );
  return err(refusal);
}

export async function requestErasure(
  dependencies: PrivacyDependencies,
  command: RequestErasureCommand,
): Promise<Result<ErasureOperationRecord>> {
  const existing = await dependencies.repository.findByIdempotencyKey(
    command.organizationId,
    command.idempotencyKey,
  );
  if (!existing.ok) return err(operationStoreUnavailable(existing.error.code));
  if (existing.value !== null) return existingAnswer(dependencies, command, existing.value);

  const context = await resolveSubjectContext(dependencies, {
    organizationId: command.organizationId,
    externalUserId: command.externalUserId,
    callerHoldPolicyId: command.legalHoldPolicyId ?? null,
  });
  if (!context.ok) return err(context.error);

  const blocked = context.value.legalHoldPolicyId !== null;
  // Discovery finding nothing is not success, and it is not an error either: the
  // request happened and must leave evidence. The row lands at
  // `verification_failed` — we destroyed nothing and cannot prove the subject
  // is gone.
  const unresolved = !blocked && context.value.subjects.length === 0;
  const opened = await openOperation(
    dependencies,
    command,
    context.value,
    blocked,
    unresolved ? "PRIVACY_SUBJECT_NOT_RESOLVED" : null,
  );
  if (!opened.ok) return err(opened.error);
  if (blocked || unresolved) {
    return ok(projectOperation(opened.value, dependencies.policy.erasure.requiredTargets));
  }

  // Barrier first, destruction second. A seal that fails leaves the operation
  // pending and retryable, which is recoverable; an unsealed sweep is a subject
  // the next request restores.
  const sealed = await sealSubject(dependencies, {
    organizationId: command.organizationId,
    operationId: opened.value.operationId,
    aliases: context.value.aliases,
  });
  if (!sealed.ok) return err(sealed.error);

  const pass = await runErasurePass(dependencies, { subjects: context.value.subjects });
  return recordPass(dependencies, {
    operation: opened.value,
    outcomes: pass.outcomes,
    cause: "request",
    handles: context.value.handles,
    legalHold: false,
  });
}
