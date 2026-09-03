// Tenancy and request scope.
//
// ADR M0.3 §1 (context 2, `tenancy`) makes Organization -> Project ->
// Environment -> Entity the tree every other context is keyed by, and §7
// decision 6 fixes Entity as the structural leaf of that tree rather than a
// channel-specific record.
//
// Scope is modelled as a discriminated union rather than a bag of nullable ids.
// With nullable fields, "is this environment-scoped?" is a runtime question that
// every caller must remember to ask, and forgetting is silent. With a union it
// is a compile-time question the checker answers, and an environment-scoped
// operation cannot be handed an organization scope at all. Cross-scope denial is
// the property this programme cannot get wrong, so it belongs in the type.

import type { EnvironmentId, OrganizationId, PrincipalId, ProjectId, RequestId } from "./identifier.js";

export type ScopeLevel = "organization" | "project" | "environment";

export interface OrganizationScope {
  readonly level: "organization";
  readonly organizationId: OrganizationId;
}

export interface ProjectScope {
  readonly level: "project";
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
}

export interface EnvironmentScope {
  readonly level: "environment";
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly environmentId: EnvironmentId;
}

/** Where in the tenant tree an operation is addressed. */
export type TenantScope = OrganizationScope | ProjectScope | EnvironmentScope;

export function organizationScope(organizationId: OrganizationId): OrganizationScope {
  return { level: "organization", organizationId };
}

export function projectScope(organizationId: OrganizationId, projectId: ProjectId): ProjectScope {
  return { level: "project", organizationId, projectId };
}

export function environmentScope(
  organizationId: OrganizationId,
  projectId: ProjectId,
  environmentId: EnvironmentId,
): EnvironmentScope {
  return { level: "environment", organizationId, projectId, environmentId };
}

/**
 * The canonical, stable string form of a scope: `org/<id>`, `org/<id>/proj/<id>`,
 * `org/<id>/proj/<id>/env/<id>`.
 *
 * This is the `resolvePath()` of ADR M0.3 §4. It is the one place a scope becomes
 * a key, so cache namespaces, rate-limit buckets, object-storage prefixes and log
 * fields all agree by construction instead of by convention.
 */
export function resolvePath(scope: TenantScope): string {
  const organization = `org/${scope.organizationId}`;
  if (scope.level === "organization") return organization;
  const project = `${organization}/proj/${scope.projectId}`;
  if (scope.level === "project") return project;
  return `${project}/env/${scope.environmentId}`;
}

/**
 * True when `outer` contains `inner` — the single containment predicate every
 * authorization decision reduces to. A scope always contains itself.
 */
export function contains(outer: TenantScope, inner: TenantScope): boolean {
  const outerPath = resolvePath(outer);
  const innerPath = resolvePath(inner);
  return innerPath === outerPath || innerPath.startsWith(`${outerPath}/`);
}

/** Widen a scope to the organization it belongs to. */
export function toOrganizationScope(scope: TenantScope): OrganizationScope {
  return organizationScope(scope.organizationId);
}

/**
 * One inbound unit of work, carried unchanged through every layer.
 *
 * `requestId` is the correlation identifier the cross-cutting observability gate
 * requires on every domain event, span and log line. `onBehalfOf` is present only
 * while an operator is impersonating: the acting principal stays `principalId` so
 * an audit record can never lose who really acted.
 */
export interface RequestScope {
  readonly requestId: RequestId;
  readonly tenant: TenantScope;
  readonly principalId: PrincipalId;
  readonly onBehalfOf: PrincipalId | null;
  readonly receivedAt: Date;
}
