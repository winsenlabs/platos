// This context's implementation of the kernel `ErasureTarget` port.
//
// ADR M0.3 §3 hosts the port in the kernel precisely so that `privacy` never
// imports anyone and nobody implements a `privacy`-defined interface: each
// context implements it for the rows it is SOLE WRITER of, and the composition
// root injects the array. `files` is sole writer of `MessageAttachment` and
// `Artifact`, so those are the two plan items below and there are no others.
//
// METHOD, PER MODEL — the decision this file exists to record:
//
//   MessageAttachment -> delete. Its blob is destroyed through `ObjectStore`,
//     then its row goes. Anonymising is not on the table: the identifying
//     content is the BYTES, and no column rewrite touches them.
//
//   Artifact -> delete, NOT anonymize. `Artifact.content` is free-form text
//     stored inline in Postgres. Overwriting `createdBy` while leaving `content`
//     intact would be erasure theatre — if a subject's data is in an artifact at
//     all, it is in the content, and there is no column-level redaction that
//     removes it. Nothing holds a foreign key to an artifact that would need the
//     row to survive for referential truth, so the row is destroyed outright.
//
// BLOBS ARE DESTROYED BEFORE ROWS, even though `erase` runs inside the caller's
// transaction and a blob destruction cannot join it. `domain/destruction.ts`
// decides that asymmetry: a rolled-back erasure leaves rows pointing at
// destroyed blobs, which the retry finishes; the opposite order leaves the
// subject's BYTES in the bucket with no row pointing at them, which no sweep can
// find and which is the breach erasure exists to prevent.

import type {
  DomainError,
  ErasurePlan,
  ErasurePlanItem,
  ErasureReceipt,
  ErasureSubject,
  ErasureTarget,
  TransactionScope,
} from "@platos/kernel";

import { erasurePlanForeign, type Attachment } from "../domain/index.js";
import type { FilesDependencies } from "./dependencies.js";
import { destroyAttachmentInTransaction } from "./destroy-attachment.js";
import type { FilesErasureSelector } from "./ports/index.js";

export const FILES_ERASURE_TARGET_NAME = "files";
export const ATTACHMENT_MODEL = "MessageAttachment";
export const ARTIFACT_MODEL = "Artifact";

/**
 * Carries a `DomainError` out through a port whose signature has no failure
 * channel.
 *
 * `ErasureTarget.erase` returns `Promise<ErasureReceipt>`. A blob that would not
 * be destroyed must NOT produce a receipt claiming it was, so the only truthful
 * option is to reject — which also rolls the caller's transaction back, which is
 * the wanted outcome for a multi-context erasure.
 */
export class FilesErasureRejected extends Error {
  readonly domainError: DomainError;

  constructor(error: DomainError) {
    super(`${error.code}: ${error.message}`);
    this.name = "FilesErasureRejected";
    this.domainError = error;
  }
}

/**
 * The kernel's `ErasurePlan` carries `targetName` and `items` and NOTHING about
 * whose data it describes, so a stateless target handed a plan back cannot know
 * what to destroy. Rather than make the target stateful (a plan-id map that
 * leaks on every abandoned plan), the plan this target mints carries its subject
 * as a context-owned rider. It is still exactly an `ErasurePlan` to every other
 * reader, and a plan arriving without the rider is refused rather than guessed.
 */
export interface FilesErasurePlan extends ErasurePlan {
  readonly subject: ErasureSubject;
}

export function isFilesErasurePlan(plan: ErasurePlan): plan is FilesErasurePlan {
  return plan.targetName === FILES_ERASURE_TARGET_NAME && "subject" in plan;
}

/**
 * Translate a kernel subject into this context's columns.
 *
 * `MessageAttachment.endUserId` matches only an `end-user` subject.
 * `Artifact.createdBy` is a principal id, so it matches an operator `user` too.
 * An `entity` subject matches neither — this context owns no Entity-keyed row —
 * and reporting a zero-row plan is more honest than omitting the target from the
 * operation altogether.
 */
export function selectorFor(subject: ErasureSubject): FilesErasureSelector {
  if (subject.subjectKind === "end-user") {
    return { scope: subject.scope, endUserId: subject.subjectId, principalId: subject.subjectId };
  }
  if (subject.subjectKind === "user") {
    return { scope: subject.scope, endUserId: null, principalId: subject.subjectId };
  }
  return { scope: subject.scope, endUserId: null, principalId: null };
}

export function selectorIsVacuous(selector: FilesErasureSelector): boolean {
  return selector.endUserId === null && selector.principalId === null;
}

function planItem(model: string, rowCount: number): ErasurePlanItem {
  // `blockedBy` stays null: legal hold and retention policy are `privacy`'s to
  // evaluate against this plan (ADR M0.3 §1, context 18). This context reports
  // what it holds; it does not adjudicate whether it may go.
  return { model, method: "delete", rowCount, blockedBy: null };
}

function planFor(subject: ErasureSubject, attachments: number, artifacts: number): FilesErasurePlan {
  return {
    targetName: FILES_ERASURE_TARGET_NAME,
    subject,
    items: [planItem(ATTACHMENT_MODEL, attachments), planItem(ARTIFACT_MODEL, artifacts)],
  };
}

function refuse(error: DomainError): never {
  throw new FilesErasureRejected(error);
}

async function destroyAttachments(
  dependencies: FilesDependencies,
  attachments: readonly Attachment[],
  transaction: TransactionScope,
): Promise<number> {
  let destroyed = 0;
  for (const attachment of attachments) {
    const report = await destroyAttachmentInTransaction(
      dependencies.repository,
      dependencies.objectStore,
      attachment,
      transaction,
    );
    if (report.error !== null) refuse(report.error);
    destroyed += 1;
  }
  return destroyed;
}

async function buildPlan(dependencies: FilesDependencies, subject: ErasureSubject): Promise<FilesErasurePlan> {
  const selector = selectorFor(subject);
  if (selectorIsVacuous(selector)) return planFor(subject, 0, 0);
  const attachments = await dependencies.repository.countAttachmentsForSubject(selector);
  if (!attachments.ok) refuse(attachments.error);
  const artifacts = await dependencies.repository.countArtifactRevisionsForSubject(selector);
  if (!artifacts.ok) refuse(artifacts.error);
  return planFor(subject, attachments.value, artifacts.value);
}

async function carryOutPlan(
  dependencies: FilesDependencies,
  plan: ErasurePlan,
  transaction: TransactionScope,
): Promise<ErasureReceipt> {
  if (!isFilesErasurePlan(plan)) refuse(erasurePlanForeign(plan.targetName));
  const selector = selectorFor(plan.subject);
  if (selectorIsVacuous(selector)) {
    return { targetName: FILES_ERASURE_TARGET_NAME, erasedAt: dependencies.clock.now(), items: plan.items };
  }
  const attachments = await dependencies.repository.listAttachmentsForSubject(selector);
  if (!attachments.ok) refuse(attachments.error);
  const destroyed = await destroyAttachments(dependencies, attachments.value, transaction);
  const artifacts = await dependencies.repository.deleteArtifactRevisionsForSubject(selector, transaction);
  if (!artifacts.ok) refuse(artifacts.error);
  return {
    targetName: FILES_ERASURE_TARGET_NAME,
    erasedAt: dependencies.clock.now(),
    items: [planItem(ATTACHMENT_MODEL, destroyed), planItem(ARTIFACT_MODEL, artifacts.value)],
  };
}

export function createFilesErasureTarget(dependencies: FilesDependencies): ErasureTarget {
  return {
    targetName: FILES_ERASURE_TARGET_NAME,
    plan: (subject: ErasureSubject) => buildPlan(dependencies, subject),
    erase: (plan: ErasurePlan, transaction: TransactionScope) => carryOutPlan(dependencies, plan, transaction),
  };
}
