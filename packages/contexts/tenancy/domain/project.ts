// `Project` — the middle level of the tenant tree.
//
// Tenancy is sole writer. Note `@@unique([id, organizationId])` on the table:
// that redundant-looking key exists solely so `ProjectMembership` can hang a
// composite foreign key off it and have the database verify that a membership's
// organization really is the project's organization. See `membership.ts`.

import type { OrganizationId, ProjectId } from "@platos/kernel";

import type { Slug } from "./identifiers.js";

export interface ProjectRecord {
  readonly id: ProjectId;
  readonly organizationId: OrganizationId;
  /** Unique within the organization: `@@unique([organizationId, slug])`. */
  readonly slug: Slug;
  readonly name: string;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function isProjectArchived(project: ProjectRecord): boolean {
  return project.archivedAt !== null;
}

export function archiveProject(project: ProjectRecord, at: Date): ProjectRecord {
  if (project.archivedAt !== null) return project;
  return { ...project, archivedAt: at, updatedAt: at };
}

export function restoreProject(project: ProjectRecord, at: Date): ProjectRecord {
  if (project.archivedAt === null) return project;
  return { ...project, archivedAt: null, updatedAt: at };
}

export function belongsToOrganization(project: ProjectRecord, organizationId: OrganizationId): boolean {
  return project.organizationId === organizationId;
}
