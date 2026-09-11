// THE PLATFORM MCP CREDENTIAL SURFACE: MINT, LIST, REVOKE.
//
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
//
// -----------------------------------------------------------------------------
// GET /mcp/platform/tokens AND POST /mcp/platform/tokens/:id/revoke
//
// WIN-268 (M4.2). Both are in the generated operation manifest with an
// `apps/agent` implementation and, until now, none here — the same shape the mint
// above had before P1, and the same cause: a V1 route may only reach a contract
// method, and `identity-access` published no listing and no revocation.
//
// THEY ASK FOR DIFFERENT ACCESS LEVELS AND THAT IS THE POINT. The listing asks for
// `metadata` because it answers with no material at all; the revocation asks for
// `secret:mutate` because ending a credential changes the environment's secrets.
// Each method's own note gives the reasoning.

import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";

import { err, ok, type FieldViolation, type Result } from "@platos/kernel";
import type { McpPermissionTier } from "@platos/context-identity-access";

import { DomainValidationPipe } from "../../http/validation.pipe.js";
import { REST_APPLICATION, type RestApplication } from "../rest/dependencies.js";
import {
  collectionEnvelope,
  encodeCursor,
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
  bearerCredentialResource,
  nextTokenCursor,
  revokedTokenResource,
  tokenListQueryValidator,
  PLATFORM_TOKEN_KIND,
  type BearerCredentialResource,
  type RevokedTokenResource,
  type TokenListQuery,
  type TokenListWireQuery,
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

/**
 * The revocation's body: the environment, and nothing else.
 *
 * IT IS A BODY AND NOT A QUERY because this route is a `POST` — and the method is
 * not a free choice: `http/idempotency-policy.ts` binds the template
 * `POST /mcp/platform/tokens/:id/revoke`, compared as a string against the
 * generated manifest. Its sibling on the entity surface is a `DELETE` and reads
 * the same value from the query for the same reason in reverse. Neither reads a
 * header; see `token-lifecycle.ts`.
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
const LIST_QUERY_PIPE = new DomainValidationPipe<TokenListQuery, TokenListWireQuery>(
  tokenListQueryValidator,
);

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
   * `GET /mcp/platform/tokens` — the listing the dashboard's MCP settings page
   * reads, served on the V1 chassis for the first time.
   *
   * `metadata` AND NOT `secret:mutate`, which is the one authorization decision
   * this route makes and the opposite of the mint's. `EnvironmentAccess` has two
   * levels and `operator.ts` states the rule: "Asking for more than a route needs
   * is how a viewer-shaped role stops being able to read anything." This answers
   * with no secret and no digest — `BearerCredentialResource` has no field that
   * could carry one — so what it exposes is an inventory, and auditing which
   * credentials exist in an environment is exactly what a viewer should be able to
   * do without being able to mint or end one.
   *
   * THE AUTHORIZATION'S SCOPE IS PASSED, NEVER THE ID FROM THE QUERY. Tenancy
   * re-derived it from the environment's own ancestry while deciding, and
   * `EnvironmentOperatorAuthorization` is branded so a caller cannot forge one —
   * using the raw query value would throw that away one line after earning it.
   *
   * AND THE REFUSAL IS RAISED RATHER THAN TURNED INTO AN EMPTY PAGE. An operator
   * shown `200 {"data":[]}` for an environment they may not see cannot tell it from
   * one that holds no credentials, and neither can a support engineer reading the
   * response.
   */
  @Get("tokens")
  async list(
    @Req() request: InboundOperatorRequest,
    @Query(LIST_QUERY_PIPE) query: TokenListQuery,
  ): Promise<CollectionEnvelope<BearerCredentialResource>> {
    const app = this.application.app;
    const operator = await authenticateOperator(app, request);
    const authorization = await authorizeEnvironment(app, operator, query.environmentId);
    const page = await requireMint(app).listBearerCredentials({
      kind: PLATFORM_TOKEN_KIND,
      scope: authorization.scope,
      // NULL BY CONSTRUCTION, not by omission: `McpToken` has no subject column at
      // all, and the contract refuses a platform listing that names one.
      subjectId: null,
      limit: query.limit,
      offset: query.offset,
    });
    if (!page.ok) raise(page.error);
    return collectionEnvelope({
      rows: page.value.credentials.map(bearerCredentialResource),
      cursor: query.offset === 0 ? null : encodeCursor({ offset: query.offset }),
      limit: page.value.limit,
      nextCursor: nextTokenCursor(page.value),
      total: page.value.total,
    });
  }

  /**
   * `POST /mcp/platform/tokens/:id/revoke` — the one that matters most.
   *
   * `secret:mutate`, because ending a credential is a change to the environment's
   * secrets even though it returns none. The mint asks for the same level, and a
   * revocation that asked for `metadata` would be a revocation any viewer-shaped
   * role could perform.
   *
   * `200` AND NOT `201` OR `204`. It creates nothing, so not 201; and it has a body
   * worth reading, so not 204 — `previousState` and `newlyRevoked` are the whole
   * point of this route over the legacy one, which answered a bare boolean and
   * could not tell a mistyped id from a second click.
   *
   * IT IS IDEMPOTENT AND `idempotency-policy.ts` ALREADY SAYS SO. That table
   * classes this template `exempt` on the recorded ground that "a token revoked
   * twice is revoked", so the second call is a SUCCESS reporting
   * `previousState: "revoked"` with the original instant, not a refusal — a
   * refusal would falsify an exemption already in the tree. The only refusal is
   * `CREDENTIAL_NOT_FOUND`, for an id no row in this environment carries.
   */
  @Post("tokens/:id/revoke")
  @HttpCode(200)
  async revoke(
    @Req() request: InboundOperatorRequest,
    @Param("id") id: string,
    @Body(REVOKE_BODY_PIPE) body: RevokePlatformTokenBody,
  ): Promise<ItemEnvelope<RevokedTokenResource>> {
    const app = this.application.app;
    const operator = await authenticateOperator(app, request);
    const authorization = await authorizeEnvironment(
      app,
      operator,
      body.environmentId,
      "secret:mutate",
    );
    const revoked = await requireMint(app).revokeBearerCredential({
      kind: PLATFORM_TOKEN_KIND,
      credentialId: id,
      scope: authorization.scope,
      subjectId: null,
      // THE ACTOR, NOT THE EFFECTIVE USER, and unlike the mint an impersonated
      // session is NOT refused here. The mint refuses one because the credential it
      // creates outlives the impersonation and its single actor column cannot record
      // both humans; a revocation creates nothing that outlives anything, and
      // `McpToken.revokedBy` records who did it — so the real human is written and
      // the audit line is true.
      revokedByUserId: operator.actorUserId,
    });
    if (!revoked.ok) raise(revoked.error);
    return itemEnvelope(revokedTokenResource(revoked.value));
  }
}
