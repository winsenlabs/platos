// MagicLinkToken — the passwordless login credential.
//
// THERE ARE NO PASSWORDS IN THIS SYSTEM. Nothing in the schema stores one, and
// nothing in the extraction source hashes or compares one. Operator login is a
// mailed single-use token or a federated identity provider, and that is the
// whole set. Any future "password" column would be a new decision, not a gap.
//
// A magic link is single-use AND time-boxed, and both halves are load-bearing.
// Time-boxing alone leaves a link in a mailbox usable for its whole window by
// anyone who reaches that mailbox later; single-use alone leaves a link valid
// forever until somebody clicks it. Fifteen minutes and one use.
//
// CONSUMPTION IS A CONDITIONAL WRITE, NOT A READ THEN A WRITE. The extraction
// source consumes with `UPDATE ... WHERE consumedAt IS NULL` and requires the
// row count to be exactly one, so two concurrent clicks on the same link
// produce one session and one refusal rather than two sessions. `consumed()`
// states the rule; the adapter is responsible for making the write conditional.

import { instantAfter } from "./credential.js";
import { unauthenticated } from "./errors.js";
import type { EmailAddress, TokenHash } from "./principal.js";
import { err, ok, type Result } from "@platos/kernel";

export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
/** OrganizationInvitation is written by `tenancy`; only the TTL is shared. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface MagicLinkTokenRecord {
  readonly tokenHash: TokenHash;
  readonly email: EmailAddress;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly createdAt: Date;
}

export function issuedMagicLink(input: {
  readonly tokenHash: TokenHash;
  readonly email: EmailAddress;
  readonly now: Date;
  readonly expiresAt?: Date;
}): MagicLinkTokenRecord {
  return {
    tokenHash: input.tokenHash,
    email: input.email,
    expiresAt: input.expiresAt ?? instantAfter(input.now, MAGIC_LINK_TTL_MS),
    consumedAt: null,
    createdAt: input.now,
  };
}

/**
 * Consume a link, or refuse it.
 *
 * Expiry and prior consumption both return the SAME opaque failure. A response
 * that distinguished "this link expired" from "this link was already used" would
 * confirm to a stranger holding a leaked URL that the address it was mailed to
 * is a real account, and when it last logged in.
 */
export function consumed(
  link: MagicLinkTokenRecord,
  now: Date,
): Result<MagicLinkTokenRecord> {
  if (link.consumedAt !== null) return err(unauthenticated({ reason: "magic-link-consumed" }));
  if (link.expiresAt.getTime() <= now.getTime()) {
    return err(unauthenticated({ reason: "magic-link-expired" }));
  }
  return ok({ ...link, consumedAt: now });
}

export function isConsumable(link: MagicLinkTokenRecord, now: Date): boolean {
  return consumed(link, now).ok;
}
