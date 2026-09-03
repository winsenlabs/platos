// An in-memory `TenancyRepository` and the store behind it.
//
// It ships in the package rather than hiding in a test file because it has two
// jobs, and only one of them is this context's own tests: it is also the
// contract fixture `packages/adapters/postgres-tenancy` is measured against, so
// "the real adapter and the fake disagree" is a failing test rather than a
// production surprise.
//
// It is a FAKE, not a mock: it stores rows and answers questions about them, so
// a use case exercised against it takes the same path it takes in production.
// It has no framework, no client and no I/O, so it is legal in `application/`
// under the same rules as everything else here.
//
// WHERE IT DELIBERATELY DIFFERS FROM POSTGRES: it enforces no foreign keys. The
// composite-key integrity that Postgres guarantees for `ProjectMembership` is
// therefore NOT enforced here, which is exactly why the domain restates it —
// and why a use case that relies on the database for that check would pass its
// unit tests and fail in production.

import type {
  EntityId,
  EnvironmentId,
  OrganizationId,
  ProjectId,
  TransactionScope,
} from "@platos/kernel";
import { asIdentifier } from "@platos/kernel";

import type {
  EmailAddress,
  EntityRecord,
  EnvironmentAncestry,
  EnvironmentRecord,
  EnvironmentSessionRecord,
  OrganizationInvitationId,
  OrganizationInvitationRecord,
  OrganizationMembershipId,
  OrganizationMembershipRecord,
  OrganizationRecord,
  ProjectMembershipRecord,
  ProjectRecord,
  TokenDigest,
  UserId,
} from "../../domain/index.js";
import { OrganizationRole, isInvitationLive } from "../../domain/index.js";
import type { OrganizationMembershipUpsert, TenancyRepository } from "../ports/index.js";

/** Mutable row storage. Tests seed it directly; use cases go through the port. */
export interface TenancyStore {
  organizations: OrganizationRecord[];
  projects: ProjectRecord[];
  environments: EnvironmentRecord[];
  organizationMemberships: OrganizationMembershipRecord[];
  projectMemberships: ProjectMembershipRecord[];
  invitations: OrganizationInvitationRecord[];
  entities: EntityRecord[];
  environmentSessions: EnvironmentSessionRecord[];
  /** Sequence for ids the store itself has to mint (the membership upsert). */
  sequence: number;
}

export function createTenancyStore(): TenancyStore {
  return {
    organizations: [],
    projects: [],
    environments: [],
    organizationMemberships: [],
    projectMemberships: [],
    invitations: [],
    entities: [],
    environmentSessions: [],
    sequence: 0,
  };
}

function replace<Row extends { readonly id: string }>(rows: Row[], row: Row): void {
  const index = rows.findIndex((candidate) => candidate.id === row.id);
  if (index === -1) rows.push(row);
  else rows.splice(index, 1, row);
}

export function createInMemoryTenancyRepository(store: TenancyStore): TenancyRepository {
  const organization = (id: OrganizationId) =>
    store.organizations.find((row) => row.id === id) ?? null;
  const project = (id: ProjectId) => store.projects.find((row) => row.id === id) ?? null;
  const environment = (id: EnvironmentId) =>
    store.environments.find((row) => row.id === id) ?? null;

  return {
    async loadEnvironmentAncestry(environmentId): Promise<EnvironmentAncestry | null> {
      const environmentRow = environment(environmentId);
      if (environmentRow === null) return null;
      const projectRow = project(environmentRow.projectId);
      if (projectRow === null) return null;
      const organizationRow = organization(projectRow.organizationId);
      if (organizationRow === null) return null;
      return { organization: organizationRow, project: projectRow, environment: environmentRow };
    },

    async loadOrganization(organizationId) {
      return organization(organizationId);
    },

    async loadProject(projectId) {
      return project(projectId);
    },

    async loadEnvironment(environmentId) {
      return environment(environmentId);
    },

    async listProjects(organizationId) {
      return store.projects.filter((row) => row.organizationId === organizationId);
    },

    async listEnvironments(projectId) {
      return store.environments.filter((row) => row.projectId === projectId);
    },

    async saveOrganization(row: OrganizationRecord, _transaction: TransactionScope) {
      replace(store.organizations, row);
    },

    async saveProject(row: ProjectRecord, _transaction: TransactionScope) {
      replace(store.projects, row);
    },

    async saveEnvironment(row: EnvironmentRecord, _transaction: TransactionScope) {
      replace(store.environments, row);
    },

    async findOrganizationMembershipByUser(organizationId, userId) {
      return (
        store.organizationMemberships.find(
          (row) => row.organizationId === organizationId && row.userId === userId,
        ) ?? null
      );
    },

    async findOrganizationMembershipById(organizationId, membershipId) {
      return (
        store.organizationMemberships.find(
          (row) => row.organizationId === organizationId && row.id === membershipId,
        ) ?? null
      );
    },

    async countActiveOwners(organizationId) {
      return store.organizationMemberships.filter(
        (row) =>
          row.organizationId === organizationId &&
          row.deactivatedAt === null &&
          row.role === OrganizationRole.OWNER,
      ).length;
    },

    async findProjectMembership(projectId, organizationMembershipId) {
      return (
        store.projectMemberships.find(
          (row) =>
            row.projectId === projectId &&
            row.organizationMembershipId === organizationMembershipId,
        ) ?? null
      );
    },

    async saveOrganizationMembership(row: OrganizationMembershipRecord, _transaction) {
      replace(store.organizationMemberships, row);
    },

    async upsertOrganizationMembership(
      upsert: OrganizationMembershipUpsert,
      _transaction: TransactionScope,
    ) {
      const existing = store.organizationMemberships.find(
        (row) => row.organizationId === upsert.organizationId && row.userId === upsert.userId,
      );
      const next: OrganizationMembershipRecord =
        existing === undefined
          ? {
              id: asIdentifier<OrganizationMembershipId>(`membership-${(store.sequence += 1)}`),
              organizationId: upsert.organizationId,
              userId: upsert.userId,
              role: upsert.role,
              deactivatedAt: null,
              createdAt: upsert.at,
              updatedAt: upsert.at,
            }
          : { ...existing, role: upsert.role, deactivatedAt: null, updatedAt: upsert.at };
      replace(store.organizationMemberships, next);
      return next;
    },

    async saveProjectMembership(row: ProjectMembershipRecord, _transaction) {
      replace(store.projectMemberships, row);
    },

    async findLiveInvitations(organizationId: OrganizationId, email: EmailAddress) {
      return store.invitations.filter(
        (row) =>
          row.organizationId === organizationId && row.email === email && isInvitationLive(row),
      );
    },

    async findInvitationByTokenDigest(tokenDigest: TokenDigest) {
      return store.invitations.find((row) => row.tokenDigest === tokenDigest) ?? null;
    },

    async saveInvitation(row: OrganizationInvitationRecord, _transaction) {
      replace(store.invitations, row);
    },

    async consumeInvitation(
      invitationId: OrganizationInvitationId,
      acceptedAt: Date,
      acceptedByUserId: UserId,
      _transaction: TransactionScope,
    ) {
      // The conditional update, including its WHERE clause: an invitation that
      // was accepted or revoked between the read and here affects zero rows.
      const row = store.invitations.find(
        (candidate) => candidate.id === invitationId && isInvitationLive(candidate),
      );
      if (row === undefined) return 0;
      replace(store.invitations, { ...row, acceptedAt, acceptedByUserId });
      return 1;
    },

    async findEntity(entityId: EntityId) {
      return store.entities.find((row) => row.id === entityId) ?? null;
    },

    async findEntityByExternalId(projectId: ProjectId, externalId: string) {
      return (
        store.entities.find(
          (row) => row.projectId === projectId && row.externalId === externalId,
        ) ?? null
      );
    },

    async listProjectEntities(projectId: ProjectId) {
      return store.entities.filter((row) => row.projectId === projectId);
    },

    async saveEntity(row: EntityRecord, _transaction) {
      replace(store.entities, row);
    },

    async listOpenEnvironmentSessions(environmentId: EnvironmentId) {
      return store.environmentSessions.filter(
        (row) => row.environmentId === environmentId && row.endedAt === null,
      );
    },

    async saveEnvironmentSession(row: EnvironmentSessionRecord, _transaction) {
      replace(store.environmentSessions, row);
    },
  };
}
