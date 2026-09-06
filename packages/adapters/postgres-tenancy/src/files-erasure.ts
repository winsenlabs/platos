// This context's half of the kernel `ErasureTarget`, over the two rows it is
// sole writer of.
//
// *** THE SELECTOR IS ADDRESSED BY CONTAINMENT, NOT BY EQUALITY ***
// `FilesErasureSelector.scope` is a `TenantScope` and not an `EnvironmentScope`,
// because an erasure may be addressed at a whole ORGANIZATION — and both of this
// context's tables are keyed by an environment underneath one. So the scope
// predicate below is written as three clauses that TURN THEMSELVES OFF: the
// organization clause always applies, and the project and environment clauses
// are skipped by a null parameter rather than by a different statement. One
// statement for all three levels is what keeps the measured statement count of
// an organization-wide erasure equal to that of an environment-wide one.
//
// *** THE TWO MODELS ARE MATCHED ON DIFFERENT COLUMNS, AND THAT IS THE ADR'S
// DECISION RATHER THAN THIS FILE'S *** `MessageAttachment.endUserId` is a
// `@db.Uuid` and matches only an end-user subject; `Artifact.createdBy` is a
// plain `TEXT` principal and matches an operator user too. A selector half that
// is null is answered WITHOUT A STATEMENT, which is both correct and the only
// honest reading: a subject this context holds no column for has zero rows here,
// and asking the database would be asking a question with a known answer.
//
// *** ATTACHMENTS ARE LISTED AND NOT DELETED HERE, AND THE PORT SAYS WHY ***
// There is no `deleteAttachmentsForSubject`. `files-erasure-target.ts` walks the
// list and destroys each row's BLOB through `ObjectStore` before removing the
// row through `deleteAttachment`, because `domain/destruction.ts` fixes that
// order: a rolled-back erasure leaves rows pointing at destroyed blobs, which a
// retry finishes, while the opposite order leaves the subject's bytes in the
// bucket with no row pointing at them. So the N+1 on that path is the CONTRACT,
// not a defect in this store, and `files-statements.integration.test.ts` pins it
// as `1 + 2 per row` with a small fixture and a large one to show which part
// grows and why.
//
// *** ARTIFACTS ARE DELETED IN ONE STATEMENT *** `deleteArtifactRevisionsForSubject`
// answers a COUNT, and the count has to be the number of rows that actually
// went. A `DELETE ... USING` names the two parent tables in the same statement,
// so the join that resolves containment and the delete that acts on it cannot
// disagree — and `scripts/arch/sole-writer.mjs` attributes the statement to
// `Artifact` by the table it names, exactly as it attributes a delegate call.

import type {
  Attachment,
  FilesErasureSelector,
  Result,
  TransactionScope,
} from "@platos/context-files/application/ports/index.js";
import { err, ok } from "@platos/context-files/application/ports/index.js";

import { ATTACHMENT_PROJECTION } from "./files-attachments.js";
import {
  requirePrincipal,
  requireTenantScopeShape,
  requireUuid,
} from "./files-guards.js";
import { refuseFiles } from "./files-refusal.js";
import { readAttachmentRow, type AttachmentRow } from "./files-rows.js";
import type { TenancyTransactions } from "./transaction.js";

/** The three ids the scope predicate binds, with the narrower two nullable. */
interface ScopeBindings {
  readonly organizationId: string;
  readonly projectId: string | null;
  readonly environmentId: string | null;
}

function scopeBindings(selector: FilesErasureSelector): ScopeBindings {
  const scope = selector.scope;
  return {
    organizationId: scope.organizationId,
    projectId: scope.level === "organization" ? null : scope.projectId,
    environmentId: scope.level === "environment" ? scope.environmentId : null,
  };
}

export interface FilesErasureStore {
  countAttachmentsForSubject(selector: FilesErasureSelector): Promise<Result<number>>;
  countArtifactRevisionsForSubject(selector: FilesErasureSelector): Promise<Result<number>>;
  listAttachmentsForSubject(selector: FilesErasureSelector): Promise<Result<readonly Attachment[]>>;
  deleteArtifactRevisionsForSubject(
    selector: FilesErasureSelector,
    transaction: TransactionScope,
  ): Promise<Result<number>>;
}

export function createFilesErasureStore(transactions: TenancyTransactions): FilesErasureStore {
  return {
    async countAttachmentsForSubject(selector) {
      return refuseFiles(async () => {
        requireTenantScopeShape(selector.scope);
        if (selector.endUserId === null) return ok(0);
        requireUuid("selector.endUserId", selector.endUserId);
        const bindings = scopeBindings(selector);
        const rows = await transactions.reader().$queryRawUnsafe<
          readonly { readonly matched: bigint }[]
        >(
          `SELECT count(*)::bigint AS "matched"
           FROM "public"."MessageAttachment" attachment
           LEFT JOIN "public"."Environment" environment ON environment."id" = attachment."environmentId"
           LEFT JOIN "public"."Project" project ON project."id" = environment."projectId"
           WHERE attachment."endUserId" = $1::uuid
             AND project."organizationId" = $2::uuid
             AND ($3::uuid IS NULL OR environment."projectId" = $3::uuid)
             AND ($4::uuid IS NULL OR attachment."environmentId" = $4::uuid)`,
          selector.endUserId,
          bindings.organizationId,
          bindings.projectId,
          bindings.environmentId,
        );
        return ok(Number(rows[0]?.matched ?? 0n));
      }, "countAttachmentsForSubject");
    },

    async countArtifactRevisionsForSubject(selector) {
      return refuseFiles(async () => {
        requireTenantScopeShape(selector.scope);
        if (selector.principalId === null) return ok(0);
        requirePrincipal("selector.principalId", selector.principalId);
        const bindings = scopeBindings(selector);
        const rows = await transactions.reader().$queryRawUnsafe<
          readonly { readonly matched: bigint }[]
        >(
          `SELECT count(*)::bigint AS "matched"
           FROM "public"."Artifact" artifact
           LEFT JOIN "public"."Environment" environment ON environment."id" = artifact."environmentId"
           LEFT JOIN "public"."Project" project ON project."id" = environment."projectId"
           WHERE artifact."createdBy" = $1
             AND project."organizationId" = $2::uuid
             AND ($3::uuid IS NULL OR environment."projectId" = $3::uuid)
             AND ($4::uuid IS NULL OR artifact."environmentId" = $4::uuid)`,
          selector.principalId,
          bindings.organizationId,
          bindings.projectId,
          bindings.environmentId,
        );
        return ok(Number(rows[0]?.matched ?? 0n));
      }, "countArtifactRevisionsForSubject");
    },

    async listAttachmentsForSubject(selector) {
      return refuseFiles(async () => {
        requireTenantScopeShape(selector.scope);
        if (selector.endUserId === null) return ok([]);
        requireUuid("selector.endUserId", selector.endUserId);
        const bindings = scopeBindings(selector);
        // UNBOUNDED BY CONTRACT. The port's own comment — "needed in full
        // because each row's blob must be destroyed individually" — is what
        // decides there is no limit here. A page would have made the plan's
        // count and the receipt's count two different numbers.
        const rows = await transactions.reader().$queryRawUnsafe<readonly AttachmentRow[]>(
          `SELECT ${ATTACHMENT_PROJECTION}
           WHERE attachment."endUserId" = $1::uuid
             AND project."organizationId" = $2::uuid
             AND ($3::uuid IS NULL OR environment."projectId" = $3::uuid)
             AND ($4::uuid IS NULL OR attachment."environmentId" = $4::uuid)
           ORDER BY attachment."createdAt" ASC, attachment."id" ASC`,
          selector.endUserId,
          bindings.organizationId,
          bindings.projectId,
          bindings.environmentId,
        );
        const attachments: Attachment[] = [];
        for (const row of rows) {
          const read = readAttachmentRow(row);
          if (!read.ok) return err(read.error);
          attachments.push(read.value);
        }
        return ok(attachments);
      }, "listAttachmentsForSubject");
    },

    async deleteArtifactRevisionsForSubject(selector, transaction) {
      return refuseFiles(async () => {
        requireTenantScopeShape(selector.scope);
        if (selector.principalId === null) return ok(0);
        requirePrincipal("selector.principalId", selector.principalId);
        const bindings = scopeBindings(selector);
        const removed = await transactions.writer(transaction).$executeRawUnsafe(
          `DELETE FROM "public"."Artifact" artifact
           USING "public"."Environment" environment, "public"."Project" project
           WHERE environment."id" = artifact."environmentId"
             AND project."id" = environment."projectId"
             AND artifact."createdBy" = $1
             AND project."organizationId" = $2::uuid
             AND ($3::uuid IS NULL OR environment."projectId" = $3::uuid)
             AND ($4::uuid IS NULL OR artifact."environmentId" = $4::uuid)`,
          selector.principalId,
          bindings.organizationId,
          bindings.projectId,
          bindings.environmentId,
        );
        return ok(removed);
      }, "deleteArtifactRevisionsForSubject");
    },
  };
}
