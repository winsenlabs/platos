// Admission rules for a new attachment: metadata shape, size, quota, retention
// and content-hash dedupe.
//
// All of it is pure. The use case does the I/O (quota total, dedupe lookup,
// presign) and asks this module whether the answer is admissible, so every rule
// here is exercisable without a store or a database.

import { err, ok, type FieldViolation, type Result } from "@platos/kernel";

import type { Attachment, AttachmentKind, AttachmentMedia } from "./attachment.js";
import { classifyAttachmentKind, NO_MEDIA_DIMENSIONS } from "./attachment.js";
import { attachmentMetadataInvalid, attachmentQuotaExceeded, attachmentTooLarge } from "./errors.js";
import type { ContentHash } from "./identifiers.js";
import type { FilesRetentionPolicy, FilesUploadPolicy } from "./policy.js";
import { sameEnvironment, type AttachmentScope } from "./scope.js";
import { storageKeyBelongsToScope } from "./storage-key.js";

/** Shape only. The column is `String`; this is not a list of accepted types. */
const MEDIA_TYPE_SHAPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu;
const MEDIA_TYPE_MAX_LENGTH = 128;
const ORIGINAL_NAME_MAX_LENGTH = 256;

export interface AttachmentIntake {
  readonly mimeType: string;
  readonly bytes: number;
  readonly originalName?: string | null;
  readonly kind?: AttachmentKind | null;
  readonly media?: AttachmentMedia | null;
  readonly contentHash?: ContentHash | null;
}

export interface AdmittedAttachment {
  readonly mimeType: string;
  readonly bytes: number;
  readonly originalName: string | null;
  readonly kind: AttachmentKind;
  readonly media: AttachmentMedia;
  readonly contentHash: ContentHash | null;
}

function violation(field: string, code: string, message: string): readonly FieldViolation[] {
  return [{ field, code, message }];
}

function admitMediaType(raw: string): Result<string> {
  const mimeType = raw.trim().toLowerCase();
  if (mimeType.length === 0 || mimeType.length > MEDIA_TYPE_MAX_LENGTH || !MEDIA_TYPE_SHAPE.test(mimeType)) {
    return err(
      attachmentMetadataInvalid(
        "mimeType must be a type/subtype token no longer than 128 characters",
        violation("mimeType", "MALFORMED", "expected <type>/<subtype>"),
      ),
    );
  }
  return ok(mimeType);
}

function admitByteCount(bytes: number, policy: FilesUploadPolicy): Result<number> {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    return err(
      attachmentMetadataInvalid(
        "bytes must be a positive safe integer",
        violation("bytes", "OUT_OF_RANGE", "expected a positive safe integer"),
      ),
    );
  }
  if (bytes > policy.maxAttachmentBytes) return err(attachmentTooLarge(bytes, policy.maxAttachmentBytes));
  return ok(bytes);
}

function admitOriginalName(raw: string | null | undefined): Result<string | null> {
  const trimmed = raw?.trim() ?? "";
  if (trimmed.length === 0) return ok(null);
  if (trimmed.length > ORIGINAL_NAME_MAX_LENGTH) {
    return err(
      attachmentMetadataInvalid(
        "originalName must be at most 256 characters",
        violation("originalName", "TOO_LONG", "at most 256 characters"),
      ),
    );
  }
  return ok(trimmed);
}

/**
 * Validate one upload request. `kind` is taken verbatim when supplied and
 * classified from the media type otherwise — the column stays open either way.
 */
export function admitAttachment(intake: AttachmentIntake, policy: FilesUploadPolicy): Result<AdmittedAttachment> {
  const mimeType = admitMediaType(intake.mimeType);
  if (!mimeType.ok) return err(mimeType.error);
  const bytes = admitByteCount(intake.bytes, policy);
  if (!bytes.ok) return err(bytes.error);
  const originalName = admitOriginalName(intake.originalName);
  if (!originalName.ok) return err(originalName.error);

  const declaredKind = intake.kind?.trim() ?? "";
  return ok({
    mimeType: mimeType.value,
    bytes: bytes.value,
    originalName: originalName.value,
    kind: declaredKind === "" ? classifyAttachmentKind(mimeType.value) : declaredKind,
    media: intake.media ?? NO_MEDIA_DIMENSIONS,
    contentHash: intake.contentHash ?? null,
  });
}

/** The organization-wide stored-bytes ceiling, checked before a key is minted. */
export function admitAgainstQuota(
  usedBytes: number,
  requestedBytes: number,
  policy: FilesUploadPolicy,
): Result<number> {
  const projected = usedBytes + requestedBytes;
  if (projected > policy.organizationQuotaBytes) {
    return err(attachmentQuotaExceeded(usedBytes, requestedBytes, policy.organizationQuotaBytes));
  }
  return ok(projected);
}

/** The per-turn ceiling, checked before any byte is pulled into memory. */
export function admitTurnTotal(attachments: readonly Attachment[], policy: FilesUploadPolicy): Result<number> {
  let total = 0;
  for (const attachment of attachments) {
    if (attachment.bytes > policy.maxAttachmentBytes) {
      return err(attachmentTooLarge(attachment.bytes, policy.maxAttachmentBytes));
    }
    total += attachment.bytes;
  }
  if (total > policy.maxTurnTotalBytes) return err(attachmentTooLarge(total, policy.maxTurnTotalBytes));
  return ok(total);
}

export function pendingExpiry(now: Date, policy: FilesRetentionPolicy): Date {
  return new Date(now.getTime() + policy.pendingGraceSeconds * 1000);
}

export function boundExpiry(now: Date, policy: FilesRetentionPolicy): Date {
  return new Date(now.getTime() + policy.boundRetentionSeconds * 1000);
}

/**
 * How the new row's blob comes into existence.
 *
 * `copy-from` is the dedupe path: the bytes already exist in this environment
 * under another row's key, so the store duplicates them server-side and the
 * caller uploads nothing. Deliberately a COPY and not a shared key — one row,
 * one blob keeps destruction 1:1 and removes the need to reference-count a key
 * before deleting it.
 */
export type BlobOrigin =
  | { readonly origin: "upload" }
  | { readonly origin: "copy-from"; readonly sourceKey: Attachment["storageKey"] };

export const UPLOAD_ORIGIN: BlobOrigin = Object.freeze({ origin: "upload" });

/**
 * Decide whether an existing row's blob may seed this one.
 *
 * A candidate qualifies only when its hash matches, its own key verifies against
 * ITS scope, and that scope is in the SAME ENVIRONMENT as the new row's. Reuse
 * across threads inside one environment is fine — the bytes are already the
 * tenant's. Matching a hash across environments would hand one tenant another
 * tenant's bytes, so the check is structural here and not merely a filter the
 * repository is trusted to have applied.
 */
export function decideBlobOrigin(
  scope: AttachmentScope,
  contentHash: ContentHash | null,
  candidate: Attachment | null,
): BlobOrigin {
  if (contentHash === null || candidate === null) return UPLOAD_ORIGIN;
  if (candidate.contentHash !== contentHash) return UPLOAD_ORIGIN;
  if (!sameEnvironment(candidate.scope, scope)) return UPLOAD_ORIGIN;
  if (!storageKeyBelongsToScope(candidate.storageKey, candidate.scope)) return UPLOAD_ORIGIN;
  return { origin: "copy-from", sourceKey: candidate.storageKey };
}
