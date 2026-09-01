// The membership-mutation policy, taken gate for gate from `changeMembershipRole`
// (internal-packages/tenancy-database/src/auth.ts:400-481).
//
// The oracle's gates, in its order:
//   1. the organization row is locked FOR UPDATE and must exist unarchived —
//      the lock serializes concurrent owner demotions so two of them cannot
//      each observe the other owner and both succeed;
//   2. the ACTOR must hold an active OWNER or ADMIN membership in that
//      organization, and the TARGET must be an active membership of it;
//   3. only an OWNER may grant OWNER or take OWNER away;
//   4. a no-op (target already has the requested role) returns early, before
//      the last-owner check and before any session revocation;
//   5. demoting the last active OWNER is refused with 409 `owner_invariant`;
//   6. the role is written and every session of the affected user — direct and
//      impersonated — is revoked in the SAME transaction.
//
// Gate 4 sitting before gate 5 is load-bearing: re-asserting OWNER on the only
// owner must succeed, not trip the invariant.

import { err, ok, type Result } from "@platos/kernel";

import { lastOwnerInvariant, membershipMutationForbidden } from "./errors.js";
import {
  isActiveMembership,
  withOrganizationRole,
  type OrganizationMembershipRecord,
} from "./membership.js";
import { OrganizationRole } from "./roles.js";
import { revokeSessionsFor, type SessionRevocationOrder } from "./session-revocation.js";

export interface MembershipRoleChangeInput {
  /** False when the organization row is missing, archived, or unlockable. */
  readonly organizationLocked: boolean;
  readonly actor: OrganizationMembershipRecord | null;
  readonly target: OrganizationMembershipRecord | null;
  readonly nextRole: OrganizationRole;
  /** Active OWNER memberships in the organization, counted under the lock. */
  readonly activeOwnerCount: number;
  readonly at: Date;
}

export type MembershipRoleChange =
  | { readonly kind: "unchanged" }
  | {
      readonly kind: "changed";
      readonly membership: OrganizationMembershipRecord;
      readonly revocation: SessionRevocationOrder;
    };

/** Gates 1 and 2. Returns the pair only when both sides are usable. */
function admitActorAndTarget(
  input: MembershipRoleChangeInput,
): Result<{ actor: OrganizationMembershipRecord; target: OrganizationMembershipRecord }> {
  if (!input.organizationLocked) {
    return err(membershipMutationForbidden("organization-unavailable"));
  }
  const { actor, target } = input;
  if (actor === null || !isActiveMembership(actor)) {
    return err(membershipMutationForbidden("actor-not-active"));
  }
  if (actor.role !== OrganizationRole.OWNER && actor.role !== OrganizationRole.ADMIN) {
    return err(membershipMutationForbidden("actor-not-admin"));
  }
  if (target === null || !isActiveMembership(target)) {
    return err(membershipMutationForbidden("target-not-active"));
  }
  if (target.organizationId !== actor.organizationId) {
    return err(membershipMutationForbidden("target-in-other-organization"));
  }
  return ok({ actor, target });
}

/**
 * Gate 3 — ONLY AN OWNER MAY GRANT OR REVOKE OWNER.
 *
 * Both directions are covered by one condition in the oracle: an ADMIN may
 * neither promote anybody to OWNER nor touch an existing OWNER at all. Without
 * the second half, an ADMIN could demote every OWNER and then hold the highest
 * remaining role in the organization.
 */
export function mayChangeOwnership(
  actorRole: OrganizationRole,
  targetRole: OrganizationRole,
  nextRole: OrganizationRole,
): boolean {
  if (actorRole === OrganizationRole.OWNER) return true;
  return targetRole !== OrganizationRole.OWNER && nextRole !== OrganizationRole.OWNER;
}

/**
 * Gate 5 — an organization must retain at least one active OWNER.
 *
 * Only a demotion FROM owner can break it, and `activeOwnerCount` is read under
 * the same row lock that serializes the mutation, so two concurrent demotions
 * cannot both see a second owner.
 */
export function wouldStrandOrganization(
  targetRole: OrganizationRole,
  nextRole: OrganizationRole,
  activeOwnerCount: number,
): boolean {
  if (targetRole !== OrganizationRole.OWNER) return false;
  if (nextRole === OrganizationRole.OWNER) return false;
  return activeOwnerCount <= 1;
}

export function decideMembershipRoleChange(
  input: MembershipRoleChangeInput,
): Result<MembershipRoleChange> {
  const admitted = admitActorAndTarget(input);
  if (!admitted.ok) return err(admitted.error);
  const { actor, target } = admitted.value;

  if (!mayChangeOwnership(actor.role, target.role, input.nextRole)) {
    return err(membershipMutationForbidden("owner-grant-requires-owner"));
  }
  // Gate 4 before gate 5: re-asserting the role an owner already holds is a
  // no-op and must not trip the last-owner invariant.
  if (target.role === input.nextRole) return ok({ kind: "unchanged" });

  if (wouldStrandOrganization(target.role, input.nextRole, input.activeOwnerCount)) {
    return err(lastOwnerInvariant());
  }

  return ok({
    kind: "changed",
    membership: withOrganizationRole(target, input.nextRole, input.at),
    revocation: revokeSessionsFor(target.userId, "membership-role-changed", input.at),
  });
}

/**
 * `removeMembership` in the oracle is a bare `deactivatedAt` write with no
 * authorization and no owner check — the database rule then revokes the user's
 * sessions. Two of those three facts are defects rather than decisions, so the
 * decision is modelled with the same gates as a role change: removing the last
 * active OWNER strands the organization exactly as demoting them does, and the
 * oracle's own SQL comment says the database rule is there for callers that
 * bypass the service, not instead of the service.
 */
export function decideMembershipDeactivation(
  input: Omit<MembershipRoleChangeInput, "nextRole">,
): Result<MembershipRoleChange> {
  const admitted = admitActorAndTarget({ ...input, nextRole: OrganizationRole.MEMBER });
  if (!admitted.ok) return err(admitted.error);
  const { actor, target } = admitted.value;

  if (target.role === OrganizationRole.OWNER && actor.role !== OrganizationRole.OWNER) {
    return err(membershipMutationForbidden("owner-removal-requires-owner"));
  }
  if (target.role === OrganizationRole.OWNER && input.activeOwnerCount <= 1) {
    return err(lastOwnerInvariant());
  }
  return ok({
    kind: "changed",
    membership: { ...target, deactivatedAt: input.at, updatedAt: input.at },
    revocation: revokeSessionsFor(target.userId, "membership-deactivated", input.at),
  });
}
