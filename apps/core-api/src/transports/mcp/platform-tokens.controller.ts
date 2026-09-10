// /mcp/platform/tokens — THE PLATFORM MCP CREDENTIAL'S WHOLE LIFE.
//
// WIN-268 (M4.2) stage 2 ADDS THE LISTING AND THE REVOCATION beside the mint, so
// this controller now covers `POST`, `GET` and `POST :id/revoke`. The mint landed
// alone in P1 because `identity-access` published `mintBearerCredential` and
// nothing else about a bearer credential's life; the register that measured the
// gap said so by name — "`list` and `revoke` are not published by
// `identity-access` at all, which is what keeps `GET /mcp/platform/tokens` and
// `POST /mcp/platform/tokens/:id/revoke` in this deployable". Both methods exist
// now, so both routes do.
//
// THE THREE ROUTES ASK FOR DIFFERENT ACCESS AND THE DIFFERENCE IS DELIBERATE.
// `EnvironmentAccess` is `"metadata" | "secret:mutate"`: minting a ninety-day
// credential and destroying one are both `secret:mutate`, and LISTING redacted
// metadata is `metadata`. Asking for more than a route needs is how a
// viewer-shaped role stops being able to read anything, and asking for less is how
// one ends up able to revoke.
//
// -----------------------------------------------------------------------------
// POST /mcp/platform/tokens — THE FIRST OF THE TWO MINTS THE IDEMPOTENCY GATE
// HAS BEEN BINDING WITH NOTHING BEHIND IT.
//
// `http/idempotency-policy.ts` classes this operation `required`: no
// `Idempotency-Key`, no execution, `400 IDEMPOTENCY_KEY_REQUIRED`. That gate has
// run at the edge of this process since M4.1 and this route did not exist, so a
// caller that DID send a key was reserved, admitted, and then handed
// `TRANSPORT_ROUTE_NOT_FOUND` by the terminal controller — and the reservation
// it now held recorded that 404 and replayed it for every retry of the same key
// for twenty-four hours. The gate was not wrong; it was covering an operation
// nobody served.
//
// -----------------------------------------------------------------------------
// THE PATH IS UNVERSIONED AND THAT IS THE POINT
//
// ADR M0.4 §2's MCP row keeps MCP paths out of the URL-major scheme — the major
// travels in `serverInfo.version` — so this controller is `VERSION_NEUTRAL` by
// way of `MCP_ROUTE_VERSION`, and the path is composed from `MCP_PLATFORM_PATH`
// rather than typed. It has to be exactly `/mcp/platform/tokens`, because that
// is the TEMPLATE the policy table binds and the table compares templates as
// strings.
//
// -----------------------------------------------------------------------------
// WHAT THIS ROUTE REFUSES, AND WHY EACH REFUSAL HAS ITS OWN CODE
//
//   UNAUTHENTICATED / SESSION_*            no live operator          (401)
//   MCP_TOKEN_MINT_WHILE_IMPERSONATING     a live operator borrowing
//                                          somebody else's account   (403)
//   TENANCY_ENVIRONMENT_FORBIDDEN          the four-gate decision, asked at
//                                          `secret:mutate`           (403)
//   TRANSPORT_REQUEST_INVALID              a malformed body, with `fields[]`
//   CREDENTIAL_MATERIAL_INVALID            a body the DOMAIN refuses (400)
//   CREDENTIAL_MINT_REFUSED                the store refused the row  (409)
//
// The third is asked at `secret:mutate` and not at `metadata`, which is the
// level tenancy's gate 4 narrows. A mint that asked for `metadata` would be a
// mint any viewer-shaped role could perform, and the difference between reading
// an environment and minting a ninety-day credential inside it is exactly what
// that gate is for.
//
// -----------------------------------------------------------------------------
// THE ENVIRONMENT ARRIVES IN THE BODY, AND IT IS NOT A HEADER
//
// The legacy handler in `apps/agent` reads its scope from `X-Platos-*` request
// headers through `ScopeGuard`. This one does not, and the difference is
// deliberate: WIN-249 §2 fixes the V1 request shape, and an operation whose
// tenancy arrives in headers cannot be described by an OpenAPI request schema,
// cannot be validated by the chassis `ValidationPipe`, and cannot report a
// missing tenant as `fields[]`. So `environmentId` is a body field, refused by
// name when it is absent, and re-derived by `tenancy` from the leaf before
// anything is written.

import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";

import { err, ok, type FieldViolation, type Result } from "@platos/kernel";
import type { McpPermissionTier } from "@platos/context-identity-access";

import { DomainValidationPipe } from "../../http/validation.pipe.js";
import { REST_APPLICATION, type RestApplication } from "../rest/dependencies.js";
import {
  collectionEnvelope,
  itemEnvelope,
  type CollectionEnvelope,
  type ItemEnvelope,
} from "../rest/envelope.js";
import { raise } from "../rest/fault.js";
import {
  authenticateOperator,
  authorizeEnvironment,
  type InboundOperatorRequest,
} from "../rest/operator.js";
import { requestInvalid } from "../rest/transport-errors.js";
import { MCP_PLATFORM_PATH, MCP_ROUTE_VERSION } from "./mcp-surface.js";
import {
  currentTokenCursor,
  nextTokenCursor,
  revokedTokenResource,
  tokenListQueryValidator,
  tokenResource,
  tokenScopeQueryValidator,
  type RevokedTokenResource,
  type TokenListQuery,
  type TokenResource,
} from "./token-lifecycle.js";
import {
  mintedTokenResource,
  mintingOperator,
  optionalTtlSeconds,
  permissionTier,
  requireMint,
  requireObject,
  requiredString,
  stringArray,
  type MintedTokenResource,
} from "./token-mint.js";

/** The request, after the chassis has read it. */
export interface MintPlatformTokenBody {
  readonly environmentId: string;
  readonly name: string;
  readonly permissions: readonly string[];
  readonly tier: McpPermissionTier;
  readonly ttlSeconds: number | null;
}

/**
 * EVERY VIOLATION IS COLLECTED BEFORE ANY IS REPORTED.
 *
 * A validator that returned on the first bad field would make a caller with
 * three mistakes take three round trips to find them, and M0.4 §2's error
 * envelope carries `fields[]` precisely so it does not have to.
 */
export const mintPlatformTokenValidator = (input: unknown): Result<MintPlatformTokenBody> => {
  const object = requireObject(input);
  if (!object.ok) return err(object.error);
  const violations: FieldViolation[] = [];
  const environmentId = requiredString(object.value, "environmentId", violations);
  const name = requiredString(object.value, "name", violations);
  // NO FALLBACK. A platform token with no permissions can call nothing, and the
  // legacy handler's `?? []` reaches a service that throws — a 500 for a request
  // the caller could have been told about.
  const permissions = stringArray(object.value, "permissions", violations, null);
  const tier = permissionTier(object.value, violations);
  const ttlSeconds = optionalTtlSeconds(object.value, violations);
  if (violations.length > 0) return err(requestInvalid(violations));
  return ok({ environmentId, name, permissions, tier, ttlSeconds });
};

const MINT_BODY_PIPE = new DomainValidationPipe(mintPlatformTokenValidator);
const LIST_QUERY_PIPE = new DomainValidationPipe(tokenListQueryValidator);
const REVOKE_QUERY_PIPE = new DomainValidationPipe(tokenScopeQueryValidator);

/**
 * The revocation's request, after the chassis has read it.
 *
 * IT IS THE SAME `environmentId` THE MINT TAKES AND IT IS IN THE BODY FOR THE SAME
 * REASON: this operation has a body, so the tenant is a body field and can be
 * described by an OpenAPI request schema. The two token LISTINGS have no body and
 * take it as `?environmentId=`; `token-lifecycle.ts` states the one rule both
 * follow.
 *
 * THE LEGACY HANDLER TAKES A BODY AND IGNORES IT (`@Body() _body: unknown`),
 * reading its scope from `X-Platos-*` headers instead. So a caller migrating to
 * this route is not losing a field — it is gaining the only one this operation
 * ever needed.
 */
export interface RevokePlatformTokenBody {
  readonly environmentId: string;
}

export const revokePlatformTokenValidator = (input: unknown): Result<RevokePlatformTokenBody> => {
  const object = requireObject(input);
  if (!object.ok) return err(object.error);
  const violations: FieldViolation[] = [];
  const environmentId = requiredString(object.value, "environmentId", violations);
  if (violations.length > 0) return err(requestInvalid(violations));
  return ok({ environmentId });
};

const REVOKE_BODY_PIPE = new DomainValidationPipe(revokePlatformTokenValidator);

@Controller({ path: MCP_PLATFORM_PATH, version: MCP_ROUTE_VERSION })
export class McpPlatformTokensController {
  constructor(@Inject(REST_APPLICATION) private readonly application: RestApplication) {}

  /**
   * `201` AND NOT `200`. A mint CREATES a credential, and M0.4 §2's item
   * envelope says nothing about the status — so the status is HTTP's own rule
   * rather than this route's opinion. It also matters to the idempotency gate:
   * `settlementFor` records everything below 500, so the replay of a successful
   * mint returns the same 201 and the same secret with
   * `Idempotency-Replayed: true`.
   */
  @Post("tokens")
  @HttpCode(201)
  async mint(
    @Req() request: InboundOperatorRequest,
    @Body(MINT_BODY_PIPE) body: MintPlatformTokenBody,
  ): Promise<ItemEnvelope<MintedTokenResource>> {
    const app = this.application.app;
    const operator = await mintingOperator(app, request);
    const authorization = await authorizeEnvironment(
      app,
      operator,
      body.environmentId,
      "secret:mutate",
    );
    const minted = await requireMint(app).mintBearerCredential({
      kind: "mcp-token",
      // THE AUTHORIZATION'S SCOPE, never one assembled from the body. Tenancy
      // re-derived it from the environment's own ancestry while deciding, and
      // `EnvironmentOperatorAuthorization` is branded so a caller cannot forge
      // one — using the id from the request would throw that away one line after
      // earning it.
      scope: authorization.scope,
      label: body.name,
      permissions: body.permissions,
      // THE ACTOR, and the impersonation case is already refused above. `McpToken`
      // has one actor column and the store reads it back as the credential's
      // principal, so these two are the same value BY NECESSITY here — which is
      // exactly why an impersonated session, where they would differ, cannot
      // reach this line.
      createdByUserId: operator.actorUserId,
      principalId: operator.actorUserId as never,
      subjectId: null,
      permissionTier: body.tier,
      ttlSeconds: body.ttlSeconds,
    });
    if (!minted.ok) raise(minted.error);
    return itemEnvelope(mintedTokenResource(minted.value));
  }

  /**
   * The environment's platform credentials, newest first.
   *
   * `metadata` AND NOT `secret:mutate`. This route returns labels, permission
   * lists, tiers and lifetimes and NO secret of any kind — the contract's
   * `BearerCredentialView` has no digest field to omit — so it is a read, and
   * requiring the mutation level would lock a viewer out of the inventory they
   * need to notice a credential that should not exist.
   *
   * A REFUSAL IS NOT AN EMPTY PAGE. `authorizeEnvironment` raises, so an operator
   * with no membership gets `TENANCY_ENVIRONMENT_FORBIDDEN` at 403 carrying which
   * gate closed — never `200 {"data":[]}`, which would tell them an environment
   * they cannot see holds no credentials.
   */
  @Get("tokens")
  async list(
    @Req() request: InboundOperatorRequest,
    @Query(LIST_QUERY_PIPE) query: TokenListQuery,
  ): Promise<CollectionEnvelope<TokenResource>> {
    const app = this.application.app;
    const operator = await authenticateOperator(app, request);
    const authorization = await authorizeEnvironment(app, operator, query.environmentId);
    const page = await requireMint(app).listBearerCredentials({
      kind: "mcp-token",
      // THE AUTHORIZATION'S SCOPE, never one assembled from the query string —
      // the same rule the mint above states. Tenancy re-derived it from the
      // environment's own ancestry while deciding.
      scope: authorization.scope,
      limit: query.limit,
      offset: query.offset,
    });
    if (!page.ok) raise(page.error);
    return collectionEnvelope({
      rows: page.value.credentials.map(tokenResource),
      cursor: currentTokenCursor(query.offset),
      limit: page.value.limit,
      nextCursor: nextTokenCursor(page.value),
      total: page.value.total,
    });
  }

  /**
   * Revoke one platform credential, idempotently.
   *
   * `secret:mutate`, THE SAME LEVEL THE MINT ASKS FOR. Destroying a credential is
   * as much a change to what can reach an environment as creating one, and a
   * revocation available at `metadata` would let any reader lock an integration
   * out.
   *
   * `200` AND NOT `204`, and the body carries `alreadyRevoked`. The contract
   * distinguishes "this call revoked it" from "it was already revoked" because
   * both legacy services returned one boolean for the two; answering 204 would put
   * that collapse straight back. A credential that is not in this environment —
   * or not anywhere — is `404 MCP_TOKEN_NOT_FOUND`, which is the legacy handler's
   * own code.
   */
  @Post("tokens/:id/revoke")
  @HttpCode(200)
  async revoke(
    @Req() request: InboundOperatorRequest,
    @Param("id") id: string,
    @Query(REVOKE_QUERY_PIPE) _query: unknown,
    @Body(REVOKE_BODY_PIPE) body: RevokePlatformTokenBody,
  ): Promise<ItemEnvelope<RevokedTokenResource>> {
    const app = this.application.app;
    const operator = await mintingOperator(app, request);
    const authorization = await authorizeEnvironment(
      app,
      operator,
      body.environmentId,
      "secret:mutate",
    );
    const revoked = await requireMint(app).revokeBearerCredential({
      kind: "mcp-token",
      credentialId: id,
      scope: authorization.scope,
      // THE ACTOR, and the impersonation case is refused above by
      // `mintingOperator`. `McpToken.revokedBy` has one column and recording an
      // impersonated session's effective user there would attribute the
      // revocation to somebody who did not perform it.
      revokedByUserId: operator.actorUserId,
    });
    if (!revoked.ok) raise(revoked.error);
    const resource = revokedTokenResource(id, revoked.value);
    if (!resource.ok) raise(resource.error);
    return itemEnvelope(resource.value);
  }
}
