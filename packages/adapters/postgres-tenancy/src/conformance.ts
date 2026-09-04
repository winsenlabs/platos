// One scenario, written once, so the in-memory fake and this adapter can be
// asked the SAME questions and their answers compared.
//
// WHY A SHARED SCENARIO RATHER THAN TWO SUITES. The fake in
// `packages/contexts/tenancy/application/testing/` says in its own header that
// it is "the contract fixture `packages/adapters/postgres-tenancy` is measured
// against". Two independently written suites would measure two things and agree
// by coincidence. This module drives one sequence of port calls and records what
// came back; a test runs it twice and compares. A divergence is then a specific
// step with a specific value, not "the adapter behaves differently somehow".
//
// IDENTIFIERS ARE NORMALISED, NOT COMPARED. `upsertOrganizationMembership` mints
// an id, and the two implementations mint differently on purpose — one counts,
// the other lets PostgreSQL generate a UUID. Every minted id is replaced by a
// stable label before comparison, so the comparison is about behaviour and not
// about which id generator is underneath. Nothing else is normalised: dates,
// counts, ordering and null-versus-absent all compare literally.

import type {
  EmailAddress,
  EnvironmentId,
  OrganizationId,
  OrganizationInvitationId,
  OrganizationMembershipId,
  ProjectId,
  TenancyRepository,
  TokenDigest,
  UnitOfWork,
  UserId,
} from "@platos/context-tenancy/application/ports/index.js";
import { asIdentifier, OrganizationRole } from "@platos/context-tenancy/application/ports/index.js";

/** Every identifier the scenario needs, supplied so each store can use its own. */
export interface ConformanceIds {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly ownerUserId: string;
  readonly secondOwnerUserId: string;
  readonly memberUserId: string;
  readonly invitationId: string;
  readonly entityId: string;
  readonly environmentSessionId: string;
  readonly operatorSessionId: string;
}

const AT = new Date("2026-05-01T09:00:00.000Z");
const LATER = new Date("2026-05-02T09:00:00.000Z");
const EXPIRES = new Date("2026-05-08T09:00:00.000Z");

/** What the scenario observed, in call order. Compared verbatim between stores. */
export type ConformanceObservation = Record<string, unknown>;

function label(minted: string, ids: ConformanceIds): string {
  const known = new Set<string>(Object.values(ids));
  return known.has(minted) ? minted : "<minted>";
}

export async function runTenancyConformance(
  repository: TenancyRepository,
  unitOfWork: UnitOfWork,
  ids: ConformanceIds,
): Promise<ConformanceObservation> {
  const organizationId = asIdentifier<OrganizationId>(ids.organizationId);
  const projectId = asIdentifier<ProjectId>(ids.projectId);
  const environmentId = asIdentifier<EnvironmentId>(ids.environmentId);
  const ownerUserId = asIdentifier<UserId>(ids.ownerUserId);
  const secondOwnerUserId = asIdentifier<UserId>(ids.secondOwnerUserId);
  const memberUserId = asIdentifier<UserId>(ids.memberUserId);
  const observed: ConformanceObservation = {};

  // --- one transaction writes the whole tenant tree ------------------------
  await unitOfWork.run(async (transaction) => {
    await repository.saveOrganization(
      {
        id: organizationId,
        slug: asIdentifier("conformance-org"),
        name: "Conformance",
        archivedAt: null,
        createdAt: AT,
        updatedAt: AT,
      },
      transaction,
    );
    await repository.saveProject(
      {
        id: projectId,
        organizationId,
        slug: asIdentifier("conformance-project"),
        name: "Conformance project",
        archivedAt: null,
        createdAt: AT,
        updatedAt: AT,
      },
      transaction,
    );
    await repository.saveEnvironment(
      {
        id: environmentId,
        projectId,
        slug: asIdentifier("prod"),
        name: "Production",
        archivedAt: null,
        accessKeyRevocationVersion: 0,
        memoryFeedbackBackfillCursor: null,
        memoryFeedbackBackfillCompletedAt: null,
        createdAt: AT,
        updatedAt: AT,
      },
      transaction,
    );
  });

  const ancestry = await repository.loadEnvironmentAncestry(environmentId);
  observed.ancestry = ancestry === null ? null : {
    organizationSlug: ancestry.organization.slug,
    projectSlug: ancestry.project.slug,
    environmentSlug: ancestry.environment.slug,
    revocationVersion: ancestry.environment.accessKeyRevocationVersion,
  };
  observed.ancestryOfUnknownEnvironment = await repository.loadEnvironmentAncestry(
    asIdentifier<EnvironmentId>(ids.environmentSessionId),
  );
  observed.projectBySlug = (
    await repository.findProjectBySlug(organizationId, asIdentifier("conformance-project"))
  )?.name;
  observed.projectBySlugInWrongOrganization = await repository.findProjectBySlug(
    asIdentifier<OrganizationId>(ids.entityId),
    asIdentifier("conformance-project"),
  );
  observed.projectCount = (await repository.listProjects(organizationId)).length;
  observed.environmentCount = (await repository.listEnvironments(projectId)).length;

  // --- membership: mint, reactivate, count under the ownership rule --------
  const minted = await unitOfWork.run((transaction) =>
    repository.upsertOrganizationMembership(
      { organizationId, userId: ownerUserId, role: OrganizationRole.OWNER, at: AT },
      transaction,
    ),
  );
  observed.mintedMembership = {
    id: label(minted.id, ids),
    role: minted.role,
    deactivatedAt: minted.deactivatedAt,
    createdAt: minted.createdAt,
  };

  const reactivated = await unitOfWork.run((transaction) =>
    repository.upsertOrganizationMembership(
      { organizationId, userId: ownerUserId, role: OrganizationRole.ADMIN, at: LATER },
      transaction,
    ),
  );
  observed.upsertIsIdempotentOnTheUniqueKey = reactivated.id === minted.id;
  observed.reactivatedRole = reactivated.role;
  observed.reactivatedUpdatedAt = reactivated.updatedAt;

  const secondOwner = await unitOfWork.run((transaction) =>
    repository.upsertOrganizationMembership(
      { organizationId, userId: secondOwnerUserId, role: OrganizationRole.OWNER, at: AT },
      transaction,
    ),
  );
  const removed = await unitOfWork.run(async (transaction) => {
    const membership = await repository.upsertOrganizationMembership(
      { organizationId, userId: memberUserId, role: OrganizationRole.OWNER, at: AT },
      transaction,
    );
    await repository.saveOrganizationMembership(
      { ...membership, deactivatedAt: LATER, updatedAt: LATER },
      transaction,
    );
    return membership;
  });

  observed.activeOwners = await repository.countActiveOwners(organizationId);
  observed.membershipsForRemovedUser = (
    await repository.listOrganizationMembershipsForUser(memberUserId)
  ).map((row) => ({ role: row.role, deactivated: row.deactivatedAt !== null }));
  observed.membershipByUser = (
    await repository.findOrganizationMembershipByUser(organizationId, secondOwnerUserId)
  )?.role;
  observed.membershipByIdInOwnOrganization = (
    await repository.findOrganizationMembershipById(
      organizationId,
      asIdentifier<OrganizationMembershipId>(secondOwner.id),
    )
  )?.role;
  observed.membershipByIdInAnotherOrganization = await repository.findOrganizationMembershipById(
    asIdentifier<OrganizationId>(ids.entityId),
    asIdentifier<OrganizationMembershipId>(secondOwner.id),
  );
  observed.removedMembershipIsDeactivated =
    (await repository.findOrganizationMembershipByUser(organizationId, memberUserId))
      ?.deactivatedAt !== null;
  observed.unusedRemovedId = label(removed.id, ids);

  // --- invitations: the compare-and-set consumption ------------------------
  const invitationId = asIdentifier<OrganizationInvitationId>(ids.invitationId);
  const email = asIdentifier<EmailAddress>("invitee@example.test");
  await unitOfWork.run((transaction) =>
    repository.saveInvitation(
      {
        id: invitationId,
        organizationId,
        inviterId: ownerUserId,
        acceptedByUserId: null,
        email,
        role: OrganizationRole.MEMBER,
        tokenDigest: asIdentifier<TokenDigest>("conformance-digest"),
        expiresAt: EXPIRES,
        acceptedAt: null,
        revokedAt: null,
        createdAt: AT,
      },
      transaction,
    ),
  );
  observed.liveInvitations = (await repository.findLiveInvitations(organizationId, email)).length;
  observed.invitationByDigest = (
    await repository.findInvitationByTokenDigest(asIdentifier<TokenDigest>("conformance-digest"))
  )?.role;
  observed.firstConsume = await unitOfWork.run((transaction) =>
    repository.consumeInvitation(invitationId, LATER, memberUserId, transaction),
  );
  observed.secondConsume = await unitOfWork.run((transaction) =>
    repository.consumeInvitation(invitationId, LATER, ownerUserId, transaction),
  );
  observed.liveInvitationsAfterConsume = (
    await repository.findLiveInvitations(organizationId, email)
  ).length;
  observed.consumedBy = (
    await repository.findInvitationByTokenDigest(asIdentifier<TokenDigest>("conformance-digest"))
  )?.acceptedByUserId;

  // --- entity and environment session --------------------------------------
  await unitOfWork.run(async (transaction) => {
    await repository.saveEntity(
      {
        id: asIdentifier(ids.entityId),
        projectId,
        externalId: "conformance-external",
        displayName: "Conformance entity",
        connectionStatus: "CONNECTED",
        connectionKind: "MCP",
        mcpUrls: ["https://mcp.example.test"],
        allowedOrigins: [],
        capabilities: ["tools"],
        lastConnectedAt: null,
        createdAt: AT,
        updatedAt: AT,
      },
      transaction,
    );
    await repository.saveEnvironmentSession(
      {
        id: asIdentifier(ids.environmentSessionId),
        environmentId,
        operatorSessionId: asIdentifier(ids.operatorSessionId),
        tier: "OPERATOR",
        ipAddress: null,
        userAgent: null,
        lastSeenAt: null,
        endedAt: null,
        createdAt: AT,
      },
      transaction,
    );
  });
  observed.entityByExternalId = (
    await repository.findEntityByExternalId(projectId, "conformance-external")
  )?.displayName;
  observed.entityByExternalIdInWrongProject = await repository.findEntityByExternalId(
    asIdentifier<ProjectId>(ids.environmentId),
    "conformance-external",
  );
  observed.projectEntities = (await repository.listProjectEntities(projectId)).length;
  observed.openSessions = (await repository.listOpenEnvironmentSessions(environmentId)).length;
  await unitOfWork.run(async (transaction) => {
    const [open] = await repository.listOpenEnvironmentSessions(environmentId);
    if (open !== undefined) {
      await repository.saveEnvironmentSession({ ...open, endedAt: LATER }, transaction);
    }
  });
  observed.openSessionsAfterEnding = (
    await repository.listOpenEnvironmentSessions(environmentId)
  ).length;

  return observed;
}
