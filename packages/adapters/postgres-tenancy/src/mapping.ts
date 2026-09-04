// Row -> record mapping, and the one place a column is trusted or refused.
//
// Every function here is PURE and takes a structural row type rather than a
// generated one. That is deliberate: the generated types come from a client
// that has to be built before it exists, and a mapping suite that could only run
// after `prisma generate` would be a suite nobody runs. The structural types
// below are checked against the generated ones where the repository calls these
// functions, so a schema change still breaks the build — it just breaks it at
// the call site instead of here.
//
// ENUM COLUMNS ARE VALIDATED, NOT CAST. A role arrives from the database as a
// string. Casting it to the domain union would make a row written by an older
// binary — or by a migration that added a value this binary has not heard of —
// silently become a role this code then makes authorization decisions with.
// Both refusals below carry their own code, because "the row is not readable by
// this binary" and "the row is not readable by this binary in a DIFFERENT way"
// are separate operational events during the expand/contract window when two
// binaries share one database.

import {
  asIdentifier,
  isOrganizationRole,
  isProjectRole,
  PrincipalTier,
} from "@platos/context-tenancy/application/ports/index.js";
import type {
  EntityId,
  EntityRecord,
  EnvironmentId,
  EnvironmentRecord,
  EnvironmentSessionId,
  EnvironmentSessionRecord,
  OperatorSessionId,
  OrganizationId,
  OrganizationInvitationId,
  OrganizationInvitationRecord,
  OrganizationMembershipId,
  OrganizationMembershipRecord,
  OrganizationRecord,
  OrganizationRole,
  ProjectId,
  ProjectMembershipId,
  ProjectMembershipRecord,
  ProjectRecord,
  ProjectRole,
  Slug,
  EmailAddress,
  TokenDigest,
  UserId,
} from "@platos/context-tenancy/application/ports/index.js";

/** A stored organization role this binary does not recognise. */
export const UNKNOWN_ORGANIZATION_ROLE = "tenancy.row.unknown_organization_role";

/** A stored project role this binary does not recognise. */
export const UNKNOWN_PROJECT_ROLE = "tenancy.row.unknown_project_role";

/** A stored principal tier this binary does not recognise. */
export const UNKNOWN_PRINCIPAL_TIER = "tenancy.row.unknown_principal_tier";

export class UnreadableRowError extends Error {
  readonly code: string;
  readonly column: string;
  readonly value: string;

  constructor(code: string, column: string, value: string) {
    super(`${column} holds ${JSON.stringify(value)}, which this binary cannot read`);
    this.name = "UnreadableRowError";
    this.code = code;
    this.column = column;
    this.value = value;
  }
}

export function readOrganizationRole(value: string): OrganizationRole {
  if (!isOrganizationRole(value)) {
    throw new UnreadableRowError(UNKNOWN_ORGANIZATION_ROLE, "OrganizationMembership.role", value);
  }
  return value;
}

export function readProjectRole(value: string): ProjectRole {
  if (!isProjectRole(value)) {
    throw new UnreadableRowError(UNKNOWN_PROJECT_ROLE, "ProjectMembership.role", value);
  }
  return value;
}

export function readPrincipalTier(value: string): typeof PrincipalTier[keyof typeof PrincipalTier] {
  if (value !== PrincipalTier.OPERATOR && value !== PrincipalTier.END_USER) {
    throw new UnreadableRowError(UNKNOWN_PRINCIPAL_TIER, "EnvironmentSession.tier", value);
  }
  return value;
}

// --- structural row shapes -------------------------------------------------

export interface OrganizationRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ProjectRow extends OrganizationRow {
  readonly organizationId: string;
}

export interface EnvironmentRow {
  readonly id: string;
  readonly projectId: string;
  readonly slug: string;
  readonly name: string;
  readonly archivedAt: Date | null;
  readonly accessKeyRevocationVersion: number;
  readonly memoryFeedbackBackfillCursor: string | null;
  readonly memoryFeedbackBackfillCompletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OrganizationMembershipRow {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly role: string;
  readonly deactivatedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ProjectMembershipRow {
  readonly id: string;
  readonly projectId: string;
  readonly organizationMembershipId: string;
  readonly organizationId: string;
  readonly role: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OrganizationInvitationRow {
  readonly id: string;
  readonly organizationId: string;
  readonly inviterId: string | null;
  readonly acceptedByUserId: string | null;
  readonly email: string;
  readonly role: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

export interface EntityRow {
  readonly id: string;
  readonly projectId: string;
  readonly externalId: string;
  readonly displayName: string;
  readonly connectionStatus: string;
  readonly connectionKind: string;
  readonly mcpUrls: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly capabilities: readonly string[];
  readonly lastConnectedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface EnvironmentSessionRow {
  readonly id: string;
  readonly environmentId: string;
  readonly operatorSessionId: string;
  readonly tier: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly lastSeenAt: Date | null;
  readonly endedAt: Date | null;
  readonly createdAt: Date;
}

// --- row -> record ---------------------------------------------------------

export function toOrganization(row: OrganizationRow): OrganizationRecord {
  return {
    id: asIdentifier<OrganizationId>(row.id),
    slug: asIdentifier<Slug>(row.slug),
    name: row.name,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toProject(row: ProjectRow): ProjectRecord {
  return {
    id: asIdentifier<ProjectId>(row.id),
    organizationId: asIdentifier<OrganizationId>(row.organizationId),
    slug: asIdentifier<Slug>(row.slug),
    name: row.name,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toEnvironment(row: EnvironmentRow): EnvironmentRecord {
  return {
    id: asIdentifier<EnvironmentId>(row.id),
    projectId: asIdentifier<ProjectId>(row.projectId),
    slug: asIdentifier<Slug>(row.slug),
    name: row.name,
    archivedAt: row.archivedAt,
    accessKeyRevocationVersion: row.accessKeyRevocationVersion,
    memoryFeedbackBackfillCursor: row.memoryFeedbackBackfillCursor,
    memoryFeedbackBackfillCompletedAt: row.memoryFeedbackBackfillCompletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toOrganizationMembership(
  row: OrganizationMembershipRow,
): OrganizationMembershipRecord {
  return {
    id: asIdentifier<OrganizationMembershipId>(row.id),
    organizationId: asIdentifier<OrganizationId>(row.organizationId),
    userId: asIdentifier<UserId>(row.userId),
    role: readOrganizationRole(row.role),
    deactivatedAt: row.deactivatedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toProjectMembership(row: ProjectMembershipRow): ProjectMembershipRecord {
  return {
    id: asIdentifier<ProjectMembershipId>(row.id),
    projectId: asIdentifier<ProjectId>(row.projectId),
    organizationMembershipId: asIdentifier<OrganizationMembershipId>(row.organizationMembershipId),
    organizationId: asIdentifier<OrganizationId>(row.organizationId),
    role: readProjectRole(row.role),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toInvitation(row: OrganizationInvitationRow): OrganizationInvitationRecord {
  return {
    id: asIdentifier<OrganizationInvitationId>(row.id),
    organizationId: asIdentifier<OrganizationId>(row.organizationId),
    inviterId: row.inviterId === null ? null : asIdentifier<UserId>(row.inviterId),
    acceptedByUserId:
      row.acceptedByUserId === null ? null : asIdentifier<UserId>(row.acceptedByUserId),
    email: asIdentifier<EmailAddress>(row.email),
    role: readOrganizationRole(row.role),
    tokenDigest: asIdentifier<TokenDigest>(row.tokenHash),
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

export function toEntity(row: EntityRow): EntityRecord {
  return {
    id: asIdentifier<EntityId>(row.id),
    projectId: asIdentifier<ProjectId>(row.projectId),
    externalId: row.externalId,
    displayName: row.displayName,
    connectionStatus: row.connectionStatus,
    connectionKind: row.connectionKind,
    mcpUrls: [...row.mcpUrls],
    allowedOrigins: [...row.allowedOrigins],
    capabilities: [...row.capabilities],
    lastConnectedAt: row.lastConnectedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toEnvironmentSession(row: EnvironmentSessionRow): EnvironmentSessionRecord {
  return {
    id: asIdentifier<EnvironmentSessionId>(row.id),
    environmentId: asIdentifier<EnvironmentId>(row.environmentId),
    operatorSessionId: asIdentifier<OperatorSessionId>(row.operatorSessionId),
    tier: readPrincipalTier(row.tier),
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    lastSeenAt: row.lastSeenAt,
    endedAt: row.endedAt,
    createdAt: row.createdAt,
  };
}
