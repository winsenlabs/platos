// Canonical record builders.
//
// Pure functions that produce a valid instance of each tenancy record with
// sensible defaults, so a test states only the field it is actually about. They
// live in `domain/` rather than beside a test because the domain's own tests,
// the application's tests and the adapter's contract tests must all build the
// SAME records — three private sets of builders drifting apart is how a fixture
// starts asserting something the production shape no longer says.
//
// Nothing here is a policy: every default is the schema's default (`archivedAt`
// null, `role` MEMBER / VIEWER, `accessKeyRevocationVersion` 0), and every
// builder takes an override bag.

import type { EntityId, EnvironmentId, OrganizationId, ProjectId } from "@platos/kernel";
import { asIdentifier } from "@platos/kernel";

import type { EntityRecord } from "./entity.js";
import type { EnvironmentRecord } from "./environment.js";
import type {
  OrganizationMembershipId,
  ProjectMembershipId,
  Slug,
  UserId,
} from "./identifiers.js";
import type { OrganizationMembershipRecord, ProjectMembershipRecord } from "./membership.js";
import type { OrganizationRecord } from "./organization.js";
import type { ProjectRecord } from "./project.js";
import { OrganizationRole, ProjectRole } from "./roles.js";

/** A fixed instant, so every builder is deterministic. */
export const RECORD_EPOCH = new Date("2026-01-01T00:00:00.000Z");

export function organizationId(value: string): OrganizationId {
  return asIdentifier<OrganizationId>(value);
}
export function projectId(value: string): ProjectId {
  return asIdentifier<ProjectId>(value);
}
export function environmentId(value: string): EnvironmentId {
  return asIdentifier<EnvironmentId>(value);
}
export function entityId(value: string): EntityId {
  return asIdentifier<EntityId>(value);
}
export function userId(value: string): UserId {
  return asIdentifier<UserId>(value);
}
export function membershipId(value: string): OrganizationMembershipId {
  return asIdentifier<OrganizationMembershipId>(value);
}
export function projectMembershipId(value: string): ProjectMembershipId {
  return asIdentifier<ProjectMembershipId>(value);
}
export function slug(value: string): Slug {
  return asIdentifier<Slug>(value);
}

export function anOrganization(
  id: string,
  overrides: Partial<OrganizationRecord> = {},
): OrganizationRecord {
  return {
    id: organizationId(id),
    slug: slug(id),
    name: id,
    archivedAt: null,
    createdAt: RECORD_EPOCH,
    updatedAt: RECORD_EPOCH,
    ...overrides,
  };
}

export function aProject(
  id: string,
  organization: OrganizationId,
  overrides: Partial<ProjectRecord> = {},
): ProjectRecord {
  return {
    id: projectId(id),
    organizationId: organization,
    slug: slug(id),
    name: id,
    archivedAt: null,
    createdAt: RECORD_EPOCH,
    updatedAt: RECORD_EPOCH,
    ...overrides,
  };
}

export function anEnvironment(
  id: string,
  project: ProjectId,
  overrides: Partial<EnvironmentRecord> = {},
): EnvironmentRecord {
  return {
    id: environmentId(id),
    projectId: project,
    slug: slug(id),
    name: id,
    archivedAt: null,
    accessKeyRevocationVersion: 0,
    memoryFeedbackBackfillCursor: null,
    memoryFeedbackBackfillCompletedAt: null,
    createdAt: RECORD_EPOCH,
    updatedAt: RECORD_EPOCH,
    ...overrides,
  };
}

export function anOrganizationMembership(
  id: string,
  organization: OrganizationId,
  user: UserId,
  overrides: Partial<OrganizationMembershipRecord> = {},
): OrganizationMembershipRecord {
  return {
    id: membershipId(id),
    organizationId: organization,
    userId: user,
    role: OrganizationRole.MEMBER,
    deactivatedAt: null,
    createdAt: RECORD_EPOCH,
    updatedAt: RECORD_EPOCH,
    ...overrides,
  };
}

export function aProjectMembership(
  id: string,
  project: ProjectRecord,
  organizationMembership: OrganizationMembershipRecord,
  overrides: Partial<ProjectMembershipRecord> = {},
): ProjectMembershipRecord {
  return {
    id: projectMembershipId(id),
    projectId: project.id,
    organizationMembershipId: organizationMembership.id,
    // Derived from the project, exactly as the composite foreign key derives it.
    // An override here is how a test forges a cross-tenant row.
    organizationId: project.organizationId,
    role: ProjectRole.VIEWER,
    createdAt: RECORD_EPOCH,
    updatedAt: RECORD_EPOCH,
    ...overrides,
  };
}

export function anEntity(
  id: string,
  project: ProjectId,
  overrides: Partial<EntityRecord> = {},
): EntityRecord {
  return {
    id: entityId(id),
    projectId: project,
    externalId: id,
    displayName: id,
    connectionStatus: "connected",
    connectionKind: "mcp",
    mcpUrls: [],
    allowedOrigins: [],
    capabilities: [],
    lastConnectedAt: null,
    createdAt: RECORD_EPOCH,
    updatedAt: RECORD_EPOCH,
    ...overrides,
  };
}
