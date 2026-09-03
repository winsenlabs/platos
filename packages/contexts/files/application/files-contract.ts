// The composition of this context's use cases into its published contract.
//
// Thin on purpose. Every rule lives in `domain/`, every orchestration in a named
// use-case module, and this file is the adapter between the command shapes the
// contract publishes and the ones the use cases take. It holds no rule of its
// own, which is what keeps it from becoming the god-service ADR M0.3 §6 exists
// to prevent.

import { err, ok, type ErasureTarget, type Result } from "@platos/kernel";

import type {
  ArtifactRevisionView,
  AttachmentDownloadView,
  AttachmentRetentionSweepView,
  AttachmentUploadView,
  AttachmentView,
  FilesContract,
  RequestArtifactRead,
  RequestArtifactRevision,
  RequestAttachmentBinding,
  RequestAttachmentDownload,
  RequestAttachmentRetentionSweep,
  RequestAttachmentUpload,
} from "../contracts/index.js";
import { attachmentNotFound } from "../domain/index.js";
import { bindAttachmentsToTurn } from "./bind-attachments-to-turn.js";
import type { FilesDependencies } from "./dependencies.js";
import { sweepElapsedAttachments } from "./destroy-attachment.js";
import { createFilesErasureTarget } from "./files-erasure-target.js";
import { presignAttachmentUpload } from "./presign-attachment-upload.js";
import { readArtifactRevision } from "./read-artifact-revision.js";
import { issueAttachmentDownload } from "./read-attachment.js";
import { toArtifactRevisionView, toAttachmentView, toGrantView, toSweepView } from "./views.js";
import { writeArtifactRevision } from "./write-artifact-revision.js";

async function requestUpload(
  dependencies: FilesDependencies,
  request: RequestAttachmentUpload,
): Promise<Result<AttachmentUploadView>> {
  const granted = await presignAttachmentUpload(dependencies, {
    scope: request.scope,
    intake: {
      mimeType: request.mimeType,
      bytes: request.bytes,
      originalName: request.originalName ?? null,
      kind: request.kind ?? null,
      media: {
        width: request.width ?? null,
        height: request.height ?? null,
        durationSeconds: request.durationSeconds ?? null,
      },
      contentHash: request.contentHash ?? null,
    },
  });
  if (!granted.ok) return err(granted.error);
  return ok({
    attachment: toAttachmentView(granted.value.attachment),
    grant: granted.value.grant === null ? null : toGrantView(granted.value.grant),
    deduplicated: granted.value.origin.origin === "copy-from",
  });
}

async function bindToTurn(
  dependencies: FilesDependencies,
  request: RequestAttachmentBinding,
): Promise<Result<readonly AttachmentView[]>> {
  const bound = await bindAttachmentsToTurn(dependencies, request);
  if (!bound.ok) return err(bound.error);
  return ok(bound.value.map(toAttachmentView));
}

async function requestDownload(
  dependencies: FilesDependencies,
  request: RequestAttachmentDownload,
): Promise<Result<AttachmentDownloadView>> {
  const issued = await issueAttachmentDownload(dependencies, request);
  if (!issued.ok) return err(issued.error);
  return ok({ attachment: toAttachmentView(issued.value.attachment), grant: toGrantView(issued.value.grant) });
}

async function describeAttachment(
  dependencies: FilesDependencies,
  request: RequestAttachmentDownload,
): Promise<Result<AttachmentView>> {
  const found = await dependencies.repository.findAttachment(request.scope, request.attachmentId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(attachmentNotFound(request.attachmentId));
  return ok(toAttachmentView(found.value));
}

async function appendArtifactRevision(
  dependencies: FilesDependencies,
  request: RequestArtifactRevision,
): Promise<Result<ArtifactRevisionView>> {
  const written = await writeArtifactRevision(dependencies, request);
  if (!written.ok) return err(written.error);
  return ok(toArtifactRevisionView(written.value));
}

async function readArtifact(
  dependencies: FilesDependencies,
  request: RequestArtifactRead,
): Promise<Result<ArtifactRevisionView>> {
  const found = await readArtifactRevision(dependencies, request);
  if (!found.ok) return err(found.error);
  return ok(toArtifactRevisionView(found.value));
}

async function sweepRetention(
  dependencies: FilesDependencies,
  request: RequestAttachmentRetentionSweep,
): Promise<Result<AttachmentRetentionSweepView>> {
  const swept = await sweepElapsedAttachments(dependencies, request);
  if (!swept.ok) return err(swept.error);
  return ok(toSweepView(swept.value));
}

/** Build the context. The composition root calls this once, at boot. */
export function createFilesContract(dependencies: FilesDependencies): FilesContract {
  const erasure: ErasureTarget = createFilesErasureTarget(dependencies);
  return {
    name: "files",
    requestUpload: (request) => requestUpload(dependencies, request),
    bindToTurn: (request) => bindToTurn(dependencies, request),
    requestDownload: (request) => requestDownload(dependencies, request),
    describeAttachment: (request) => describeAttachment(dependencies, request),
    appendArtifactRevision: (request) => appendArtifactRevision(dependencies, request),
    readArtifact: (request) => readArtifact(dependencies, request),
    sweepRetention: (request) => sweepRetention(dependencies, request),
    erasureTarget: () => erasure,
  };
}
