// Use case: change an organization membership's role, and deactivate one.
//
// Transcribed from `changeMembershipRole` (auth.ts:400-481). The three things
// that make it correct are all preserved:
//
//   * the organization row is LOCKED FOR UPDATE first, so two concurrent owner
//     demotions serialize and the last-owner count cannot be read stale;
//   * the whole decision is pure (`decideMembershipRoleChange`) and takes the
//     owner count as an input, so every gate is exercisable in memory; and
//   * the role write and the session revocation happen in ONE transaction, so
//     there is no instant in which the privilege is gone and the session that
//     carried it is still live.

import type { OrganizationId, Result, TransactionScope } from "@platos/kernel";
import { err, ok, runResult } from "@platos/kernel";

import {
  decideMembershipDeactivation,
  decideMembershipRoleChange,
  membershipMutationForbidden,
  type MembershipRoleChange,
  type OrganizationMembershipId,
  type OrganizationRole,
  type UserId,
} from "../domain/index.js";

import type { TenancyDependencies } from "./dependencies.js";

export interface ChangeMembershipRoleCommand {
  readonly organizationId: OrganizationId;
  readonly membershipId: OrganizationMembershipId;
  readonly actorUserId: UserId;
  readonly role: OrganizationRole;
}

export interface MembershipMutationOutcome {
  readonly changed: boolean;
  readonly revokedSessionCount: number;
}

export type ChangeMembershipRole = (
  command: ChangeMembershipRoleCommand,
) => Promise<Result<MembershipMutationOutcome>>;

export type DeactivateMembership = (
  command: Omit<ChangeMembershipRoleCommand, "role">,
) => Promise<Result<MembershipMutationOutcome>>;

type Dependencies = Pick<
  TenancyDependencies,
  "repository" | "locks" | "sessionRevoker" | "clock" | "unitOfWork"
>;

/** The reads every membership mutation needs, taken under the lock. */
async function readUnderLock(
  dependencies: Dependencies,
  command: Omit<ChangeMembershipRoleCommand, "role">,
  transaction: TransactionScope,
) {
  const { repository, locks } = dependencies;
  const organizationLocked = await locks.lockOrganizationForUpdate(
    command.organizationId,
    transaction,
  );
  const actor = await repository.findOrganizationMembershipByUser(
    command.organizationId,
    command.actorUserId,
  );
  const target = await repository.findOrganizationMembershipById(
    command.organizationId,
    command.membershipId,
  );
  const activeOwnerCount = await repository.countActiveOwners(command.organizationId);
  return { organizationLocked, actor, target, activeOwnerCount };
}

/** Apply a decision: write the row, then end the affected user's sessions. */
async function applyChange(
  dependencies: Dependencies,
  change: MembershipRoleChange,
  transaction: TransactionScope,
): Promise<MembershipMutationOutcome> {
  if (change.kind === "unchanged") return { changed: false, revokedSessionCount: 0 };
  await dependencies.repository.saveOrganizationMembership(change.membership, transaction);
  const revokedSessionCount = await dependencies.sessionRevoker.revoke(
    change.revocation,
    transaction,
  );
  return { changed: true, revokedSessionCount };
}

export function createChangeMembershipRole(dependencies: Dependencies): ChangeMembershipRole {
  return async (command) =>
    runResult(dependencies.unitOfWork, async (transaction) => {
      const state = await readUnderLock(dependencies, command, transaction);
      const decision = decideMembershipRoleChange({
        ...state,
        nextRole: command.role,
        at: dependencies.clock.now(),
      });
      if (!decision.ok) return err(decision.error);
      return ok(await applyChange(dependencies, decision.value, transaction));
    });
}

export function createDeactivateMembership(dependencies: Dependencies): DeactivateMembership {
  return async (command) =>
    runResult(dependencies.unitOfWork, async (transaction) => {
      const state = await readUnderLock(dependencies, command, transaction);
      if (state.target !== null && state.target.id === state.actor?.id) {
        // Self-removal would let the last owner strand the organization through
        // a path the role change refuses; the oracle's bare `removeMembership`
        // has no guard at all, which is recorded on `decideMembershipDeactivation`.
        return err(membershipMutationForbidden("self-removal"));
      }
      const decision = decideMembershipDeactivation({
        ...state,
        at: dependencies.clock.now(),
      });
      if (!decision.ok) return err(decision.error);
      return ok(await applyChange(dependencies, decision.value, transaction));
    });
}
