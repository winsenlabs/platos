// Admitting the files a turn carries into its prompt.
//
// THIS CONTEXT OWNS NO ATTACHMENT ROW. `MessageAttachment` and `Artifact` are
// `files`' (ADR M0.3 §1 row 6), and the object store is behind `files`' own
// `ObjectStore` port. What this context owns is the DECISION: which of the files
// a caller named may become a content part of this turn's prompt, and what the
// refusal is when one may not.
//
// SO THE CHECKS HERE ARE THE ONES THE OWNER CANNOT MAKE. `files` knows a row's
// size, its media type and which thread it hangs off. It does not know how many
// files THIS turn is carrying, what the per-turn byte ceiling is, or which media
// types the prompt vocabulary has a part for — those are turn-shaped questions,
// and they are the three below.
//
// FOUR REFUSALS, FOUR CODES, AND THE SPLIT IS THE ONE THE SOURCE ALREADY MAKES
// AND THEN COLLAPSES. `AttachmentSizeExceeded` carries a `kind` of
// `"per-attachment"` or `"per-turn"` — two decisions in one error class — and
// the boundary mismatch is a bare `Error("Attachment binding does not match its
// pending Agent and Thread boundary")`. Here:
//
//   TOO LARGE      one file over the per-file ceiling.
//   COUNT EXCEEDED too many files, each of them small. The byte ceilings do not
//                  bound the count, so sixteen one-byte files pass both and the
//                  source has nothing to stop a thousand.
//   MEDIA TYPE     a type no prompt content part can carry. The source drops
//                  these silently, so a caller learns their document was ignored
//                  by reading a model answer that does not mention it.
//   FOREIGN        the file is not this thread's. `files` answers where it
//                  hangs; this compares.
//
// THE PER-TURN CEILING IS CHECKED BEFORE ANY BYTE IS FETCHED, which the source
// gets right and is worth keeping: the point of a ceiling on total bytes is not
// to reject after paying to download them.

import { err, ok, type Result } from "@platos/kernel";

import {
  attachmentCountExceeded,
  attachmentForeign,
  attachmentMediaTypeRefused,
  attachmentTooLarge,
  attachmentTurnTooLarge,
} from "./errors.js";
import type { ThreadId } from "./identifiers.js";
import type { AttachmentPolicy } from "./policy.js";

/**
 * What `files` answers about one file, as this context needs it.
 *
 * Deliberately NOT `files`' own view type: `domain/` may import only its own
 * domain and the kernel (ADR M0.3 §2), so the shape a use case translates into
 * is declared here. The translation is one function in `application/`, and it is
 * the only place the two vocabularies meet.
 */
export interface AttachmentCandidate {
  readonly fileId: string;
  readonly mediaType: string;
  readonly bytes: number;
  /** Which thread `files` says it hangs off. Null when it hangs off none. */
  readonly threadId: ThreadId | null;
}

export interface AdmittedAttachments {
  readonly candidates: readonly AttachmentCandidate[];
  readonly totalBytes: number;
}

function promptable(mediaType: string, policy: AttachmentPolicy): boolean {
  return policy.promptableMediaTypePrefixes.some((prefix) => mediaType.startsWith(prefix));
}

/**
 * Admit every attachment a turn names, or refuse the first that fails.
 *
 * THE ORDER IS COUNT, THEN PER-FILE, THEN TYPE, THEN OWNERSHIP, and it is fixed
 * so that a request breaching two ceilings answers deterministically. Count
 * first because it is the cheapest and bounds the loop; ownership last because
 * it is the one that needed a lookup to answer at all.
 */
export function admitAttachments(
  threadId: ThreadId,
  candidates: readonly AttachmentCandidate[],
  policy: AttachmentPolicy,
): Result<AdmittedAttachments> {
  if (candidates.length > policy.maxAttachmentsPerTurn) {
    return err(attachmentCountExceeded(candidates.length, policy.maxAttachmentsPerTurn));
  }

  let totalBytes = 0;
  for (const candidate of candidates) {
    if (candidate.bytes > policy.maxBytesPerAttachment) {
      return err(attachmentTooLarge(candidate.bytes, policy.maxBytesPerAttachment));
    }
    if (!promptable(candidate.mediaType, policy)) {
      return err(attachmentMediaTypeRefused(candidate.mediaType));
    }
    if (candidate.threadId !== threadId) {
      return err(attachmentForeign(candidate.fileId, threadId));
    }
    totalBytes += candidate.bytes;
  }

  if (totalBytes > policy.maxBytesPerTurn) {
    return err(attachmentTurnTooLarge(totalBytes, policy.maxBytesPerTurn));
  }

  return ok(Object.freeze({ candidates: Object.freeze([...candidates]), totalBytes }));
}

/**
 * Which prompt content part a media type becomes.
 *
 * `image` for images and `file` for everything else, matching the two parts
 * `providers`' prompt vocabulary offers. A type that reaches here has already
 * been admitted, so there is no refusal branch and no default that silently
 * drops one.
 */
export function contentPartKindFor(mediaType: string): "image" | "file" {
  return mediaType.startsWith("image/") ? "image" : "file";
}
