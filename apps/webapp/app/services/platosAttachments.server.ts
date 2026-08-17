/** Environment-owned attachment upload reservations and object-store signing. */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  OrganizationRole,
  ProjectRole,
  reconcileAttachmentUploadBytes,
  reserveAttachmentUpload,
  sweepExpiredAttachmentUploadReservations,
} from "@platos/database";
import { randomUUID } from "node:crypto";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "./logger.server";

export interface AttachmentScope {
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
}

export type AttachmentKind = "image" | "audio" | "video" | "document";

const IMAGE_MIME = /^image\/(png|jpe?g|webp|gif|heic|heif|avif)$/i;
const AUDIO_MIME = /^audio\//i;
const VIDEO_MIME = /^video\//i;

export function classifyMimeType(mimeType: string): AttachmentKind {
  if (IMAGE_MIME.test(mimeType)) return "image";
  if (AUDIO_MIME.test(mimeType)) return "audio";
  if (VIDEO_MIME.test(mimeType)) return "video";
  return "document";
}

let _internalClient: S3Client | null = null;
let _publicClient: S3Client | null = null;

function client(endpoint: string): S3Client {
  return new S3Client({
    endpoint,
    region: env.MINIO_REGION,
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: env.MINIO_ACCESS_KEY,
      secretAccessKey: env.MINIO_SECRET_KEY,
    },
  });
}

function internalClient(): S3Client {
  return (_internalClient ??= client(env.MINIO_ENDPOINT));
}

function publicClient(): S3Client {
  return (_publicClient ??= client(env.MINIO_PUBLIC_ENDPOINT));
}

function sanitizeName(name: string | undefined): string {
  if (!name) return "file";
  const cleaned = name.trim().replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return cleaned || "file";
}

function environmentScopeWhere(scope: AttachmentScope) {
  return {
    environmentId: scope.environmentId,
    environment: {
      projectId: scope.projectId,
      project: { organizationId: scope.organizationId },
    },
  } as const;
}

async function requireAttachmentAccess(
  scope: AttachmentScope,
  access: "read" | "mutate",
): Promise<{ id: string }> {
  const environment = await prisma.environment.findFirst({
    where: {
      id: scope.environmentId,
      projectId: scope.projectId,
      archivedAt: null,
      project: { organizationId: scope.organizationId, archivedAt: null },
    },
    select: { id: true },
  });
  if (!environment) throw new Error("Attachment scope is not accessible");

  const organizationMembership = await prisma.organizationMembership.findUnique({
    where: {
      organizationId_userId: {
        organizationId: scope.organizationId,
        userId: scope.userId,
      },
    },
    select: { id: true, role: true, deactivatedAt: true },
  });
  if (!organizationMembership || organizationMembership.deactivatedAt) {
    throw new Error("Attachment scope is not accessible");
  }
  const projectMembership = await prisma.projectMembership.findUnique({
    where: {
      projectId_organizationMembershipId: {
        projectId: scope.projectId,
        organizationMembershipId: organizationMembership.id,
      },
    },
    select: { role: true },
  });
  if (access === "read" && !projectMembership) {
    throw new Error("Attachment scope is not accessible");
  }
  if (
    access === "mutate" &&
    organizationMembership.role !== OrganizationRole.OWNER &&
    organizationMembership.role !== OrganizationRole.ADMIN &&
    projectMembership?.role !== ProjectRole.ADMIN
  ) {
    throw new Error("Attachment scope is not accessible");
  }
  return environment;
}

export interface CreatePresignedUploadInput {
  scope: AttachmentScope;
  mimeType: string;
  bytes: number;
  filename?: string;
  kind?: AttachmentKind;
  width?: number;
  height?: number;
  durationSec?: number;
  contentHash?: string;
}

export interface CreatePresignedUploadResult {
  /** Clean-schema AttachmentUploadReservation id. */
  attachmentId: string;
  uploadUrl: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string;
  maxBytes: number;
}

export async function createPresignedUpload(
  input: CreatePresignedUploadInput
): Promise<CreatePresignedUploadResult> {
  const { scope } = input;
  if (!Number.isSafeInteger(input.bytes) || input.bytes <= 0) {
    throw new Error("bytes must be a positive integer");
  }
  if (input.bytes > env.PLATOS_ATTACHMENT_MAX_BYTES) {
    throw new Error(`Attachment exceeds per-upload cap of ${env.PLATOS_ATTACHMENT_MAX_BYTES} bytes`);
  }
  if (!input.mimeType) throw new Error("mimeType is required");

  // Re-derive scope from the canonical Environment before using tenant values
  // in an object key. The route authorizes too, but this service stays closed
  // if it is called from another boundary later.
  const canonical = await requireAttachmentAccess(scope, "mutate");

  const kind = input.kind ?? classifyMimeType(input.mimeType);
  const storageKey = `${scope.organizationId}/${scope.projectId}/${scope.environmentId}/${randomUUID()}/${sanitizeName(input.filename)}`;
  const reservation = await reserveAttachmentUpload(prisma, {
    environmentId: canonical.id,
    uploader: { userId: scope.userId },
    kind,
    mimeType: input.mimeType,
    bytes: input.bytes,
    width: input.width,
    height: input.height,
    durationSec: input.durationSec,
    storageKey,
    originalName: input.filename,
    contentHash: input.contentHash,
    quotaBytes: env.PLATOS_ATTACHMENT_ORG_QUOTA_BYTES,
  });

  const command = new PutObjectCommand({
    Bucket: env.MINIO_BUCKET,
    Key: storageKey,
    ContentType: input.mimeType,
    ContentLength: input.bytes,
  });

  let uploadUrl: string;
  try {
    uploadUrl = await getSignedUrl(publicClient(), command, {
      expiresIn: env.PLATOS_ATTACHMENT_PRESIGN_TTL_SECONDS,
    });
  } catch (error) {
    await prisma.attachmentUploadReservation.deleteMany({
      where: { id: reservation.id, messageAttachmentId: null },
    });
    throw error;
  }

  logger.info("Platos attachment presigned upload minted", {
    attachmentId: reservation.id,
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    kind,
    bytes: input.bytes,
  });

  return {
    attachmentId: reservation.id,
    uploadUrl,
    method: "PUT",
    headers: { "Content-Type": input.mimeType },
    expiresAt: new Date(
      Date.now() + env.PLATOS_ATTACHMENT_PRESIGN_TTL_SECONDS * 1000
    ).toISOString(),
    maxBytes: env.PLATOS_ATTACHMENT_MAX_BYTES,
  };
}

export interface CreatePresignedDownloadResult {
  attachmentId: string;
  downloadUrl: string;
  mimeType: string;
  kind: AttachmentKind;
  bytes: number;
  originalName: string | null;
  expiresAt: string;
}

type StoredAttachment = {
  id: string;
  storageKey: string;
  mimeType: string;
  kind: string;
  bytes: number;
  originalName: string | null;
  messageAttachmentId?: string | null;
  source: "reservation" | "attachment";
};

async function findStoredAttachment(
  attachmentId: string,
  scope: AttachmentScope,
  access: "read" | "mutate",
): Promise<StoredAttachment | null> {
  await requireAttachmentAccess(scope, access);
  const reservation = await prisma.attachmentUploadReservation.findFirst({
    where: { id: attachmentId, ...environmentScopeWhere(scope) },
    select: {
      id: true,
      storageKey: true,
      mimeType: true,
      kind: true,
      bytes: true,
      originalName: true,
      messageAttachmentId: true,
    },
  });
  if (reservation) return { ...reservation, source: "reservation" };

  const attachment = await prisma.messageAttachment.findFirst({
    where: { id: attachmentId, ...environmentScopeWhere(scope) },
    select: {
      id: true,
      storageKey: true,
      mimeType: true,
      kind: true,
      bytes: true,
      originalName: true,
    },
  });
  return attachment ? { ...attachment, source: "attachment" } : null;
}

export async function createPresignedDownload(
  attachmentId: string,
  scope: AttachmentScope
): Promise<CreatePresignedDownloadResult | null> {
  const row = await findStoredAttachment(attachmentId, scope, "read");
  if (!row) return null;
  const downloadUrl = await getSignedUrl(
    publicClient(),
    new GetObjectCommand({ Bucket: env.MINIO_BUCKET, Key: row.storageKey }),
    { expiresIn: env.PLATOS_ATTACHMENT_PRESIGN_TTL_SECONDS }
  );
  return {
    attachmentId: row.id,
    downloadUrl,
    mimeType: row.mimeType,
    kind: row.kind as AttachmentKind,
    bytes: row.bytes,
    originalName: row.originalName,
    expiresAt: new Date(
      Date.now() + env.PLATOS_ATTACHMENT_PRESIGN_TTL_SECONDS * 1000
    ).toISOString(),
  };
}

export async function deleteAttachment(
  attachmentId: string,
  scope: AttachmentScope
): Promise<boolean> {
  const row = await findStoredAttachment(attachmentId, scope, "mutate");
  if (!row) return false;
  try {
    await internalClient().send(
      new DeleteObjectCommand({ Bucket: env.MINIO_BUCKET, Key: row.storageKey })
    );
  } catch (error) {
    logger.warn("Attachment object delete failed; removing metadata anyway", {
      attachmentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (row.source === "reservation") {
    if (row.messageAttachmentId) {
      await prisma.messageAttachment.deleteMany({ where: { id: row.messageAttachmentId } });
    } else {
      await prisma.attachmentUploadReservation.deleteMany({ where: { id: row.id } });
    }
  } else {
    await prisma.messageAttachment.deleteMany({ where: { id: row.id } });
  }
  return true;
}

export async function deleteStorageKey(storageKey: string): Promise<void> {
  await internalClient().send(
    new DeleteObjectCommand({ Bucket: env.MINIO_BUCKET, Key: storageKey })
  );
}

export async function reconcileAttachmentBytes(
  attachmentId: string,
  scope: AttachmentScope
): Promise<{ claimedBytes: number; actualBytes: number | null; corrected: boolean } | null> {
  const row = await findStoredAttachment(attachmentId, scope, "mutate");
  if (!row) return null;

  let actualBytes: number | null = null;
  try {
    const head = await internalClient().send(
      new HeadObjectCommand({ Bucket: env.MINIO_BUCKET, Key: row.storageKey })
    );
    if (typeof head.ContentLength === "number") actualBytes = head.ContentLength;
  } catch (error) {
    logger.debug("reconcileAttachmentBytes: HEAD failed", {
      attachmentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { claimedBytes: row.bytes, actualBytes: null, corrected: false };
  }

  if (actualBytes === null || actualBytes === row.bytes) {
    return { claimedBytes: row.bytes, actualBytes, corrected: false };
  }

  if (row.source !== "reservation") {
    return { claimedBytes: row.bytes, actualBytes, corrected: false };
  }
  const reconciliation = await reconcileAttachmentUploadBytes(prisma, {
    reservationId: row.id,
    environmentId: scope.environmentId,
    storageKey: row.storageKey,
    claimedBytes: row.bytes,
    actualBytes,
    quotaBytes: env.PLATOS_ATTACHMENT_ORG_QUOTA_BYTES,
  });

  logger.info("Platos attachment bytes reconciled", {
    attachmentId,
    organizationId: scope.organizationId,
    claimedBytes: row.bytes,
    actualBytes,
    delta: actualBytes - row.bytes,
  });
  return {
    claimedBytes: reconciliation.claimedBytes,
    actualBytes: reconciliation.actualBytes,
    corrected: reconciliation.corrected,
  };
}

export async function runRetentionSweep(options: { limit?: number } = {}): Promise<{
  scanned: number;
  deletedRows: number;
  storageFailures: number;
}> {
  const limit = options.limit ?? 500;
  const expiredReservations = await sweepExpiredAttachmentUploadReservations(prisma, limit);
  const remaining = Math.max(0, limit - expiredReservations.length);
  const expiredAttachments = remaining
    ? await prisma.messageAttachment.findMany({
        where: { expiresAt: { lt: new Date() } },
        take: remaining,
        orderBy: { expiresAt: "asc" },
        select: { id: true, storageKey: true },
      })
    : [];

  let storageFailures = 0;
  for (const row of [...expiredReservations, ...expiredAttachments]) {
    try {
      await deleteStorageKey(row.storageKey);
    } catch (error) {
      storageFailures += 1;
      logger.warn("Retention: object delete failed (dropping metadata anyway)", {
        attachmentId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  for (const row of expiredAttachments) {
    await prisma.messageAttachment.deleteMany({ where: { id: row.id } });
  }

  const deletedRows = expiredReservations.length + expiredAttachments.length;
  return { scanned: deletedRows, deletedRows, storageFailures };
}
