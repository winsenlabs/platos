// `TenancyRepository` — the driven port over the eight rows tenancy is sole
// writer of (ADR M0.3 §1, context 2): Organization, OrganizationMembership,
// OrganizationInvitation, Project, ProjectMembership, Environment,
// EnvironmentSession, Entity.
//
// Implemented by `packages/adapters/postgres-tenancy`, which is the only place
// the database client exists. Nothing below names a vendor type: the write
// methods take the kernel's opaque `TransactionScope`, which carries an
// identifier and no session handle, so no transaction ever leaks across this
// boundary (ADR M0.3 §3).
//
// THE READ SHAPES ARE PART OF THE CONTRACT. `loadEnvironmentAncestry` takes an
// `EnvironmentId` and nothing else, because the oracle re-derives the whole
// tenant chain from the leaf and deliberately ignores caller-supplied tenant
// ids. A repository method that accepted `(organizationId, environmentId)`
// would reintroduce exactly the parameter an attacker controls.

import type {
  EntityId,
  EnvironmentId,
  OrganizationId,
  ProjectId,
  TransactionScope,
} from "@platos/kernel";

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
  OrganizationRole,
  ProjectMembershipRecord,
  ProjectRecord,
  Slug,
  TokenDigest,
  UserId,
} from "../../domain/index.js";

/** What `acceptInvitation` upserts: create, or reactivate with the new role. */
export interface OrganizationMembershipUpsert {
  readonly organizationId: OrganizationId;
  readonly userId: UserId;
  readonly role: OrganizationRole;
  readonly at: Date;
}

export interface TenancyRepository {
  // --- tenant tree, always resolved downward from an id it was given --------

  /**
   * The organization, project and environment above one environment, in one
   * read. `null` when there is no such environment. The ONLY way this context
   * obtains an ancestry.
   */
  loadEnvironmentAncestry(environmentId: EnvironmentId): Promise<EnvironmentAncestry | null>;

  loadOrganization(organizationId: OrganizationId): Promise<OrganizationRecord | null>;
  loadProject(projectId: ProjectId): Promise<ProjectRecord | null>;
  loadEnvironment(environmentId: EnvironmentId): Promise<EnvironmentRecord | null>;

  // --- slug lookups, one per unique index ----------------------------------
  //
  // These exist so a creation can REFUSE legibly. They are not the enforcer:
  // `Organization.slug` is `@unique`, `Project` is `@@unique([organizationId,
  // slug])` and `Environment` is `@@unique([projectId, slug])`, and the index is
  // what makes a duplicate impossible. A read before the write cannot close the
  // window between the two, and this port does not pretend otherwise — an
  // implementation must still surface the index violation, and the in-memory
  // fake raises one so the transaction that hits it is seen to roll back.

  findOrganizationBySlug(slug: Slug): Promise<OrganizationRecord | null>;
  findProjectBySlug(organizationId: OrganizationId, slug: Slug): Promise<ProjectRecord | null>;
  findEnvironmentBySlug(projectId: ProjectId, slug: Slug): Promise<EnvironmentRecord | null>;

  listProjects(organizationId: OrganizationId): Promise<readonly ProjectRecord[]>;
  listEnvironments(projectId: ProjectId): Promise<readonly EnvironmentRecord[]>;

  saveOrganization(organization: OrganizationRecord, transaction: TransactionScope): Promise<void>;
  saveProject(project: ProjectRecord, transaction: TransactionScope): Promise<void>;
  saveEnvironment(environment: EnvironmentRecord, transaction: TransactionScope): Promise<void>;

  // --- membership ----------------------------------------------------------

  /** The `@@unique([organizationId, userId])` lookup. */
  findOrganizationMembershipByUser(
    organizationId: OrganizationId,
    userId: UserId,
  ): Promise<OrganizationMembershipRecord | null>;

  /** The `@@unique([id, organizationId])` lookup — never by id alone. */
  findOrganizationMembershipById(
    organizationId: OrganizationId,
    membershipId: OrganizationMembershipId,
  ): Promise<OrganizationMembershipRecord | null>;

  /** Active OWNER count, read under the organization row lock. */
  countActiveOwners(organizationId: OrganizationId): Promise<number>;

  /** The `@@unique([projectId, organizationMembershipId])` lookup. */
  findProjectMembership(
    projectId: ProjectId,
    organizationMembershipId: OrganizationMembershipId,
  ): Promise<ProjectMembershipRecord | null>;

  saveOrganizationMembership(
    membership: OrganizationMembershipRecord,
    transaction: TransactionScope,
  ): Promise<void>;

  upsertOrganizationMembership(
    upsert: OrganizationMembershipUpsert,
    transaction: TransactionScope,
  ): Promise<OrganizationMembershipRecord>;

  saveProjectMembership(
    membership: ProjectMembershipRecord,
    transaction: TransactionScope,
  ): Promise<void>;

  // --- invitations ---------------------------------------------------------

  /** Exactly the rows `OrganizationInvitation_one_active_per_email` covers. */
  findLiveInvitations(
    organizationId: OrganizationId,
    email: EmailAddress,
  ): Promise<readonly OrganizationInvitationRecord[]>;

  findInvitationByTokenDigest(
    tokenDigest: TokenDigest,
  ): Promise<OrganizationInvitationRecord | null>;

  saveInvitation(
    invitation: OrganizationInvitationRecord,
    transaction: TransactionScope,
  ): Promise<void>;

  /**
   * The compare-and-set consumption: update WHERE id = ? AND acceptedAt IS NULL
   * AND revokedAt IS NULL, returning the affected row count. Returning the
   * COUNT rather than a boolean keeps the oracle's `count !== 1` check
   * expressible without the adapter deciding what the count means.
   */
  consumeInvitation(
    invitationId: OrganizationInvitationId,
    acceptedAt: Date,
    acceptedByUserId: UserId,
    transaction: TransactionScope,
  ): Promise<number>;

  // --- entity (hangs off Project) ------------------------------------------

  findEntity(entityId: EntityId): Promise<EntityRecord | null>;

  /** `@@unique([projectId, externalId])`. There is no environment in this key. */
  findEntityByExternalId(projectId: ProjectId, externalId: string): Promise<EntityRecord | null>;

  listProjectEntities(projectId: ProjectId): Promise<readonly EntityRecord[]>;

  saveEntity(entity: EntityRecord, transaction: TransactionScope): Promise<void>;

  // --- environment sessions ------------------------------------------------

  listOpenEnvironmentSessions(
    environmentId: EnvironmentId,
  ): Promise<readonly EnvironmentSessionRecord[]>;

  saveEnvironmentSession(
    session: EnvironmentSessionRecord,
    transaction: TransactionScope,
  ): Promise<void>;
}
