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

import { Body, Controller, HttpCode, Inject, Post, Req } from "@nestjs/common";

import { err, ok, type FieldViolation, type Result } from "@platos/kernel";
import type { McpPermissionTier } from "@platos/context-identity-access";

import { DomainValidationPipe } from "../../http/validation.pipe.js";
import { REST_APPLICATION, type RestApplication } from "../rest/dependencies.js";
import { itemEnvelope, type ItemEnvelope } from "../rest/envelope.js";
import { raise } from "../rest/fault.js";
import { authorizeEnvironment, type InboundOperatorRequest } from "../rest/operator.js";
import { requestInvalid } from "../rest/transport-errors.js";
import { MCP_PLATFORM_PATH, MCP_ROUTE_VERSION } from "./mcp-surface.js";
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
}
