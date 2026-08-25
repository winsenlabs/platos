import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { normalizeMemoryProfileKey } from "@platos/tenancy-database";
import { MessageCryptoService } from "../monitoring/message-crypto.service";
import { PRISMA_TOKEN, type ControlDatabaseClient } from "../shared/database.provider";
import { isEncryptedMetadataEnvelope } from "./memory-feedback-legacy";

interface ProfileCandidate {
  id: string;
  environmentId: string;
  endUserId: string;
  agentId: string;
  clusterId: string | null;
  metadata: unknown;
  updatedAt: Date;
}

/**
 * Finalizes the additive profileKey rollout before Nest starts accepting
 * requests. SQL cannot inspect encrypted metadata, so application crypto and
 * one serializable/advisory-locked transaction own the full transition.
 */
@Injectable()
export class MemoryProfileBackfillService implements OnModuleInit {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient,
    private readonly crypto: MessageCryptoService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.run();
  }

  async run(): Promise<{ profiles: number; deduplicated: number }> {
    return this.prisma.$transaction(async (tx: any) => {
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtextextended('MemoryProfileBackfillService:v1', 0))`,
      );
      const rows = await tx.$queryRawUnsafe(
        `SELECT "id", "environmentId", "endUserId", "agentId", "clusterId", "metadata", "updatedAt"
         FROM "Memory"
         WHERE "kind" = 'profile'
         ORDER BY "updatedAt" DESC, "id" DESC
         FOR UPDATE`,
      ) as ProfileCandidate[];

      const keyed = rows.flatMap((row) => {
        const metadata = this.crypto.decryptJsonField(row.metadata);
        if (isEncryptedMetadataEnvelope(row.metadata) && isEncryptedMetadataEnvelope(metadata)) {
          throw backfillError(
            "MEMORY_PROFILE_BACKFILL_DECRYPT_UNAVAILABLE",
            "encrypted profile metadata could not be decrypted",
          );
        }
        const profileKey = metadata && typeof metadata === "object" && !Array.isArray(metadata)
          ? (metadata as Record<string, unknown>).profileKey
          : undefined;
        if (typeof profileKey !== "string" || !profileKey.trim()) return [];
        return [{ row, profileKey: normalizeMemoryProfileKey(profileKey) }];
      });

      const winners = new Map<string, (typeof keyed)[number]>();
      const losers: Array<{ loserId: string; winnerId: string }> = [];
      for (const candidate of keyed) {
        const owner = candidate.row.clusterId
          ? `cluster:${candidate.row.clusterId}`
          : `agent:${candidate.row.agentId}`;
        const identity = [
          candidate.row.environmentId,
          candidate.row.endUserId,
          owner,
          candidate.profileKey,
        ].join(":");
        const winner = winners.get(identity);
        if (winner) losers.push({ loserId: candidate.row.id, winnerId: winner.row.id });
        else winners.set(identity, candidate);
      }

      for (const { loserId, winnerId } of losers) {
        await tx.$executeRawUnsafe(
          `UPDATE "MemoryRelationship" SET "sourceMemoryId" = $1::uuid WHERE "sourceMemoryId" = $2::uuid`,
          winnerId,
          loserId,
        );
      }
      if (losers.length) {
        await tx.$executeRawUnsafe(
          `DELETE FROM "Memory" WHERE "id" = ANY($1::uuid[])`,
          losers.map(({ loserId }) => loserId),
        );
      }

      for (const candidate of winners.values()) {
        await tx.$executeRawUnsafe(
          `UPDATE "Memory" SET "profileKey" = $1 WHERE "id" = $2::uuid`,
          candidate.profileKey,
          candidate.row.id,
        );
      }

      const validIds = Array.from(winners.values(), ({ row }) => row.id);
      if (validIds.length) {
        const missing = await tx.$queryRawUnsafe(
          `SELECT count(*)::int AS "count"
           FROM "Memory"
           WHERE "id" = ANY($1::uuid[]) AND "profileKey" IS NULL`,
          validIds,
        ) as Array<{ count: number }>;
        if (Number(missing[0]?.count ?? 0) !== 0) {
          throw backfillError(
            "MEMORY_PROFILE_BACKFILL_INCOMPLETE",
            "valid profile rows remain without normalized identity",
          );
        }
      }

      // These indexes are the prerequisite for MemoryService's partial-index
      // ON CONFLICT targets. They are installed only after all prior work and
      // verification has succeeded in this same atomic transaction.
      await tx.$executeRawUnsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS "Memory_profile_standalone_key"
         ON "Memory"("environmentId", "endUserId", "agentId", "profileKey")
         WHERE "kind" = 'profile' AND "clusterId" IS NULL AND "profileKey" IS NOT NULL`,
      );
      await tx.$executeRawUnsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS "Memory_profile_cluster_key"
         ON "Memory"("environmentId", "endUserId", "clusterId", "profileKey")
         WHERE "kind" = 'profile' AND "clusterId" IS NOT NULL AND "profileKey" IS NOT NULL`,
      );
      const indexes = await tx.$queryRawUnsafe(
        `SELECT
           index_class.relname AS "name",
           pg_index.indisunique AS "unique",
           pg_index.indisvalid AS "valid",
           ARRAY(
             SELECT attribute.attname
             FROM unnest(pg_index.indkey) WITH ORDINALITY AS key_column(attnum, position)
             JOIN pg_attribute attribute
               ON attribute.attrelid = pg_index.indrelid
              AND attribute.attnum = key_column.attnum
             ORDER BY key_column.position
           ) AS "columns",
           pg_get_expr(pg_index.indpred, pg_index.indrelid) AS "predicate"
         FROM pg_index
         JOIN pg_class index_class ON index_class.oid = pg_index.indexrelid
         WHERE index_class.relname IN (
           'Memory_profile_standalone_key',
           'Memory_profile_cluster_key'
         )
         ORDER BY index_class.relname`,
      ) as Array<{
        name: string;
        unique: boolean;
        valid: boolean;
        columns: string[];
        predicate: string | null;
      }>;
      if (!validProfileIndexes(indexes)) {
        throw backfillError(
          "MEMORY_PROFILE_INDEX_VALIDATION_FAILED",
          "profile uniqueness indexes are missing or do not match the required contract",
        );
      }

      return { profiles: keyed.length, deduplicated: losers.length };
    }, { isolationLevel: "Serializable", timeout: 120_000 });
  }
}

function validProfileIndexes(
  indexes: Array<{
    name: string;
    unique: boolean;
    valid: boolean;
    columns: string[];
    predicate: string | null;
  }>,
): boolean {
  const expected = new Map([
    ["Memory_profile_cluster_key", ["environmentId", "endUserId", "clusterId", "profileKey"]],
    ["Memory_profile_standalone_key", ["environmentId", "endUserId", "agentId", "profileKey"]],
  ]);
  if (indexes.length !== expected.size) return false;
  return indexes.every((index) => {
    const columns = expected.get(index.name);
    const predicate = index.predicate ?? "";
    return !!columns
      && index.unique
      && index.valid
      && JSON.stringify(index.columns) === JSON.stringify(columns)
      && /"?kind"?\s*=\s*'profile'(?:::text)?/.test(predicate)
      && predicate.includes('"profileKey" IS NOT NULL')
      && predicate.includes(index.name.includes("standalone")
        ? '"clusterId" IS NULL'
        : '"clusterId" IS NOT NULL');
  });
}

function backfillError(code: string, message: string): Error {
  const error = new Error(message);
  (error as any).code = code;
  return error;
}
