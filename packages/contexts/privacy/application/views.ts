// Domain records → the published views.
//
// One direction only, and one place. The contract's shapes are stable across a
// major (M0.4 §1) while the domain's are free to change, so every crossing goes
// through here rather than a caller reaching into a record and picking fields.
//
// The flattening of `counts` is deliberate: the contract exposes four numbers
// rather than a nested object, because a view is read by a transport that has to
// render it and a nested optional is one more thing to get wrong. Nothing is
// added on the way out — a view can only ever say less than the record.

import type {
  ErasureOperationRecord,
  TargetOutcome,
} from "../domain/index.js";
import type { ErasureOperationView, TargetOutcomeView } from "../contracts/index.js";

export function toTargetOutcomeView(outcome: TargetOutcome): TargetOutcomeView {
  return {
    target: outcome.target,
    status: outcome.status,
    verification: outcome.verification,
    discovered: outcome.discovered,
    deleted: outcome.counts.deleted,
    anonymized: outcome.counts.anonymized,
    cryptoShredded: outcome.counts.cryptoShredded,
    retained: outcome.counts.retained,
    failures: outcome.failures,
    note: outcome.note,
  };
}

/**
 * The receipt as a caller sees it.
 *
 * `leaseToken` and `leaseExpiresAt` are deliberately absent: the lease is how
 * two passes avoid overlapping, and publishing the token would let a caller take
 * a lease it did not earn. `nextRetryAt` IS published, because an operator
 * asking "when will this finish" has no other way to find out.
 */
export function toErasureOperationView(operation: ErasureOperationRecord): ErasureOperationView {
  return {
    operationId: operation.operationId,
    organizationId: operation.organizationId,
    idempotencyKey: operation.idempotencyKey,
    subjectKeyHash: operation.subjectKeyHash,
    status: operation.status,
    scopes: operation.scopes,
    outcomes: operation.outcomes.map(toTargetOutcomeView),
    policyVersion: operation.policyVersion,
    legalHoldPolicyId: operation.legalHoldPolicyId,
    retryCount: operation.retryCount,
    requestedAt: operation.requestedAt,
    startedAt: operation.startedAt,
    completedAt: operation.completedAt,
    nextRetryAt: operation.nextRetryAt,
  };
}
