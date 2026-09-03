// Use case: bind pending attachments to the turn that used them.
//
// ALL-OR-NOTHING. If any id the caller named is not visible inside the owner
// boundary, nothing is bound. Binding the visible subset and reporting a partial
// success would let a caller probe for the existence of another owner's rows by
// difference, and would leave the turn's transcript half-recorded.
//
// Binding also extends retention: a pending upload lives on the short grace
// window so an abandoned one is collected quickly, and a bound one lives on the
// full retention window so the sweep does not collect it mid-conversation.
//
// Re-binding to the SAME turn is idempotent; binding to a DIFFERENT turn is a
// conflict (`domain/attachment.ts`). Delivery is at-least-once everywhere in
// this system, so an idempotent repeat must not fail.

import { err, ok, type Result, type TransactionScope } from "@platos/kernel";

import {
  admitTurnTotal,
  attachmentNotFound,
  bindAttachment,
  boundExpiry,
  type Attachment,
  type AttachmentId,
  type ThreadScope,
  type TurnId,
} from "../domain/index.js";
import type { FilesDependencies } from "./dependencies.js";

export interface BindAttachmentsCommand {
  readonly scope: ThreadScope;
  readonly attachmentIds: readonly AttachmentId[];
  readonly turnId: TurnId;
}

function distinct(ids: readonly AttachmentId[]): readonly AttachmentId[] {
  return [...new Set(ids)];
}

/** Fails closed on the first id the boundary did not return. */
function requireEveryId(
  requested: readonly AttachmentId[],
  found: readonly Attachment[],
): Result<readonly Attachment[]> {
  const visible = new Map(found.map((attachment) => [attachment.attachmentId, attachment]));
  const resolved: Attachment[] = [];
  for (const attachmentId of requested) {
    const attachment = visible.get(attachmentId);
    if (attachment === undefined) return err(attachmentNotFound(attachmentId));
    resolved.push(attachment);
  }
  return ok(resolved);
}

function bindAll(
  attachments: readonly Attachment[],
  turnId: TurnId,
  retainUntil: Date,
  now: Date,
): Result<readonly Attachment[]> {
  const bound: Attachment[] = [];
  for (const attachment of attachments) {
    const next = bindAttachment(attachment, turnId, retainUntil, now);
    if (!next.ok) return err(next.error);
    bound.push(next.value);
  }
  return ok(bound);
}

async function persistBindings(
  dependencies: FilesDependencies,
  bound: readonly Attachment[],
  transaction: TransactionScope,
): Promise<Result<readonly Attachment[]>> {
  const persisted: Attachment[] = [];
  for (const attachment of bound) {
    const saved = await dependencies.repository.updateAttachmentBinding(attachment, transaction);
    if (!saved.ok) return err(saved.error);
    persisted.push(saved.value);
  }
  return ok(persisted);
}

export async function bindAttachmentsToTurn(
  dependencies: FilesDependencies,
  command: BindAttachmentsCommand,
): Promise<Result<readonly Attachment[]>> {
  const requested = distinct(command.attachmentIds);
  if (requested.length === 0) return ok([]);

  const found = await dependencies.repository.findAttachmentsInScope(command.scope, requested);
  if (!found.ok) return err(found.error);

  const resolved = requireEveryId(requested, found.value);
  if (!resolved.ok) return err(resolved.error);

  const withinBudget = admitTurnTotal(resolved.value, dependencies.policy.upload);
  if (!withinBudget.ok) return err(withinBudget.error);

  const now = dependencies.clock.now();
  const bound = bindAll(resolved.value, command.turnId, boundExpiry(now, dependencies.policy.retention), now);
  if (!bound.ok) return err(bound.error);

  return dependencies.unitOfWork.run((transaction) => persistBindings(dependencies, bound.value, transaction));
}
