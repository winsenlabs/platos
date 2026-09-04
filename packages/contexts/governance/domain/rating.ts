// A thumb on one turn, by one end user.
//
// `@@unique([turnId, endUserId])` is the whole model: one person, one turn, one
// current opinion. Changing your mind flips the sign in place and bumps the
// revision; withdrawing it deletes the row. There is no history table, and this
// context does not pretend there is one.
//
// A RATING IS EXACTLY 1 OR -1. The column is an `Int` and the source checks
// `input.rating !== 1 && input.rating !== -1` on the write path — but its READ
// path then folds with `if (r.rating > 0) ups += 1; else if (r.rating < 0)
// downs += 1;` and computes `total = ups + downs`, so a zero row (which only a
// write around the service can produce) vanishes from BOTH counts and from the
// total, and the satisfaction score silently changes denominator. Admission is
// kept exactly; the fold is fixed in `satisfaction.ts` and reports what it
// discarded rather than dropping it.
//
// THE REVISION IS THE RECONCILIATION KEY, NOT THE SIGN. The source's memory
// feedback reconciles against the persisted row's revision precisely so that
// two clients racing the same flip converge on one answer. `nextRevision` is
// that increment, stated once.

import { err, ok, type Result } from "@platos/kernel";

import { ratingCommentTooLong, ratingValueInvalid } from "./errors.js";
import type { AgentId, AgentVersionId, EndUserId, MessageRatingId, TurnId } from "./identifiers.js";

/** The only two values the column may hold. */
export type RatingValue = 1 | -1;

export interface MessageRating {
  readonly messageRatingId: MessageRatingId;
  readonly environmentId: string;
  readonly turnId: TurnId;
  readonly agentId: AgentId;
  /** Null when the agent had no bound version at the instant of the vote. */
  readonly agentVersionId: AgentVersionId | null;
  readonly endUserId: EndUserId;
  readonly rating: RatingValue;
  readonly revision: number;
  readonly comment: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Admit a rating value.
 *
 * `Number.isInteger` first, so `1.0000000001` and `NaN` are refused rather than
 * reaching a strict equality that would silently answer false for one and true
 * for neither.
 */
export function admitRatingValue(value: number): Result<RatingValue> {
  if (!Number.isInteger(value)) return err(ratingValueInvalid(value));
  if (value !== 1 && value !== -1) return err(ratingValueInvalid(value));
  return ok(value);
}

/**
 * Admit a comment.
 *
 * Trimmed, and an all-whitespace comment becomes null rather than a row carrying
 * a blank string: a comment nobody wrote should not read as a comment somebody
 * left empty. The ceiling is a REFUSAL rather than a truncation, unlike a safety
 * detail, because this is operator-typed input on a request that is allowed to
 * fail, not a signal that must never fail a turn.
 */
export function admitRatingComment(
  comment: string | null | undefined,
  maxLength: number,
): Result<string | null> {
  if (comment === null || comment === undefined) return ok(null);
  const trimmed = comment.trim();
  if (trimmed === "") return ok(null);
  if (trimmed.length > maxLength) return err(ratingCommentTooLong(trimmed.length, maxLength));
  return ok(trimmed);
}

/** The revision a flip writes. A fresh row starts at 1. */
export function nextRevision(existing: MessageRating | null): number {
  return existing === null ? 1 : existing.revision + 1;
}

export interface RatingTally {
  readonly ups: number;
  readonly downs: number;
  /** Rows whose stored value is neither 1 nor -1. Never silently folded away. */
  readonly discarded: number;
}

/** Count a set of stored rows. Every row lands in exactly one of the three. */
export function tally(rows: readonly { readonly rating: number }[]): RatingTally {
  let ups = 0;
  let downs = 0;
  let discarded = 0;
  for (const row of rows) {
    if (row.rating === 1) ups += 1;
    else if (row.rating === -1) downs += 1;
    else discarded += 1;
  }
  return { ups, downs, discarded };
}
