// `Organization` — the root of the tenant tree and the archival root.
//
// Tenancy is sole writer of this row (ADR M0.3 §1, context 2).

import type { OrganizationId } from "@platos/kernel";

import type { Slug } from "./identifiers.js";

export interface OrganizationRecord {
  readonly id: OrganizationId;
  /** Globally unique: `Organization.slug` carries a plain `@unique`. */
  readonly slug: Slug;
  readonly name: string;
  /**
   * Archival is a soft state, never a delete. An archived organization denies
   * every operator authorization beneath it (gate 1) while its rows stay
   * readable for audit, billing reconciliation and right-to-erasure planning.
   */
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function isOrganizationArchived(organization: OrganizationRecord): boolean {
  return organization.archivedAt !== null;
}

export function archiveOrganization(organization: OrganizationRecord, at: Date): OrganizationRecord {
  if (organization.archivedAt !== null) return organization;
  return { ...organization, archivedAt: at, updatedAt: at };
}

/**
 * Un-archival exists so an archived organization is recoverable, and it does
 * NOT cascade: a project archived on its own stays archived when its
 * organization is restored, because the two decisions were taken separately.
 * Archival propagates downward in EFFECT (see `archivedAncestor`), never by
 * rewriting descendant rows, so restoring a parent cannot silently resurrect a
 * child somebody deliberately archived.
 */
export function restoreOrganization(organization: OrganizationRecord, at: Date): OrganizationRecord {
  if (organization.archivedAt === null) return organization;
  return { ...organization, archivedAt: null, updatedAt: at };
}

export function renameOrganization(
  organization: OrganizationRecord,
  name: string,
  at: Date,
): OrganizationRecord {
  return { ...organization, name, updatedAt: at };
}
