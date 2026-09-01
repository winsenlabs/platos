// Use cases: issue a download grant, and redeem one.
//
// They are two calls on purpose. Issuing mints a short-lived grant; redeeming
// checks that grant against the clock BEFORE the store is touched. A caller that
// held a grant too long gets `FILES_PRESIGNED_GRANT_ELAPSED` from this context
// rather than a signature failure from a client it is forbidden to import — and
// the store is never called at all, which is what makes the rule provable with a
// fake that records its calls.
//
// Every path re-verifies the storage key against the requesting scope. The key
// was derived under one environment and a key from any other fails the prefix
// test, so a leaked key is inert outside its tenant.

import { err, ok, type Result } from "@platos/kernel";

import {
  admitGrantWindow,
  assertStorageKeyInScope,
  attachmentNotFound,
  grantExpiry,
  redeemGrant,
  toThreadScope,
  type Attachment,
  type AttachmentId,
  type PresignedGrant,
  type ThreadScope,
} from "../domain/index.js";
import type { FilesDependencies } from "./dependencies.js";
import type { StoredObject } from "./ports/index.js";

export interface IssueAttachmentDownloadCommand {
  readonly scope: ThreadScope;
  readonly attachmentId: AttachmentId;
  readonly windowSeconds?: number;
}

export interface AttachmentDownload {
  readonly attachment: Attachment;
  readonly grant: PresignedGrant;
}

export async function issueAttachmentDownload(
  dependencies: FilesDependencies,
  command: IssueAttachmentDownloadCommand,
): Promise<Result<AttachmentDownload>> {
  const window = admitGrantWindow(
    command.windowSeconds ?? dependencies.policy.upload.downloadWindowSeconds,
    dependencies.policy.upload.maxWindowSeconds,
  );
  if (!window.ok) return err(window.error);

  const found = await dependencies.repository.findAttachment(command.scope, command.attachmentId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(attachmentNotFound(command.attachmentId));

  const verified = assertStorageKeyInScope(found.value.storageKey, command.scope);
  if (!verified.ok) return err(verified.error);

  const issuedAt = dependencies.clock.now();
  const presigned = await dependencies.objectStore.presignDownload({
    key: verified.value,
    expiresAt: grantExpiry(issuedAt, window.value),
    downloadName: found.value.originalName,
  });
  if (!presigned.ok) return err(presigned.error);

  const grant: PresignedGrant = {
    operation: "download",
    key: presigned.value.key,
    url: presigned.value.url,
    method: "GET",
    requiredHeaders: presigned.value.requiredHeaders,
    issuedAt,
    expiresAt: presigned.value.expiresAt,
  };
  return ok({ attachment: found.value, grant });
}

export interface RedeemAttachmentDownloadCommand {
  readonly scope: ThreadScope;
  readonly grant: PresignedGrant;
}

/**
 * Pull the bytes a grant addresses. The two gates — expiry, then scope — run
 * before `ObjectStore.get`, so an elapsed or foreign grant costs one comparison
 * and no network call.
 */
export async function redeemAttachmentDownload(
  dependencies: FilesDependencies,
  command: RedeemAttachmentDownloadCommand,
): Promise<Result<StoredObject>> {
  const live = redeemGrant(command.grant, dependencies.clock.now());
  if (!live.ok) return err(live.error);
  const verified = assertStorageKeyInScope(live.value.key, command.scope);
  if (!verified.ok) return err(verified.error);
  return dependencies.objectStore.get(verified.value);
}

/** Convenience for the resolver path: scope-check by row, then fetch. */
export async function readAttachmentContent(
  dependencies: FilesDependencies,
  attachment: Attachment,
): Promise<Result<StoredObject>> {
  const verified = assertStorageKeyInScope(attachment.storageKey, toThreadScope(attachment.scope));
  if (!verified.ok) return err(verified.error);
  return dependencies.objectStore.get(verified.value);
}
