// Organization invitations, entities and environment sessions, over PostgreSQL.
//
// `consumeInvitation` IS THE COMPARE-AND-SET, AND IT IS THE WHOLE GUARD. It is
// an `updateMany` whose WHERE clause carries the precondition — not yet
// accepted, not revoked — and it returns the affected row COUNT rather than a
// boolean, because the domain's `confirmInvitationConsumed` is the thing
// entitled to decide what a count that is not 1 means. Two clicks on one
// invitation link race here and exactly one of them sees a count of 1; a
// read-then-write would let both through, and both would create a membership.
//
// A LIVE INVITATION IS `acceptedAt IS NULL AND revokedAt IS NULL`, which is the
// same predicate as the partial index `OrganizationInvitation_one_active_per_email`
// covers and the same one `isInvitationLive` states in the domain. Expiry is NOT
// part of it: an expired-but-unaccepted invitation is still a live row that a
// re-invite has to supersede, and the domain refuses it on its own terms.

import type {
  EmailAddress,
  EntityId,
  EntityRecord,
  EnvironmentId,
  EnvironmentSessionRecord,
  OrganizationId,
  OrganizationInvitationId,
  OrganizationInvitationRecord,
  ProjectId,
  TokenDigest,
  TransactionScope,
  UserId,
} from "@platos/context-tenancy/application/ports/index.js";

import { toEntity, toEnvironmentSession, toInvitation } from "./mapping.js";
import { LIST_ORDER } from "./tree.js";
import type { TenancyTransactions } from "./transaction.js";

export function createInvitationRepository(transactions: TenancyTransactions) {
  return {
    async findLiveInvitations(
      organizationId: OrganizationId,
      email: EmailAddress,
    ): Promise<readonly OrganizationInvitationRecord[]> {
      const rows = await transactions.reader().organizationInvitation.findMany({
        where: { organizationId, email, acceptedAt: null, revokedAt: null },
        orderBy: [...LIST_ORDER],
      });
      return rows.map(toInvitation);
    },

    async findInvitationByTokenDigest(
      tokenDigest: TokenDigest,
    ): Promise<OrganizationInvitationRecord | null> {
      const row = await transactions
        .reader()
        .organizationInvitation.findUnique({ where: { tokenHash: tokenDigest } });
      return row === null ? null : toInvitation(row);
    },

    async saveInvitation(
      invitation: OrganizationInvitationRecord,
      transaction: TransactionScope,
    ): Promise<void> {
      const data = {
        organizationId: invitation.organizationId,
        inviterId: invitation.inviterId,
        acceptedByUserId: invitation.acceptedByUserId,
        email: invitation.email,
        role: invitation.role,
        tokenHash: invitation.tokenDigest,
        expiresAt: invitation.expiresAt,
        acceptedAt: invitation.acceptedAt,
        revokedAt: invitation.revokedAt,
        createdAt: invitation.createdAt,
      };
      await transactions.writer(transaction).organizationInvitation.upsert({
        where: { id: invitation.id },
        create: { id: invitation.id, ...data },
        update: data,
      });
    },

    async consumeInvitation(
      invitationId: OrganizationInvitationId,
      acceptedAt: Date,
      acceptedByUserId: UserId,
      transaction: TransactionScope,
    ): Promise<number> {
      const result = await transactions.writer(transaction).organizationInvitation.updateMany({
        where: { id: invitationId, acceptedAt: null, revokedAt: null },
        data: { acceptedAt, acceptedByUserId },
      });
      return result.count;
    },

    async findEntity(entityId: EntityId): Promise<EntityRecord | null> {
      const row = await transactions.reader().entity.findUnique({ where: { id: entityId } });
      return row === null ? null : toEntity(row);
    },

    async findEntityByExternalId(
      projectId: ProjectId,
      externalId: string,
    ): Promise<EntityRecord | null> {
      const row = await transactions.reader().entity.findUnique({
        where: { projectId_externalId: { projectId, externalId } },
      });
      return row === null ? null : toEntity(row);
    },

    async listProjectEntities(projectId: ProjectId): Promise<readonly EntityRecord[]> {
      const rows = await transactions
        .reader()
        .entity.findMany({ where: { projectId }, orderBy: [...LIST_ORDER] });
      return rows.map(toEntity);
    },

    async saveEntity(entity: EntityRecord, transaction: TransactionScope): Promise<void> {
      const data = {
        projectId: entity.projectId,
        externalId: entity.externalId,
        displayName: entity.displayName,
        connectionStatus: entity.connectionStatus,
        connectionKind: entity.connectionKind,
        mcpUrls: [...entity.mcpUrls],
        allowedOrigins: [...entity.allowedOrigins],
        capabilities: [...entity.capabilities],
        lastConnectedAt: entity.lastConnectedAt,
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt,
      };
      await transactions.writer(transaction).entity.upsert({
        where: { id: entity.id },
        create: { id: entity.id, ...data },
        update: data,
      });
    },

    async listOpenEnvironmentSessions(
      environmentId: EnvironmentId,
    ): Promise<readonly EnvironmentSessionRecord[]> {
      const rows = await transactions.reader().environmentSession.findMany({
        where: { environmentId, endedAt: null },
        orderBy: [...LIST_ORDER],
      });
      return rows.map(toEnvironmentSession);
    },

    async saveEnvironmentSession(
      session: EnvironmentSessionRecord,
      transaction: TransactionScope,
    ): Promise<void> {
      const data = {
        environmentId: session.environmentId,
        operatorSessionId: session.operatorSessionId,
        tier: session.tier,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        lastSeenAt: session.lastSeenAt,
        endedAt: session.endedAt,
        createdAt: session.createdAt,
      };
      await transactions.writer(transaction).environmentSession.upsert({
        where: { id: session.id },
        create: { id: session.id, ...data },
        update: data,
      });
    },
  };
}
