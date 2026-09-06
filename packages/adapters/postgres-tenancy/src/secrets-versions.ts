// `CredentialSecretVersion` and `CredentialAudit` — the envelope's whole
// lifecycle and the evidence of it, over real PostgreSQL.
//
// THREE THINGS THE DATABASE DOES THAT NO DOUBLE CAN.
//
//   THE ENVELOPE IS IMMUTABLE. `CredentialSecretVersion_envelope_immutable`
//   fires BEFORE UPDATE and refuses any change to `credentialId`,
//   `secretRevision`, `formatVersion`, `rootKeyVersion`, `salt`, `nonce`,
//   `ciphertext`, `authTag` or `createdAt`. `retireSecretVersion` therefore
//   writes EXACTLY TWO columns, and it is the only UPDATE this file issues.
//
//   THE AUDIT ROW IS APPEND-ONLY. Three rules refuse UPDATE, DELETE and
//   TRUNCATE, and UPDATE/DELETE/TRUNCATE are revoked from PUBLIC on top. There
//   is nothing here but an INSERT because there is nothing else the table
//   permits — which is what makes "an unauditable mutation does not happen"
//   enforceable rather than aspirational.
//
//   THE PURGE RE-CHECKS EVERY CLAUSE INSIDE THE DELETE. The port says so in as
//   many words, and the reason is that `listPurgeCandidates` and
//   `purgeSecretVersion` are separate calls: between them a rotation can make a
//   candidate active again. `Credential_activeSecretVersionId_id_fkey` is ON
//   DELETE RESTRICT, so the database would refuse that delete with SQLSTATE
//   23503 — an exception, mid-batch, with the transaction already poisoned. The
//   `IS DISTINCT FROM` clause turns the same fact into a ZERO-ROW result, which
//   the use case reads as "the world changed" and rolls the batch back on
//   purpose.
//
// WHY `listPurgeCandidates` AND `purgeSecretVersion` ARE RAW SQL. The first
// needs `FOR UPDATE OF version` over a join — unexpressible in the query builder
// — so the candidates it hands out cannot be retired or repointed by anyone else
// for the rest of the transaction. The second needs `DELETE … USING` so the
// eligibility clauses that live on `Credential` are evaluated in the SAME
// statement as the delete; two statements would be the race again, one level
// down.

import type {
  CredentialAuditDraft,
  CredentialId,
  CredentialSecretVersion,
  CredentialSecretVersionDraft,
  EnvironmentId,
  Result,
  RetiredSecretVersionCandidate,
  RootKeyUsage,
  RootKeyVersion,
  SecretRevision,
  SecretVersionId,
  TransactionScope,
} from "@platos/context-secrets/application/ports/index.js";
import {
  asSecretsIdentifier,
  credentialUnavailable,
  err,
  ok,
  secretVersionAlreadyExists,
} from "@platos/context-secrets/application/ports/index.js";

import { isUniqueViolation } from "./client.js";
import {
  ENVELOPE_AUTH_TAG_BYTES,
  ENVELOPE_NONCE_BYTES,
  ENVELOPE_SALT_BYTES,
  requireAuditOrdinal,
  requireEnvelopeBytes,
  requireEnvelopeOrdinal,
  requireInstant,
  requireInstantOrNull,
  requirePurgeLimit,
  requireUuid,
} from "./secrets-guards.js";
import type { SecretVersionRow } from "./secrets-rows.js";
import { SECRET_VERSION_COLUMNS, readRootKeyUsage, readSecretVersion } from "./secrets-rows.js";
import type { TenancyTransactions } from "./transaction.js";

/** The envelope and evidence half of `SecretsRepository`. */
export interface SecretsVersionStore {
  listPurgeCandidates(
    cutoff: Date,
    limit: number,
    transaction: TransactionScope,
  ): Promise<Result<readonly RetiredSecretVersionCandidate[]>>;
  countVersionsByRootKey(): Promise<Result<readonly RootKeyUsage[]>>;
  insertSecretVersion(
    draft: CredentialSecretVersionDraft,
    transaction: TransactionScope,
  ): Promise<Result<CredentialSecretVersion>>;
  retireSecretVersion(
    secretVersionId: SecretVersionId,
    retiredAt: Date,
    readableUntil: Date | null,
    transaction: TransactionScope,
  ): Promise<Result<CredentialSecretVersion>>;
  purgeSecretVersion(
    candidate: RetiredSecretVersionCandidate,
    cutoff: Date,
    transaction: TransactionScope,
  ): Promise<Result<number>>;
  appendAudit(draft: CredentialAuditDraft, transaction: TransactionScope): Promise<Result<void>>;
}

interface CandidateRow {
  readonly id: string;
  readonly credentialId: string;
  readonly environmentId: string;
  readonly secretRevision: number;
  readonly rootKeyVersion: number;
}

export function createSecretsVersionStore(
  transactions: TenancyTransactions,
): SecretsVersionStore {
  return {
    async listPurgeCandidates(cutoff, limit, transaction) {
      const at = requireInstant("CredentialSecretVersion.retiredAt", cutoff);
      const bound = requirePurgeLimit(limit);
      const rows = await transactions.writer(transaction).$queryRaw<readonly CandidateRow[]>`
        SELECT
          version."id",
          version."credentialId",
          credential."environmentId",
          version."secretRevision",
          version."rootKeyVersion"
        FROM "public"."CredentialSecretVersion" AS version
        INNER JOIN "public"."Credential" AS credential
          ON credential."id" = version."credentialId"
        WHERE version."retiredAt" IS NOT NULL
          AND version."retiredAt" <= ${at}
          AND (version."readableUntil" IS NULL OR version."readableUntil" <= ${at})
          AND credential."activeSecretVersionId" IS DISTINCT FROM version."id"
        ORDER BY version."createdAt" ASC, version."id" ASC
        LIMIT ${bound}
        FOR UPDATE OF version
      `;
      // The order is the domain's `purgeOrder` — oldest first, ties broken by
      // id — spelled as SQL rather than sorted afterwards, because `LIMIT`
      // without a total order takes an arbitrary subset and a second call would
      // take a different one.
      return ok(
        rows.map(
          (row): RetiredSecretVersionCandidate => ({
            secretVersionId: asSecretsIdentifier<SecretVersionId>(row.id),
            credentialId: asSecretsIdentifier<CredentialId>(row.credentialId),
            environmentId: asSecretsIdentifier<EnvironmentId>(row.environmentId),
            secretRevision: row.secretRevision as SecretRevision,
            rootKeyVersion: row.rootKeyVersion as RootKeyVersion,
          }),
        ),
      );
    },

    async countVersionsByRootKey() {
      // INSTALLATION-WIDE, across every tenant, and that is the port's contract:
      // "unpurged envelope counts per root key version, across every tenant". It
      // answers `canRemoveRootKey`, which is an operator's question about a KEY,
      // not a tenant's question about a credential.
      //
      // ONE `GROUP BY`, not one count per version. A loop over the ring would be
      // an N+1 whose length is the number of root keys — small today and
      // unbounded by anything — and it could not see a version whose key has
      // already left the ring, which is exactly the row an operator needs to know
      // about.
      const buckets = await transactions.reader().credentialSecretVersion.groupBy({
        by: ["rootKeyVersion"],
        _count: { _all: true },
      });
      return ok(
        buckets.map((bucket) =>
          readRootKeyUsage({
            rootKeyVersion: bucket.rootKeyVersion,
            unpurgedVersionCount: bucket._count._all,
          }),
        ),
      );
    },

    async insertSecretVersion(draft, transaction) {
      try {
        const row = (await transactions.writer(transaction).credentialSecretVersion.create({
          data: {
            id: requireUuid("CredentialSecretVersion.id", draft.id),
            credentialId: requireUuid("CredentialSecretVersion.credentialId", draft.credentialId),
            secretRevision: requireEnvelopeOrdinal(
              "CredentialSecretVersion.secretRevision",
              draft.secretRevision,
            ),
            formatVersion: requireEnvelopeOrdinal(
              "CredentialSecretVersion.formatVersion",
              draft.formatVersion,
            ),
            rootKeyVersion: requireEnvelopeOrdinal(
              "CredentialSecretVersion.rootKeyVersion",
              draft.rootKeyVersion,
            ),
            salt: requireEnvelopeBytes(
              "CredentialSecretVersion.salt",
              draft.salt,
              ENVELOPE_SALT_BYTES,
            ),
            nonce: requireEnvelopeBytes(
              "CredentialSecretVersion.nonce",
              draft.nonce,
              ENVELOPE_NONCE_BYTES,
            ),
            // `ciphertext` carries NO width rule, in the migration or here. It is
            // as long as the plaintext was, and a guard inventing a bound would
            // be stricter than the column.
            ciphertext: draft.ciphertext,
            authTag: requireEnvelopeBytes(
              "CredentialSecretVersion.authTag",
              draft.authTag,
              ENVELOPE_AUTH_TAG_BYTES,
            ),
            createdAt: requireInstant("CredentialSecretVersion.createdAt", draft.createdAt),
          },
          select: SECRET_VERSION_COLUMNS,
        })) as SecretVersionRow;
        return ok(readSecretVersion(row));
      } catch (error) {
        // `CredentialSecretVersion_credentialId_secretRevision_rootKey_key`. The
        // key includes `rootKeyVersion` ON PURPOSE — that is what lets a rewrap
        // write the SAME revision under a new key — so this refusal means a
        // genuine duplicate rather than a re-encryption.
        if (isUniqueViolation(error)) return err(secretVersionAlreadyExists());
        throw error;
      }
    },

    async retireSecretVersion(secretVersionId, retiredAt, readableUntil, transaction) {
      // TWO COLUMNS. Everything else on this row is frozen by
      // `CredentialSecretVersion_envelope_immutable`, and writing a third here —
      // even the same value it already holds — raises SQLSTATE 23514.
      const rows = (await transactions
        .writer(transaction)
        .credentialSecretVersion.updateManyAndReturn({
          where: { id: requireUuid("CredentialSecretVersion.id", secretVersionId) },
          data: {
            retiredAt: requireInstant("CredentialSecretVersion.retiredAt", retiredAt),
            readableUntil: requireInstantOrNull(
              "CredentialSecretVersion.readableUntil",
              readableUntil,
            ),
          },
          select: SECRET_VERSION_COLUMNS,
        })) as readonly SecretVersionRow[];
      const row = rows[0];
      // The double answers `secret_version_retired` for a version it cannot find,
      // and so does this: nine reasons collapse to one code by design, and a
      // store that minted a tenth would re-open the probing oracle
      // `domain/errors.ts` exists to close.
      return row === undefined
        ? err(credentialUnavailable("secret_version_retired"))
        : ok(readSecretVersion(row));
    },

    async purgeSecretVersion(candidate, cutoff, transaction) {
      const at = requireInstant("CredentialSecretVersion.retiredAt", cutoff);
      const rows = await transactions.writer(transaction).$queryRaw<readonly { id: string }[]>`
        DELETE FROM "public"."CredentialSecretVersion" AS version
        USING "public"."Credential" AS credential
        WHERE version."id" = ${requireUuid(
          "CredentialSecretVersion.id",
          candidate.secretVersionId,
        )}::uuid
          AND version."credentialId" = ${requireUuid(
            "CredentialSecretVersion.credentialId",
            candidate.credentialId,
          )}::uuid
          AND credential."id" = version."credentialId"
          AND version."retiredAt" IS NOT NULL
          AND version."retiredAt" <= ${at}
          AND (version."readableUntil" IS NULL OR version."readableUntil" <= ${at})
          AND credential."activeSecretVersionId" IS DISTINCT FROM version."id"
        RETURNING version."id"
      `;
      // The COUNT, not a boolean. The use case treats anything other than one as
      // "the world changed underneath the candidate list" and rolls the whole
      // batch back, so a store that answered `true`/`false` would have thrown
      // away the distinction between "nothing matched" and "something matched
      // twice" — and the second is impossible only while the primary key holds.
      return ok(rows.length);
    },

    async appendAudit(draft, transaction) {
      await transactions.writer(transaction).credentialAudit.create({
        data: {
          id: requireUuid("CredentialAudit.id", draft.id),
          environmentId: requireUuid("CredentialAudit.environmentId", draft.environmentId),
          credentialId: requireUuid("CredentialAudit.credentialId", draft.credentialId),
          action: draft.action,
          outcome: draft.outcome,
          actorType: draft.actorType,
          actorId: draft.actorId,
          effectiveUserId: draft.effectiveUserId,
          secretRevision: requireAuditOrdinal("CredentialAudit.secretRevision", draft.secretRevision),
          fromRootKeyVersion: requireAuditOrdinal(
            "CredentialAudit.fromRootKeyVersion",
            draft.fromRootKeyVersion,
          ),
          toRootKeyVersion: requireAuditOrdinal(
            "CredentialAudit.toRootKeyVersion",
            draft.toRootKeyVersion,
          ),
          createdAt: requireInstant("CredentialAudit.createdAt", draft.createdAt),
        },
        // The narrowest projection the client will issue. Nothing reads an audit
        // row back through this port, so selecting the whole row would be bytes
        // crossing the wire for no reader.
        select: { id: true },
      });
      return ok(undefined);
    },
  };
}
