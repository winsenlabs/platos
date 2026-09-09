// GET /api/v1/workspaces/:organizationSlug/:projectSlug/:environmentSlug —
// THE ROUTE THE DASHBOARD OPENS EVERY PAGE WITH.
//
// `apps/webapp/app/services/auth.server.ts` has resolved this triple with a
// Prisma `environment.findFirst` since the product existed, and every route under
// `/orgs/:org/projects/:project/env/:env` calls it first. It is the last reason
// the webapp needs a database credential. This route serves it from the contract.
//
// ONE CALL, BECAUSE THE REFUSAL MUST BE ONE REFUSAL. The handler does not resolve
// and then authorize: `tenancy.resolveWorkspace` does both, and returns a single
// `TENANCY_ENVIRONMENT_FORBIDDEN` whether the organization does not exist, the
// project belongs to somebody else, an ancestor is archived, or the four-gate RBAC
// decision said no. A transport that composed two contract calls would have to
// remember to collapse them, and a transport that forgot would turn slugs — which
// are customer names and the word "production" — into an enumeration oracle. The
// context's own `environmentForbidden` banner already made this argument for ids;
// slugs need it more.
//
// SO THERE IS NO 404 ON THIS ROUTE, ON PURPOSE. A reader expecting one should read
// `packages/contexts/tenancy/application/resolve-workspace.ts`, which states the
// property, and `resolve-workspace.test.ts`, which measures it against a genuine
// RBAC denial rather than against a literal.
//
// `access` IS THE CALLER'S ASK, AND IT CAN ONLY TIGHTEN. `EnvironmentAccess` is
// `"metadata" | "secret:mutate"`; passing the stronger value makes gate 4 apply,
// so a caller can use it to be refused but never to be granted more than their
// role carries. It is on the wire because the oracle takes it — the environment
// variables page asks for `secret:mutate` up front so it can refuse before
// rendering a form the operator may not submit — and defaulting it to the WEAKEST
// value is what stops a viewer-shaped role losing read access to everything.

import { Controller, Get, Inject, Param, Query, Req } from "@nestjs/common";

import { err, ok, type FieldViolation, type Result } from "@platos/kernel";
import type {
  EnvironmentAccess,
  EnvironmentRecord,
  OrganizationRecord,
  ProjectRecord,
  WorkspaceDescriptor,
} from "@platos/context-tenancy";

import { API_VERSION } from "../../http/api-surface.js";
import { DomainValidationPipe } from "../../http/validation.pipe.js";
import { REST_APPLICATION, type RestApplication } from "./dependencies.js";
import { itemEnvelope, type ItemEnvelope } from "./envelope.js";
import { raise } from "./fault.js";
import {
  authenticateOperator,
  operatorPrincipal,
  requireTenancy,
  type InboundOperatorRequest,
} from "./operator.js";
import type { QueryInput } from "./page.js";
import { requestInvalid } from "./transport-errors.js";

/** A tenant node as the workspace publishes it. The three levels share a shape. */
export interface TenantNodeResource {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

/**
 * What the operator was granted, alongside what they addressed.
 *
 * `scope` IS THE AUTHORIZATION'S, NOT THE URL'S. It is the triple tenancy
 * re-derived from the leaf while deciding, and it is published so a client keys
 * its next request by the value that was checked rather than by the slugs it
 * happened to type. The two agree — `resolveWorkspace` refuses if they do not —
 * and publishing the checked one is what keeps that true one hop further out.
 */
export interface WorkspaceAuthorizationResource {
  readonly access: EnvironmentAccess;
  readonly organizationRole: string;
  readonly projectRole: string | null;
  readonly actorUserId: string;
  readonly effectiveUserId: string;
  readonly scope: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly environmentId: string;
  };
}

export interface WorkspaceResource {
  readonly organization: TenantNodeResource;
  readonly project: TenantNodeResource;
  readonly environment: TenantNodeResource;
  /** The project's unarchived environments, oldest first — the switcher's list. */
  readonly environments: readonly TenantNodeResource[];
  readonly authorization: WorkspaceAuthorizationResource;
}

const ACCESS_VALUES: readonly EnvironmentAccess[] = ["metadata", "secret:mutate"];

/** What this route reads out of the query string. */
export interface WorkspaceQuery {
  readonly access: EnvironmentAccess;
}

/**
 * SHAPE ONLY, and an unknown value is REFUSED rather than coerced to the default.
 *
 * A caller that sent `access=secret-mutate` (a plausible typo, hyphen for colon)
 * and was quietly served a metadata authorization would render a form the
 * operator cannot submit, and would find out at the write. `EnvironmentAccess` is
 * a closed union in the domain, so an unrecognised member is a client defect and
 * says so.
 */
export const workspaceQueryValidator = (input: unknown): Result<WorkspaceQuery> => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return err(
      requestInvalid([
        { field: "query", code: "malformed", message: "The query string could not be read." },
      ]),
    );
  }
  const raw = (input as QueryInput)["access"];
  if (raw === undefined || raw === null) return ok({ access: "metadata" });
  const violations: FieldViolation[] = [];
  if (typeof raw !== "string") {
    violations.push({
      field: "query.access",
      code: "repeated",
      message: "Send this parameter once; it was sent more than once.",
    });
  } else if (!ACCESS_VALUES.includes(raw as EnvironmentAccess)) {
    violations.push({
      field: "query.access",
      code: "unknown",
      message: `access must be one of: ${ACCESS_VALUES.join(", ")}`,
    });
  }
  if (violations.length > 0) return err(requestInvalid(violations));
  return ok({ access: raw as EnvironmentAccess });
};

const WORKSPACE_QUERY_PIPE = new DomainValidationPipe(workspaceQueryValidator);

function tenantNode(row: OrganizationRecord | ProjectRecord | EnvironmentRecord): TenantNodeResource {
  return { id: row.id, slug: row.slug, name: row.name };
}

export function workspaceResource(descriptor: WorkspaceDescriptor): WorkspaceResource {
  const authorization = descriptor.authorization;
  return {
    organization: tenantNode(descriptor.organization),
    project: tenantNode(descriptor.project),
    environment: tenantNode(descriptor.environment),
    environments: descriptor.environments.map(tenantNode),
    authorization: {
      access: authorization.access,
      organizationRole: authorization.organizationRole,
      projectRole: authorization.projectRole,
      actorUserId: authorization.actorUserId,
      effectiveUserId: authorization.effectiveUserId,
      scope: {
        organizationId: authorization.scope.organizationId,
        projectId: authorization.scope.projectId,
        environmentId: authorization.scope.environmentId,
      },
    },
  };
}

@Controller({ path: "workspaces", version: API_VERSION })
export class WorkspaceController {
  constructor(@Inject(REST_APPLICATION) private readonly application: RestApplication) {}

  @Get(":organizationSlug/:projectSlug/:environmentSlug")
  async resolve(
    @Req() request: InboundOperatorRequest,
    @Param("organizationSlug") organizationSlug: string,
    @Param("projectSlug") projectSlug: string,
    @Param("environmentSlug") environmentSlug: string,
    @Query(WORKSPACE_QUERY_PIPE) query: WorkspaceQuery,
  ): Promise<ItemEnvelope<WorkspaceResource>> {
    const app = this.application.app;
    const operator = await authenticateOperator(app, request);
    const tenancy = requireTenancy(app);
    const resolved = await tenancy.resolveWorkspace({
      organizationSlug,
      projectSlug,
      environmentSlug,
      operator: operatorPrincipal(operator),
      access: query.access,
    });
    // UNEDITED. The one refusal is the point; see the banner.
    if (!resolved.ok) raise(resolved.error);
    return itemEnvelope(workspaceResource(resolved.value));
  }
}
