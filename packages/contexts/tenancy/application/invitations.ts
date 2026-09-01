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
// ONE GAP, RECORDED NOT INVENTED. Neither oracle function performs any
// authorization: `issueInvitation` will mint an invitation for any
// `organizationId` and `inviterId` it is handed, and the check that the inviter
// may invite lives in the controller above it. That is a real gap, and closing
// it here would be inventing a rule with no oracle, so the use case takes the
// inviter as data and the transport keeps the duty until a decision is taken.

import type { OrganizationId, Result, TransactionScope } from "@platos/kernel";
import { asIdentifier, err, ok } from "@platos/kernel";

import {
  DEFAULT_INVITATION_TTL_MS,
  confirmInvitationConsumed,
  decideInvitationAcceptance,
  normalizeEmail,
  planInvitationIssue,
  type OrganizationInvitationId,
  type OrganizationInvitationRecord,
  type OrganizationMembershipRecord,
  type OrganizationRole,
  type UserId,
} from "../domain/index.js";

import type { TenancyDependencies } from "./dependencies.js";

export interface IssueInvitationCommand {
  readonly organizationId: OrganizationId;
  readonly inviterId: UserId | null;
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
    const minted = invitationTokens.mint();
    const expiresAt = command.expiresAt ?? new Date(now.getTime() + DEFAULT_INVITATION_TTL_MS);

    return unitOfWork.run(async (transaction) => {
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

    return unitOfWork.run(async (transaction) =>
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
