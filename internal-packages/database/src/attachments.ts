import type { AttachmentUploadReservation, MessageAttachment } from "../generated/control";
import { Prisma, type PrismaClient } from "../generated/control";

const UNCLAIMED_TTL_DAYS = 7;
const CLAIMED_TTL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export type AttachmentUploader =
  | { readonly userId: string; readonly endUserId?: never }
  | { readonly userId?: never; readonly endUserId: string };

export interface ReserveAttachmentUploadInput {
  readonly environmentId: string;
  readonly uploader: AttachmentUploader;
  readonly kind: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly width?: number;
  readonly height?: number;
  readonly durationSec?: number;
  readonly storageKey: string;
  readonly originalName?: string;
  readonly contentHash?: string;
  /** Canonical organization-wide cap, in bytes. */
  readonly quotaBytes: number;
}

export interface ClaimAttachmentUploadInput {
  readonly reservationId: string;
  readonly environmentId: string;
  readonly turnId: string;
}

export interface ReconcileAttachmentUploadBytesInput {
  readonly reservationId: string;
  readonly environmentId: string;
  readonly storageKey: string;
  readonly claimedBytes: number;
  readonly actualBytes: number;
  readonly quotaBytes: number;
}

export interface AttachmentByteReconciliation {
  readonly claimedBytes: number;
  readonly actualBytes: number;
  readonly corrected: boolean;
}

export class AttachmentQuotaExceededError extends Error {
  readonly usedBytes: number;
  readonly requestedBytes: number;
  readonly quotaBytes: number;

  constructor(usedBytes: number, requestedBytes: number, quotaBytes: number) {
    super("Attachment upload quota exceeded");
    this.name = "AttachmentQuotaExceededError";
    this.usedBytes = usedBytes;
    this.requestedBytes = requestedBytes;
    this.quotaBytes = quotaBytes;
  }
}

export class AttachmentClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentClaimError";
  }
}

function requirePositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
}

function validateReservationInput(input: ReserveAttachmentUploadInput): void {
  requirePositiveInteger(input.bytes, "bytes");
  requirePositiveInteger(input.quotaBytes, "quotaBytes");
  if (input.width !== undefined) requirePositiveInteger(input.width, "width");
  if (input.height !== undefined) requirePositiveInteger(input.height, "height");
  if (input.durationSec !== undefined && (!Number.isSafeInteger(input.durationSec) || input.durationSec < 0)) {
    throw new TypeError("durationSec must be a non-negative safe integer");
  }
  if (input.kind.trim() === "") throw new TypeError("kind must not be empty");
  if (input.mimeType.trim() === "") throw new TypeError("mimeType must not be empty");
  if (input.storageKey === "") throw new TypeError("storageKey must not be empty");
}

/**
 * Atomically reserves organization quota for one Environment-owned upload.
 *
 * The advisory transaction lock is keyed by the Environment's canonical
 * Organization, so concurrent reservations in sibling Projects/Environments
 * cannot both observe the same remaining quota. Expired rows are deliberately
 * excluded and therefore stop consuming quota before a sweep removes them.
 */
export async function reserveAttachmentUpload(
  client: PrismaClient,
  input: ReserveAttachmentUploadInput
): Promise<AttachmentUploadReservation> {
  validateReservationInput(input);

  return client.$transaction(async (tx) => {
    const scope = await tx.environment.findUnique({
      where: { id: input.environmentId },
      select: { project: { select: { organizationId: true } } },
    });
    if (!scope) throw new AttachmentClaimError("Attachment upload scope is not accessible");
    const organizationId = scope.project.organizationId;

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}::text, 0))`;
    const [usage] = await tx.$queryRaw<Array<{ usedBytes: bigint }>>(Prisma.sql`
      SELECT (
        COALESCE((
          SELECT SUM(reservation."bytes")::bigint
            FROM "AttachmentUploadReservation" reservation
            JOIN "Environment" environment ON environment.id = reservation."environmentId"
            JOIN "Project" project ON project.id = environment."projectId"
           WHERE project."organizationId" = ${organizationId}::uuid
             AND reservation."expiresAt" > CURRENT_TIMESTAMP
        ), 0) +
        COALESCE((
          SELECT SUM(attachment."bytes")::bigint
            FROM "MessageAttachment" attachment
            JOIN "Environment" environment ON environment.id = attachment."environmentId"
            JOIN "Project" project ON project.id = environment."projectId"
            LEFT JOIN "AttachmentUploadReservation" reservation
              ON reservation."messageAttachmentId" = attachment.id
           WHERE project."organizationId" = ${organizationId}::uuid
             AND reservation.id IS NULL
             AND (attachment."expiresAt" IS NULL OR attachment."expiresAt" > CURRENT_TIMESTAMP)
        ), 0)
      )::bigint AS "usedBytes"
    `);
    const usedBytes = Number(usage?.usedBytes ?? 0n);
    if (usedBytes + input.bytes > input.quotaBytes) {
      throw new AttachmentQuotaExceededError(usedBytes, input.bytes, input.quotaBytes);
    }

    const createdAt = new Date();
    return tx.attachmentUploadReservation.create({
      data: {
        environmentId: input.environmentId,
        uploadedByUserId: input.uploader.userId,
        uploadedByEndUserId: input.uploader.endUserId,
        kind: input.kind,
        mimeType: input.mimeType,
        bytes: input.bytes,
        width: input.width,
        height: input.height,
        durationSec: input.durationSec,
        storageKey: input.storageKey,
        originalName: input.originalName,
        contentHash: input.contentHash,
        createdAt,
        expiresAt: new Date(createdAt.getTime() + UNCLAIMED_TTL_DAYS * DAY_MS),
      },
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

/**
 * Claims a reservation exactly once. A retry for the same Turn returns the
 * existing attachment; a different Turn can never reassign it.
 */
export async function claimAttachmentUpload(
  client: PrismaClient,
  input: ClaimAttachmentUploadInput
): Promise<MessageAttachment> {
  return client.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id
        FROM "AttachmentUploadReservation"
       WHERE id = ${input.reservationId}::uuid
         AND "environmentId" = ${input.environmentId}::uuid
       FOR UPDATE
    `);
    if (locked.length !== 1) {
      throw new AttachmentClaimError("Attachment upload reservation is not accessible");
    }

    const reservation = await tx.attachmentUploadReservation.findUniqueOrThrow({
      where: { id: input.reservationId },
      include: { messageAttachment: true },
    });
    if (reservation.messageAttachment) {
      if (reservation.messageAttachment.turnId !== input.turnId) {
        throw new AttachmentClaimError("Attachment upload reservation was claimed by another turn");
      }
      return reservation.messageAttachment;
    }
    if (reservation.expiresAt.getTime() <= Date.now()) {
      throw new AttachmentClaimError("Attachment upload reservation has expired");
    }

    const turn = await tx.turn.findFirst({
      where: {
        id: input.turnId,
        thread: { environmentId: input.environmentId },
      },
      select: { id: true, thread: { select: { endUserId: true } } },
    });
    if (!turn) throw new AttachmentClaimError("Attachment target turn is not accessible");
    if (
      reservation.uploadedByEndUserId !== null &&
      reservation.uploadedByEndUserId !== turn.thread.endUserId
    ) {
      throw new AttachmentClaimError("Attachment target turn is not accessible");
    }

    const claimedAt = new Date();
    const expiresAt = new Date(claimedAt.getTime() + CLAIMED_TTL_DAYS * DAY_MS);
    const attachment = await tx.messageAttachment.create({
      data: {
        environmentId: reservation.environmentId,
        endUserId: turn.thread.endUserId,
        turnId: turn.id,
        kind: reservation.kind,
        mimeType: reservation.mimeType,
        bytes: reservation.bytes,
        width: reservation.width,
        height: reservation.height,
        durationSec: reservation.durationSec,
        storageKey: reservation.storageKey,
        originalName: reservation.originalName,
        contentHash: reservation.contentHash,
        expiresAt,
      },
    });
    await tx.attachmentUploadReservation.update({
      where: { id: reservation.id },
      data: { messageAttachmentId: attachment.id, claimedAt, expiresAt },
    });
    return attachment;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

/**
 * Corrects object-store byte metadata through the database's constrained
 * quota-locked reconciliation function. Claimed reservations update their
 * immutable MessageAttachment partner in the same transaction.
 */
export async function reconcileAttachmentUploadBytes(
  client: PrismaClient,
  input: ReconcileAttachmentUploadBytesInput,
): Promise<AttachmentByteReconciliation> {
  requirePositiveInteger(input.claimedBytes, "claimedBytes");
  requirePositiveInteger(input.actualBytes, "actualBytes");
  requirePositiveInteger(input.quotaBytes, "quotaBytes");
  if (!input.storageKey) throw new TypeError("storageKey must not be empty");

  const rows = await client.$queryRaw<AttachmentByteReconciliation[]>(Prisma.sql`
    SELECT "claimedBytes", "actualBytes", corrected
      FROM "public"."reconcile_attachment_upload_bytes"(
        ${input.reservationId}::uuid,
        ${input.environmentId}::uuid,
        ${input.storageKey},
        ${input.claimedBytes}::integer,
        ${input.actualBytes}::integer,
        ${BigInt(input.quotaBytes)}::bigint
      )
  `);
  const result = rows[0];
  if (!result) throw new AttachmentClaimError("Attachment upload reservation is not accessible");
  return result;
}

export interface SweptAttachmentUploadReservation {
  readonly id: string;
  readonly storageKey: string;
}

/**
 * Removes expired, still-unclaimed reservations in bounded lock-safe batches.
 * Returned object keys let the caller perform best-effort object-store cleanup.
 */
export async function sweepExpiredAttachmentUploadReservations(
  client: PrismaClient,
  limit = 500
): Promise<SweptAttachmentUploadReservation[]> {
  requirePositiveInteger(limit, "limit");
  return client.$transaction((tx) => tx.$queryRaw<SweptAttachmentUploadReservation[]>(Prisma.sql`
    DELETE FROM "AttachmentUploadReservation"
     WHERE id IN (
       SELECT id
         FROM "AttachmentUploadReservation"
        WHERE "messageAttachmentId" IS NULL
          AND "expiresAt" <= CURRENT_TIMESTAMP
        ORDER BY "expiresAt", id
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
     )
    RETURNING id, "storageKey"
  `));
}

export const attachmentUploadRetention = Object.freeze({
  unclaimedDays: UNCLAIMED_TTL_DAYS,
  claimedDays: CLAIMED_TTL_DAYS,
});
