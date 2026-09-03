// The `MessageAttachment` aggregate — a pointer at a blob.
//
// The row owns no bytes. It owns an address (`storageKey`), the facts a caller
// needs before deciding to fetch those bytes (`bytes`, `mimeType`, the optional
// media dimensions), an owner, a binding, and an expiry. Everything expensive
// lives behind `ObjectStore`.
//
// ON `kind` AND `mimeType`. The baseline schema declares both as free-form
// `String`; neither is an enum, and this module does not invent one. `kind` is
// `string`, with the four values the current classifier produces exported as
// named constants so callers can spell them without a type narrowing the column.
// A caller-supplied `kind` is taken verbatim. `mimeType` is validated for SHAPE
// only — the existing type/subtype pattern and length cap — never against a list.

import { err, ok, type Result } from "@platos/kernel";

import { attachmentBindingConflict, attachmentRetentionElapsed } from "./errors.js";
import type { AttachmentId, ContentHash, StorageKey, TurnId } from "./identifiers.js";
import type { AttachmentScope } from "./scope.js";

/**
 * Open by construction: the column is `String`. These constants are the four
 * values the classifier produces, not the permitted set.
 */
export type AttachmentKind = string;

export const ATTACHMENT_KIND_IMAGE = "image";
export const ATTACHMENT_KIND_AUDIO = "audio";
export const ATTACHMENT_KIND_VIDEO = "video";
export const ATTACHMENT_KIND_DOCUMENT = "document";

/** The fallback when a caller supplies no `kind`, keyed off the media type. */
export function classifyAttachmentKind(mimeType: string): AttachmentKind {
  const normalized = mimeType.toLowerCase();
  if (normalized.startsWith("image/")) return ATTACHMENT_KIND_IMAGE;
  if (normalized.startsWith("audio/")) return ATTACHMENT_KIND_AUDIO;
  if (normalized.startsWith("video/")) return ATTACHMENT_KIND_VIDEO;
  return ATTACHMENT_KIND_DOCUMENT;
}

/**
 * `turnId` is nullable in the schema, and the two states it distinguishes have
 * different rules, so it is a union here rather than a nullable field. "Is this
 * bound?" becomes a question the checker answers.
 */
export type AttachmentBinding =
  | { readonly state: "pending" }
  | { readonly state: "bound"; readonly turnId: TurnId };

export const PENDING_BINDING: AttachmentBinding = Object.freeze({ state: "pending" });

export function boundTo(turnId: TurnId): AttachmentBinding {
  return { state: "bound", turnId };
}

/** The three optional media columns, grouped so they travel together. */
export interface AttachmentMedia {
  readonly width: number | null;
  readonly height: number | null;
  readonly durationSeconds: number | null;
}

export const NO_MEDIA_DIMENSIONS: AttachmentMedia = Object.freeze({
  width: null,
  height: null,
  durationSeconds: null,
});

export interface Attachment {
  readonly attachmentId: AttachmentId;
  readonly scope: AttachmentScope;
  readonly binding: AttachmentBinding;
  readonly kind: AttachmentKind;
  readonly mimeType: string;
  readonly bytes: number;
  readonly media: AttachmentMedia;
  readonly storageKey: StorageKey;
  readonly originalName: string | null;
  readonly contentHash: ContentHash | null;
  readonly createdAt: Date;
  /** Null means "retained indefinitely"; the schema column is nullable. */
  readonly expiresAt: Date | null;
}

export function attachmentTurnId(attachment: Attachment): TurnId | null {
  return attachment.binding.state === "bound" ? attachment.binding.turnId : null;
}

/** Expiry is a comparison against an injected instant, never the wall clock. */
export function attachmentRetentionHasElapsed(attachment: Attachment, now: Date): boolean {
  if (attachment.expiresAt === null) return false;
  return attachment.expiresAt.getTime() <= now.getTime();
}

/**
 * Bind an attachment to the turn that used it, and push its expiry out to the
 * bound-retention window so the sweep does not collect it mid-conversation.
 *
 * Re-binding to the SAME turn is idempotent: a redelivered request must not
 * fail. Binding to a DIFFERENT turn is a conflict — the row is a per-turn
 * transcript fact, and silently re-pointing it would rewrite history.
 */
export function bindAttachment(
  attachment: Attachment,
  turnId: TurnId,
  retainUntil: Date,
  now: Date,
): Result<Attachment> {
  if (attachmentRetentionHasElapsed(attachment, now)) {
    return err(
      attachmentRetentionElapsed(
        attachment.attachmentId,
        attachment.expiresAt?.toISOString() ?? "never",
        now.toISOString(),
      ),
    );
  }
  const existing = attachmentTurnId(attachment);
  if (existing !== null && existing !== turnId) {
    return err(attachmentBindingConflict(attachment.attachmentId, existing, turnId));
  }
  return ok({ ...attachment, binding: boundTo(turnId), expiresAt: retainUntil });
}
