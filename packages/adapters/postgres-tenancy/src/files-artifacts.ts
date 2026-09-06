// The `Artifact` half — a VERSIONED INLINE DOCUMENT, and the one write in this
// package whose refusal the port names in advance.
//
// *** THE APPEND-ONLY UNIQUE IS THE POINT OF THIS FILE ***
// `@@unique([threadId, artifactKey, revision])` is what makes "revise this
// artifact" structurally unable to mean "update that row", and
// `files-repository.ts`'s port comment is explicit about what an implementation
// owes it: "an implementation MUST surface a violation as
// `FILES_ARTIFACT_REVISION_CONFLICT` and MUST NOT convert the insert into an
// update or retry at the next free revision."
//
// SO THE INSERT CARRIES `ON CONFLICT ... DO NOTHING RETURNING "id"`, AND THAT IS
// NOT A STYLE CHOICE. On PostgreSQL a violated unique aborts the WHOLE
// transaction, not the statement: a caller that appended a revision, lost the
// race and then wrote an outbox row in the same unit of work would meet 25P02
// rather than the conflict, and the SECOND failure would be the one it reported.
// `DO NOTHING` turns the race into a row count — zero means the slot was taken —
// so the conflict is a `Result` the caller can act on inside a transaction that
// is still usable, which is the whole reason the guards in `files-guards.ts`
// refuse before a statement rather than after one.
//
// IT IS ALSO THE ONLY SPELLING WITH NO WINDOW IN IT. `domain/artifact-revision.ts`
// already reads the occupant and refuses through `admitRevisionSlot`, but that
// read and this write are two statements with a gap between them, and the
// interesting failure is exactly another writer landing in the gap — the case
// the in-memory double ships a `hookAfterLatestLookup` seam for. A store that
// pre-checked again would have added a second statement to the same race rather
// than closing it. The index closes it.
//
// *** `Artifact_ancestry` IS THE RULE THAT IS NOT IN `schema.prisma` ***
// BEFORE INSERT OR UPDATE: the thread must be IN the row's environment, and
// `producedByTurnId`, when present, must be a turn OF THAT THREAD. The
// in-memory double checks neither — an artifact there is a record with ids in it
// and no tree behind it.
//
// *** `metadata` TRAVELS AS TEXT AND IS CAST ***. It is bound as one `text`
// parameter and cast with `::jsonb`, which is what lets `null` mean SQL NULL
// here. The delegate API has TWO nulls for a nullable `Json` column — `DbNull`
// and `JsonNull` — and `client.ts` records that reaching for the second writes
// the JSON scalar `null`, whose `jsonb_typeof` is `'null'` and which
// `Artifact_metadata_json_root` then refuses. A text parameter has one null.

import type {
  ArtifactKey,
  ArtifactRevision,
  Result,
  ThreadScope,
  TransactionScope,
} from "@platos/context-files/application/ports/index.js";
import {
  artifactRevisionConflict,
  err,
  ok,
} from "@platos/context-files/application/ports/index.js";

import { requireAncestry } from "./files-ancestry.js";
import {
  requireInstant,
  requireInt32,
  requireJsonObject,
  requireOptionalStorableText,
  requireOptionalUuid,
  requirePrincipal,
  requireScopeShape,
  requireStorableText,
  requireUuid,
} from "./files-guards.js";
import { refuseFiles } from "./files-refusal.js";
import { readArtifactRow, type ArtifactRow } from "./files-rows.js";
import type { TenancyTransactions } from "./transaction.js";

/**
 * The columns every read of this table projects, with the environment's two
 * parents joined on.
 *
 * `LEFT JOIN` and not `JOIN`, so an environment that has lost its project is a
 * row this store REFUSES rather than a row it silently cannot see.
 */
const ARTIFACT_PROJECTION = `
  artifact."id", artifact."environmentId", environment."projectId",
  project."organizationId", artifact."threadId", artifact."producedByTurnId",
  artifact."artifactKey", artifact."revision", artifact."kind", artifact."title",
  artifact."mimeType", artifact."content", artifact."metadata",
  artifact."createdBy", artifact."createdAt"
  FROM "public"."Artifact" artifact
  LEFT JOIN "public"."Environment" environment ON environment."id" = artifact."environmentId"
  LEFT JOIN "public"."Project" project ON project."id" = environment."projectId"`;

export interface ArtifactStore {
  findLatestArtifactRevision(
    scope: ThreadScope,
    artifactKey: ArtifactKey,
  ): Promise<Result<ArtifactRevision | null>>;
  findArtifactRevision(
    scope: ThreadScope,
    artifactKey: ArtifactKey,
    revision: number,
  ): Promise<Result<ArtifactRevision | null>>;
  insertArtifactRevision(
    revision: ArtifactRevision,
    transaction: TransactionScope,
  ): Promise<Result<ArtifactRevision>>;
}

export function createArtifactStore(transactions: TenancyTransactions): ArtifactStore {
  function admitThreadScope(scope: ThreadScope): void {
    requireScopeShape(scope.environment);
    requireUuid("scope.threadId", scope.threadId);
  }

  return {
    async findLatestArtifactRevision(scope, artifactKey) {
      return refuseFiles(async () => {
        admitThreadScope(scope);
        requireStorableText("artifactKey", artifactKey);
        // ORDER BY revision DESC, not by `createdAt`. Two revisions written in
        // the same millisecond TIE on `timestamp(3)`, and the newest revision is
        // a fact about the number the append-only rule counts, not about a clock.
        const rows = await transactions.reader().$queryRawUnsafe<readonly ArtifactRow[]>(
          `SELECT ${ARTIFACT_PROJECTION}
           WHERE artifact."threadId" = $1::uuid
             AND artifact."artifactKey" = $2
             AND artifact."environmentId" = $3::uuid
             AND environment."projectId" = $4::uuid
             AND project."organizationId" = $5::uuid
           ORDER BY artifact."revision" DESC
           LIMIT 1`,
          scope.threadId,
          artifactKey,
          scope.environment.environmentId,
          scope.environment.projectId,
          scope.environment.organizationId,
        );
        const row = rows[0];
        if (row === undefined) return ok(null);
        return readArtifactRow(row);
      }, "findLatestArtifactRevision");
    },

    async findArtifactRevision(scope, artifactKey, revision) {
      return refuseFiles(async () => {
        admitThreadScope(scope);
        requireStorableText("artifactKey", artifactKey);
        requireInt32("revision", revision, 1);
        const rows = await transactions.reader().$queryRawUnsafe<readonly ArtifactRow[]>(
          `SELECT ${ARTIFACT_PROJECTION}
           WHERE artifact."threadId" = $1::uuid
             AND artifact."artifactKey" = $2
             AND artifact."revision" = $3::int
             AND artifact."environmentId" = $4::uuid
             AND environment."projectId" = $5::uuid
             AND project."organizationId" = $6::uuid`,
          scope.threadId,
          artifactKey,
          revision,
          scope.environment.environmentId,
          scope.environment.projectId,
          scope.environment.organizationId,
        );
        const row = rows[0];
        if (row === undefined) return ok(null);
        return readArtifactRow(row);
      }, "findArtifactRevision");
    },

    async insertArtifactRevision(revision, transaction) {
      return refuseFiles(async () => {
        const scope = revision.scope;
        requireScopeShape(scope.environment);
        requireUuid("Artifact.threadId", scope.threadId);
        requireUuid("Artifact.id", revision.artifactId);
        requireOptionalUuid("Artifact.producedByTurnId", revision.producedByTurnId);
        requireStorableText("Artifact.artifactKey", revision.artifactKey);
        requireStorableText("Artifact.kind", revision.kind);
        requireStorableText("Artifact.content", revision.content);
        requireOptionalStorableText("Artifact.title", revision.title);
        requireOptionalStorableText("Artifact.mimeType", revision.mimeType);
        requirePrincipal("Artifact.createdBy", revision.createdBy);
        requireInt32("Artifact.revision", revision.revision, 1);
        requireInstant("Artifact.createdAt", revision.createdAt);
        if (revision.metadata !== null) requireJsonObject("Artifact.metadata", revision.metadata);
        const metadata = revision.metadata === null ? null : JSON.stringify(revision.metadata);
        const writer = transactions.writer(transaction);
        await requireAncestry(writer, scope.environment);
        const written = await writer.$queryRaw<readonly { readonly id: string }[]>`
          INSERT INTO "public"."Artifact" (
            "id", "environmentId", "threadId", "producedByTurnId", "artifactKey",
            "revision", "kind", "title", "mimeType", "content", "metadata",
            "createdBy", "createdAt"
          ) VALUES (
            ${revision.artifactId}::uuid,
            ${scope.environment.environmentId}::uuid,
            ${scope.threadId}::uuid,
            ${revision.producedByTurnId}::uuid,
            ${revision.artifactKey},
            ${revision.revision}::int,
            ${revision.kind},
            ${revision.title},
            ${revision.mimeType},
            ${revision.content},
            ${metadata}::jsonb,
            ${revision.createdBy},
            ${revision.createdAt}
          )
          ON CONFLICT ("threadId", "artifactKey", "revision") DO NOTHING
          RETURNING "id"`;
        // ZERO ROWS IS THE CONFLICT, and it is the only thing zero rows can be:
        // the statement has no WHERE, so the row was either inserted or refused
        // by the one index this table's identity is.
        if (written.length === 0) {
          return err(artifactRevisionConflict(revision.artifactKey, revision.revision));
        }
        return ok(revision);
      }, "insertArtifactRevision");
    },
  };
}
