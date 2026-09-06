// Use case: admit an upload, mint the row, and hand back a grant.
//
// THE ROW IS CREATED BEFORE THE BLOB, and that is the destruction rule read
// forwards. The row is the authoritative record (`domain/destruction.ts`), so it
// comes into existence first and goes out of existence last. If the store then
// cannot seed the blob, the compensation is the ordinary destruction routine —
// blob first (idempotent, and normally already absent), then the row — so the
// rollback cannot itself leave an orphan.
//
// Two ways a blob comes into existence, decided by content hash:
//
//   upload     nothing exists yet; a PUT grant is signed and the client sends
//              the bytes. The row is `pending` until a turn binds it.
//   copy-from  identical bytes already exist in THIS environment; the store
//              duplicates them server-side and the client uploads nothing. The
//              new row still gets its OWN key, so one row still owns one blob
//              and destruction stays 1:1 with no reference counting.

import { asIdentifier, err, ok, runResult, type Result } from "@platos/kernel";

import {
  admitAgainstQuota,
  admitAttachment,
  admitGrantWindow,
  assertStorageKeyInScope,
  deriveAttachmentStorageKey,
  decideBlobOrigin,
  grantExpiry,
  PENDING_BINDING,
  pendingExpiry,
  toThreadScope,
  UPLOAD_ORIGIN,
  type AdmittedAttachment,
  type Attachment,
  type AttachmentId,
  type AttachmentIntake,
  type AttachmentScope,
  type BlobOrigin,
  type PresignedGrant,
} from "../domain/index.js";
import type { FilesDependencies } from "./dependencies.js";
import { destroyAttachment } from "./destroy-attachment.js";

export interface PresignAttachmentUploadCommand {
  readonly scope: AttachmentScope;
  readonly intake: AttachmentIntake;
  /** Overrides the policy default; still capped by `maxWindowSeconds`. */
  readonly windowSeconds?: number;
}

export interface AttachmentUploadGrant {
  readonly attachment: Attachment;
  /**
   * Null on the dedupe path: the bytes already exist and the client has nothing
   * to send. A caller MUST branch on this rather than assume a URL.
   */
  readonly grant: PresignedGrant | null;
  readonly origin: BlobOrigin;
}

async function resolveOrigin(
  dependencies: FilesDependencies,
  scope: AttachmentScope,
  admitted: AdmittedAttachment,
): Promise<Result<BlobOrigin>> {
  const contentHash = admitted.contentHash;
  if (contentHash === null) return ok(UPLOAD_ORIGIN);
  const candidate = await dependencies.repository.findAttachmentByContentHash(scope.environment, contentHash);
  if (!candidate.ok) return err(candidate.error);
  return ok(decideBlobOrigin(scope, contentHash, candidate.value));
}

async function seedBlob(
  dependencies: FilesDependencies,
  origin: BlobOrigin,
  attachment: Attachment,
  windowSeconds: number,
): Promise<Result<PresignedGrant | null>> {
  if (origin.origin === "copy-from") {
    const copied = await dependencies.objectStore.copy({
      sourceKey: origin.sourceKey,
      destinationKey: attachment.storageKey,
    });
    if (!copied.ok) return err(copied.error);
    return ok(null);
  }
  const issuedAt = dependencies.clock.now();
  const presigned = await dependencies.objectStore.presignUpload({
    key: attachment.storageKey,
    contentType: attachment.mimeType,
    contentLengthBytes: attachment.bytes,
    expiresAt: grantExpiry(issuedAt, windowSeconds),
  });
  if (!presigned.ok) return err(presigned.error);
  const grant: PresignedGrant = {
    operation: "upload",
    key: presigned.value.key,
    url: presigned.value.url,
    method: "PUT",
    requiredHeaders: presigned.value.requiredHeaders,
    issuedAt,
    expiresAt: presigned.value.expiresAt,
  };
  return ok(grant);
}

function draftAttachment(
  command: PresignAttachmentUploadCommand,
  admitted: AdmittedAttachment,
  attachmentId: AttachmentId,
  now: Date,
  dependencies: FilesDependencies,
): Result<Attachment> {
  const storageKey = deriveAttachmentStorageKey(command.scope, attachmentId, admitted.originalName);
  const verified = assertStorageKeyInScope(storageKey, toThreadScope(command.scope));
  if (!verified.ok) return err(verified.error);
  return ok({
    attachmentId,
    scope: command.scope,
    binding: PENDING_BINDING,
    kind: admitted.kind,
    mimeType: admitted.mimeType,
    bytes: admitted.bytes,
    media: admitted.media,
    storageKey: verified.value,
    originalName: admitted.originalName,
    contentHash: admitted.contentHash,
    createdAt: now,
    expiresAt: pendingExpiry(now, dependencies.policy.retention),
  });
}

async function admitCommand(
  dependencies: FilesDependencies,
  command: PresignAttachmentUploadCommand,
): Promise<Result<{ readonly admitted: AdmittedAttachment; readonly windowSeconds: number }>> {
  const { policy, repository } = dependencies;
  const admitted = admitAttachment(command.intake, policy.upload);
  if (!admitted.ok) return err(admitted.error);
  const window = admitGrantWindow(
    command.windowSeconds ?? policy.upload.uploadWindowSeconds,
    policy.upload.maxWindowSeconds,
  );
  if (!window.ok) return err(window.error);
  const used = await repository.sumAttachmentBytes({
    level: "organization",
    organizationId: command.scope.environment.organizationId,
  });
  if (!used.ok) return err(used.error);
  const quota = admitAgainstQuota(used.value, admitted.value.bytes, policy.upload);
  if (!quota.ok) return err(quota.error);
  return ok({ admitted: admitted.value, windowSeconds: window.value });
}

export async function presignAttachmentUpload(
  dependencies: FilesDependencies,
  command: PresignAttachmentUploadCommand,
): Promise<Result<AttachmentUploadGrant>> {
  const gate = await admitCommand(dependencies, command);
  if (!gate.ok) return err(gate.error);

  const origin = await resolveOrigin(dependencies, command.scope, gate.value.admitted);
  if (!origin.ok) return err(origin.error);

  const attachmentId = asIdentifier<AttachmentId>(dependencies.ids.uuid());
  const drafted = draftAttachment(command, gate.value.admitted, attachmentId, dependencies.clock.now(), dependencies);
  if (!drafted.ok) return err(drafted.error);

  const inserted = await runResult(dependencies.unitOfWork, (transaction) =>
    dependencies.repository.insertAttachment(drafted.value, transaction),
  );
  if (!inserted.ok) return err(inserted.error);

  const seeded = await seedBlob(dependencies, origin.value, inserted.value, gate.value.windowSeconds);
  if (!seeded.ok) {
    const rolledBack = await destroyAttachment(dependencies, inserted.value);
    return err(rolledBack.error ?? seeded.error);
  }
  return ok({ attachment: inserted.value, grant: seeded.value, origin: origin.value });
}
