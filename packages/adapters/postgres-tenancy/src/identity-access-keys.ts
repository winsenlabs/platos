// `AccessKeyStore` — the environment access key, its rotation, and the fence
// that makes a revoke dominate a rotation it raced.
//
// THIS STORE WRITES A ROW IT DOES NOT OWN, LEGALLY. The revocation generation
// is `Environment.accessKeyRevocationVersion`, a column on a row ADR M0.3 §1
// assigns to `tenancy`. `revokeAll` increments it. That write is permitted
// because this directory is ALSO tenancy's canonical-store delegate
// (`CANONICAL_STORE_ADAPTERS` in scripts/arch/table-ownership.mjs), which is one
// of the reasons ADR M0.3 §15 puts both contexts' repositories in one directory:
// a separate identity-access adapter package could not have bumped the fence
// without writing a row it does not own.
//
// THE ROTATION DANCE IS FORCED BY A PARTIAL UNIQUE INDEX, and it is the single
// clearest example in this package of a rule that exists only in the migrations.
// `AccessKey_one_active_per_environment` is
//
//     UNIQUE (environmentId) WHERE revokedAt IS NULL AND validUntil IS NULL
//
// so at most one key per environment may be active at a time. A rotation has to
// bring a second key into existence while the first is still active, which the
// index forbids — unless the incoming key is inserted with a NON-NULL
// `validUntil` (invisible to the index), the outgoing key is then given its
// overlap end, and only THEN is the incoming key's `validUntil` set back to
// null. Three statements in one transaction where a naive implementation writes
// two. Neither `schema.prisma` nor the in-memory double carries that index, so
// neither would have shown the two-statement version failing.

import type {
  AccessKeyRecord,
  AccessKeyRotationPlan,
  EnvironmentId,
  TokenHash,
} from "@platos/context-identity-access/application/ports/index.js";
import type { AccessKeyStore } from "@platos/context-identity-access/application/ports/index.js";

import { requireDigest } from "./identity-guards.js";
import { toAccessKeyRecord } from "./identity-rows.js";
import type { TenancyTransactions } from "./transaction.js";

const KEY_COLUMNS = {
  id: true,
  environmentId: true,
  keyPrefix: true,
  keyHash: true,
  allowedOrigins: true,
  validUntil: true,
  replacedById: true,
  revokedAt: true,
  lastUsedAt: true,
} as const;

interface LockedEnvironment {
  readonly id: string;
  readonly accessKeyRevocationVersion: number;
}

export function createAccessKeyStore(transactions: TenancyTransactions): AccessKeyStore {
  return {
    async findActiveKey(environmentId: EnvironmentId): Promise<AccessKeyRecord | null> {
      const row = await transactions.reader().accessKey.findFirst({
        where: { environmentId, revokedAt: null, validUntil: null },
        select: KEY_COLUMNS,
      });
      return row === null ? null : toAccessKeyRecord(row);
    },

    async findByHash(
      environmentId: EnvironmentId,
      keyHash: TokenHash,
    ): Promise<AccessKeyRecord | null> {
      // Filtered on the environment as well as the hash, even though `keyHash`
      // is globally unique. A lookup by hash alone would answer for another
      // tenant's key when a caller passed the wrong environment, and the caller
      // would have no way to tell.
      const row = await transactions.reader().accessKey.findFirst({
        where: { environmentId, keyHash },
        select: KEY_COLUMNS,
      });
      return row === null ? null : toAccessKeyRecord(row);
    },

    async readRevocationGeneration(environmentId: EnvironmentId): Promise<number | null> {
      // WITHOUT the lock, and that is the point. It is snapshotted before the
      // rotation queues for the Environment row, so a revoke that starts
      // afterwards changes the generation and the rotation — which then sees a
      // different value UNDER the lock — refuses.
      const row = await transactions.reader().environment.findUnique({
        where: { id: environmentId },
        select: { accessKeyRevocationVersion: true },
      });
      return row === null ? null : row.accessKeyRevocationVersion;
    },

    async commitRotation(input: {
      readonly environmentId: EnvironmentId;
      readonly plan: AccessKeyRotationPlan;
      readonly observedGeneration: number;
    }): Promise<{ readonly committed: boolean; readonly generation: number }> {
      requireDigest("AccessKey.keyHash", input.plan.nextKey.keyHash);
      return transactions.atomic(async (client) => {
        // ONE string literal, not a concatenation. `scripts/arch/sole-writer.mjs`
        // reads raw SQL off the AST and can attribute a statement only when the
        // table name is written literally; text assembled at run time is
        // UNATTRIBUTABLE and no package may make it, which is the correct answer
        // for a rule about who may write which row.
        const locked = await client.$queryRawUnsafe<LockedEnvironment[]>(
          `SELECT "id", "accessKeyRevocationVersion" FROM "public"."Environment" WHERE "id" = $1::uuid FOR UPDATE`,
          input.environmentId,
        );
        const environment = locked[0];
        if (environment === undefined) return { committed: false, generation: -1 };
        const generation = environment.accessKeyRevocationVersion;
        // The fence. The comparison itself is the domain's
        // `assertGenerationUnchanged`; all this store does is observe the value
        // under the lock and report it, so the rule stays in the domain and only
        // the locking is here.
        if (generation !== input.observedGeneration) return { committed: false, generation };

        const { nextKey, retiringKey, overlapEndsAt } = input.plan;
        await client.accessKey.create({
          data: {
            id: nextKey.accessKeyId,
            environmentId: nextKey.environmentId,
            keyHash: nextKey.keyHash,
            keyPrefix: nextKey.keyPrefix,
            allowedOrigins: [...nextKey.allowedOrigins],
            // NON-NULL on insert, so the partial unique index does not see this
            // row while the outgoing key is still active. Set back to null at
            // the end of this transaction.
            validUntil: overlapEndsAt,
          },
        });
        if (retiringKey !== null) {
          await client.accessKey.update({
            where: { id: retiringKey.accessKeyId },
            data: { validUntil: retiringKey.validUntil, replacedById: nextKey.accessKeyId },
          });
        }
        await client.accessKey.update({
          where: { id: nextKey.accessKeyId },
          data: { validUntil: null },
        });
        return { committed: true, generation };
      });
    },

    async revokeAll(environmentId: EnvironmentId, now: Date): Promise<number> {
      return transactions.atomic(async (client) => {
        await client.$queryRawUnsafe<LockedEnvironment[]>(
          `SELECT "id", "accessKeyRevocationVersion" FROM "public"."Environment" WHERE "id" = $1::uuid FOR UPDATE`,
          environmentId,
        );
        // The increment comes BEFORE the revocation, under the same lock. A
        // rotation waiting on this lock will read the new generation, find it
        // different from its snapshot and refuse — so a revoke dominates every
        // rotation that observed an older generation, whether that rotation is
        // already queued or has not started.
        await client.environment.update({
          where: { id: environmentId },
          data: { accessKeyRevocationVersion: { increment: 1 } },
        });
        const result = await client.accessKey.updateMany({
          where: { environmentId, revokedAt: null },
          data: { revokedAt: now },
        });
        return result.count;
      });
    },
  };
}
