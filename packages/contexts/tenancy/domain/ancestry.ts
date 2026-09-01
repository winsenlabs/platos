// Ancestry: the three tenant-tree rows that stand above one environment, loaded
// together, and the scope they resolve to.
//
// RE-DERIVATION IS THE SECURITY CONTROL. The oracle's
// `authorizeEnvironmentOperator` loads ancestry with a single
// `environment.findUnique({ where: { id: environmentId } })` that pulls the
// project and organization through relations, and it never looks at an
// organization id or project id supplied by the caller. Its comment says so:
// "Callers pass the result of operator-session authentication, never tenant IDs
// copied from request headers."
//
// That is not a convenience. If the caller supplied the organization id, an
// attacker with a valid membership in organization A could present environment
// E from organization B alongside organization A's id and be checked against
// the wrong tree. Every ancestry in this context therefore originates from the
// LEAF identifier, and `EnvironmentAncestry` is the only way to obtain a scope.

import { contains, environmentScope, type EnvironmentScope, type TenantScope } from "@platos/kernel";

import { isEnvironmentArchived, type EnvironmentRecord } from "./environment.js";
import { isOrganizationArchived, type OrganizationRecord } from "./organization.js";
import { isProjectArchived, type ProjectRecord } from "./project.js";

export type AncestryLevel = "organization" | "project" | "environment";

/**
 * The three rows above and including one environment, as one value. Assembled
 * only by a repository that started from an `EnvironmentId`.
 */
export interface EnvironmentAncestry {
  readonly organization: OrganizationRecord;
  readonly project: ProjectRecord;
  readonly environment: EnvironmentRecord;
}

/**
 * True when the three rows really are parent and child. A repository that
 * assembled the ancestry from relations cannot produce an inconsistent one, but
 * an in-memory fake, a cache, or a future denormalized read model can, and a
 * mismatched ancestry is exactly a cross-tenant authorization.
 */
export function isAncestryConsistent(ancestry: EnvironmentAncestry): boolean {
  return (
    ancestry.project.organizationId === ancestry.organization.id &&
    ancestry.environment.projectId === ancestry.project.id
  );
}

/** The kernel scope this ancestry addresses. The only constructor of one. */
export function ancestryScope(ancestry: EnvironmentAncestry): EnvironmentScope {
  return environmentScope(ancestry.organization.id, ancestry.project.id, ancestry.environment.id);
}

/**
 * Gate 1 of the oracle: which level, if any, is archived.
 *
 * Archival propagates DOWNWARD in effect. The oracle tests all three
 * (`environment.archivedAt || project.archivedAt || organization.archivedAt`)
 * in one condition, so archiving an organization denies every environment
 * beneath it without touching a single descendant row. The widest archived
 * ancestor is reported so a log records the real cause rather than the leaf.
 */
export function archivedAncestor(ancestry: EnvironmentAncestry): AncestryLevel | null {
  if (isOrganizationArchived(ancestry.organization)) return "organization";
  if (isProjectArchived(ancestry.project)) return "project";
  if (isEnvironmentArchived(ancestry.environment)) return "environment";
  return null;
}

export function isAncestryLive(ancestry: EnvironmentAncestry): boolean {
  return archivedAncestor(ancestry) === null;
}

/**
 * Containment, delegated to the kernel's single `contains()` predicate rather
 * than re-implemented by comparing ids field by field. Scope comparison exists
 * once in this codebase; every authorization decision reduces to it.
 */
export function ancestryContains(ancestry: EnvironmentAncestry, inner: TenantScope): boolean {
  return contains(ancestryScope(ancestry), inner);
}

/** True when `outer` (any level) contains this environment. */
export function ancestryWithin(ancestry: EnvironmentAncestry, outer: TenantScope): boolean {
  return contains(outer, ancestryScope(ancestry));
}
