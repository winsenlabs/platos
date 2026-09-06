// The `MessageAttachment` half — a POINTER at a blob, and every rule about it
// that lives in the database rather than in `schema.prisma`.
//
// *** THREE RULES GOVERN THIS TABLE AND NONE OF THEM IS IN THE MODEL ***
//
//   MessageAttachment_ancestry         BEFORE INSERT OR UPDATE. The end user must
//                                      belong to the environment's ORGANIZATION,
//                                      the agent to its PROJECT, and the thread
//                                      must carry the same environment, the same
//                                      end user AND the same agent. So an
//                                      attachment cannot be filed against
//                                      somebody else's thread — and the
//                                      in-memory double creates one happily,
//                                      because an attachment there is a record
//                                      with ids in it and no tree behind it.
//
//   MessageAttachment_owner_immutable  BEFORE UPDATE. `environmentId`,
//                                      `endUserId`, `agentId` and `threadId` may
//                                      not move. Ever.
//
//   MessageAttachment_binding_one_way  BEFORE UPDATE. Once `turnId` is set it may
//                                      not change — INCLUDING back to NULL. The
//                                      domain's `bindAttachment` refuses a
//                                      re-bind to a DIFFERENT turn; the database
//                                      also refuses an UNBIND, which no rule in
//                                      the domain expresses.
//
// *** WHY `updateAttachmentBinding` IS AN `updateMany` WITH THE OWNER IN ITS
// `WHERE` *** The port hands the store a WHOLE `Attachment`, so the value it is
// given carries an owner as well as a binding — and a caller that mutated the
// owner would be asking for a row move that
// `MessageAttachment_owner_immutable` refuses with a 23514 naming a column and
// not a port. Writing only `turnId` and `expiresAt` would be worse: the changed
// owner would be silently ignored and the caller would be told the write
// succeeded. So the owner columns are in the WHERE. A mismatch matches no row,
// the count comes back zero, and the store answers `FILES_ATTACHMENT_NOT_FOUND`
// — which is the truthful answer, because no attachment with THAT owner and
// THAT id exists.
//
// *** EVERY READ IS ONE STATEMENT AND EVERY READ IS RAW *** Both halves of this
// aggregate's identity — the `EnvironmentScope` and the two owner columns — are
// three ids the row does not hold, and the delegate spelling
// (`messageAttachment.findUnique` selecting
// `environment: { projectId, project: { organizationId } }`) is THREE round
// trips, because the client loads each relation level as its own query. That is
// two extra round trips on a path the inbound turn calls before it can do
// anything. Every statement below is a static tagged template with interpolated
// VALUES only, so `scripts/arch/sole-writer.mjs` can still attribute it and it
// names no table it does not read.

import type {
  Attachment,
  AttachmentId,
  ContentHash,
  EnvironmentScope,
  OrganizationScope,
  Result,
  ThreadScope,
  TransactionScope,
} from "@platos/context-files/application/ports/index.js";
import {
  attachmentNotFound,
  attachmentTurnId,
  err,
  ok,
} from "@platos/context-files/application/ports/index.js";

import { requireAncestry } from "./files-ancestry.js";
import {
  requireInstant,
  requireInt32,
  requireOptionalInstant,
  requireOptionalInt32,
  requireOptionalStorableText,
  requireOptionalUuid,
  requireScopeShape,
  requireStorableText,
  requireUuid,
} from "./files-guards.js";
import { refuseFiles } from "./files-refusal.js";
import {
  readAttachmentRow,
  readTotalBytes,
  type AttachmentRow,
} from "./files-rows.js";
import type { TenancyTransactions } from "./transaction.js";

/**
 * The columns every read of this table projects, with the environment's two
 * parents joined on.
 *
 * A `const` rather than repeated text so the six reads here and the one in
 * `files-erasure.ts` cannot drift apart in a column, and so a column added by a
 * later migration is added once.
 *
 * `LEFT JOIN` AND NOT `JOIN`, WHICH IS A DECISION AND NOT A HABIT. With
 * `MessageAttachment_environmentId_fkey` and `Environment_projectId_fkey` in
 * force, an attachment whose environment does not resolve to a project and an
 * organization is UNREACHABLE from a live database — so an inner join would
 * never drop a row, and the two spellings are indistinguishable in production.
 * They are not indistinguishable in the TYPE: the outer join is what makes
 * `projectId: string | null` the honest shape of the row, which is what forces
 * `readAttachmentRow` to answer the question rather than assume it. The refusal
 * it produces is falsifiable at the mapping boundary — `files-rows.test.ts`
 * hands it a row with a null parent and watches it refuse — and this comment is
 * the record that it is not falsifiable through a statement while those two
 * foreign keys stand.
 */
export const ATTACHMENT_PROJECTION = `
  attachment."id", attachment."environmentId", environment."projectId",
  project."organizationId", attachment."endUserId", attachment."agentId",
  attachment."threadId", attachment."turnId", attachment."kind",
  attachment."mimeType", attachment."bytes", attachment."width",
  attachment."height", attachment."durationSec", attachment."storageKey",
  attachment."originalName", attachment."contentHash", attachment."createdAt",
  attachment."expiresAt"
  FROM "public"."MessageAttachment" attachment
  LEFT JOIN "public"."Environment" environment ON environment."id" = attachment."environmentId"
  LEFT JOIN "public"."Project" project ON project."id" = environment."projectId"`;

/** Every read of many rows, mapped or refused on the first row that will not read. */
function readAll(rows: readonly AttachmentRow[]): Result<readonly Attachment[]> {
  const attachments: Attachment[] = [];
  for (const row of rows) {
    const read = readAttachmentRow(row);
    if (!read.ok) return err(read.error);
    attachments.push(read.value);
  }
  return ok(attachments);
}

export interface AttachmentStore {
  insertAttachment(attachment: Attachment, transaction: TransactionScope): Promise<Result<Attachment>>;
  findAttachment(scope: ThreadScope, attachmentId: AttachmentId): Promise<Result<Attachment | null>>;
  findAttachmentsInScope(
    scope: ThreadScope,
    attachmentIds: readonly AttachmentId[],
  ): Promise<Result<readonly Attachment[]>>;
  findAttachmentByContentHash(
    environment: EnvironmentScope,
    contentHash: ContentHash,
  ): Promise<Result<Attachment | null>>;
  sumAttachmentBytes(scope: OrganizationScope): Promise<Result<number>>;
  listElapsedAttachments(asOf: Date, limit: number): Promise<Result<readonly Attachment[]>>;
  updateAttachmentBinding(
    attachment: Attachment,
    transaction: TransactionScope,
  ): Promise<Result<Attachment>>;
  deleteAttachment(
    scope: ThreadScope,
    attachmentId: AttachmentId,
    transaction: TransactionScope,
  ): Promise<Result<boolean>>;
}

export function createAttachmentStore(transactions: TenancyTransactions): AttachmentStore {
  /** The shape half of a scoped read, before a statement is sent. */
  function admitThreadScope(scope: ThreadScope): void {
    requireScopeShape(scope.environment);
    requireUuid("scope.threadId", scope.threadId);
  }

  return {
    async insertAttachment(attachment, transaction) {
      return refuseFiles(async () => {
        const scope = attachment.scope;
        requireScopeShape(scope.environment);
        requireUuid("MessageAttachment.threadId", scope.threadId);
        requireUuid("MessageAttachment.id", attachment.attachmentId);
        requireUuid("MessageAttachment.endUserId", scope.owner.endUserId);
        requireUuid("MessageAttachment.agentId", scope.owner.agentId);
        requireOptionalUuid("MessageAttachment.turnId", attachmentTurnId(attachment));
        requireStorableText("MessageAttachment.kind", attachment.kind);
        requireStorableText("MessageAttachment.mimeType", attachment.mimeType);
        requireStorableText("MessageAttachment.storageKey", attachment.storageKey);
        requireOptionalStorableText("MessageAttachment.originalName", attachment.originalName);
        requireOptionalStorableText("MessageAttachment.contentHash", attachment.contentHash);
        requireInt32("MessageAttachment.bytes", attachment.bytes, 0);
        requireOptionalInt32("MessageAttachment.width", attachment.media.width, 0);
        requireOptionalInt32("MessageAttachment.height", attachment.media.height, 0);
        requireOptionalInt32("MessageAttachment.durationSec", attachment.media.durationSeconds, 0);
        requireInstant("MessageAttachment.createdAt", attachment.createdAt);
        requireOptionalInstant("MessageAttachment.expiresAt", attachment.expiresAt);
        // The CLAIM about the environment's parents, which no database rule
        // checks. See `files-ancestry.ts` for what a forged one would cost.
        await requireAncestry(transactions.writer(transaction), scope.environment);
        await transactions.writer(transaction).messageAttachment.create({
          data: {
            id: attachment.attachmentId,
            environmentId: scope.environment.environmentId,
            endUserId: scope.owner.endUserId,
            agentId: scope.owner.agentId,
            threadId: scope.threadId,
            turnId: attachmentTurnId(attachment),
            kind: attachment.kind,
            mimeType: attachment.mimeType,
            bytes: attachment.bytes,
            width: attachment.media.width,
            height: attachment.media.height,
            durationSec: attachment.media.durationSeconds,
            storageKey: attachment.storageKey,
            originalName: attachment.originalName,
            contentHash: attachment.contentHash,
            createdAt: attachment.createdAt,
            expiresAt: attachment.expiresAt,
          },
          select: { id: true },
        });
        return ok(attachment);
      }, "insertAttachment");
    },

    async findAttachment(scope, attachmentId) {
      return refuseFiles(async () => {
        admitThreadScope(scope);
        requireUuid("attachmentId", attachmentId);
        const rows = await transactions.reader().$queryRawUnsafe<readonly AttachmentRow[]>(
          `SELECT ${ATTACHMENT_PROJECTION}
           WHERE attachment."id" = $1::uuid
             AND attachment."threadId" = $2::uuid
             AND attachment."environmentId" = $3::uuid
             AND environment."projectId" = $4::uuid
             AND project."organizationId" = $5::uuid`,
          attachmentId,
          scope.threadId,
          scope.environment.environmentId,
          scope.environment.projectId,
          scope.environment.organizationId,
        );
        const row = rows[0];
        if (row === undefined) return ok(null);
        return readAttachmentRow(row);
      }, "findAttachment");
    },

    async findAttachmentsInScope(scope, attachmentIds) {
      return refuseFiles(async () => {
        admitThreadScope(scope);
        for (const attachmentId of attachmentIds) requireUuid("attachmentId", attachmentId);
        // An empty list is answered without a statement. `= ANY('{}')` is a
        // correct query that returns nothing, and sending it would make the
        // measured statement count of a no-op read one rather than zero.
        if (attachmentIds.length === 0) return ok([]);
        // THE LIST TRAVELS AS DELIMITED TEXT, NOT AS AN ARRAY — the shape
        // `memory-vectors.ts` in this package already settled. A JavaScript
        // array bound into a statement depends on the driver's array
        // serialisation; one `text` parameter re-split in SQL depends on
        // nothing. Every element has already passed `requireUuid`, so none of
        // them can contain the delimiter.
        const rows = await transactions.reader().$queryRawUnsafe<readonly AttachmentRow[]>(
          `SELECT ${ATTACHMENT_PROJECTION}
           WHERE attachment."id" = ANY(string_to_array($1, ',')::uuid[])
             AND attachment."threadId" = $2::uuid
             AND attachment."environmentId" = $3::uuid
             AND environment."projectId" = $4::uuid
             AND project."organizationId" = $5::uuid
           ORDER BY attachment."createdAt" ASC, attachment."id" ASC`,
          attachmentIds.join(","),
          scope.threadId,
          scope.environment.environmentId,
          scope.environment.projectId,
          scope.environment.organizationId,
        );
        return readAll(rows);
      }, "findAttachmentsInScope");
    },

    async findAttachmentByContentHash(environment, contentHash) {
      return refuseFiles(async () => {
        requireScopeShape(environment);
        requireStorableText("contentHash", contentHash);
        // ORDERED AND LIMITED, and the order is not decoration. `contentHash`
        // carries no unique index — the probe is "has this environment already
        // stored these bytes", and several rows may answer yes. The port's
        // signature is `Attachment | null`, so SOMETHING has to decide which,
        // and an unordered `LIMIT 1` would let the plan decide: two calls, two
        // answers, and a dedupe that copies a different blob each time.
        const rows = await transactions.reader().$queryRawUnsafe<readonly AttachmentRow[]>(
          `SELECT ${ATTACHMENT_PROJECTION}
           WHERE attachment."contentHash" = $1
             AND attachment."environmentId" = $2::uuid
             AND environment."projectId" = $3::uuid
             AND project."organizationId" = $4::uuid
           ORDER BY attachment."createdAt" ASC, attachment."id" ASC
           LIMIT 1`,
          contentHash,
          environment.environmentId,
          environment.projectId,
          environment.organizationId,
        );
        const row = rows[0];
        if (row === undefined) return ok(null);
        return readAttachmentRow(row);
      }, "findAttachmentByContentHash");
    },

    async sumAttachmentBytes(scope) {
      return refuseFiles(async () => {
        requireUuid("scope.organizationId", scope.organizationId);
        // ONE statement over every environment of every project of the
        // organization, and `COALESCE` rather than a null check in TypeScript
        // because `sum()` over no rows is SQL NULL and a quota input of `null`
        // is not zero, it is a crash one layer up.
        const rows = await transactions.reader().$queryRaw<readonly { readonly total: bigint }[]>`
          SELECT COALESCE(SUM(attachment."bytes"), 0)::bigint AS "total"
          FROM "public"."MessageAttachment" attachment
          JOIN "public"."Environment" environment ON environment."id" = attachment."environmentId"
          JOIN "public"."Project" project ON project."id" = environment."projectId"
          WHERE project."organizationId" = ${scope.organizationId}::uuid`;
        const total = rows[0];
        if (total === undefined) return ok(0);
        return readTotalBytes(total.total, `sumAttachmentBytes/${scope.organizationId}`);
      }, "sumAttachmentBytes");
    },

    async listElapsedAttachments(asOf, limit) {
      return refuseFiles(async () => {
        requireInstant("asOf", asOf);
        requireInt32("limit", limit, 0);
        if (limit === 0) return ok([]);
        // ONE PREDICATE AND NOT TWO. `expiresAt IS NOT NULL` was here and is
        // gone: a comparison against SQL NULL is NULL, so a row retained
        // indefinitely is excluded by `<=` already. A redundant clause is not a
        // guard — nothing can falsify it — and one standing beside a real guard
        // makes the real one look like a pair.
        //
        // UNSCOPED BY DESIGN. The retention sweep is an installation-wide job:
        // the port takes no scope, and a row whose environment was deleted
        // between the write and the sweep still has a blob to destroy. The
        // parents are LEFT-joined for exactly that reason, and a row that
        // cannot resolve them is refused by `readAttachmentRow` rather than
        // read with guessed ones.
        const rows = await transactions.reader().$queryRawUnsafe<readonly AttachmentRow[]>(
          `SELECT ${ATTACHMENT_PROJECTION}
           WHERE attachment."expiresAt" <= $1
           ORDER BY attachment."createdAt" ASC, attachment."id" ASC
           LIMIT $2::int`,
          asOf,
          limit,
        );
        return readAll(rows);
      }, "listElapsedAttachments");
    },

    async updateAttachmentBinding(attachment, transaction) {
      return refuseFiles(async () => {
        const scope = attachment.scope;
        requireScopeShape(scope.environment);
        requireUuid("MessageAttachment.threadId", scope.threadId);
        requireUuid("MessageAttachment.id", attachment.attachmentId);
        requireUuid("MessageAttachment.endUserId", scope.owner.endUserId);
        requireUuid("MessageAttachment.agentId", scope.owner.agentId);
        requireOptionalUuid("MessageAttachment.turnId", attachmentTurnId(attachment));
        requireOptionalInstant("MessageAttachment.expiresAt", attachment.expiresAt);
        const changed = await transactions.writer(transaction).messageAttachment.updateMany({
          // THE OWNER IS IN THE `WHERE`, NOT IN THE `DATA`. See the header: the
          // four owner columns are immutable in the database, so a caller that
          // moved one must be told no rather than have the move dropped.
          where: {
            id: attachment.attachmentId,
            environmentId: scope.environment.environmentId,
            endUserId: scope.owner.endUserId,
            agentId: scope.owner.agentId,
            threadId: scope.threadId,
          },
          data: { turnId: attachmentTurnId(attachment), expiresAt: attachment.expiresAt },
        });
        if (changed.count === 0) return err(attachmentNotFound(attachment.attachmentId));
        return ok(attachment);
      }, "updateAttachmentBinding");
    },

    async deleteAttachment(scope, attachmentId, transaction) {
      return refuseFiles(async () => {
        admitThreadScope(scope);
        requireUuid("attachmentId", attachmentId);
        // The organization and project halves of the scope are NOT in this
        // WHERE and cannot be: `MessageAttachment` holds neither column, and the
        // delegate API cannot filter a delete through a relation. They are
        // proved instead by the ancestry re-assertion, which is one statement
        // and runs first — so a caller holding a forged scope is refused before
        // any row is removed rather than after.
        await requireAncestry(transactions.writer(transaction), scope.environment);
        const removed = await transactions.writer(transaction).messageAttachment.deleteMany({
          where: { id: attachmentId, threadId: scope.threadId, environmentId: scope.environment.environmentId },
        });
        return ok(removed.count > 0);
      }, "deleteAttachment");
    },
  };
}
