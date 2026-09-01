// `OrganizationInvitation` — issue, supersede, accept.
//
// THE ONE-ACTIVE-PER-EMAIL INVARIANT is enforced three times over, and all
// three layers are deliberate:
//
//   1. a partial unique index,
//        CREATE UNIQUE INDEX "OrganizationInvitation_one_active_per_email"
//          ON "OrganizationInvitation" ("organizationId", "email")
//          WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL;
//      which makes a second live invitation impossible;
//   2. `pg_advisory_xact_lock(hashtextextended('organization-invitation:<org>:<email>', 0))`
//      taken by `issueInvitation` before it revokes and re-creates, so two
//      concurrent invites to the same address SERIALIZE rather than one of them
//      surfacing a raw unique-violation to the caller; and
//   3. the predicate below, so an in-memory use case refuses the same thing the
//      index would refuse.
//
// Issuing is therefore "supersede then create", not "create": an outstanding
// invitation to an address is revoked by the act of re-inviting it, and only
// then is a fresh token minted.

import type { OrganizationId } from "@platos/kernel";
import { err, ok, type Result } from "@platos/kernel";

import { invitationConsumed, invitationEmailMismatch, invitationInvalid } from "./errors.js";
import type {
  EmailAddress,
  OrganizationInvitationId,
  TokenDigest,
  UserId,
} from "./identifiers.js";
import { normalizeEmail } from "./identifiers.js";
import type { OrganizationRole } from "./roles.js";

export interface OrganizationInvitationRecord {
  readonly id: OrganizationInvitationId;
  readonly organizationId: OrganizationId;
  readonly inviterId: UserId | null;
  readonly acceptedByUserId: UserId | null;
  /** Stored normalized; a CHECK constraint enforces `lower(btrim(email))`. */
  readonly email: EmailAddress;
  readonly role: OrganizationRole;
  readonly tokenDigest: TokenDigest;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

/**
 * Seven days, from `DEFAULT_INVITATION_TTL_MS` in the oracle. A policy constant,
 * so it lives in the domain and is overridable per call rather than baked into
 * a use case.
 */
export const DEFAULT_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Live: neither accepted nor revoked. Expiry is checked separately. */
export function isInvitationLive(invitation: OrganizationInvitationRecord): boolean {
  return invitation.acceptedAt === null && invitation.revokedAt === null;
}

export function isInvitationExpired(
  invitation: OrganizationInvitationRecord,
  now: Date,
): boolean {
  return invitation.expiresAt.getTime() <= now.getTime();
}

/** Exactly the rows the partial unique index would consider in conflict. */
export function activeInvitationsFor(
  invitations: readonly OrganizationInvitationRecord[],
  organizationId: OrganizationId,
  email: EmailAddress,
): readonly OrganizationInvitationRecord[] {
  return invitations.filter(
    (invitation) =>
      invitation.organizationId === organizationId &&
      invitation.email === email &&
      isInvitationLive(invitation),
  );
}

export function revokeInvitation(
  invitation: OrganizationInvitationRecord,
  at: Date,
): OrganizationInvitationRecord {
  if (!isInvitationLive(invitation)) return invitation;
  return { ...invitation, revokedAt: at };
}

/**
 * What issuing does: revoke every live invitation for the address, then mint
 * one. Returned as a plan rather than performed, so the use case can write both
 * halves in a single transaction and the invariant never has a window in which
 * two live rows exist.
 */
export interface InvitationIssuePlan {
  readonly superseded: readonly OrganizationInvitationRecord[];
  readonly issued: OrganizationInvitationRecord;
}

export function planInvitationIssue(
  existing: readonly OrganizationInvitationRecord[],
  issued: OrganizationInvitationRecord,
  at: Date,
): InvitationIssuePlan {
  const superseded = activeInvitationsFor(existing, issued.organizationId, issued.email).map(
    (invitation) => revokeInvitation(invitation, at),
  );
  return { superseded, issued };
}

/** The acceptance outcome: the invitation to consume and the grant it implies. */
export interface InvitationAcceptance {
  readonly invitation: OrganizationInvitationRecord;
  readonly organizationId: OrganizationId;
  readonly role: OrganizationRole;
  readonly userId: UserId;
}

export interface InvitationAcceptanceInput {
  readonly invitation: OrganizationInvitationRecord | null;
  readonly userId: UserId;
  /** The address the accepting party proved they control. */
  readonly claimedEmail: string;
  /**
   * The address identity-access holds for `userId`, or null when there is no
   * such user. The oracle checks BOTH this and `claimedEmail` against the
   * invitation: proving control of an address is not the same as being the
   * account the membership will be attached to.
   */
  readonly accountEmail: EmailAddress | null;
  readonly now: Date;
}

export function decideInvitationAcceptance(
  input: InvitationAcceptanceInput,
): Result<InvitationAcceptance> {
  const { invitation } = input;
  if (invitation === null || invitation.revokedAt !== null || isInvitationExpired(invitation, input.now)) {
    return err(invitationInvalid());
  }
  if (invitation.acceptedAt !== null) return err(invitationConsumed());

  const claimed = normalizeEmail(input.claimedEmail);
  if (normalizeEmail(invitation.email) !== claimed) return err(invitationEmailMismatch());
  if (input.accountEmail === null || normalizeEmail(input.accountEmail) !== claimed) {
    return err(invitationEmailMismatch());
  }

  return ok({
    invitation: {
      ...invitation,
      acceptedAt: input.now,
      acceptedByUserId: input.userId,
    },
    organizationId: invitation.organizationId,
    role: invitation.role,
    userId: input.userId,
  });
}

/**
 * The compare-and-set the oracle performs after its checks
 * (`updateMany({ where: { id, acceptedAt: null, revokedAt: null } })` and then
 * `count !== 1` -> 409). Re-checking under the write is what closes the window
 * between reading the invitation and consuming it.
 */
export function confirmInvitationConsumed(updatedRowCount: number): Result<void> {
  return updatedRowCount === 1 ? ok(undefined) : err(invitationConsumed());
}
