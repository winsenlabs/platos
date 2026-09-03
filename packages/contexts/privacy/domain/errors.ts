// The `privacy` error catalogue.
//
// M0.4 §2 fixes `code` as a SCREAMING_SNAKE string that is immutable within a
// major, and the kernel makes an error a VALUE rather than a thrown class. Every
// code this context can produce is minted here, once, so a transport can build
// its status table from one list and an operator grepping a log finds exactly
// one definition.
//
// NOTHING BELOW CARRIES A RAW HANDLE. `details` is rendered into logs, and this
// is the one context whose whole purpose is to destroy the identifiers it is
// handed. Every constructor takes the salted digest, an operation id, or a
// count — never the subject. `domain/content-free.ts` is the mechanical check
// that keeps that true for the durable records; this file is the same rule
// applied to the transient ones.

import { domainError, type DomainError, type FieldViolation } from "@platos/kernel";

export const PRIVACY_ERROR_CODES = [
  "PRIVACY_IDEMPOTENCY_KEY_CONFLICT",
  "PRIVACY_OPERATION_NOT_FOUND",
  "PRIVACY_SUBJECT_NOT_RESOLVED",
  "PRIVACY_SUBJECT_MISMATCH",
  "PRIVACY_ALIAS_INVALID",
  "PRIVACY_LEGAL_HOLD_IN_FORCE",
  "PRIVACY_SUBJECT_ERASED",
  "PRIVACY_ERASURE_REGISTER_UNAVAILABLE",
  "PRIVACY_TARGET_REJECTED",
  "PRIVACY_TARGET_NOT_WIRED",
  "PRIVACY_RETRY_NOT_PERMITTED",
  "PRIVACY_RETRY_BUDGET_EXHAUSTED",
  "PRIVACY_LEASE_HELD",
  "PRIVACY_RECEIPT_WOULD_LEAK_SUBJECT",
  "PRIVACY_OPERATION_STORE_UNAVAILABLE",
  "PRIVACY_SUBJECT_DIRECTORY_UNAVAILABLE",
  "PRIVACY_LEGAL_HOLD_REGISTER_UNAVAILABLE",
] as const;

export type PrivacyErrorCode = (typeof PRIVACY_ERROR_CODES)[number];

/**
 * The reused key names a different person.
 *
 * `conflict`, and deliberately not `not_found`: the caller did address a real
 * operation, just not one about the subject they asked for. This is the refusal
 * most worth recording — it is what someone targeting person B with person A's
 * key looks like from inside.
 */
export function idempotencyKeyConflict(operationId: string): DomainError {
  return domainError(
    "PRIVACY_IDEMPOTENCY_KEY_CONFLICT",
    "conflict",
    "idempotency key is already bound to another subject",
    { details: { operationId } },
  );
}

export function operationNotFound(operationId: string): DomainError {
  return domainError("PRIVACY_OPERATION_NOT_FOUND", "not_found", "erasure operation is not visible in this scope", {
    details: { operationId },
  });
}

/**
 * Discovery resolved nobody.
 *
 * Not a success with zero rows. An unresolved subject almost always means the
 * request named a handle this installation does not key on, and certifying
 * "completed, nothing found" for it would sign a statement about a search that
 * never looked in the right place.
 */
export function subjectNotResolved(subjectKeyHash: string): DomainError {
  return domainError(
    "PRIVACY_SUBJECT_NOT_RESOLVED",
    "precondition_failed",
    "erasure discovery resolved no subject; refusing to certify an empty sweep",
    { details: { subjectKeyHash } },
  );
}

/**
 * Discovery resolved SOMEBODY, and it is not the person this operation is about.
 *
 * Deliberately NOT `subjectNotResolved`. The two refusals sit next to each other
 * on the retry path and they mean opposite things about the directory: one says
 * it found nobody, the other says it found the wrong person. They shared a code
 * until 2026-09-03, and the cost was exact — a test asserting the shared code
 * could not tell which branch produced it, so the "resolved nobody" guard could
 * be deleted with the suite still green, and the refusal an auditor reads named
 * a cause the returned error contradicted. Distinct codes are what make the two
 * branches separately provable, and separately legible on the record.
 *
 * `conflict`, for the same reason `idempotencyKeyConflict` is: the caller
 * addressed a real operation, just not one about the subject they named. This is
 * what someone pointing a finished receipt at a second person looks like from
 * inside.
 */
export function subjectMismatch(operationId: string, subjectKeyHash: string): DomainError {
  return domainError(
    "PRIVACY_SUBJECT_MISMATCH",
    "conflict",
    "the re-supplied handle resolves to a different subject than this operation was opened for",
    { details: { operationId, subjectKeyHash } },
  );
}

export function aliasInvalid(message: string, fields: readonly FieldViolation[] = []): DomainError {
  return domainError("PRIVACY_ALIAS_INVALID", "invalid_input", message, { fields });
}

/**
 * `precondition_failed`, not `forbidden`: the caller is entitled to ask, and the
 * refusal is about the subject's state rather than the caller's authority.
 * `reference` is a register POSITION plus a truncated digest — never the entry.
 */
export function legalHoldInForce(reference: string): DomainError {
  return domainError("PRIVACY_LEGAL_HOLD_IN_FORCE", "precondition_failed", "a legal hold blocks this erasure", {
    details: { legalHoldPolicyId: reference },
  });
}

/**
 * The write barrier fired: this organization has erased the subject the write
 * was for.
 *
 * `forbidden` rather than `conflict` because the refusal is permanent for the
 * life of the tombstone, and the details carry the organization and nothing
 * else — naming the matched alias would put the erased handle in a log line.
 */
export function subjectErased(organizationId: string): DomainError {
  return domainError("PRIVACY_SUBJECT_ERASED", "forbidden", "subject has been erased; write refused", {
    details: { organizationId },
  });
}

/**
 * The register could not be consulted.
 *
 * A different fact from `subjectErased` — they mean opposite things about the
 * subject — but identical in effect, because both refuse the write. Reported
 * separately so an operator can tell "we blocked a resurrection" from "we lost
 * the ability to tell", which is an incident.
 */
export function erasureRegisterUnavailable(reason: string): DomainError {
  return domainError(
    "PRIVACY_ERASURE_REGISTER_UNAVAILABLE",
    "unavailable",
    "erased-subject register is unavailable; the write is refused rather than allowed",
    { retryAfterSeconds: 5, details: { reason } },
  );
}

/**
 * A target refused to carry out its plan.
 *
 * `unavailable` because the operation stays open and retryable. The target name
 * is a context name, which is public architecture, not subject data.
 */
export function targetRejected(targetName: string, reason: string): DomainError {
  return domainError("PRIVACY_TARGET_REJECTED", "unavailable", "an erasure target refused to carry out its plan", {
    retryAfterSeconds: 5,
    details: { targetName, reason },
  });
}

/**
 * A required target was not injected at the composition root.
 *
 * Kept distinct from "this target holds nothing": no target wired is NOT the
 * same as nothing to erase, and letting an unwired context read as clean is how
 * an erasure certifies rows it never asked anyone about.
 */
export function targetNotWired(targetName: string): DomainError {
  return domainError(
    "PRIVACY_TARGET_NOT_WIRED",
    "internal",
    "a required erasure target is not wired at the composition root",
    { details: { targetName } },
  );
}

export function retryNotPermitted(reason: string): DomainError {
  return domainError("PRIVACY_RETRY_NOT_PERMITTED", "precondition_failed", reason);
}

export function retryBudgetExhausted(retryCount: number, maxRetries: number): DomainError {
  return domainError(
    "PRIVACY_RETRY_BUDGET_EXHAUSTED",
    "precondition_failed",
    "automatic retries are exhausted; the operation is left for an operator",
    { details: { retryCount, maxRetries } },
  );
}

/** Another pass holds the lease. Two destructive passes must never overlap. */
export function leaseHeld(operationId: string, leaseExpiresAt: string): DomainError {
  return domainError("PRIVACY_LEASE_HELD", "conflict", "another erasure pass holds this operation's lease", {
    details: { operationId, leaseExpiresAt },
  });
}

/**
 * The guard in `domain/content-free.ts` found a subject identifier in something
 * about to be persisted. `internal`, because reaching here is a defect in this
 * package rather than anything the caller did.
 */
export function receiptWouldLeakSubject(what: string): DomainError {
  return domainError(
    "PRIVACY_RECEIPT_WOULD_LEAK_SUBJECT",
    "internal",
    "record would leak a subject identifier; refusing to persist",
    { details: { what } },
  );
}

export function operationStoreUnavailable(reason: string): DomainError {
  return domainError(
    "PRIVACY_OPERATION_STORE_UNAVAILABLE",
    "unavailable",
    "erasure operation store is unavailable",
    { retryAfterSeconds: 5, details: { reason } },
  );
}

export function subjectDirectoryUnavailable(reason: string): DomainError {
  return domainError(
    "PRIVACY_SUBJECT_DIRECTORY_UNAVAILABLE",
    "unavailable",
    "subject directory is unavailable; the subject cannot be resolved",
    { retryAfterSeconds: 5, details: { reason } },
  );
}

/**
 * The hold register could not be read.
 *
 * Fails the request rather than proceeding. An erasure is irreversible and a
 * hold register that cannot be consulted is indistinguishable from an empty
 * one — which is the reading that destroys held evidence.
 */
export function legalHoldRegisterUnavailable(reason: string): DomainError {
  return domainError(
    "PRIVACY_LEGAL_HOLD_REGISTER_UNAVAILABLE",
    "unavailable",
    "legal-hold register is unavailable; the erasure is refused rather than run unchecked",
    { retryAfterSeconds: 5, details: { reason } },
  );
}
