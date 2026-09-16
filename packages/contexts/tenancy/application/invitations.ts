// Use cases: issue and accept an organization invitation.
//
// ISSUE is "supersede then create", inside one transaction, behind the advisory
// slot lock — the exact order of `issueInvitation` (auth.ts:787-821). Doing it
// the other way round (create then revoke the old one) would violate the
// partial unique index `OrganizationInvitation_one_active_per_email` for the
// duration of the transaction.
//
// ACCEPT re-checks under the write. The oracle validates the invitation, then
// consumes it with a conditional update and refuses if the affected row count
// is not exactly one, which closes the window between the read and the write
// without an extra lock.
//
// THE GAP THAT WAS RECORDED HERE IS CLOSED BY D1 (2026-09-15), in this use case
// and not in a transport. Neither oracle function performs any authorization —
// `issueInvitation` would mint an invitation for any `organizationId` and
// `inviterId` it was handed — and the only gate was the Remix invite route's
// `organization.findFirst` over OWNER/ADMIN memberships, which T8 deletes. D1
// chose to mirror that gate: only an ACTIVE OWNER or ADMIN of the target
// organization may issue, and anyone else is refused `TENANCY_INVITATION_FORBIDDEN`
// with the gate in `details`. It is decided INSIDE the unit of work, before the
// slot lock, so the membership that authorizes the write is read in the same
// transaction that commits it.
//
// ONE MORE RULE, CHOSEN UNDER D1 RATHER THAN PORTED: an ADMIN may not invite an
// OWNER. The Remix route only ever invited MEMBERs, so the question never arose
// there; `changeMembershipRole` already refuses an ADMIN granting OWNER
// (`mayChangeOwnership`, gate 3 of the ported policy), and an invitation that
// could do what a role change may not would be the way around it.

import type { OrganizationId, Result, TransactionScope } from "@platos/kernel";
import { asIdentifier, err, ok, runResult } from "@platos/kernel";

import {
  DEFAULT_INVITATION_TTL_MS,
  OrganizationRole,
  administrationGate,
  confirmInvitationConsumed,
  invalidInvitationEmail,
  invalidOrganizationRole,
  invitationForbidden,
  isOrganizationRole,
  isInvitableEmail,
  decideInvitationAcceptance,
  normalizeEmail,
  planInvitationIssue,
  type OrganizationInvitationId,
  type OrganizationInvitationRecord,
  type OrganizationMembershipRecord,
  type UserId,
} from "../domain/index.js";

import type { TenancyDependencies } from "./dependencies.js";

export interface IssueInvitationCommand {
  readonly organizationId: OrganizationId;
  /**
   * The operator issuing it — the EFFECTIVE user a transport authenticated. D1
   * made this the authorization subject, so it can no longer be null: an
   * invitation with no inviter is an invitation nobody was authorized to send.
   */
  readonly inviterId: UserId;
  readonly email: string;
  readonly role: OrganizationRole;
  /** Overrides the seven-day default. */
  readonly expiresAt?: Date;
}

export interface IssuedInvitation {
  readonly invitationId: OrganizationInvitationId;
  /** The secret to deliver. Never stored, never logged. */
  readonly token: string;
  readonly expiresAt: Date;
  /** How many outstanding invitations to this address were revoked. */
  readonly supersededCount: number;
}

export type IssueInvitation = (
  command: IssueInvitationCommand,
) => Promise<Result<IssuedInvitation>>;

type IssueDependencies = Pick<
  TenancyDependencies,
  "repository" | "locks" | "invitationTokens" | "clock" | "ids" | "unitOfWork"
>;

export function createIssueInvitation(dependencies: IssueDependencies): IssueInvitation {
  const { repository, locks, invitationTokens, clock, ids, unitOfWork } = dependencies;
  return async (command) => {
    const now = clock.now();
    const email = normalizeEmail(command.email);
    if (!isInvitableEmail(email)) return err(invalidInvitationEmail());
    if (!isOrganizationRole(command.role)) return err(invalidOrganizationRole());

    return runResult(unitOfWork, async (transaction) => {
      // D1. Read under the transaction, decided before anything is locked or minted.
      const organization = await repository.loadOrganization(command.organizationId);
      const inviter = await repository.findOrganizationMembershipByUser(
        command.organizationId,
        command.inviterId,
      );
      const gate = administrationGate({ organization, actorMembership: inviter });
      if (gate !== null) return err(invitationForbidden(gate));
      if (command.role === OrganizationRole.OWNER && inviter?.role !== OrganizationRole.OWNER) {
        return err(invitationForbidden("owner-grant-requires-owner"));
      }

      const minted = invitationTokens.mint();
      const expiresAt = command.expiresAt ?? new Date(now.getTime() + DEFAULT_INVITATION_TTL_MS);
      await locks.lockInvitationSlot(command.organizationId, email, transaction);
      const existing = await repository.findLiveInvitations(command.organizationId, email);
      const issued: OrganizationInvitationRecord = {
        id: asIdentifier<OrganizationInvitationId>(ids.uuid()),
        organizationId: command.organizationId,
        inviterId: command.inviterId,
        acceptedByUserId: null,
        email,
        role: command.role,
        tokenDigest: minted.digest,
        expiresAt,
        acceptedAt: null,
        revokedAt: null,
        createdAt: now,
      };
      const plan = planInvitationIssue(existing, issued, now);
      for (const superseded of plan.superseded) {
        await repository.saveInvitation(superseded, transaction);
      }
      await repository.saveInvitation(plan.issued, transaction);
      return ok({
        invitationId: plan.issued.id,
        token: minted.token,
        expiresAt,
        supersededCount: plan.superseded.length,
      });
    });
  };
}

export interface AcceptInvitationCommand {
  readonly token: string;
  readonly userId: UserId;
  /** The address the accepting party proved they control. */
  readonly email: string;
}

export interface AcceptedInvitation {
  readonly organizationId: OrganizationId;
  readonly role: OrganizationRole;
  readonly membership: OrganizationMembershipRecord;
}

export type AcceptInvitation = (
  command: AcceptInvitationCommand,
) => Promise<Result<AcceptedInvitation>>;

type AcceptDependencies = Pick<
  TenancyDependencies,
  "repository" | "invitationTokens" | "operators" | "clock" | "unitOfWork"
>;

export function createAcceptInvitation(dependencies: AcceptDependencies): AcceptInvitation {
  const { repository, invitationTokens, operators, clock, unitOfWork } = dependencies;
  return async (command) => {
    const now = clock.now();
    const digest = invitationTokens.digest(command.token);
    const invitation = await repository.findInvitationByTokenDigest(digest);
    const account = await operators.findAccount(command.userId);
    const decision = decideInvitationAcceptance({
      invitation,
      userId: command.userId,
      claimedEmail: command.email,
      accountEmail: account !== null && account.disabledAt === null ? account.email : null,
      now,
    });
    if (!decision.ok) return err(decision.error);

    return runResult(unitOfWork, async (transaction) =>
      consume(dependencies, decision.value.invitation, command.userId, now, transaction),
    );
  };
}

/** The compare-and-set consumption plus the membership upsert it implies. */
async function consume(
  dependencies: AcceptDependencies,
  invitation: OrganizationInvitationRecord,
  userId: UserId,
  now: Date,
  transaction: TransactionScope,
): Promise<Result<AcceptedInvitation>> {
  const affected = await dependencies.repository.consumeInvitation(
    invitation.id,
    now,
    userId,
    transaction,
  );
  const consumed = confirmInvitationConsumed(affected);
  if (!consumed.ok) return err(consumed.error);

  // Upsert, not insert: `@@unique([organizationId, userId])` means a previously
  // deactivated member's row is REACTIVATED with the invited role, which is the
  // oracle's `update: { role, deactivatedAt: null }`.
  const membership = await dependencies.repository.upsertOrganizationMembership(
    { organizationId: invitation.organizationId, userId, role: invitation.role, at: now },
    transaction,
  );
  return ok({ organizationId: invitation.organizationId, role: invitation.role, membership });
}
