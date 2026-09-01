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
