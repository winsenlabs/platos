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
 * This helper accepts scope as EITHER raw IDs OR slugs. In both paths
 * it verifies:
 *   1. Project exists AND is owned by `organizationId`.
 *   2. RuntimeEnvironment exists AND is owned by `projectId`.
 *   3. The authenticated user is a member of the organization.
 *
 * On any failure returns a typed ScopeVerifyError so callers can surface
 * the right HTTP status (400 / 403 / 404).
 */
import { $replica } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";

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
  envSlug?: string | null;
}

/**
 * Resolve scope from request query/body params and verify the caller
 * has access. Fails closed.
 *
 * Accepts either a complete raw-id triple OR a complete slug triple.
 * Partial triples return bad_request.
 */
export async function resolveAndVerifyScope(
  input: ScopeVerifyInput,
  userId: string,
): Promise<{ ok: true; scope: ResolvedScope } | { ok: false; error: ScopeVerifyError }> {
  const hasAllIds = !!(input.organizationId && input.projectId && input.environmentId);
  const hasAllSlugs = !!(input.organizationSlug && input.projectSlug && input.envSlug);

  if (!hasAllIds && !hasAllSlugs) {
    return {
      ok: false,
      error: {
        kind: "bad_request",
        message:
          "Must provide a complete (organizationId + projectId + environmentId) or (organizationSlug + projectSlug + envSlug) triple.",
      },
    };
  }

  if (hasAllSlugs) {
    // Slug path — already authz-checked by the repo helpers.
    const project = await findProjectBySlug(
      input.organizationSlug!,
      input.projectSlug!,
      userId,
    );
    if (!project) {
      return { ok: false, error: { kind: "not_found", message: "Project not found" } };
    }
    const environment = await findEnvironmentBySlug(project.id, input.envSlug!, userId);
    if (!environment) {
      return { ok: false, error: { kind: "not_found", message: "Environment not found" } };
    }
    return {
      ok: true,
      scope: {
        organizationId: project.organizationId,
        projectId: project.id,
        environmentId: environment.id,
      },
    };
  }

  // Raw-id path — verify membership + parent-child ownership.
  const organizationId = input.organizationId!;
  const projectId = input.projectId!;
  const environmentId = input.environmentId!;

  // 1. User is a member of the org.
  const member = await $replica.orgMember.findFirst({
    where: { organizationId, userId },
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
    where: { id: projectId, organizationId },
    select: { id: true },
  });
  if (!project) {
    return {
      ok: false,
      error: { kind: "not_found", message: "Project not found in this organization" },
    };
  }

  // 3. Environment exists under project.
  const environment = await $replica.runtimeEnvironment.findFirst({
    where: { id: environmentId, projectId },
    select: { id: true },
  });
  if (!environment) {
    return {
      ok: false,
      error: { kind: "not_found", message: "Environment not found in this project" },
    };
  }

  return { ok: true, scope: { organizationId, projectId, environmentId } };
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

