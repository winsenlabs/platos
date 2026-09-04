// Row -> record mapping for the twenty-three rows `identity-access` owns, and
// the one place a column of one of them is trusted or refused.
//
// Same shape and same reasons as `./mapping.ts`, which does this for tenancy:
// every function is PURE, takes a STRUCTURAL row type rather than a generated
// one, and validates an enum column instead of casting it.
//
// THIS FILE CARRIES FIVE REFUSALS AND FIVE CODES. They are five different
// operational events and a shared code would make them indistinguishable in a
// log — which is the exact defect ADR M0.3's transaction note records for
// `privacy` and for this context. In order of how far the row is from readable:
//
//   UNKNOWN_IDENTITY_PROVIDER          an OperatorIdentity.provider this binary
//                                      has not heard of
//   UNKNOWN_IDENTITY_PRINCIPAL_TIER    a tier column this binary cannot read
//   UNKNOWN_AUTHORIZATION_SCOPE_KIND   a scopeKind outside the schema enum
//   INCONSISTENT_AUTHORIZATION_SCOPE   a scopeKind whose id columns contradict
//                                      it (kind says PROJECT, projectId null)
//   UNRESOLVED_SCOPE_ANCESTRY          a project/environment scope whose
//                                      ancestors the read did not fetch
//
// WHY ANCESTRY HAS TO BE RESOLVED AT ALL, which is a fact about the SCHEMA that
// no in-memory double can carry. The four scoped token tables store the scope as
// `scopeKind` plus three nullable ids, and the migrations' `*_scope_shape_check`
// requires EXACTLY ONE of them to be set — so a PROJECT-scoped row holds
// `projectId` and NOT `organizationId`. The kernel's `ProjectScope` requires
// both. The organization is therefore not in the row and has to be read from the
// project, and an `EnvironmentScope` needs two levels of it. The fake stores the
// assembled `AuthorizationScope` object and never meets this at all.

import type {
  AuthorizationScope,
  AuthorizationScopeKind,
  EnvironmentId,
  OperatorIdentityProvider,
  OrganizationId,
  PrincipalTier,
  ProjectId,
} from "@platos/context-identity-access/application/ports/index.js";
import {
  asIdentifier,
  environmentScope,
  GLOBAL_SCOPE,
  OPERATOR_IDENTITY_PROVIDERS,
  organizationScope,
  PRINCIPAL_TIERS,
  projectScope,
  tenantAuthorizationScope,
} from "@platos/context-identity-access/application/ports/index.js";

import { UnreadableRowError } from "./mapping.js";

/** A stored OperatorIdentity.provider this binary does not recognise. */
export const UNKNOWN_IDENTITY_PROVIDER = "identity.row.unknown_provider";

/** A stored tier on an identity-access row this binary does not recognise. */
export const UNKNOWN_IDENTITY_PRINCIPAL_TIER = "identity.row.unknown_principal_tier";

/** A stored `scopeKind` outside the schema enum. */
export const UNKNOWN_AUTHORIZATION_SCOPE_KIND = "identity.row.unknown_scope_kind";

/** A `scopeKind` whose three nullable id columns contradict it. */
export const INCONSISTENT_AUTHORIZATION_SCOPE = "identity.row.inconsistent_scope";

/** A scoped row whose ancestor rows were not fetched with it. */
export const UNRESOLVED_SCOPE_ANCESTRY = "identity.row.unresolved_scope_ancestry";

export function readIdentityProvider(value: string): OperatorIdentityProvider {
  const known: readonly string[] = OPERATOR_IDENTITY_PROVIDERS;
  if (!known.includes(value)) {
    throw new UnreadableRowError(UNKNOWN_IDENTITY_PROVIDER, "OperatorIdentity.provider", value);
  }
  return value as OperatorIdentityProvider;
}

export function readIdentityTier(column: string, value: string): PrincipalTier {
  const known: readonly string[] = PRINCIPAL_TIERS;
  if (!known.includes(value)) {
    throw new UnreadableRowError(UNKNOWN_IDENTITY_PRINCIPAL_TIER, column, value);
  }
  return value as PrincipalTier;
}

/** The ancestor ids a scoped row does NOT carry, fetched alongside it. */
export interface ScopeAncestry {
  /** `Project.organizationId`, when the row is project-scoped. */
  readonly projectOrganizationId?: string | null;
  /** `Environment.projectId`, when the row is environment-scoped. */
  readonly environmentProjectId?: string | null;
  /** `Environment.project.organizationId`, when the row is environment-scoped. */
  readonly environmentOrganizationId?: string | null;
}

export interface ScopeColumns {
  readonly scopeKind: string;
  readonly organizationId: string | null;
  readonly projectId: string | null;
  readonly environmentId: string | null;
}

const SCOPE_KINDS: readonly string[] = ["GLOBAL", "ORGANIZATION", "PROJECT", "ENVIRONMENT"];

function requireAncestor(column: string, value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    throw new UnreadableRowError(UNRESOLVED_SCOPE_ANCESTRY, column, String(value));
  }
  return value;
}

/**
 * Assemble the four scope columns into the domain's `AuthorizationScope`.
 *
 * The shape check is repeated here and not delegated to the database's
 * `*_scope_shape_check`. Those constraints police what may be WRITTEN; this
 * polices what is READ, and the expand/contract window is exactly the period in
 * which a row written by a binary with a different idea of the shape can be
 * sitting in the table while this one reads it.
 */
export function readAuthorizationScope(
  columns: ScopeColumns,
  ancestry: ScopeAncestry = {},
  table = "row",
): AuthorizationScope {
  if (!SCOPE_KINDS.includes(columns.scopeKind)) {
    throw new UnreadableRowError(
      UNKNOWN_AUTHORIZATION_SCOPE_KIND,
      `${table}.scopeKind`,
      columns.scopeKind,
    );
  }
  const kind = columns.scopeKind as AuthorizationScopeKind;
  const set = [columns.organizationId, columns.projectId, columns.environmentId].filter(
    (value) => value !== null && value !== "",
  ).length;

  if (kind === "GLOBAL") {
    if (set !== 0) {
      throw new UnreadableRowError(
        INCONSISTENT_AUTHORIZATION_SCOPE,
        `${table}.scopeKind`,
        `GLOBAL with ${String(set)} tenant id(s) set`,
      );
    }
    return GLOBAL_SCOPE;
  }
  if (set !== 1) {
    throw new UnreadableRowError(
      INCONSISTENT_AUTHORIZATION_SCOPE,
      `${table}.scopeKind`,
      `${kind} with ${String(set)} tenant id(s) set`,
    );
  }
  if (kind === "ORGANIZATION") {
    if (columns.organizationId === null) {
      throw new UnreadableRowError(
        INCONSISTENT_AUTHORIZATION_SCOPE,
        `${table}.organizationId`,
        "null",
      );
    }
    return tenantAuthorizationScope(
      organizationScope(asIdentifier<OrganizationId>(columns.organizationId)),
    );
  }
  if (kind === "PROJECT") {
    if (columns.projectId === null) {
      throw new UnreadableRowError(INCONSISTENT_AUTHORIZATION_SCOPE, `${table}.projectId`, "null");
    }
    const organizationId = requireAncestor(
      `${table}.project.organizationId`,
      ancestry.projectOrganizationId,
    );
    return tenantAuthorizationScope(
      projectScope(
        asIdentifier<OrganizationId>(organizationId),
        asIdentifier<ProjectId>(columns.projectId),
      ),
    );
  }
  if (columns.environmentId === null) {
    throw new UnreadableRowError(INCONSISTENT_AUTHORIZATION_SCOPE, `${table}.environmentId`, "null");
  }
  const projectId = requireAncestor(
    `${table}.environment.projectId`,
    ancestry.environmentProjectId,
  );
  const organizationId = requireAncestor(
    `${table}.environment.project.organizationId`,
    ancestry.environmentOrganizationId,
  );
  return tenantAuthorizationScope(
    environmentScope(
      asIdentifier<OrganizationId>(organizationId),
      asIdentifier<ProjectId>(projectId),
      asIdentifier<EnvironmentId>(columns.environmentId),
    ),
  );
}

/**
 * The four columns a scope is written as.
 *
 * EXACTLY ONE id is written, and the organization of a project scope is
 * DROPPED. That looks like data loss and is the schema's own rule: the
 * migrations' `*_scope_shape_check` refuses a row that sets two, so writing the
 * organization beside the project would make every project-scoped insert fail.
 * The ancestry is recoverable from the project, which is what `readAuthorizationScope`
 * does.
 */
export function writeAuthorizationScope(scope: AuthorizationScope): ScopeColumns {
  if (scope.kind === "GLOBAL") {
    return { scopeKind: "GLOBAL", organizationId: null, projectId: null, environmentId: null };
  }
  const tenant = scope.tenant;
  if (tenant.level === "organization") {
    return {
      scopeKind: "ORGANIZATION",
      organizationId: tenant.organizationId,
      projectId: null,
      environmentId: null,
    };
  }
  if (tenant.level === "project") {
    return {
      scopeKind: "PROJECT",
      organizationId: null,
      projectId: tenant.projectId,
      environmentId: null,
    };
  }
  return {
    scopeKind: "ENVIRONMENT",
    organizationId: null,
    projectId: null,
    environmentId: tenant.environmentId,
  };
}
