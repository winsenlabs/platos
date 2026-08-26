import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "../generated/control";

const DEFAULT_ROTATION_OVERLAP_MS = 10 * 60_000;

export const ACCESS_KEY_SAFE_SELECT = {
  id: true,
  environmentId: true,
  keyPrefix: true,
  allowedOrigins: true,
  lastUsedAt: true,
  validUntil: true,
  replacedById: true,
  revokedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AccessKeySelect;

export type SafeAccessKey = Prisma.AccessKeyGetPayload<{
  select: typeof ACCESS_KEY_SAFE_SELECT;
}>;

export interface AccessKeyRotationResult {
  key: SafeAccessKey;
  retiringKey: SafeAccessKey | null;
}

async function readRevocationVersion(database: PrismaClient, environmentId: string) {
  const environment = await database.environment.findUnique({
    where: { id: environmentId },
    select: { accessKeyRevocationVersion: true },
  });
  if (!environment) throw new Error("access_key_store_unavailable");
  return environment.accessKeyRevocationVersion;
}

async function lockEnvironment(
  tx: Prisma.TransactionClient,
  environmentId: string
): Promise<{ id: string; accessKeyRevocationVersion: number }> {
  const environment = await tx.$queryRaw<
    Array<{ id: string; accessKeyRevocationVersion: number }>
  >(Prisma.sql`
    SELECT "id", "accessKeyRevocationVersion"
    FROM "public"."Environment"
    WHERE "id" = ${environmentId}::uuid
    FOR UPDATE
  `);
  if (environment.length !== 1) throw new Error("access_key_store_unavailable");
  return environment[0]!;
}

/**
 * Rotates the hash-only Environment access key under an Environment row lock.
 * The temporary expired state is transaction-local and permits the database's
 * partial unique index to enforce one active key throughout the transition.
 */
export async function rotateAccessKey(
  database: PrismaClient,
  input: {
    environmentId: string;
    keyHash: string;
    keyPrefix: string;
    overlapMs?: number;
  }
): Promise<AccessKeyRotationResult> {
  const overlapMs = input.overlapMs ?? DEFAULT_ROTATION_OVERLAP_MS;
  if (
    !/^[a-f0-9]{64}$/.test(input.keyHash) ||
    !/^platos_live_[A-Za-z0-9_-]{1,12}$/.test(input.keyPrefix) ||
    !Number.isSafeInteger(overlapMs) ||
    overlapMs <= 0
  ) {
    throw new Error("invalid_access_key_material");
  }

  // Snapshot the persisted revocation generation before waiting for the
  // Environment lock. A revoke that starts after this rotation increments the
  // generation under that same lock and therefore supersedes this request.
  const revocationVersion = await readRevocationVersion(database, input.environmentId);

  return database.$transaction(async (tx) => {
    const environment = await lockEnvironment(tx, input.environmentId);
    if (environment.accessKeyRevocationVersion !== revocationVersion) {
      throw new Error("access_key_rotation_superseded");
    }

    const replayedKey = await tx.accessKey.findFirst({
      where: {
        environmentId: input.environmentId,
        keyHash: input.keyHash,
        revokedAt: null,
        validUntil: null,
      },
      select: ACCESS_KEY_SAFE_SELECT,
    });
    if (replayedKey) {
      const retiringKey = await tx.accessKey.findFirst({
        where: {
          environmentId: input.environmentId,
          revokedAt: null,
          replacedById: replayedKey.id,
        },
        select: ACCESS_KEY_SAFE_SELECT,
      });
      return { key: replayedKey, retiringKey };
    }

    const now = new Date();
    const validUntil = new Date(now.getTime() + overlapMs);
    const active = await tx.accessKey.findFirst({
      where: { environmentId: input.environmentId, revokedAt: null, validUntil: null },
      select: ACCESS_KEY_SAFE_SELECT,
    });

    if (!active) {
      const key = await tx.accessKey.create({
        data: {
          environmentId: input.environmentId,
          keyHash: input.keyHash,
          keyPrefix: input.keyPrefix,
        },
        select: ACCESS_KEY_SAFE_SELECT,
      });
      return { key, retiringKey: null };
    }

    const nextId = randomUUID();
    await tx.accessKey.create({
      data: {
        id: nextId,
        environmentId: input.environmentId,
        keyHash: input.keyHash,
        keyPrefix: input.keyPrefix,
        allowedOrigins: active.allowedOrigins,
        validUntil: now,
      },
    });
    const retiringKey = await tx.accessKey.update({
      where: { id: active.id },
      data: { validUntil, replacedById: nextId },
      select: ACCESS_KEY_SAFE_SELECT,
    });
    const key = await tx.accessKey.update({
      where: { id: nextId },
      data: { validUntil: null },
      select: ACCESS_KEY_SAFE_SELECT,
    });
    return { key, retiringKey };
  });
}

/** Replace origins on the active key while serialized with rotation/revoke. */
export async function setAccessKeyAllowedOrigins(
  database: PrismaClient,
  input: { environmentId: string; origins: string[] }
): Promise<number> {
  return database.$transaction(async (tx) => {
    await lockEnvironment(tx, input.environmentId);
    const result = await tx.accessKey.updateMany({
      where: {
        environmentId: input.environmentId,
        revokedAt: null,
        validUntil: null,
      },
      data: { allowedOrigins: input.origins },
    });
    return result.count;
  });
}

/**
 * Revoke dominates every rotation that observed an older generation, whether
 * that rotation currently owns the Environment lock or is already waiting.
 */
export async function revokeAccessKeys(
  database: PrismaClient,
  input: { environmentId: string }
): Promise<number> {
  return database.$transaction(async (tx) => {
    await lockEnvironment(tx, input.environmentId);
    await tx.environment.update({
      where: { id: input.environmentId },
      data: { accessKeyRevocationVersion: { increment: 1 } },
    });
    const result = await tx.accessKey.updateMany({
      where: { environmentId: input.environmentId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  });
}
