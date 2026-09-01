// Projections from domain values onto the published contract shapes.
//
// Kept apart from the use cases so a change to the wire shape cannot quietly
// change a rule, and so the mapping is one small readable table rather than an
// object literal buried in a control-flow branch.

import type {
  ArtifactRevisionView,
  AttachmentDestructionView,
  AttachmentRetentionSweepView,
  AttachmentView,
  TransferGrantView,
} from "../contracts/index.js";
import {
  attachmentTurnId,
  type ArtifactRevision,
  type Attachment,
  type DestructionReport,
  type DestructionSummary,
  type PresignedGrant,
} from "../domain/index.js";

export function toAttachmentView(attachment: Attachment): AttachmentView {
  return {
    attachmentId: attachment.attachmentId,
    kind: attachment.kind,
    mimeType: attachment.mimeType,
    bytes: attachment.bytes,
    width: attachment.media.width,
    height: attachment.media.height,
    durationSeconds: attachment.media.durationSeconds,
    originalName: attachment.originalName,
    contentHash: attachment.contentHash,
    turnId: attachmentTurnId(attachment),
    createdAt: attachment.createdAt,
    expiresAt: attachment.expiresAt,
  };
}

export function toGrantView(grant: PresignedGrant): TransferGrantView {
  return {
    url: grant.url,
    method: grant.method,
    requiredHeaders: grant.requiredHeaders,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
  };
}

export function toArtifactRevisionView(revision: ArtifactRevision): ArtifactRevisionView {
  return {
    artifactKey: revision.artifactKey,
    revision: revision.revision,
    kind: revision.kind,
    title: revision.title,
    mimeType: revision.mimeType,
    content: revision.content,
    metadata: revision.metadata,
    producedByTurnId: revision.producedByTurnId,
    createdBy: revision.createdBy,
    createdAt: revision.createdAt,
  };
}

export function toDestructionView(report: DestructionReport): AttachmentDestructionView {
  return {
    attachmentId: report.attachmentId,
    blobDestroyed: report.blob.outcome !== "failed",
    rowDestroyed: report.rowDestroyed,
    retainedBecause: report.error === null ? null : report.error.code,
  };
}

export function toSweepView(summary: DestructionSummary): AttachmentRetentionSweepView {
  return {
    examined: summary.reports.length,
    rowsDestroyed: summary.rowsDestroyed,
    rowsRetained: summary.rowsRetained,
    reports: summary.reports.map(toDestructionView),
  };
}
