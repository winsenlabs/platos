// GET /api/v1/environments/by-slugs — THE SCOPE A DASHBOARD URL NAMES.
//
// Every page under `/orgs/:organizationSlug/projects/:projectParam/env/:envParam`
// opens with `requireEnvironmentScope` (`apps/webapp/app/services/auth.server.ts`,
// line 75 at this tranche's base), which is the ORACLE for this route: it resolves
// the three slugs through an unarchived chain with a Prisma query (404 when
// nothing matches), runs the four-gate authorization on the environment it found
// (403 unchanged), and hands the page the organization, the project, the
// environment and the project's unarchived environments for the switcher. The
// contract only had `resolveEnvironmentScope(environmentId)`, so a route that
// began with slugs could not be served without reaching past it.
//
// `resolveOperatorEnvironment` is that function, ported into tenancy — and the
// part that matters for tenancy is that the slugs only CHOOSE which environment to
// ask about. The authorization it returns is re-derived from that environment's
// id, exactly as `authorizeEnvironment` derives every other route's.
//
// THE TWO REFUSALS ARE THE ORACLE'S AND THEY ARE DIFFERENT CODES ON PURPOSE:
//
//   TENANCY_NOT_FOUND              404  no live environment has these slugs
//   TENANCY_ENVIRONMENT_FORBIDDEN  403  one does, and this operator may not see it
//
// The difference discloses whether a slug triple exists, which the id-keyed
// authorization does not. That is the running product's behaviour, kept rather
// than silently tightened, and recorded as a finding in the read model's banner.
//
// `access` IS NOT A PARAMETER. The oracle took one because a Remix action reused
// the loader's resolver with `secret:mutate`; here the mutation routes authorize
// their own access level, so this read asks for the weakest one and says so.

import { Controller, Get, Inject, Query, Req } from "@nestjs/common";

import { asIdentifier, err, ok, type FieldViolation, type Result } from "@platos/kernel";
import type { EnvironmentRecord, OperatorEnvironmentView, UserId } from "@platos/context-tenancy";

import { API_VERSION } from "../../http/api-surface.js";
import { DomainValidationPipe } from "../../http/validation.pipe.js";
import { REST_APPLICATION, type RestApplication } from "./dependencies.js";
import { itemEnvelope, type ItemEnvelope } from "./envelope.js";
import { raise } from "./fault.js";
import { authenticateOperator, requireTenancy, type InboundOperatorRequest } from "./operator.js";
import { requestInvalid } from "./transport-errors.js";

/** `?organizationSlug=&projectSlug=&environmentSlug=` — what a caller sends. Every one a string. */
export interface EnvironmentScopeWireQuery {
  readonly organizationSlug: string;
  readonly projectSlug: string;
  readonly environmentSlug: string;
}

export interface EnvironmentScopeQuery {
  readonly organizationSlug: string;
  readonly projectSlug: string;
  readonly environmentSlug: string;
}

export interface TenantNodeResource {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export interface EnvironmentScopeResource {
  readonly organization: TenantNodeResource;
  readonly project: TenantNodeResource;
  readonly environment: TenantNodeResource;
  /** The project's unarchived environments, oldest first — the switcher's list. */
  readonly environments: readonly TenantNodeResource[];
  /** The access level this answer was authorized at. Always `metadata`; see the banner. */
  readonly access: string;
  readonly organizationRole: string;
  readonly projectRole: string | null;
}

const SLUG_PARAMETERS = ["organizationSlug", "projectSlug", "environmentSlug"] as const;

/**
 * SHAPE ONLY: three single-valued strings. A slug that names nothing is the read
 * model's 404, not this file's 400 — the grammar is tenancy's.
 */
export const environmentScopeQueryValidator = (input: unknown): Result<EnvironmentScopeQuery> => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return err(requestInvalid([{ field: "query", code: "malformed", message: "The query string could not be read." }]));
  }
  const query = input as Readonly<Record<string, unknown>>;
  const violations: FieldViolation[] = [];
  const values: Record<string, string> = {};
  for (const name of SLUG_PARAMETERS) {
    const value = query[name];
    if (typeof value === "string" && value !== "") {
      values[name] = value;
      continue;
    }
    violations.push({
      field: `query.${name}`,
      code: value === undefined || value === "" ? "required" : "repeated",
      message:
        value === undefined || value === ""
          ? `${name} is required.`
          : "Send this parameter once; it was sent more than once.",
    });
  }
  if (violations.length > 0) return err(requestInvalid(violations));
  return ok({
    organizationSlug: values["organizationSlug"] as string,
    projectSlug: values["projectSlug"] as string,
    environmentSlug: values["environmentSlug"] as string,
  });
};

const SCOPE_QUERY_PIPE = new DomainValidationPipe<EnvironmentScopeQuery, EnvironmentScopeWireQuery>(
  environmentScopeQueryValidator,
);

function node(row: { readonly id: string; readonly slug: string; readonly name: string }): TenantNodeResource {
  return { id: row.id, slug: row.slug, name: row.name };
}

export function environmentScopeResource(view: OperatorEnvironmentView): EnvironmentScopeResource {
  return {
    organization: node(view.organization),
    project: node(view.project),
    environment: node(view.environment),
    environments: view.environments.map((row: EnvironmentRecord) => node(row)),
    access: view.authorization.access,
    organizationRole: view.authorization.organizationRole,
    projectRole: view.authorization.projectRole,
  };
}

@Controller({ path: "environments", version: API_VERSION })
export class EnvironmentScopeController {
  constructor(@Inject(REST_APPLICATION) private readonly application: RestApplication) {}

  @Get("by-slugs")
  async resolve(
    @Req() request: InboundOperatorRequest,
    @Query(SCOPE_QUERY_PIPE) query: EnvironmentScopeQuery,
  ): Promise<ItemEnvelope<EnvironmentScopeResource>> {
    const app = this.application.app;
    const operator = await authenticateOperator(app, request);
    const resolved = await requireTenancy(app).resolveOperatorEnvironment({
      organizationSlug: query.organizationSlug,
      projectSlug: query.projectSlug,
      environmentSlug: query.environmentSlug,
      // BOTH IDS, for the reason `operatorPrincipal` gives: memberships are
      // evaluated for the effective user and the actor is stamped on the grant.
      operator: {
        actorUserId: asIdentifier<UserId>(operator.actorUserId),
        effectiveUserId: asIdentifier<UserId>(operator.effectiveUserId),
      },
      access: "metadata",
    });
    if (!resolved.ok) raise(resolved.error);
    return itemEnvelope(environmentScopeResource(resolved.value));
  }
}
