/**
 * Shared scope resolver + access verifier for webapp proxy routes that
 * forward scope headers to the Platos agent service.
 *
 * EOBD.6 / EOBD.7 / EOBD.8 — closes the cross-tenant IDOR where raw
 * (organizationId, projectId, environmentId) query params were
 * forwarded verbatim to the agent. The agent trusts direct headers on
 * internal (non-proxied) requests, so any authenticated webapp user
 * could read / delete / upload against another org's scope simply by
 * supplying that org's IDs.
 *
 * This helper accepts scope as EITHER raw IDs OR organization/project slugs
 * plus the canonical Environment UUID. In both paths
 * it verifies:
 *   1. Project exists AND is owned by `organizationId`.
 *   2. Environment exists AND is owned by `projectId`.
 *   3. The authenticated user is a member of the organization.
 *
 * On any failure returns a typed ScopeVerifyError so callers can surface
 * the right HTTP status (400 / 403 / 404).
 */
import { OrganizationRole, ProjectRole } from "@platos/database";
import { $replica, prisma } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";

export type ScopeVerifyError =
  | { kind: "bad_request"; message: string }
  | { kind: "forbidden"; message: string }
  | { kind: "not_found"; message: string };

export interface ResolvedScope {
  organizationId: string;
  projectId: string;
  environmentId: string;
}

export interface ScopeVerifyInput {
  organizationId?: string | null;
  projectId?: string | null;
  environmentId?: string | null;
  organizationSlug?: string | null;
  projectSlug?: string | null;
}

export type ProjectAccess = "read" | "mutate";

export async function verifyProjectAccess(
  scope: Pick<ResolvedScope, "organizationId" | "projectId">,
  userId: string,
  access: ProjectAccess,
): Promise<boolean> {
  const organizationMembership = await prisma.organizationMembership.findUnique({
    where: {
      organizationId_userId: {
        organizationId: scope.organizationId,
        userId,
      },
    },
    select: { id: true, role: true, deactivatedAt: true },
  });
  if (!organizationMembership || organizationMembership.deactivatedAt) return false;

  const projectMembership = await prisma.projectMembership.findUnique({
    where: {
      projectId_organizationMembershipId: {
        projectId: scope.projectId,
        organizationMembershipId: organizationMembership.id,
      },
    },
    select: { role: true },
  });
  if (access === "read") return projectMembership !== null;
  return (
    organizationMembership.role === OrganizationRole.OWNER ||
    organizationMembership.role === OrganizationRole.ADMIN ||
    projectMembership?.role === ProjectRole.ADMIN
  );
}

/**
 * Resolve scope from request query/body params and verify the caller
 * has access. Fails closed.
 *
 * Accepts either a complete raw-id triple OR organization/project slugs with
 * an Environment UUID.
 * Partial triples return bad_request.
 */
export async function resolveAndVerifyScope(
  input: ScopeVerifyInput,
  userId: string,
  access?: ProjectAccess,
): Promise<{ ok: true; scope: ResolvedScope } | { ok: false; error: ScopeVerifyError }> {
  const hasAllIds = !!(input.organizationId && input.projectId && input.environmentId);
  const hasSlugScope = !!(input.organizationSlug && input.projectSlug && input.environmentId);

  if (!hasAllIds && !hasSlugScope) {
    return {
      ok: false,
      error: {
        kind: "bad_request",
        message:
          "Must provide a complete (organizationId + projectId + environmentId) or (organizationSlug + projectSlug + environmentId) scope.",
      },
    };
  }

  if (hasSlugScope) {
    // Human-readable parent path plus canonical Environment UUID.
    const project = await findProjectBySlug(
      input.organizationSlug!,
      input.projectSlug!,
      userId,
    );
    if (!project) {
      return { ok: false, error: { kind: "not_found", message: "Project not found" } };
    }
    const environment = await findEnvironmentById(input.environmentId!, userId, project.id);
    if (!environment) {
      return { ok: false, error: { kind: "not_found", message: "Environment not found" } };
    }
    const scope = {
      organizationId: project.organizationId,
      projectId: project.id,
      environmentId: environment.id,
    };
    if (access && !(await verifyProjectAccess(scope, userId, access))) {
      return {
        ok: false,
        error: { kind: "forbidden", message: "User does not have required project access" },
      };
    }
    return {
      ok: true,
      scope,
    };
  }

  // Raw-id path — verify membership + parent-child ownership.
  const organizationId = input.organizationId!;
  const projectId = input.projectId!;
  const environmentId = input.environmentId!;

  // 1. User is a member of the org.
  const member = await $replica.organizationMembership.findFirst({
    where: { organizationId, userId, deactivatedAt: null },
    select: { id: true },
  });
  if (!member) {
    return {
      ok: false,
      error: {
        kind: "forbidden",
        message: "User is not a member of this organization",
      },
    };
  }

  // 2. Project exists under org.
  const project = await $replica.project.findFirst({
    where: { id: projectId, organizationId, archivedAt: null },
    select: { id: true },
  });
  if (!project) {
    return {
      ok: false,
      error: { kind: "not_found", message: "Project not found in this organization" },
    };
  }

  // 3. Environment exists under project.
  const environment = await $replica.environment.findFirst({
    where: { id: environmentId, projectId, archivedAt: null },
    select: { id: true },
  });
  if (!environment) {
    return {
      ok: false,
      error: { kind: "not_found", message: "Environment not found in this project" },
    };
  }

  const scope = { organizationId, projectId, environmentId };
  if (access && !(await verifyProjectAccess(scope, userId, access))) {
    return {
      ok: false,
      error: { kind: "forbidden", message: "User does not have required project access" },
    };
  }
  return { ok: true, scope };
}

/** HTTP status code to return for a given error kind. */
export function scopeErrorStatus(err: ScopeVerifyError): number {
  switch (err.kind) {
    case "bad_request":
      return 400;
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
  }
}
