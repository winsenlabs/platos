/**
 * Platos Theme D — multimodal attachments service.
 *
 * Mints scope-gated presigned URLs so the browser uploads directly to MinIO
 * (raw creds never reach the browser). Enforces per-upload size caps + per-org
 * quota on every upload request.
 *
 * Two S3 clients:
 *   - `internalClient` — used when the webapp itself needs to talk to MinIO
 *     (retention sweep, quota counting, delete).
 *   - `publicClient` — used to *sign* URLs that the browser will follow. Its
 *     `endpoint` is the browser-facing host (MINIO_PUBLIC_ENDPOINT) so the
 *     signed URL is actually reachable from the user's machine.
 *
 * Both clients use `forcePathStyle: true` — MinIO doesn't support virtual-hosted
 * style addressing out of the box, so keys appear as `/bucket/key` in the URL.
 *
 * PLATOS_ATTACHMENT_PRESIGN_TTL_SECONDS (default 900) bounds the signed URL's
 * lifetime so even if the URL leaks it expires in 15 minutes.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
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

/** Classify a mime type into one of four coarse kinds used by the model. */
export function classifyMimeType(mimeType: string): AttachmentKind {
  if (IMAGE_MIME.test(mimeType)) return "image";
  if (AUDIO_MIME.test(mimeType)) return "audio";
  if (VIDEO_MIME.test(mimeType)) return "video";
  return "document";
}

let _internalClient: S3Client | null = null;
let _publicClient: S3Client | null = null;

// AWS SDK v3 ≥3.726.0 defaults `requestChecksumCalculation` to "WHEN_SUPPORTED",
// which signs presigned PUT URLs with a placeholder `x-amz-checksum-crc32=AAAAAA==`
// header. The browser's actual upload computes a real CRC32, the signed header
// value differs, and MinIO returns 403 SignatureDoesNotMatch. Pinning to
// "WHEN_REQUIRED" keeps presigned-PUT integrity behavior compatible with MinIO
// + S3-compat backends. https://github.com/minio/minio/issues/20845
function internalClient(): S3Client {
  if (_internalClient) return _internalClient;
  _internalClient = new S3Client({
    endpoint: env.MINIO_ENDPOINT,
    region: env.MINIO_REGION,
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: env.MINIO_ACCESS_KEY,
      secretAccessKey: env.MINIO_SECRET_KEY,
    },
  });
  return _internalClient;
}

function publicClient(): S3Client {
  if (_publicClient) return _publicClient;
  _publicClient = new S3Client({
    endpoint: env.MINIO_PUBLIC_ENDPOINT,
    region: env.MINIO_REGION,
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: env.MINIO_ACCESS_KEY,
      secretAccessKey: env.MINIO_SECRET_KEY,
    },
  });
  return _publicClient;
}

/**
 * Sanitize a filename for use in a MinIO object key. Keep the extension but
 * strip anything non-ASCII-alphanumeric-dash-underscore-dot so the key is
 * safe in URLs and S3-compatible services.
 */
function sanitizeName(name: string | undefined): string {
  if (!name) return "file";
  const cleaned = name
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : "file";
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
  attachmentId: string;
  uploadUrl: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string; // ISO-8601
  maxBytes: number;
}

/** Sum total attachment bytes already stored for an organization. */
async function getOrgUsageBytes(organizationId: string): Promise<number> {
  const agg = await prisma.platosMessageAttachment.aggregate({
    where: { organizationId },
    _sum: { bytes: true },
  });
  return agg._sum.bytes ?? 0;
}

/**
 * PPR-19 — atomic quota-gate + insert.
 *
 * Replaces the previous "aggregate bytes, compare to quota, then insert"
 * sequence, which was TOCTOU-racy: two concurrent browsers sitting just
 * under the quota could each pass the check and then both insert, blowing
 * past the cap. We now run a single `INSERT ... SELECT ... WHERE (SELECT
 * sum(bytes) FROM ...) + :bytes <= :quota` statement inside a Postgres
 * transaction with `SERIALIZABLE` isolation so the sum is evaluated against
 * the committed state at insert time. A 0-row affected result means the
 * quota check failed and no row was inserted.
 *
 * Implementation: raw SQL because Prisma's `create` can't conditionally
 * skip based on an aggregate. We use `tx.$executeRawUnsafe` on parameterised
 * values that come from internal config + uuid — safe from SQL injection.
 */
async function insertWithQuotaGate(params: {
  id: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  uploadedBy: string;
  kind: AttachmentKind;
  mimeType: string;
  bytes: number;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  storageKey: string;
  originalName: string | null;
  contentHash: string | null;
  expiresAt: Date;
  quotaBytes: number;
}): Promise<{ inserted: boolean; usedBytes: number }> {
  // Run inside a transaction so the sum + insert are a single atomic
  // unit as far as concurrent writers are concerned. The WHERE clause
  // against a SELECT aggregate means the insert either happens (and
  // counts toward the quota) or is skipped with zero rows affected —
  // callers must surface the skip as a 413.
  return prisma.$transaction(async (tx) => {
    const inserted = await tx.$executeRaw`
      INSERT INTO "PlatosMessageAttachment" (
        "id", "organizationId", "projectId", "environmentId", "uploadedBy",
        "kind", "mimeType", "bytes", "width", "height", "durationSec",
        "storageKey", "originalName", "contentHash", "createdAt", "expiresAt"
      )
      SELECT
        ${params.id}, ${params.organizationId}, ${params.projectId},
        ${params.environmentId}, ${params.uploadedBy}, ${params.kind},
        ${params.mimeType}, ${params.bytes}, ${params.width}, ${params.height},
        ${params.durationSec}, ${params.storageKey}, ${params.originalName},
        ${params.contentHash}, NOW(), ${params.expiresAt}
      WHERE (
        COALESCE((
          SELECT SUM("bytes")::bigint
          FROM "PlatosMessageAttachment"
          WHERE "organizationId" = ${params.organizationId}
        ), 0) + ${params.bytes} <= ${params.quotaBytes}
      )
    `;
    // Re-read current usage — callers log it, and a 413 response carries
    // it so the browser UX can show "you have X/Y GB used".
    const usedAgg = await tx.platosMessageAttachment.aggregate({
      where: { organizationId: params.organizationId },
      _sum: { bytes: true },
    });
    return { inserted: inserted > 0, usedBytes: usedAgg._sum.bytes ?? 0 };
  }, { isolationLevel: "Serializable" });
}

/**
 * Create a scope-gated presigned PUT URL for a new attachment.
 * The caller must have already been auth'd by the Remix loader — this service
 * does NOT re-check session; it only validates the payload.
 */
export async function createPresignedUpload(
  input: CreatePresignedUploadInput
): Promise<CreatePresignedUploadResult> {
  const { scope } = input;

  if (!Number.isFinite(input.bytes) || input.bytes <= 0) {
    throw new Error("bytes must be a positive number");
  }
  if (input.bytes > env.PLATOS_ATTACHMENT_MAX_BYTES) {
    throw new Error(
      `Attachment exceeds per-upload cap of ${env.PLATOS_ATTACHMENT_MAX_BYTES} bytes`
    );
  }
  if (!input.mimeType || typeof input.mimeType !== "string") {
    throw new Error("mimeType is required");
  }

  const kind = input.kind ?? classifyMimeType(input.mimeType);
  const id = randomUUID();
  const safeName = sanitizeName(input.filename);
  const storageKey = `${scope.organizationId}/${scope.projectId}/${scope.environmentId}/${id}/${safeName}`;

  const expiresAtMs = Date.now() + env.PLATOS_ATTACHMENT_PRESIGN_TTL_SECONDS * 1000;

  // Persist the row FIRST so the subsequent upload is accounted for in quota
  // even if the browser retries. `expiresAt` starts as the grace-period
  // deadline and gets pushed out once the attachment is attached to a message.
  const graceDeadline = new Date(
    Date.now() + env.PLATOS_ATTACHMENT_GRACE_DAYS * 24 * 60 * 60 * 1000
  );

  // PPR-19 — atomic quota gate. If another concurrent upload beat this
  // caller to the quota ceiling the INSERT is skipped and we throw a
  // quota-exceeded error just like the previous pre-check would have.
  const { inserted, usedBytes } = await insertWithQuotaGate({
    id,
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    uploadedBy: scope.userId,
    kind,
    mimeType: input.mimeType,
    bytes: input.bytes,
    width: input.width ?? null,
    height: input.height ?? null,
    durationSec: input.durationSec ?? null,
    storageKey,
    originalName: input.filename ?? null,
    contentHash: input.contentHash ?? null,
    expiresAt: graceDeadline,
    quotaBytes: env.PLATOS_ATTACHMENT_ORG_QUOTA_BYTES,
  });
  if (!inserted) {
    throw new Error(
      `Organization quota exceeded: using ${usedBytes} + ${input.bytes} > ${env.PLATOS_ATTACHMENT_ORG_QUOTA_BYTES}`,
    );
  }

  const command = new PutObjectCommand({
    Bucket: env.MINIO_BUCKET,
    Key: storageKey,
    ContentType: input.mimeType,
    ContentLength: input.bytes,
  });

  const uploadUrl = await getSignedUrl(publicClient(), command, {
    expiresIn: env.PLATOS_ATTACHMENT_PRESIGN_TTL_SECONDS,
  });

  logger.info("Platos attachment presigned upload minted", {
    attachmentId: id,
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    kind,
    bytes: input.bytes,
  });

  return {
    attachmentId: id,
    uploadUrl,
    method: "PUT",
    headers: {
      "Content-Type": input.mimeType,
    },
    expiresAt: new Date(expiresAtMs).toISOString(),
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

/**
 * Mint a scope-gated presigned GET URL for an existing attachment.
 * Returns null if the attachment is not visible to the caller's scope —
 * cross-scope GETs must fail closed.
 */
export async function createPresignedDownload(
  attachmentId: string,
  scope: AttachmentScope
): Promise<CreatePresignedDownloadResult | null> {
  const row = await prisma.platosMessageAttachment.findFirst({
    where: {
      id: attachmentId,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    },
  });
  if (!row) return null;

  const command = new GetObjectCommand({
    Bucket: env.MINIO_BUCKET,
    Key: row.storageKey,
  });
  const downloadUrl = await getSignedUrl(publicClient(), command, {
    expiresIn: env.PLATOS_ATTACHMENT_PRESIGN_TTL_SECONDS,
  });

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

/**
 * Delete an attachment from MinIO + database. Scope-gated (same check as GET).
 */
export async function deleteAttachment(
  attachmentId: string,
  scope: AttachmentScope
): Promise<boolean> {
  const row = await prisma.platosMessageAttachment.findFirst({
    where: {
      id: attachmentId,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    },
  });
  if (!row) return false;
  try {
    await internalClient().send(
      new DeleteObjectCommand({
        Bucket: env.MINIO_BUCKET,
        Key: row.storageKey,
      })
    );
  } catch (err) {
    logger.warn("Attachment object delete failed; removing row anyway", {
      attachmentId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  await prisma.platosMessageAttachment.delete({ where: { id: row.id } });
  return true;
}

/** Server-side helper for retention task + internal reads of object bytes. */
export async function deleteStorageKey(storageKey: string): Promise<void> {
  await internalClient().send(
    new DeleteObjectCommand({
      Bucket: env.MINIO_BUCKET,
      Key: storageKey,
    })
  );
}

/**
 * PPR-19 — post-PUT size reconcile.
 *
 * The browser reports `bytes` at presign time; we trust it to gate quota.
 * A malicious or buggy client could report a small value, pass the quota
 * check, then PUT a much larger object. After the upload completes the
 * client pings this endpoint (via an attach-message loader) and we:
 *   1. HEAD the object in MinIO to learn the real byte count.
 *   2. If the real count differs from the stored `bytes`, overwrite the row.
 *   3. If the correction pushes the org past quota, we do NOT delete the
 *      row here — the retention sweep / admin dashboard is the enforcement
 *      surface. But we DO flag the discrepancy in logs so ops can spot
 *      abusive clients.
 *
 * Returns the authoritative byte count (or null if the object isn't present
 * in MinIO, e.g. the PUT hasn't completed yet — caller should retry later).
 */
export async function reconcileAttachmentBytes(
  attachmentId: string,
  scope: AttachmentScope,
): Promise<{ claimedBytes: number; actualBytes: number | null; corrected: boolean } | null> {
  const row = await prisma.platosMessageAttachment.findFirst({
    where: {
      id: attachmentId,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    },
  });
  if (!row) return null;

  let actualBytes: number | null = null;
  try {
    const head = await internalClient().send(
      new HeadObjectCommand({
        Bucket: env.MINIO_BUCKET,
        Key: row.storageKey,
      }),
    );
    if (typeof head.ContentLength === "number") {
      actualBytes = head.ContentLength;
    }
  } catch (err) {
    // Object not yet uploaded / 404 is a normal pre-PUT state; caller
    // retries after upload completes.
    logger.debug("reconcileAttachmentBytes: HEAD failed", {
      attachmentId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { claimedBytes: row.bytes, actualBytes: null, corrected: false };
  }

  if (actualBytes === null || actualBytes === row.bytes) {
    return { claimedBytes: row.bytes, actualBytes, corrected: false };
  }

  // Correct the row to reflect reality. Quota re-check happens at the next
  // upload because createPresignedUpload sums from the same column.
  await prisma.platosMessageAttachment.update({
    where: { id: row.id },
    data: { bytes: actualBytes },
  });

  logger.info("Platos attachment bytes reconciled", {
    attachmentId,
    organizationId: scope.organizationId,
    claimedBytes: row.bytes,
    actualBytes,
    delta: actualBytes - row.bytes,
  });

  return { claimedBytes: row.bytes, actualBytes, corrected: true };
}

/**
 * Sweep every PlatosMessageAttachment whose `expiresAt` is in the past.
 * Returns counts for observability. Best-effort on MinIO delete (if the
 * object is already gone, still drop the row).
 *
 * Called by the daily trigger.dev scheduled task via the admin endpoint.
 */
export async function runRetentionSweep(options: { limit?: number } = {}): Promise<{
  scanned: number;
  deletedRows: number;
  storageFailures: number;
}> {
  const limit = options.limit ?? 500;
  const expired = await prisma.platosMessageAttachment.findMany({
    where: { expiresAt: { lt: new Date() } },
    take: limit,
    orderBy: { expiresAt: "asc" },
    select: { id: true, storageKey: true },
  });

  let deletedRows = 0;
  let storageFailures = 0;

  for (const row of expired) {
    try {
      await internalClient().send(
        new DeleteObjectCommand({
          Bucket: env.MINIO_BUCKET,
          Key: row.storageKey,
        })
      );
    } catch (err) {
      storageFailures += 1;
      logger.warn("Retention: MinIO delete failed (dropping row anyway)", {
        attachmentId: row.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    await prisma.platosMessageAttachment.delete({ where: { id: row.id } });
    deletedRows += 1;
  }

  return { scanned: expired.length, deletedRows, storageFailures };
}
