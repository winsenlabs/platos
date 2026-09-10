// THE TIER-2 MCP POLICY SURFACE — THE THIRD MCP ROUTE IN THIS PROCESS, AND THE
// FIRST ONE THAT TAKES A CAPABILITY AWAY FROM `apps/agent` RATHER THAN ADDING TO
// WHAT THAT DEPLOYABLE ALREADY SERVES.
//
// -----------------------------------------------------------------------------
// WHAT MOVED, AND WHY THIS IS A MOVE AND NOT A NEW FEATURE
//
// `apps/agent/src/mcp-platform/permission-gateway.service.ts` carried three
// methods — `listOrgPolicies`, `upsertOrgPolicy`, `deleteOrgPolicy` — over
// `OrganizationMcpPolicy`, and its own banner recorded the fact that made them
// the honest first move of this tranche:
//
//   "NOTHING CALLS THEM TODAY, and that is stated rather than hidden — the three
//    are reachable only from a management surface that has not been built."
//
// So there was no route to break and no client to repoint: ninety lines of ORM
// against a table `tools` owns, in a deployable that is not its owner, reachable
// from nothing. `scripts/arch/mcp-store-ownership.mjs` counted its six delegate
// calls as MOVABLE — the owner composed, the methods published — and they were,
// in the one sense the register measures. What it could not know is that the
// "move" had no destination yet. This file is the destination.
//
// THE CAPABILITY IS THE CONTRACT'S, AND THE CONTRACT WAS ALREADY THERE.
// `ToolsContract.listOrganizationPolicies`, `setOrganizationPolicy` and
// `deleteOrganizationPolicy` are published, `app.module.ts` composes `tools`, and
// `packages/contexts/tools/application/index.ts` names
// `MCPPermissionGatewayService` as one of the three files that layer replaces.
// Nothing here holds a policy rule: the pattern bounds, the two-valued-column
// refusal and the `secret:mutate` gate all live in
// `application/organization-policy.ts`, which is why this file is short.
//
// -----------------------------------------------------------------------------
// THE THREE REFUSALS ARE THREE ANSWERS, AND THE STORE ADDS TWO MORE
//
//   UNAUTHENTICATED / SESSION_*        no live operator                  (401)
//   TENANCY_ENVIRONMENT_FORBIDDEN      the four-gate decision, with
//                                      `details.gate` naming which gate  (403)
//   TENANCY_AUTHORIZATION_FORGED       a value tenancy's own mint register
//                                      does not vouch for                (403)
//   TOOLS_SCOPE_MISMATCH               a `metadata` grant asking to mutate (403)
//   TOOLS_POLICY_PATTERN_INVALID       1–200 characters, or it is a typo  (400)
//   TOOLS_POLICY_EFFECT_UNSUPPORTED    `require_approval` on a two-valued
//                                      column, refused rather than rounded (400)
//   TOOLS_REPOSITORY_UNAVAILABLE       the store refused the scope, with
//                                      `details.reason` carrying
//                                      `out_of_scope` or
//                                      `unknown_environment`             (503)
//   TRANSPORT_CONTEXT_UNAVAILABLE      `tools` is not composed in this
//                                      process                            (503)
//
// THE LAST-BUT-ONE IS THE ONE THE LEGACY HELPERS HAND-ROLLED. They resolved the
// claimed organization out of the `Environment` row's own ancestry and threw
// `McpScopeRefusedError` with one of three reasons. That check now lives once, in
// `packages/adapters/postgres-tenancy/src/tools-scope.ts`'s `requireScope`, on
// the front of every scoped method of a twenty-five-method port — and it is
// strictly stronger here, because the scope it checks did not come from a caller
// at all. It came off an `EnvironmentOperatorAuthorization` that tenancy
// re-derived from the environment's ancestry while deciding, and which
// `verifyAuthorization` refuses unless its own private mint register holds the
// object. A forged triple cannot be assembled on this path; the store refuses
// one anyway, and `composition/mcp-organization-policy.integration.test.ts`
// proves both against a real tree.
//
// -----------------------------------------------------------------------------
// WHY THE ENVIRONMENT IS IN THE PATH AND NOT IN THE BODY
//
// Its two siblings put `environmentId` in the request BODY, and
// `platform-tokens.controller.ts` gives the reason: an operation whose tenancy
// arrives in `X-Platos-*` headers cannot be described by an OpenAPI request
// schema. A PATH PARAMETER SATISFIES THAT SAME REQUIREMENT — it is a declared,
// validated, documented part of the operation — and a `GET` has no body to put
// it in. Splitting the difference (path for the read, body for the writes) would
// make one collection addressable two ways, so all three name it the same way.
//
// The tier-2 row is an ORGANIZATION's and the path names an ENVIRONMENT, which
// looks like a mismatch and is the point: the environment is what an operator
// holds a grant for, and the organization is re-derived from its ancestry by the
// contract. A route keyed on `organizationId` would be asking the caller which
// tenant to write to.
//
// -----------------------------------------------------------------------------
// THE PATH IS UNVERSIONED, FOR THE REASON ITS SIBLINGS ARE
//
// ADR M0.4 §2's MCP row keeps MCP paths out of the URL-major scheme, so this
// controller is `VERSION_NEUTRAL` by way of `MCP_ROUTE_VERSION` and composes its
// path from `MCP_PLATFORM_PATH` rather than typing it. See `mcp-surface.ts`.

import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Put,
  Query,
  Req,
} from "@nestjs/common";

import { asIdentifier, err, ok, type FieldViolation, type Result } from "@platos/kernel";
import type {
  OrganizationMcpPolicyId,
  OrganizationPolicyView,
  PermissionState,
  ToolsContract,
} from "@platos/context-tools";
import { PERMISSION_STATES } from "@platos/context-tools";

import type { AppModule } from "../../app.module.js";
import { DomainValidationPipe } from "../../http/validation.pipe.js";
import { REST_APPLICATION, type RestApplication } from "../rest/dependencies.js";
import {
  collectionEnvelope,
  itemEnvelope,
  wholeCollection,
  type CollectionEnvelope,
  type ItemEnvelope,
} from "../rest/envelope.js";
import { raise } from "../rest/fault.js";
import { authorizeEnvironment, type InboundOperatorRequest } from "../rest/operator.js";
import { instant } from "../rest/resources.js";
import { contextUnavailable, requestInvalid } from "../rest/transport-errors.js";
import { authenticateOperator } from "../rest/operator.js";
import { MCP_PLATFORM_PATH, MCP_ROUTE_VERSION } from "./mcp-surface.js";

/**
 * The composed `tools`, or a 503 that says which context is missing.
 *
 * The same shape `requireTenancy` and `requireIdentityAccess` have in
 * `rest/operator.ts`, and for the identical reason stated there: a route reading
 * `contexts.tools` and finding `undefined` would throw a TypeError, which the
 * exception filter reports as `TRANSPORT_UNHANDLED_FAULT` — a DEFECT, with a 500
 * and an error id for somebody to chase — for a correctly-configured process
 * that simply has no database URL.
 */
export function requireTools(app: AppModule): ToolsContract {
  const tools = app.contexts.tools;
  if (tools === undefined) raise(contextUnavailable("tools"));
  return tools;
}

/** One tier-2 policy row, as V1 publishes it. ADR M0.4 D7: a declared DTO. */
export interface OrganizationPolicyResource {
  readonly policyId: string;
  readonly pattern: string;
  /**
   * `auto_allow` or `block`. NEVER `require_approval`.
   *
   * The column is two-valued and the contract's own view says so; a resource
   * that admitted the third value would be publishing a state this tier cannot
   * store, and the write that refused it would look like a bug in the client.
   */
  readonly state: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function organizationPolicyResource(
  view: OrganizationPolicyView,
): OrganizationPolicyResource {
  return {
    policyId: view.organizationMcpPolicyId,
    pattern: view.pattern,
    state: view.state,
    createdAt: instant(view.createdAt),
    updatedAt: instant(view.updatedAt),
  };
}

/**
 * What a delete answers with. A NAMED type, not an inline object literal.
 *
 * `scripts/rest-schema-derivation.mjs` refuses an `ItemEnvelope<{...}>` outright —
 * "generic argument of ItemEnvelope is not a named repository type" — and the
 * refusal is the OpenAPI ratchet working rather than getting in the way: an
 * anonymous shape has no component name, so it cannot be diffed across releases
 * and the breaking-change guard would have nothing stable to hold.
 */
export interface PolicyDeletionResource {
  readonly policyId: string;
  /**
   * `false` MEANS "NO SUCH POLICY IN THIS ORGANIZATION", NOT "NOT DELETED".
   *
   * See the note on the route: the store answers a COUNT from a `deleteMany` that
   * carries the tenant clause, so a uuid belonging to another organization is
   * indistinguishable from one that never existed — which is the correct answer to
   * give a caller who may not know either way.
   */
  readonly deleted: boolean;
}

/** The write body, after the chassis has read it. */
export interface SetOrganizationPolicyBody {
  readonly pattern: string;
  readonly state: PermissionState;
}

/**
 * EVERY VIOLATION IS COLLECTED BEFORE ANY IS REPORTED — its siblings' rule, and
 * M0.4 §2's `fields[]` is why.
 *
 * WHAT IS *NOT* CHECKED HERE. The 1–200 character pattern bound is
 * `application/organization-policy.ts`'s `MIN_POLICY_PATTERN_LENGTH` /
 * `MAX_POLICY_PATTERN_LENGTH`, and restating it in this file would be a second
 * copy of a rule the context owns — one that could disagree with the first after
 * either was edited. What this validator owns is the SHAPE: a string is a string
 * and `state` is one of the three the vocabulary defines. Whether a 201-character
 * pattern is a policy is the context's judgement, and it answers
 * `TOOLS_POLICY_PATTERN_INVALID`.
 */
export const setOrganizationPolicyValidator = (
  input: unknown,
): Result<SetOrganizationPolicyBody> => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return err(
      requestInvalid([{ field: "body", code: "malformed", message: "Send a JSON object." }]),
    );
  }
  const object = input as Record<string, unknown>;
  const violations: FieldViolation[] = [];

  const rawPattern = object["pattern"];
  if (typeof rawPattern !== "string" || rawPattern.trim() === "") {
    violations.push({
      field: "body.pattern",
      code: rawPattern === undefined ? "missing" : "invalid",
      message: "Send a non-empty string.",
    });
  }

  // NO DEFAULT. A policy write with no state is a caller who has not decided, and
  // defaulting either way picks a side: `auto_allow` writes a row that loosens
  // nothing and looks like it did, `block` writes a refusal nobody asked for.
  const rawState = object["state"];
  if (typeof rawState !== "string" || !(PERMISSION_STATES as readonly string[]).includes(rawState)) {
    violations.push({
      field: "body.state",
      code: rawState === undefined ? "missing" : "invalid",
      message: `Send one of: ${PERMISSION_STATES.join(", ")}.`,
    });
  }

  if (violations.length > 0) return err(requestInvalid(violations));
  return ok({ pattern: rawPattern as string, state: rawState as PermissionState });
};

const SET_POLICY_PIPE = new DomainValidationPipe(setOrganizationPolicyValidator);

/**
 * `?limit=` AND `?cursor=` ARE REFUSED, NOT IGNORED.
 *
 * `listOrganizationPolicies` takes an authorization and nothing else — there is
 * no limit, no offset and no cursor anywhere in `ToolsContract` for this
 * collection, because an organization's MCP policy set is bounded by how many
 * patterns an operator has written. `rest/page.ts`'s `refuseUnpagedQuery` states
 * the argument in full; this validator is the same rule for this route, spelled
 * against the same two field names.
 */
export const unpagedPolicyQueryValidator = (input: unknown): Result<null> => {
  const query = (typeof input === "object" && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  const violations: FieldViolation[] = [];
  for (const field of ["limit", "cursor"] as const) {
    if (query[field] === undefined) continue;
    violations.push({
      field: `query.${field}`,
      code: "unsupported",
      message: "This collection is not paged: it answers with every policy in the organization.",
    });
  }
  if (violations.length > 0) return err(requestInvalid(violations));
  return ok(null);
};

const UNPAGED_POLICY_QUERY_PIPE = new DomainValidationPipe(unpagedPolicyQueryValidator);

@Controller({ path: MCP_PLATFORM_PATH, version: MCP_ROUTE_VERSION })
export class McpOrganizationPoliciesController {
  constructor(@Inject(REST_APPLICATION) private readonly application: RestApplication) {}

  /**
   * `metadata`, THE WEAKEST ACCESS LEVEL, because a read of the policy set is not
   * a secret mutation. `rest/operator.ts` states the rule: asking for more than a
   * route needs is how a viewer-shaped role stops being able to read anything.
   */
  @Get("environments/:environmentId/policies")
  async list(
    @Req() request: InboundOperatorRequest,
    @Param("environmentId") environmentId: string,
    @Query(UNPAGED_POLICY_QUERY_PIPE) _page: null,
  ): Promise<CollectionEnvelope<OrganizationPolicyResource>> {
    const app = this.application.app;
    const operator = await authenticateOperator(app, request);
    const authorization = await authorizeEnvironment(app, operator, environmentId);
    const listed = await requireTools(app).listOrganizationPolicies({ authorization });
    if (!listed.ok) raise(listed.error);
    return collectionEnvelope(wholeCollection(listed.value.map(organizationPolicyResource)));
  }

  /**
   * `PUT` AND NOT `POST`, because the operation is an UPSERT keyed by
   * `@@unique([organizationId, pattern])` and is idempotent by that key: sending
   * the same pattern and state twice leaves one row in one state. `POST` would
   * promise a new resource per call, and the second call would surprise a client
   * that believed the promise.
   *
   * `200` AND NOT `201`, for the same reason: this route cannot tell a caller
   * whether it created or replaced without a read it does not need, and a status
   * that guessed would be wrong half the time.
   */
  @Put("environments/:environmentId/policies")
  async set(
    @Req() request: InboundOperatorRequest,
    @Param("environmentId") environmentId: string,
    @Body(SET_POLICY_PIPE) body: SetOrganizationPolicyBody,
  ): Promise<ItemEnvelope<OrganizationPolicyResource>> {
    const app = this.application.app;
    const operator = await authenticateOperator(app, request);
    // `secret:mutate`, which is the level tenancy's gate 4 narrows. The contract's
    // own `requireAccess` demands it too, so asking for `metadata` here would turn
    // a tenancy refusal (403, with `details.gate` naming the gate that closed)
    // into a `TOOLS_SCOPE_MISMATCH` — the right answer to the wrong question,
    // reported by the layer that was handed a grant it could not use.
    const authorization = await authorizeEnvironment(app, operator, environmentId, "secret:mutate");
    const saved = await requireTools(app).setOrganizationPolicy({
      authorization,
      pattern: body.pattern,
      state: body.state,
    });
    if (!saved.ok) raise(saved.error);
    return itemEnvelope(organizationPolicyResource(saved.value));
  }

  /**
   * `{ deleted: false }` AND NOT A 404.
   *
   * The contract answers `boolean`, and the adapter's own note says why it is a
   * count and not a `delete` by primary key: "`deleteMany` with the tenant clause
   * IN THE STATEMENT, and the count is the answer — `delete` by primary key alone
   * would let one organization retire another's policy by guessing a uuid". So
   * `false` means "no such row IN THIS ORGANIZATION", which is exactly what a
   * caller may be told, and a 404 would collapse it together with "no such route".
   *
   * The refusal a forged scope earns is NOT this `false`. It arrives as
   * `TOOLS_REPOSITORY_UNAVAILABLE` from `requireScope` before any row is read,
   * which is the distinction the legacy `McpScopeRefusedError` existed to draw
   * and which the deleted helpers drew with an exception.
   */
  @Delete("environments/:environmentId/policies/:policyId")
  async remove(
    @Req() request: InboundOperatorRequest,
    @Param("environmentId") environmentId: string,
    @Param("policyId") policyId: string,
  ): Promise<ItemEnvelope<PolicyDeletionResource>> {
    const app = this.application.app;
    const operator = await authenticateOperator(app, request);
    const authorization = await authorizeEnvironment(app, operator, environmentId, "secret:mutate");
    const removed = await requireTools(app).deleteOrganizationPolicy({
      authorization,
      organizationMcpPolicyId: asIdentifier<OrganizationMcpPolicyId>(policyId),
    });
    if (!removed.ok) raise(removed.error);
    return itemEnvelope({ policyId, deleted: removed.value });
  }
}
