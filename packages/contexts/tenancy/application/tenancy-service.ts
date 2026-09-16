// The composition of tenancy's use cases into the published `TenancyContract`.
//
// This is the only file that knows both halves. It exists so the contract is
// demonstrably INHABITABLE — a published interface nothing implements is a
// wish — and so `apps/core-api` wires one object rather than eleven closures.
//
// It holds no state and takes no decision: every method delegates to a use case
// or to the kernel.

import type { EntityId, EnvironmentId, OrganizationId, ProjectId, Result } from "@platos/kernel";
import { contains, err, ok, type TenantScope } from "@platos/kernel";

import {
  OrganizationRole,
  ancestryScope,
  archivedAncestor,
  requireAuthorization,
  tenantNotFound,
  type EntityRecord,
  type OrganizationMembershipRecord,
  type UserId,
} from "../domain/index.js";
import type {
  AcceptInvitationRequest,
  AddProjectMemberRequest,
  AuthorizeEnvironmentOperatorRequest,
  IssueInvitationRequest,
  ListOrganizationMembersRequest,
  ResolveOperatorEnvironmentRequest,
  ChangeMembershipRoleRequest,
  CreateOrganizationRequest,
  CreateProjectRequest,
  MembershipMutationResult,
  RecordEntityConnectionCommand,
  ResolvedEnvironmentScope,
  RevokeAccessKeyGenerationRequest,
  TenancyContract,
  TenantDescriptor,
} from "../contracts/index.js";

import { createAddProjectMember } from "./add-project-member.js";
import { createAuthorizeEnvironmentOperator } from "./authorize-environment-operator.js";
import { createChangeMembershipRole, createDeactivateMembership } from "./change-membership-role.js";
import { createCreateOrganization } from "./create-organization.js";
import { createCreateProject } from "./create-project.js";
import { createAcceptInvitation, createIssueInvitation } from "./invitations.js";
import { createListOrganizationMembers } from "./organization-members.js";
import { createResolveOperatorEnvironment } from "./resolve-operator-environment.js";
import {
  createListOperatorOrganizations,
  createListVisibleProjects,
} from "./operator-read-models.js";
import type { TenancyDependencies } from "./dependencies.js";
import { createRecordEntityConnection } from "./record-entity-connection.js";
import { createRevokeAccessKeyGeneration } from "./revoke-access-key-generation.js";

export function createTenancyService(dependencies: TenancyDependencies): TenancyContract {
  const { repository } = dependencies;
  const authorizeEnvironmentOperator = createAuthorizeEnvironmentOperator(dependencies);
  const changeMembershipRole = createChangeMembershipRole(dependencies);
  const deactivateMembership = createDeactivateMembership(dependencies);
  const addProjectMember = createAddProjectMember(dependencies);
  const createOrganization = createCreateOrganization(dependencies);
  const createProject = createCreateProject(dependencies);
  const listOperatorOrganizations = createListOperatorOrganizations(dependencies);
  const listVisibleProjects = createListVisibleProjects(dependencies);
  const revokeAccessKeyGeneration = createRevokeAccessKeyGeneration(dependencies);
  const issueInvitation = createIssueInvitation(dependencies);
  const acceptInvitation = createAcceptInvitation(dependencies);
  const listOrganizationMembers = createListOrganizationMembers(dependencies);
  // The SAME authorize closure every other caller gets, so the slug resolver and
  // the id-keyed route cannot disagree about the four gates.
  const resolveOperatorEnvironment = createResolveOperatorEnvironment(
    dependencies,
    authorizeEnvironmentOperator,
  );
  const recordEntityConnection = createRecordEntityConnection(dependencies);

  return {
    name: "tenancy",

    async resolveEnvironmentScope(
      environmentId: EnvironmentId,
    ): Promise<Result<ResolvedEnvironmentScope>> {
      const ancestry = await repository.loadEnvironmentAncestry(environmentId);
      if (ancestry === null) return err(tenantNotFound("environment"));
      return ok({ scope: ancestryScope(ancestry), archived: archivedAncestor(ancestry) });
    },

    async describeTenant(environmentId: EnvironmentId): Promise<Result<TenantDescriptor>> {
      const ancestry = await repository.loadEnvironmentAncestry(environmentId);
      if (ancestry === null) return err(tenantNotFound("environment"));
      return ok({
        scope: ancestryScope(ancestry),
        organization: ancestry.organization,
        project: ancestry.project,
        environment: ancestry.environment,
        archived: archivedAncestor(ancestry),
      });
    },

    authorizeEnvironmentOperator: (request: AuthorizeEnvironmentOperatorRequest) =>
      authorizeEnvironmentOperator(request),

    verifyAuthorization: (value: unknown) => requireAuthorization(value),

    createOrganization: (request: CreateOrganizationRequest) => createOrganization(request),

    createProject: (request: CreateProjectRequest) => createProject(request),

    changeMembershipRole: (request: ChangeMembershipRoleRequest) => changeMembershipRole(request),

    deactivateMembership: (
      request: Omit<ChangeMembershipRoleRequest, "role">,
    ): Promise<Result<MembershipMutationResult>> => deactivateMembership(request),

    addProjectMember: (request: AddProjectMemberRequest) => addProjectMember(request),

    async findOrganizationMembership(
      organizationId: OrganizationId,
      userId: UserId,
    ): Promise<Result<OrganizationMembershipRecord>> {
      const membership = await repository.findOrganizationMembershipByUser(organizationId, userId);
      if (membership === null) return err(tenantNotFound("organization"));
      return ok(membership);
    },

    issueInvitation: async (request: IssueInvitationRequest) => {
      const issued = await issueInvitation({
        organizationId: request.organizationId,
        inviterId: request.inviterUserId,
        email: request.email,
        role: request.role ?? OrganizationRole.MEMBER,
      });
      return issued.ok
        ? ok({
            invitationId: issued.value.invitationId,
            token: issued.value.token,
            expiresAt: issued.value.expiresAt,
            supersededCount: issued.value.supersededCount,
          })
        : issued;
    },

    acceptInvitation: (request: AcceptInvitationRequest) =>
      acceptInvitation({ token: request.token, userId: request.userId, email: request.email }),

    listOrganizationMembers: (request: ListOrganizationMembersRequest) =>
      listOrganizationMembers({
        organizationId: request.organizationId,
        actorUserId: request.actorUserId,
      }),

    resolveOperatorEnvironment: (request: ResolveOperatorEnvironmentRequest) =>
      resolveOperatorEnvironment(request),

    listOperatorOrganizations: (userId: UserId) => listOperatorOrganizations(userId),

    listVisibleProjects: (userId: UserId) => listVisibleProjects(userId),

    async listProjectEntities(projectId: ProjectId): Promise<Result<readonly EntityRecord[]>> {
      const project = await repository.loadProject(projectId);
      if (project === null) return err(tenantNotFound("project"));
      return ok(await repository.listProjectEntities(projectId));
    },

    async findEntity(entityId: EntityId): Promise<Result<EntityRecord>> {
      const entity = await repository.findEntity(entityId);
      if (entity === null) return err(tenantNotFound("entity"));
      return ok(entity);
    },

    recordEntityConnection: (command: RecordEntityConnectionCommand) =>
      recordEntityConnection(command),

    revokeAccessKeyGeneration: (request: RevokeAccessKeyGenerationRequest) =>
      revokeAccessKeyGeneration(request),

    scopeContains: (outer: TenantScope, inner: TenantScope) => contains(outer, inner),
  };
}
