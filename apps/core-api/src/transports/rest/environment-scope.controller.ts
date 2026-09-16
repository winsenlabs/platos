// GET /environments/by-slugs — THE SCOPE A DASHBOARD URL NAMES.
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
// `?access=` IS A PARAMETER, BECAUSE THE ORACLE'S IS LOAD-BEARING.
//
// `requireEnvironmentScope` takes `access` ("metadata" | "secret:mutate",
// defaulting to "metadata") and refuses at the level asked for. THE ENUMERATION
// BELOW IS A GREP A READER CAN RE-RUN, not a list to take on trust — the first
// version of this banner named six of the eight:
//
//     grep -rl 'secret:mutate' apps/webapp/app     ->  8 files (2026-09-16)
//     grep -rl 'm4Mutation'    apps/webapp/app     -> 26 files
//
// The eight are `services/m4Mutation.server.ts` and seven routes under
// `_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.`:
// agent-tools._index, agents.$agentId.tools, agents.$agentId.canary,
// agents.$agentId.skills, agent-providers._index, apikeys and
// environment-variables.new. The last three ask through a local `scoped`
// wrapper rather than a bare literal, which is why counting literals gives four
// and counting call sites gives seven.
//
// ALL BUT environment-variables.new then call apps/agent, which
// trusts the workload token the webapp mints for that tenant
// (`platosAgent.server.ts`), so for those calls the operator-level gate 4 exists
// ONLY in this resolver. (environment-variables.new writes the table directly;
// its replacement, `PUT /environments/:id/variables/:key`, authorizes
// `secret:mutate` itself.) A route that could
// answer "may this operator see it" but not "may this operator mutate it" would
// leave the T8 cutover two bad options: drop the gate, or copy the four-gate
// policy into the webapp from the roles this resource exposes. So the level is
// the caller's to choose, exactly as it was:
//
//   absent             metadata (the oracle's default)
//   metadata           gates 1-3
//   secret:mutate      gates 1-4 — org OWNER/ADMIN or project ADMIN, else
//                      TENANCY_ENVIRONMENT_FORBIDDEN (403), the oracle's refusal
//   anything else      TRANSPORT_REQUEST_INVALID (400), `query.access:unsupported`
//
// The third row is refused HERE rather than passed on: the domain's gate 4 tests
// `access === "secret:mutate"`, so an unrecognised level would be decided as
// `metadata` and echoed back as if it had been granted.

import { Controller, Get, Inject, Query, Req } from "@nestjs/common";

import { asIdentifier, err, ok, type FieldViolation, type Result } from "@platos/kernel";
import type { EnvironmentAccess, EnvironmentRecord, OperatorEnvironmentView, UserId } from "@platos/context-tenancy";

import { API_VERSION } from "../../http/api-surface.js";
import { DomainValidationPipe } from "../../http/validation.pipe.js";
import { REST_APPLICATION, type RestApplication } from "./dependencies.js";
import { itemEnvelope, type ItemEnvelope } from "./envelope.js";
import { raise } from "./fault.js";
import { authenticateOperator, requireTenancy, type InboundOperatorRequest } from "./operator.js";
import { requestInvalid } from "./transport-errors.js";

/** `?organizationSlug=&projectSlug=&environmentSlug=[&access=]` — what a caller sends. Every one a string. */
export interface EnvironmentScopeWireQuery {
  readonly organizationSlug: string;
  readonly projectSlug: string;
  readonly environmentSlug: string;
  /** `metadata` (the default when absent) or `secret:mutate`. See the banner. */
  readonly access?: string;
}

export interface EnvironmentScopeQuery {
  readonly organizationSlug: string;
  readonly projectSlug: string;
  readonly environmentSlug: string;
  readonly access: EnvironmentAccess;
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
  /** The access level this answer was authorized at: the `?access=` asked for, `metadata` when absent. */
  readonly access: string;
  readonly organizationRole: string;
  readonly projectRole: string | null;
}

const SLUG_PARAMETERS = ["organizationSlug", "projectSlug", "environmentSlug"] as const;

/** The oracle's `EnvironmentAuthorizationAccess`, as the levels a caller may name. */
export const ENVIRONMENT_SCOPE_ACCESS_LEVELS: readonly EnvironmentAccess[] = ["metadata", "secret:mutate"];

/** `?access=`: absent is the oracle's default; a level outside the two is refused, never downgraded. */
function accessLevel(value: unknown, violations: FieldViolation[]): EnvironmentAccess {
  if (value === undefined) return "metadata";
  if (typeof value !== "string") {
    violations.push({
      field: "query.access",
      code: "repeated",
      message: "Send this parameter once; it was sent more than once.",
    });
    return "metadata";
  }
  const level = ENVIRONMENT_SCOPE_ACCESS_LEVELS.find((candidate) => candidate === value);
  if (level === undefined) {
    violations.push({
      field: "query.access",
      code: "unsupported",
      message: `access must be one of: ${ENVIRONMENT_SCOPE_ACCESS_LEVELS.join(", ")}.`,
    });
    return "metadata";
  }
  return level;
}

/**
 * SHAPE ONLY: three single-valued strings and an optional access level. A slug
 * that names nothing is the read model's 404, not this file's 400 — the grammar
 * is tenancy's. The access level is the one closed set checked here, because the
 * domain would otherwise downgrade an unknown one (see `accessLevel`).
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
  const access = accessLevel(query["access"], violations);
  if (violations.length > 0) return err(requestInvalid(violations));
  return ok({
    organizationSlug: values["organizationSlug"] as string,
    projectSlug: values["projectSlug"] as string,
    environmentSlug: values["environmentSlug"] as string,
    access,
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
      access: query.access,
    });
    if (!resolved.ok) raise(resolved.error);
    return itemEnvelope(environmentScopeResource(resolved.value));
  }
}
