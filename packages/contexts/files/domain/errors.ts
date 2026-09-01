// The `files` error catalogue.
//
// M0.4 §2 fixes `code` as a SCREAMING_SNAKE string that is immutable within a
// major, and the kernel makes an error a VALUE rather than a thrown class. Every
// code this context can produce is minted here, once, so a transport can build
// its status table from one list and an operator grepping a log finds exactly
// one definition.
//
// The `FILES_OBJECT_*` codes are the object store's failure modes expressed in
// this context's vocabulary. An `ObjectStore` adapter maps its client's errors
// onto them and never lets a vendor error escape: a caller must be able to tell
// "the object is gone" from "the store is down" without catching a typed
// exception from a library it is forbidden to import.

import { domainError, type DomainError, type FieldViolation } from "@platos/kernel";

export const FILES_ERROR_CODES = [
  "FILES_ATTACHMENT_METADATA_INVALID",
  "FILES_ATTACHMENT_TOO_LARGE",
  "FILES_ATTACHMENT_QUOTA_EXCEEDED",
  "FILES_ATTACHMENT_NOT_FOUND",
  "FILES_ATTACHMENT_BINDING_CONFLICT",
  "FILES_ATTACHMENT_RETENTION_ELAPSED",
  "FILES_STORAGE_KEY_SCOPE_MISMATCH",
  "FILES_PRESIGN_WINDOW_INVALID",
  "FILES_PRESIGNED_GRANT_ELAPSED",
  "FILES_OBJECT_NOT_FOUND",
  "FILES_OBJECT_STORE_UNAVAILABLE",
  "FILES_OBJECT_PRECONDITION_FAILED",
  "FILES_BLOB_DESTRUCTION_FAILED",
  "FILES_ARTIFACT_KEY_INVALID",
  "FILES_ARTIFACT_CONTENT_INVALID",
  "FILES_ARTIFACT_CONTENT_TOO_LARGE",
  "FILES_ARTIFACT_KIND_IMMUTABLE",
  "FILES_ARTIFACT_REVISION_CONFLICT",
  "FILES_ARTIFACT_REVISION_NOT_FOUND",
  "FILES_REPOSITORY_UNAVAILABLE",
  "FILES_ERASURE_PLAN_FOREIGN",
] as const;

export type FilesErrorCode = (typeof FILES_ERROR_CODES)[number];

export function attachmentMetadataInvalid(message: string, fields: readonly FieldViolation[] = []): DomainError {
  return domainError("FILES_ATTACHMENT_METADATA_INVALID", "invalid_input", message, { fields });
}

export function attachmentTooLarge(bytes: number, maxBytes: number): DomainError {
  return domainError(
    "FILES_ATTACHMENT_TOO_LARGE",
    "invalid_input",
    `attachment of ${bytes} bytes exceeds the ${maxBytes}-byte cap`,
    { details: { bytes, maxBytes } },
  );
}

export function attachmentQuotaExceeded(usedBytes: number, requestedBytes: number, quotaBytes: number): DomainError {
  return domainError(
    "FILES_ATTACHMENT_QUOTA_EXCEEDED",
    "precondition_failed",
    "organization attachment storage quota exceeded",
    { details: { usedBytes, requestedBytes, quotaBytes } },
  );
}

export function attachmentNotFound(attachmentId: string): DomainError {
  return domainError("FILES_ATTACHMENT_NOT_FOUND", "not_found", "attachment is not visible in this scope", {
    details: { attachmentId },
  });
}

export function attachmentBindingConflict(attachmentId: string, boundTurnId: string, requestedTurnId: string): DomainError {
  return domainError(
    "FILES_ATTACHMENT_BINDING_CONFLICT",
    "conflict",
    "attachment is already bound to a different turn",
    { details: { attachmentId, boundTurnId, requestedTurnId } },
  );
}

export function attachmentRetentionElapsed(attachmentId: string, expiresAt: string, now: string): DomainError {
  return domainError(
    "FILES_ATTACHMENT_RETENTION_ELAPSED",
    "precondition_failed",
    "attachment retention window has elapsed",
    { details: { attachmentId, expiresAt, now } },
  );
}

/**
 * `forbidden`, not `not_found`: the caller named a key that resolves, but not
 * under the scope it holds. This is the cross-tenant denial the kernel's scope
 * union exists to make impossible, caught one layer further out.
 */
export function storageKeyScopeMismatch(expectedPrefix: string): DomainError {
  return domainError(
    "FILES_STORAGE_KEY_SCOPE_MISMATCH",
    "forbidden",
    "storage key does not belong to the requesting scope",
    { details: { expectedPrefix } },
  );
}

export function presignWindowInvalid(seconds: number, maxSeconds: number): DomainError {
  return domainError(
    "FILES_PRESIGN_WINDOW_INVALID",
    "invalid_input",
    `presign window of ${seconds}s must be a positive integer no greater than ${maxSeconds}s`,
    { details: { seconds, maxSeconds } },
  );
}

export function presignedGrantElapsed(expiresAt: string, now: string): DomainError {
  return domainError(
    "FILES_PRESIGNED_GRANT_ELAPSED",
    "precondition_failed",
    "presigned grant is past its expiry and must not be redeemed",
    { details: { expiresAt, now } },
  );
}

export function objectNotFound(key: string): DomainError {
  return domainError("FILES_OBJECT_NOT_FOUND", "not_found", "object is absent from the store", {
    details: { key },
  });
}

export function objectStoreUnavailable(reason: string, retryAfterSeconds = 5): DomainError {
  return domainError("FILES_OBJECT_STORE_UNAVAILABLE", "unavailable", "object store is unavailable", {
    retryAfterSeconds,
    details: { reason },
  });
}

export function objectPreconditionFailed(key: string, reason: string): DomainError {
  return domainError("FILES_OBJECT_PRECONDITION_FAILED", "precondition_failed", reason, {
    details: { key },
  });
}

/**
 * Raised when a blob could not be destroyed. The row is then RETAINED — see
 * `domain/destruction.ts` for why a surviving row is the recoverable half.
 */
export function blobDestructionFailed(key: string, cause: DomainError): DomainError {
  return domainError(
    "FILES_BLOB_DESTRUCTION_FAILED",
    "unavailable",
    "blob could not be destroyed; its row is retained so the sweep can retry",
    { retryAfterSeconds: cause.retryAfterSeconds ?? 5, details: { key, causeCode: cause.code } },
  );
}

export function artifactKeyInvalid(message: string): DomainError {
  return domainError("FILES_ARTIFACT_KEY_INVALID", "invalid_input", message);
}

export function artifactContentInvalid(message: string): DomainError {
  return domainError("FILES_ARTIFACT_CONTENT_INVALID", "invalid_input", message);
}

export function artifactContentTooLarge(bytes: number, maxBytes: number): DomainError {
  return domainError(
    "FILES_ARTIFACT_CONTENT_TOO_LARGE",
    "invalid_input",
    `artifact content of ${bytes} bytes exceeds the ${maxBytes}-byte cap`,
    { details: { bytes, maxBytes } },
  );
}

export function artifactKindImmutable(artifactKey: string, firstKind: string, requestedKind: string): DomainError {
  return domainError(
    "FILES_ARTIFACT_KIND_IMMUTABLE",
    "conflict",
    "an artifact's kind is fixed by its first revision and cannot change",
    { details: { artifactKey, firstKind, requestedKind } },
  );
}

/** The `[threadId, artifactKey, revision]` unique, expressed in the domain. */
export function artifactRevisionConflict(artifactKey: string, revision: number): DomainError {
  return domainError(
    "FILES_ARTIFACT_REVISION_CONFLICT",
    "conflict",
    "that artifact revision already exists; revisions are append-only and never overwritten",
    { details: { artifactKey, revision } },
  );
}

export function artifactRevisionNotFound(artifactKey: string, revision: number | null): DomainError {
  return domainError(
    "FILES_ARTIFACT_REVISION_NOT_FOUND",
    "not_found",
    "no such artifact revision",
    { details: { artifactKey, revision } },
  );
}

export function repositoryUnavailable(reason: string): DomainError {
  return domainError("FILES_REPOSITORY_UNAVAILABLE", "unavailable", "files repository is unavailable", {
    retryAfterSeconds: 5,
    details: { reason },
  });
}

/**
 * The kernel's `ErasurePlan` carries no subject, so a target handed a plan it did
 * not mint cannot know whose rows to destroy. Refusing is the only safe answer.
 */
export function erasurePlanForeign(targetName: string): DomainError {
  return domainError(
    "FILES_ERASURE_PLAN_FOREIGN",
    "precondition_failed",
    "erasure plan was not produced by this target and carries no subject to act on",
    { details: { targetName } },
  );
}
