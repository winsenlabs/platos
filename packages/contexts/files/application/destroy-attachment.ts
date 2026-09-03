// The one place an attachment is destroyed.
//
// `domain/destruction.ts` states the rule; this is the only code that carries it
// out, so there is no second path that could get the order wrong. Blob first,
// row second, and a blob that would not go means the row STAYS — reported, never
// silently succeeded.
//
// Every caller that removes an attachment funnels through here: the retention
// sweep, the compensating rollback when an upload cannot be seeded, and the
// erasure target. Three call sites, one ordering.

import { ok, type Result, type TransactionScope } from "@platos/kernel";

import {
  BLOB_ALREADY_ABSENT,
  BLOB_DESTROYED,
  blobDestructionFailure,
  decideRowDestruction,
  destroyedReport,
  retainedReport,
  summarizeDestruction,
  toThreadScope,
  type Attachment,
  type BlobDestruction,
  type DestructionReport,
  type DestructionSummary,
} from "../domain/index.js";
import type { FilesDependencies } from "./dependencies.js";
import type { FilesRepository, ObjectStore } from "./ports/index.js";

async function destroyBlob(objectStore: ObjectStore, attachment: Attachment): Promise<BlobDestruction> {
  const deleted = await objectStore.delete(attachment.storageKey);
  if (!deleted.ok) return blobDestructionFailure(deleted.error);
  return deleted.value.existed ? BLOB_DESTROYED : BLOB_ALREADY_ABSENT;
}

/**
 * Destroy one attachment inside an already-open transaction.
 *
 * The blob step happens BEFORE the row step and is deliberately outside any
 * transactional guarantee, because no transaction spans Postgres and a bucket.
 * That asymmetry is the whole reason the order is fixed.
 */
export async function destroyAttachmentInTransaction(
  repository: FilesRepository,
  objectStore: ObjectStore,
  attachment: Attachment,
  transaction: TransactionScope,
): Promise<DestructionReport> {
  const blob = await destroyBlob(objectStore, attachment);
  const decision = decideRowDestruction(attachment.storageKey, blob);
  if (decision.decision === "retain-row") {
    return retainedReport(attachment.attachmentId, attachment.storageKey, blob, decision.error);
  }
  const deleted = await repository.deleteAttachment(
    toThreadScope(attachment.scope),
    attachment.attachmentId,
    transaction,
  );
  if (!deleted.ok) {
    return retainedReport(attachment.attachmentId, attachment.storageKey, blob, deleted.error);
  }
  return destroyedReport(attachment.attachmentId, attachment.storageKey, blob);
}

/** Destroy one attachment, opening a transaction of its own. */
export async function destroyAttachment(
  dependencies: FilesDependencies,
  attachment: Attachment,
): Promise<DestructionReport> {
  return dependencies.unitOfWork.run((transaction) =>
    destroyAttachmentInTransaction(dependencies.repository, dependencies.objectStore, attachment, transaction),
  );
}

export interface SweepElapsedAttachmentsCommand {
  /** Upper bound on rows examined in one pass. */
  readonly limit: number;
}

/**
 * The retention sweep.
 *
 * Returns a report per row rather than a count, because "swept 40, 3 blobs would
 * not go" is operationally different from "swept 37" and the second sentence is
 * the one an alert should fire on. A row whose blob refused to be destroyed is
 * still on the worklist next pass, its expiry unchanged, which is what makes the
 * sweep converge without bookkeeping.
 */
export async function sweepElapsedAttachments(
  dependencies: FilesDependencies,
  command: SweepElapsedAttachmentsCommand,
): Promise<Result<DestructionSummary>> {
  const asOf = dependencies.clock.now();
  const elapsed = await dependencies.repository.listElapsedAttachments(asOf, command.limit);
  if (!elapsed.ok) return elapsed;

  const reports: DestructionReport[] = [];
  for (const attachment of elapsed.value) {
    reports.push(await destroyAttachment(dependencies, attachment));
  }
  return ok(summarizeDestruction(reports));
}
