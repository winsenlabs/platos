// The three tenancy enumerations, and the only two role predicates the
// behavioural oracle actually discriminates on.
//
// Modelled as a frozen const object plus a union type rather than a TypeScript
// `enum`: `isolatedModules` is on, a non-const `enum` emits a runtime object a
// pure domain does not need, and a `const enum` cannot cross a package boundary
// under `isolatedModules` at all.

/** Baseline schema `enum OrganizationRole`. */
export const OrganizationRole = {
  OWNER: "OWNER",
  ADMIN: "ADMIN",
  MEMBER: "MEMBER",
} as const;

export type OrganizationRole = (typeof OrganizationRole)[keyof typeof OrganizationRole];

export const ORGANIZATION_ROLES: readonly OrganizationRole[] = Object.freeze([
  OrganizationRole.OWNER,
  OrganizationRole.ADMIN,
  OrganizationRole.MEMBER,
]);

/**
 * Baseline schema `enum ProjectRole`.
 *
 * KNOWN GAP, STATED RATHER THAN QUIETLY CLOSED. Across the whole TypeScript
 * source of this repository, only `ProjectRole.ADMIN` is ever discriminated:
 * the single place a project role is read is the fourth gate of
 * `authorizeEnvironmentOperator`, which asks `projectRole === ADMIN` and
 * nothing else. EDITOR and VIEWER therefore have byte-identical effective
 * permissions today — a VIEWER can do everything an EDITOR can. All three
 * values are modelled because all three exist in the database and are handed
 * out by the product, but no predicate below pretends to separate them. Giving
 * EDITOR a capability VIEWER lacks is a product decision with a migration, not
 * a refactor, so it is recorded here instead of being invented.
 */
export const ProjectRole = {
  ADMIN: "ADMIN",
  EDITOR: "EDITOR",
  VIEWER: "VIEWER",
} as const;

export type ProjectRole = (typeof ProjectRole)[keyof typeof ProjectRole];

export const PROJECT_ROLES: readonly ProjectRole[] = Object.freeze([
  ProjectRole.ADMIN,
  ProjectRole.EDITOR,
  ProjectRole.VIEWER,
]);

/** Baseline schema `enum PrincipalTier`. */
export const PrincipalTier = {
  OPERATOR: "OPERATOR",
  END_USER: "END_USER",
} as const;

export type PrincipalTier = (typeof PrincipalTier)[keyof typeof PrincipalTier];

/**
 * Gate 3 of the oracle, verbatim: `role === OWNER || role === ADMIN`. An
 * organization admin needs no project membership at all — organization
 * administration is a blanket grant over every project in the organization.
 */
export function isOrganizationAdmin(role: OrganizationRole): boolean {
  return role === OrganizationRole.OWNER || role === OrganizationRole.ADMIN;
}

/**
 * Gate 4 of the oracle, verbatim: `projectMembership?.role !== ADMIN`. `null`
 * (no project membership row at all) is not an admin.
 *
 * This is the ONLY place a `ProjectRole` is discriminated. See the note on
 * `ProjectRole` above: EDITOR and VIEWER both fall through here identically.
 */
export function isProjectAdmin(role: ProjectRole | null): boolean {
  return role === ProjectRole.ADMIN;
}

export function isOrganizationRole(value: string): value is OrganizationRole {
  return (ORGANIZATION_ROLES as readonly string[]).includes(value);
}

export function isProjectRole(value: string): value is ProjectRole {
  return (PROJECT_ROLES as readonly string[]).includes(value);
}
