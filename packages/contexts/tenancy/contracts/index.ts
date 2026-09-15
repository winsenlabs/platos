// The published surface of the `tenancy` bounded context.
//
// This is the ONLY thing other contexts and `apps/core-api` may import
// (`cross-context-contracts-only`, ADR M0.3 §5.1 rule (c)). Fifteen of the
// seventeen contexts depend on it, which makes it the most-depended-on surface
// in the graph: everything below is additive-only from here.
//
// `TenancyContract` is the load-bearing name.

import type { EntityId, EnvironmentId, OrganizationId, ProjectId, Result } from "@platos/kernel";
import type { EnvironmentScope, TenantScope } from "@platos/kernel";

import type {
  AncestryLevel,
  EmailAddress,
  EntityRecord,
  EnvironmentAccess,
  EnvironmentOperatorAuthorization,
  EnvironmentRecord,
  OperatorPrincipal,
  OrganizationMembershipId,
  OrganizationMembershipRecord,
  OrganizationRecord,
  OrganizationRole,
  ProjectMembershipRecord,
  ProjectRecord,
  ProjectRole,
  ProjectVisibility,
  UserId,
} from "../domain/index.js";

// --- values other contexts legitimately need at run time --------------------

export { OrganizationRole, ProjectRole, PrincipalTier } from "../domain/roles.js";
export { isOrganizationAdmin, isProjectAdmin } from "../domain/roles.js";
export { resolveScopePathFor } from "../domain/scope-path.js";
export {
  isEnvironmentOperatorAuthorization,
  requireAuthorization,
  authorizes,
} from "../domain/authorization.js";

// --- published types ---------------------------------------------------------

export type {
  AncestryLevel,
  EmailAddress,
  ProjectVisibility,
  EntityRecord,
  EnvironmentAccess,
  EnvironmentAncestry,
  EnvironmentOperatorAuthorization,
  EnvironmentRecord,
  EnvironmentSessionRecord,
  OperatorPrincipal,
  OrganizationInvitationId,
  OrganizationInvitationRecord,
  OrganizationMembershipId,
  OrganizationMembershipRecord,
  OrganizationRecord,
  ProjectMembershipId,
  ProjectMembershipRecord,
  ProjectRecord,
  SessionRevocationOrder,
  Slug,
  TokenDigest,
  UserId,
} from "../domain/index.js";

export * from "./events.js";

// --- read models -------------------------------------------------------------

/**
 * The whole tenant chain above one environment, plus which level (if any) is
 * archived. This is what a downstream context asks for when it needs to know
 * where it is; it never assembles a scope from ids it was handed.
 */
export interface TenantDescriptor {
  readonly scope: EnvironmentScope;
  readonly organization: OrganizationRecord;
  readonly project: ProjectRecord;
  readonly environment: EnvironmentRecord;
  /** The widest archived ancestor, or null when the whole chain is live. */
  readonly archived: AncestryLevel | null;
}

/**
 * Retained from the generated skeleton so no sibling placeholder breaks. It is
 * the tenant descriptor: the "aggregate" tenancy hands out is the resolved
 * tree, not a single row.
 */
export type TenancyAggregate = TenantDescriptor;

/** One row of "my organizations", with the membership that put it there. */
export interface OperatorOrganization {
  readonly organization: OrganizationRecord;
  readonly membership: OrganizationMembershipRecord;
}

/**
 * One row of "projects I can see", and WHY.
 *
 * `through` is published rather than kept private because the two arms of the
 * rule are two different grants: `organization-admin` is the blanket grant an
 * OWNER/ADMIN holds over every project in the organization, and
 * `project-membership` is an explicit row. A consumer that could not tell them
 * apart would have to re-derive the difference, which is the coupling this
 * read model exists to remove.
 */
export interface OperatorProject {
  readonly project: ProjectRecord;
  readonly through: ProjectVisibility;
}

export interface ResolvedEnvironmentScope {
  readonly scope: EnvironmentScope;
  readonly archived: AncestryLevel | null;
}

// --- commands ----------------------------------------------------------------

export interface AuthorizeEnvironmentOperatorRequest {
  /**
   * The LEAF, and nothing above it. There is deliberately no organization or
   * project id on this request: ancestry is re-derived from this id alone, so a
   * caller has nothing to spoof.
   */
  readonly environmentId: EnvironmentId;
  readonly operator: OperatorPrincipal;
  readonly access: EnvironmentAccess;
}

export interface ChangeMembershipRoleRequest {
  readonly organizationId: OrganizationId;
  readonly membershipId: OrganizationMembershipId;
  readonly actorUserId: UserId;
  readonly role: OrganizationRole;
}

export interface AddProjectMemberRequest {
  readonly projectId: ProjectId;
  readonly organizationMembershipId: OrganizationMembershipId;
  /** Verified against the project and the membership; never used to look up. */
  readonly organizationId: OrganizationId;
  readonly role: ProjectRole;
  readonly actorUserId: UserId;
}

export interface CreateOrganizationRequest {
  readonly name: string;
  readonly slug: string;
  /** The operator who will hold the founding OWNER membership. */
  readonly founderUserId: UserId;
}

/**
 * Both rows an organization is born with.
 *
 * The membership is returned rather than left implicit because it is the point:
 * an organization with no owner cannot be administered by anybody, and a caller
 * that never sees the membership cannot tell the two states apart.
 */
export interface CreatedOrganization {
  readonly organization: OrganizationRecord;
  readonly founderMembership: OrganizationMembershipRecord;
}

export interface CreateProjectRequest {
  readonly organizationId: OrganizationId;
  /** Any ACTIVE member of the organization. Receives the ADMIN membership. */
  readonly actorUserId: UserId;
  readonly name: string;
  readonly slug: string;
  readonly environmentName: string;
  readonly environmentSlug: string;
}

/** All three rows one `createProject` commits, or none of them. */
export interface CreatedProject {
  readonly project: ProjectRecord;
  readonly environment: EnvironmentRecord;
  readonly membership: ProjectMembershipRecord;
}

/**
 * D1 (2026-09-15) — issue an invitation. `inviterUserId` is the authorization
 * subject: the use case refuses unless it holds an ACTIVE OWNER/ADMIN membership
 * of `organizationId`. `role` defaults to MEMBER, the only role the Remix route
 * ever invited with; only an OWNER may invite an OWNER.
 */
export interface IssueInvitationRequest {
  readonly organizationId: OrganizationId;
  readonly inviterUserId: UserId;
  readonly email: string;
  readonly role?: OrganizationRole;
}

/**
 * An issued invitation. `token` IS THE SECRET TO DELIVER, returned to the
 * composition root exactly as the use case always returned it — and a transport
 * must not put it in a response: D9 approves no class it would fall in, and
 * `apps/core-api` answers with the other three fields.
 */
export interface IssuedInvitationView {
  readonly invitationId: string;
  readonly token: string;
  readonly expiresAt: Date;
  readonly supersededCount: number;
}

/** Accept one. The address is the one the accepting operator PROVED control of. */
export interface AcceptInvitationRequest {
  readonly token: string;
  readonly userId: UserId;
  readonly email: string;
}

export interface AcceptedInvitationView {
  readonly organizationId: OrganizationId;
  readonly role: OrganizationRole;
  readonly membership: OrganizationMembershipRecord;
}

/** The team listing's request. Keyed by the organization named and the actor authenticated. */
export interface ListOrganizationMembersRequest {
  readonly organizationId: OrganizationId;
  readonly actorUserId: UserId;
}

/** One active member, and the operator account behind it (null when absent). */
export interface OrganizationMemberView {
  readonly membership: OrganizationMembershipRecord;
  readonly account: {
    readonly email: EmailAddress;
    /** `User.displayName`, or null; the team page renders it ahead of the address. */
    readonly displayName: string | null;
    readonly disabledAt: Date | null;
  } | null;
}

/** An environment addressed by the three slugs of a dashboard URL. */
export interface ResolveOperatorEnvironmentRequest {
  readonly organizationSlug: string;
  readonly projectSlug: string;
  readonly environmentSlug: string;
  readonly operator: OperatorPrincipal;
  readonly access: EnvironmentAccess;
}

/** The scope resolver's answer: the minted authorization plus what a switcher lists. */
export interface OperatorEnvironmentView {
  readonly authorization: EnvironmentOperatorAuthorization;
  readonly organization: OrganizationRecord;
  readonly project: ProjectRecord;
  readonly environment: EnvironmentRecord;
  readonly environments: readonly EnvironmentRecord[];
}

export interface RevokeAccessKeyGenerationRequest {
  readonly environmentId: EnvironmentId;
  readonly expectedGeneration?: number;
}

export interface MembershipMutationResult {
  readonly changed: boolean;
  readonly revokedSessionCount: number;
}

// --- the contract ------------------------------------------------------------

/**
 * What tenancy offers the rest of the system.
 *
 * Every method returns the kernel `Result<T>` rather than throwing: a failure a
 * caller must handle is visible in the type, and an exception crossing this
 * boundary means a defect.
 */
export interface TenancyContract {
  readonly name: "tenancy";

  /**
   * The scope resolver every other context depends on. ADR M0.3 §1: tenancy
   * "resolves the tenant/env scope every other context is keyed by".
   */
  resolveEnvironmentScope(environmentId: EnvironmentId): Promise<Result<ResolvedEnvironmentScope>>;

  describeTenant(environmentId: EnvironmentId): Promise<Result<TenantDescriptor>>;

  /**
   * The four-gate RBAC decision. The returned value is frozen and branded: a
   * caller cannot construct one, and `isEnvironmentOperatorAuthorization`
   * rejects anything this method did not mint.
   */
  authorizeEnvironmentOperator(
    request: AuthorizeEnvironmentOperatorRequest,
  ): Promise<Result<EnvironmentOperatorAuthorization>>;

  /**
   * Re-check an authorization that crossed a boundary where its type was erased
   * (a job payload, a JSON round trip, an `unknown` from a transport).
   */
  verifyAuthorization(value: unknown): Result<EnvironmentOperatorAuthorization>;

  /**
   * Create an organization and its founding OWNER membership, atomically.
   *
   * Tenancy could archive, rename and re-role an organization and could not make
   * one: the only creator was a Prisma nested write in the Remix route. Both
   * rows commit together, because an organization with no owner has almost no
   * path back — `changeMembershipRole` and `addProjectMember` both refuse an
   * actor who is not an active organization admin, and since D1 (2026-09-15)
   * so does `issueInvitation`, which was the one path that did not. See
   * `application/create-organization.ts`.
   */
  createOrganization(request: CreateOrganizationRequest): Promise<Result<CreatedOrganization>>;

  /**
   * Create a project, its first environment and the creator's ADMIN project
   * membership, in ONE unit of work.
   *
   * A project with no environment is unreachable — every route below a project
   * is keyed by one — and a project whose creator holds no membership is lost to
   * any creator who is not already an organization admin. The `$transaction` in
   * the Remix route is the only place that invariant has ever lived.
   */
  createProject(request: CreateProjectRequest): Promise<Result<CreatedProject>>;

  changeMembershipRole(
    request: ChangeMembershipRoleRequest,
  ): Promise<Result<MembershipMutationResult>>;

  deactivateMembership(
    request: Omit<ChangeMembershipRoleRequest, "role">,
  ): Promise<Result<MembershipMutationResult>>;

  addProjectMember(request: AddProjectMemberRequest): Promise<Result<ProjectMembershipRecord>>;

  findOrganizationMembership(
    organizationId: OrganizationId,
    userId: UserId,
  ): Promise<Result<OrganizationMembershipRecord>>;

  /**
   * D1 (2026-09-15) — issue an invitation, refused `TENANCY_INVITATION_FORBIDDEN`
   * unless the inviter is an ACTIVE OWNER/ADMIN of the organization.
   *
   * Published because the Remix invite route is one of the operations T8 deletes
   * and a V1 route may only reach a contract method. The rule it carried moved
   * INTO the use case first, so deleting the route deletes no authorization.
   */
  issueInvitation(request: IssueInvitationRequest): Promise<Result<IssuedInvitationView>>;

  /** Spend an invitation token for the operator who proved the invited address. */
  acceptInvitation(request: AcceptInvitationRequest): Promise<Result<AcceptedInvitationView>>;

  /**
   * The ACTIVE members of one organization with each one's sign-in address, oldest
   * first — `settings.team`'s loader, ported. Refused
   * `TENANCY_MEMBER_LIST_FORBIDDEN` unless the actor is an active OWNER/ADMIN.
   */
  listOrganizationMembers(
    request: ListOrganizationMembersRequest,
  ): Promise<Result<readonly OrganizationMemberView[]>>;

  /**
   * The environment a dashboard URL's three slugs name, authorized for the
   * operator, with its live siblings — `requireEnvironmentScope`, ported.
   * `TENANCY_NOT_FOUND` when no live environment has those slugs, and the four-gate
   * refusal unchanged when one does and the operator may not see it.
   */
  resolveOperatorEnvironment(
    request: ResolveOperatorEnvironmentRequest,
  ): Promise<Result<OperatorEnvironmentView>>;

  /**
   * "My organizations", in the order the dashboard lands an operator in them.
   *
   * Keyed by the operator alone. There is no organization id on this call, so a
   * caller has nothing to substitute — the same property
   * `authorizeEnvironmentOperator` gets from taking only the leaf.
   */
  listOperatorOrganizations(userId: UserId): Promise<Result<readonly OperatorOrganization[]>>;

  /**
   * "Projects I can see", and by which grant.
   *
   * This replaces `operatorVisibleProjectWhere`, an authorization rule that
   * existed only as a `Prisma.ProjectWhereInput` in the Remix tree. The rule is
   * ported, not the query: an organization OWNER/ADMIN sees every unarchived
   * project in the organization, everybody else sees exactly the projects they
   * hold a membership on, and a deactivated organization membership hides all of
   * them without a single `ProjectMembership` row changing.
   */
  listVisibleProjects(userId: UserId): Promise<Result<readonly OperatorProject[]>>;

  /**
   * `Entity` hangs off `Project`, not `Environment` (see domain/entity.ts), so
   * this is the only shape the lookup can take. There is no
   * `listEnvironmentEntities`: which of a project's entities are wired into an
   * environment is `EnvironmentEntityTool`, owned by `tools`.
   */
  listProjectEntities(projectId: ProjectId): Promise<Result<readonly EntityRecord[]>>;

  findEntity(entityId: EntityId): Promise<Result<EntityRecord>>;

  /**
   * Advance `Environment.accessKeyRevocationVersion`.
   *
   * Published so identity-access stops writing a tenancy-owned column directly
   * — the single-writer violation documented on
   * `EnvironmentAccessKeyRevocationCounter`. Returns the new generation.
   */
  revokeAccessKeyGeneration(
    request: RevokeAccessKeyGenerationRequest,
  ): Promise<Result<number>>;

  /** Containment, for a caller holding two scopes. Delegates to the kernel. */
  scopeContains(outer: TenantScope, inner: TenantScope): boolean;
}
