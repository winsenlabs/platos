// `Credential` — the vault record, over real PostgreSQL.
//
// THE ROW LOCK IS THE POINT OF THIS FILE. `loadForUpdate`'s port comment says
// two concurrent rotations of one credential "must serialise here or one
// plaintext is lost", and PostgreSQL's only way to say that is `SELECT … FOR
// UPDATE`, which the query builder cannot express at all. So the lock is raw
// SQL, resolved through `writer(scope)` rather than `reader()`, because
// `FOR UPDATE` is TRANSACTION-scoped: taken on a pooled connection with no
// transaction open it is released the instant the statement returns, the call
// succeeds, every test passes, and the race is wide open. `writer(scope)`
// refuses three ways instead.
//
// IT DOES NOT FILTER `revokedAt`, AND THE EXTRACTION SOURCE DOES.
// `findLockedActiveCredential` in internal-packages/tenancy-database/src/secrets.ts
// locks `WHERE … AND "revokedAt" IS NULL` and answers null otherwise. The
// EXTRACTED port does not: `rotate-credential.ts` loads, then checks
// `current.credential.revokedAt !== null` and answers `credential_revoked`, and
// `revoke-credential.ts` loads a credential it is about to revoke. Copying the
// source's clause here would turn both into `credential_not_found` — a different
// refusal, on a credential that exists. The clause belongs to the use case now,
// and this reads the row it is asked for.
//
// TWO STATEMENTS, NOT ONE JOIN. The lock and the active envelope are separate
// reads because `FOR UPDATE` cannot lock the nullable side of an outer join, and
// the alternative — `FOR UPDATE OF credential` across the join — re-evaluates
// only the LOCKED relation when it unblocks, so the joined envelope would come
// from the snapshot taken before the wait. Two statements under one lock is what
// the extraction source does and it is what is correct.

import type {
  Credential,
  CredentialDraft,
  CredentialId,
  CredentialQuery,
  CredentialWithActiveVersion,
  EnvironmentId,
  Result,
  SecretVersionId,
  TransactionScope,
} from "@platos/context-secrets/application/ports/index.js";
import {
  credentialNameTaken,
  credentialUnavailable,
  err,
  ok,
} from "@platos/context-secrets/application/ports/index.js";

import { isUniqueViolation } from "./client.js";
import { requireInstant, requireUuid, requireUuidOrNull } from "./secrets-guards.js";
import type { CredentialRow, SecretVersionRow } from "./secrets-rows.js";
import {
  CREDENTIAL_COLUMNS,
  SECRET_VERSION_COLUMNS,
  readCredential,
  readSecretVersion,
} from "./secrets-rows.js";
import type { TenancyTransactions } from "./transaction.js";

/** The credential half of `SecretsRepository`. Composed in `secrets-repository.ts`. */
export interface SecretsCredentialStore {
  findCredential(query: CredentialQuery): Promise<Result<CredentialWithActiveVersion | null>>;
  loadForUpdate(
    environmentId: EnvironmentId,
    credentialId: CredentialId,
    transaction: TransactionScope,
  ): Promise<Result<CredentialWithActiveVersion | null>>;
  listCredentials(
    environmentId: EnvironmentId,
  ): Promise<Result<readonly CredentialWithActiveVersion[]>>;
  insertCredential(
    draft: CredentialDraft,
    transaction: TransactionScope,
  ): Promise<Result<Credential>>;
  setActiveSecretVersion(
    credentialId: CredentialId,
    secretVersionId: SecretVersionId | null,
    at: Date,
    transaction: TransactionScope,
  ): Promise<Result<Credential>>;
  revokeCredential(
    credentialId: CredentialId,
    revokedAt: Date,
    transaction: TransactionScope,
  ): Promise<Result<Credential>>;
}

interface CredentialWithVersionRow extends CredentialRow {
  readonly activeSecretVersion: SecretVersionRow | null;
}

const WITH_ACTIVE_VERSION = {
  ...CREDENTIAL_COLUMNS,
  activeSecretVersion: { select: SECRET_VERSION_COLUMNS },
} as const;

function pair(row: CredentialWithVersionRow): CredentialWithActiveVersion {
  return {
    credential: readCredential(row),
    activeSecretVersion:
      row.activeSecretVersion === null ? null : readSecretVersion(row.activeSecretVersion),
  };
}

/**
 * The columns a repoint and a revoke are allowed to write.
 *
 * FOUR COLUMNS ARE FROZEN ON UPDATE and none of them may appear here.
 * `Credential_owner_immutable` fires BEFORE UPDATE over `environmentId`, `kind`,
 * `name` and `provider`, so a repoint carrying any of them — even unchanged,
 * even as a convenience — would be one edit away from raising SQLSTATE 23514 on
 * a statement whose purpose has nothing to do with ownership.
 */
interface CredentialPatch {
  readonly activeSecretVersionId?: string | null;
  readonly revokedAt?: Date;
  readonly updatedAt: Date;
}

export function createSecretsCredentialStore(
  transactions: TenancyTransactions,
): SecretsCredentialStore {
  /**
   * One conditional UPDATE, reported as the row or as its absence.
   *
   * `update()` raises P2025 for a missing row and both callers owe their caller
   * a `Result` instead, so the absence is turned into `null` here — once —
   * rather than in two catch blocks that could drift apart.
   */
  const patch = async (
    credentialId: CredentialId,
    transaction: TransactionScope,
    data: CredentialPatch,
  ): Promise<Credential | null> => {
    const rows = (await transactions.writer(transaction).credential.updateManyAndReturn({
      where: { id: requireUuid("Credential.id", credentialId) },
      data,
      select: CREDENTIAL_COLUMNS,
    })) as readonly CredentialRow[];
    const row = rows[0];
    return row === undefined ? null : readCredential(row);
  };

  return {
    async findCredential(query) {
      // The double's `matches` requires `revokedAt === null`, and so does the
      // extraction source's `findActiveCredential`. A revoked credential is not
      // findable by name: that is what lets a name be reused after a revoke
      // without `[environmentId, kind, name]` having to be dropped.
      const row = (await transactions.reader().credential.findFirst({
        where: {
          environmentId: query.environmentId,
          revokedAt: null,
          ...(query.credentialId === undefined ? {} : { id: query.credentialId }),
          ...(query.name === undefined ? {} : { name: query.name }),
          ...(query.provider === undefined ? {} : { provider: query.provider }),
          ...(query.kind === undefined ? {} : { kind: query.kind }),
        },
        // TOTAL, because `findFirst` over an unordered relation answers with
        // whichever row the planner reached. Every query a use case issues names
        // either the id or the `[kind, name]` pair, so the order is unobservable
        // there — and a future caller filtering on `provider` alone would
        // otherwise get a different credential on a second call with no row
        // having changed.
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: WITH_ACTIVE_VERSION,
      })) as CredentialWithVersionRow | null;
      return ok(row === null ? null : pair(row));
    },

    async loadForUpdate(environmentId, credentialId, transaction) {
      const client = transactions.writer(transaction);
      // The identifiers are CAST rather than trusted: `uuid = text` has no
      // operator in PostgreSQL, so an uncast parameter fails with a type error
      // rather than matching nothing.
      const locked = await client.$queryRaw<readonly CredentialRow[]>`
        SELECT
          "id", "environmentId", "activeSecretVersionId", "kind", "name", "prefix",
          "secretHash", "encryptedReference", "permissions", "allowedOrigins",
          "provider", "externalClientId", "expiresAt", "lastUsedAt", "revokedAt",
          "createdBy", "createdAt", "updatedAt"
        FROM "public"."Credential"
        WHERE "id" = ${requireUuid("Credential.id", credentialId)}::uuid
          AND "environmentId" = ${requireUuid("Credential.environmentId", environmentId)}::uuid
        FOR UPDATE
      `;
      // `=== 1`, not `> 0`. The primary key makes more than one row impossible,
      // and saying so is how a reader knows this is "the row is there" and not a
      // truthiness test that would also accept a future query returning several.
      if (locked.length !== 1) return ok(null);
      const row = locked[0] as CredentialRow;
      if (row.activeSecretVersionId === null) {
        return ok({ credential: readCredential(row), activeSecretVersion: null });
      }
      const version = (await client.credentialSecretVersion.findUnique({
        where: { id: row.activeSecretVersionId },
        select: SECRET_VERSION_COLUMNS,
      })) as SecretVersionRow | null;
      return ok({
        credential: readCredential(row),
        activeSecretVersion: version === null ? null : readSecretVersion(version),
      });
    },

    async listCredentials(environmentId) {
      // NO `revokedAt` FILTER, and the double has none either: this is the
      // operator's inventory, and a revoked credential an operator cannot see is
      // one nobody knows is still holding a retired envelope.
      //
      // `name` ASCENDING is the extraction source's order. It is the DATABASE's
      // collation rather than the double's `localeCompare`, and the two agree on
      // the ASCII every fixture uses and `EnvironmentVariable_key_check` demands
      // one row over.
      const rows = (await transactions.reader().credential.findMany({
        where: { environmentId },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        select: WITH_ACTIVE_VERSION,
      })) as readonly CredentialWithVersionRow[];
      return ok(rows.map(pair));
    },

    async insertCredential(draft, transaction) {
      const createdAt = requireInstant("Credential.createdAt", draft.createdAt);
      try {
        const row = (await transactions.writer(transaction).credential.create({
          data: {
            id: requireUuid("Credential.id", draft.id),
            environmentId: requireUuid("Credential.environmentId", draft.environmentId),
            kind: draft.kind,
            name: draft.name,
            provider: draft.provider,
            createdBy: draft.createdBy,
            createdAt,
            // `@updatedAt` would stamp the wall clock. The draft carries ONE
            // instant and the double writes it to both columns, so a row created
            // through either store has `createdAt === updatedAt` and a caller can
            // tell "never changed" from "changed in the same millisecond it was
            // made" — which it could not if this store used a second clock.
            updatedAt: createdAt,
          },
          select: CREDENTIAL_COLUMNS,
        })) as CredentialRow;
        return ok(readCredential(row));
      } catch (error) {
        // `Credential_environmentId_kind_name_key`. The double refuses the same
        // triple with the same domain error, so the two stores answer a taken
        // name identically instead of one refusing and the other raising.
        if (isUniqueViolation(error)) return err(credentialNameTaken());
        throw error;
      }
    },

    async setActiveSecretVersion(credentialId, secretVersionId, at, transaction) {
      const row = await patch(credentialId, transaction, {
        activeSecretVersionId: requireUuidOrNull(
          "Credential.activeSecretVersionId",
          secretVersionId,
        ),
        updatedAt: requireInstant("Credential.updatedAt", at),
      });
      return row === null ? err(credentialUnavailable("credential_not_found")) : ok(row);
    },

    async revokeCredential(credentialId, revokedAt, transaction) {
      const at = requireInstant("Credential.revokedAt", revokedAt);
      // The double stamps `updatedAt` with the revocation instant, and so does
      // this: a revoke IS the last change to the row.
      const row = await patch(credentialId, transaction, { revokedAt: at, updatedAt: at });
      return row === null ? err(credentialUnavailable("credential_not_found")) : ok(row);
    },
  };
}
