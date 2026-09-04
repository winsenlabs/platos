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
//
// IT DOES ENFORCE FIVE UNIQUE INDEXES, and that is not the same decision. A
// missing foreign key makes a use case look MORE correct than it is, so leaving
// it out keeps the domain's restatement honest. A missing unique index makes a
// use case look LESS correct than it is: a creation that refuses a duplicate
// slug would be the only thing standing between a fixture and a second row, and
// the suite could never tell a use case that checks first from one that relies
// on the database. So `UniqueViolation` is raised here exactly where Postgres
// raises 23505 — and, because it is raised from inside the write, it is also how
// a transaction is seen to roll back without any fault having to be injected.
//
// The five are exactly the indexes on the rows a CREATION writes:
// `Organization_slug_key`, `Project_organizationId_slug_key`,
// `Environment_projectId_slug_key`,
// `OrganizationMembership_organizationId_userId_key` and
// `ProjectMembership_projectId_organizationMembershipId_key`.
//
// TWO MORE EXIST ON THIS CONTEXT'S TABLES AND ARE NOT REPRODUCED, each for a
// stated reason rather than by omission.
// `OrganizationInvitation_one_active_per_email` is PARTIAL — it covers only live
// rows — and `issueInvitation` already reads `findLiveInvitations` and refuses
// with `invitationAlreadyActive` before writing; a fake that refused the write
// as well would make that guard undeletable and therefore unproven.
// `Entity_projectId_externalId_key` is left out because no use case in this
// context writes an `Entity` yet — `saveEntity` exists for an adapter to
// conformance-test against — so an enforcement here would be guarding nothing.
// Which treatment an index gets is decided by whether an application guard is
// the thing under test, and this note is where that is written down.

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

/**
 * What Postgres raises as SQLSTATE 23505.
 *
 * A distinct class, and deliberately NOT a `DomainError`: a use case that lets
 * this reach a caller has skipped its own check, and the difference between the
 * refusal it should have produced and the violation it did produce is what the
 * suites assert on.
 */
export class UniqueViolation extends Error {
  readonly index: string;

  constructor(index: string) {
    super(`unique index ${index} refused the row`);
    this.name = "UniqueViolation";
    this.index = index;
  }
}

function replace<Row extends { readonly id: string }>(rows: Row[], row: Row): void {
  const index = rows.findIndex((candidate) => candidate.id === row.id);
  if (index === -1) rows.push(row);
  else rows.splice(index, 1, row);
}

/**
 * Refuse a write that would put two rows under one index key.
 *
 * The row being written is excluded by id, so re-saving a row — which every
 * archive, rename and role change does — is an UPDATE and not a collision.
 */
function enforceUnique<Row extends { readonly id: string }>(
  rows: Row[],
  row: Row,
  index: string,
  keyOf: (candidate: Row) => string,
): void {
  const key = keyOf(row);
  if (rows.some((candidate) => candidate.id !== row.id && keyOf(candidate) === key)) {
    throw new UniqueViolation(index);
  }
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

    async findOrganizationBySlug(slug) {
      return store.organizations.find((row) => row.slug === slug) ?? null;
    },

    async findProjectBySlug(organizationId, slug) {
      return (
        store.projects.find(
          (row) => row.organizationId === organizationId && row.slug === slug,
        ) ?? null
      );
    },

    async findEnvironmentBySlug(projectId, slug) {
      return (
        store.environments.find((row) => row.projectId === projectId && row.slug === slug) ?? null
      );
    },

    async saveOrganization(row: OrganizationRecord, _transaction: TransactionScope) {
      enforceUnique(store.organizations, row, "Organization_slug_key", (candidate) => candidate.slug);
      replace(store.organizations, row);
    },

    async saveProject(row: ProjectRecord, _transaction: TransactionScope) {
      enforceUnique(
        store.projects,
        row,
        "Project_organizationId_slug_key",
        (candidate) => JSON.stringify([candidate.organizationId, candidate.slug]),
      );
      replace(store.projects, row);
    },

    async saveEnvironment(row: EnvironmentRecord, _transaction: TransactionScope) {
      enforceUnique(
        store.environments,
        row,
        "Environment_projectId_slug_key",
        (candidate) => JSON.stringify([candidate.projectId, candidate.slug]),
      );
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

    async listOrganizationMembershipsForUser(userId) {
      // Every row, active or not: the rule that a deactivated member sees
      // nothing belongs to the read model, and filtering here would hide its
      // deletion from every test.
      return store.organizationMemberships.filter((row) => row.userId === userId);
    },

    async listProjectMembershipsForMembership(organizationMembershipId) {
      return store.projectMemberships.filter(
        (row) => row.organizationMembershipId === organizationMembershipId,
      );
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
      enforceUnique(
        store.organizationMemberships,
        row,
        "OrganizationMembership_organizationId_userId_key",
        (candidate) => JSON.stringify([candidate.organizationId, candidate.userId]),
      );
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
      enforceUnique(
        store.projectMemberships,
        row,
        "ProjectMembership_projectId_organizationMembershipId_key",
        (candidate) => JSON.stringify([candidate.projectId, candidate.organizationMembershipId]),
      );
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
