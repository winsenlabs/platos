// /mcp/entity/:entityId/tokens — THE ENTITY CREDENTIAL'S WHOLE LIFE, AND THE
// TENANCY JOIN THE PLATFORM ROUTES DO NOT HAVE.
//
// WIN-268 (M4.2) stage 2 ADDS THE LISTING AND THE REVOCATION beside the mint. All
// three carry the SAME entity/environment pair check described below, and that is
// the reason they are on one controller rather than three: the pair is the failure
// this surface is built against, and a route that skipped it would be a route
// where an operator lists — or revokes — the credentials of an entity in a project
// they may not reach, one gate at a time each of which passes.
//
// -----------------------------------------------------------------------------
// POST /mcp/entity/:entityId/tokens — THE SECOND MINT, AND THE ONE WITH A
// TENANCY JOIN THE PLATFORM MINT DOES NOT HAVE.
//
// The same contract as its sibling: `http/idempotency-policy.ts` classes it
// `required`, the gate has been binding it since M4.1, and until now nothing in
// this process answered it.
//
// -----------------------------------------------------------------------------
// AN ENTITY BELONGS TO A PROJECT; A CREDENTIAL IS BOUNDED BY AN ENVIRONMENT
//
// `McpBearerToken` carries BOTH `entityId` and `environmentId`, and
// `tenancy/domain/entity.ts` says outright why they cannot be derived from each
// other: "The parent. There is no `environmentId` on this row, by design", and
// the natural key is "deliberately built from the project and never from an
// environment, so a caller cannot construct a key that implies an entity belongs
// to one environment of a project."
//
// So a mint has to name both, and naming both creates the failure this route is
// built against: an entity from ONE project and an environment from ANOTHER.
// Every individual check passes. The operator really may administer that
// environment; the entity really exists. What is wrong is the PAIR — and a
// two-tenant test would pass either way, because its foreign scope would be
// coherent. The forged triple is what separates them.
//
// The check is therefore explicit and has its OWN code: the entity's `projectId`
// must equal the project the authorization re-derived from the environment's
// ancestry. `mcp-bearer-token.service.ts` in `apps/agent` makes the same check
// and throws `Error("Entity and environment do not share canonical project
// ancestry")` — a 500 with a string. Here it is a refusal a client can act on.
//
// -----------------------------------------------------------------------------
// `mcpUserId` IS NOT A PLATOS USER, AND THE COLUMN SAYS SO
//
// `McpBearerToken.mcpUserId` is a String with no foreign key while
// `createdByUserId` is a `@db.Uuid` with one, because the first identifies an
// END USER of the entity — somebody who has no Platos account — and the second
// identifies the operator who issued the credential. The default the oracle uses
// when the caller does not name one is `mcp:pat:<token id>`, which is a
// self-referential identifier for a credential that acts as nobody but itself.
// That default is preserved rather than improved: a different one would make
// tokens minted by the two deployables sort differently in the same table.

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";

import {
  asIdentifier,
  domainError,
  err,
  ok,
  type DomainError,
  type EntityId,
  type FieldViolation,
  type Result,
} from "@platos/kernel";
import type { EntityRecord } from "@platos/context-tenancy";

import type { AppModule } from "../../app.module.js";
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
  requireTenancy,
  type InboundOperatorRequest,
} from "../rest/operator.js";
import { requestInvalid } from "../rest/transport-errors.js";
import { MCP_ENTITY_PATH, MCP_ROUTE_VERSION } from "./mcp-surface.js";
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
  type TokenScopeQuery,
} from "./token-lifecycle.js";
import {
  mintedTokenResource,
  mintingOperator,
  optionalTtlSeconds,
  requireMint,
  requireObject,
  requiredString,
  stringArray,
  type MintedTokenResource,
} from "./token-mint.js";

/**
 * The default scope set an entity token carries.
 *
 * `["mcp:tools"]` is `ENTITY_MCP_SCOPES` — the set the entity MCP server's OAuth
 * metadata advertises — and it is the default `mcp-bearer-token.service.ts`
 * applies. It is spelled here rather than imported because `apps/core-api` does
 * not depend on `apps/agent` and must not start to; the two are joined by the
 * generated manifest's `mcpContract.entityScopes`, which
 * `scripts/arch/mcp-surface.mjs` reconciles against the declaration.
 */
export const DEFAULT_ENTITY_TOKEN_SCOPES: readonly string[] = Object.freeze(["mcp:tools"]);

/**
 * The pair that does not belong together.
 *
 * ITS OWN CODE, and not `TENANCY_ENVIRONMENT_FORBIDDEN`. That code means "you
 * may not administer this environment", which is false here — the operator may.
 * What is wrong is that the entity lives in a different project, and an operator
 * told "forbidden" would go and check their memberships, find them correct, and
 * be stuck.
 */
export function entityEnvironmentMismatch(entityId: string, projectId: string): DomainError {
  return domainError(
    "MCP_ENTITY_ENVIRONMENT_MISMATCH",
    "invalid_input",
    "The entity and the environment do not share a project.",
    {
      fields: [
        {
          field: "body.environmentId",
          code: "mismatch",
          message: "This environment does not belong to the entity's project.",
        },
      ],
      details: { entityId, entityProjectId: projectId },
    },
  );
}

/** The request, after the chassis has read it. */
export interface MintEntityTokenBody {
  readonly environmentId: string;
  readonly label: string;
  readonly scopes: readonly string[];
  readonly mcpUserId: string | null;
  readonly ttlSeconds: number | null;
}

export const mintEntityTokenValidator = (input: unknown): Result<MintEntityTokenBody> => {
  const object = requireObject(input);
  if (!object.ok) return err(object.error);
  const violations: FieldViolation[] = [];
  const environmentId = requiredString(object.value, "environmentId", violations);
  const label = requiredString(object.value, "label", violations);
  // A REAL DEFAULT, unlike the platform mint's `permissions`. The oracle applies
  // `["mcp:tools"]` when the caller names none, and an entity token with the
  // entity's own scope set is a usable credential rather than a useless one.
  const scopes = stringArray(object.value, "scopes", violations, DEFAULT_ENTITY_TOKEN_SCOPES);
  const ttlSeconds = optionalTtlSeconds(object.value, violations);
  const rawMcpUserId = object.value["mcpUserId"];
  let mcpUserId: string | null = null;
  if (rawMcpUserId !== undefined && rawMcpUserId !== null) {
    if (typeof rawMcpUserId !== "string" || rawMcpUserId.trim() === "") {
      violations.push({
        field: "body.mcpUserId",
        code: "invalid",
        message: "Send a non-empty string, or omit the field.",
      });
    } else {
      mcpUserId = rawMcpUserId;
    }
  }
  if (violations.length > 0) return err(requestInvalid(violations));
  return ok({ environmentId, label, scopes, mcpUserId, ttlSeconds });
};

const MINT_BODY_PIPE = new DomainValidationPipe(mintEntityTokenValidator);
const LIST_QUERY_PIPE = new DomainValidationPipe(tokenListQueryValidator);
const REVOKE_QUERY_PIPE = new DomainValidationPipe(tokenScopeQueryValidator);

/** The entity named in the path, or tenancy's own refusal. */
async function findEntity(app: AppModule, entityId: string): Promise<EntityRecord> {
  const found = await requireTenancy(app).findEntity(asIdentifier<EntityId>(entityId));
  if (!found.ok) raise(found.error);
  return found.value;
}

/**
 * The entity, having checked it lives in the authorized environment's project.
 *
 * ALL THREE ROUTES CALL THIS AND NONE REPEATS IT, which is the rule
 * `token-mint.ts` states for `mintingOperator`: two guards spelling the same rule
 * differently is how one of them ends up not spelling it at all. The check is
 * exactly the one the mint's banner describes — the entity's `projectId` must
 * equal the project tenancy re-derived from the environment's ancestry — and it is
 * the reason a forged (entity, environment) pair cannot list or revoke anything.
 *
 * THE ORDER IS AUTHORIZE-THEN-LOAD IN EVERY CALLER. Reversed, an unauthorized
 * caller could probe which entity ids exist by reading the difference between a
 * not-found and a forbidden.
 */
async function entityInProject(
  app: AppModule,
  entityId: string,
  projectId: string,
): Promise<EntityRecord> {
  const entity = await findEntity(app, entityId);
  if (entity.projectId !== projectId) {
    raise(entityEnvironmentMismatch(entityId, entity.projectId));
  }
  return entity;
}

@Controller({ path: MCP_ENTITY_PATH, version: MCP_ROUTE_VERSION })
export class McpEntityTokensController {
  constructor(@Inject(REST_APPLICATION) private readonly application: RestApplication) {}

  @Post(":entityId/tokens")
  @HttpCode(201)
  async mint(
    @Req() request: InboundOperatorRequest,
    @Param("entityId") entityId: string,
    @Body(MINT_BODY_PIPE) body: MintEntityTokenBody,
  ): Promise<ItemEnvelope<MintedTokenResource>> {
    const app = this.application.app;
    const operator = await mintingOperator(app, request);
    // THE ENVIRONMENT IS AUTHORIZED FIRST, and the entity is loaded second.
    // Reversed, an unauthorized caller could probe which entity ids exist by
    // reading the difference between a not-found and a forbidden.
    const authorization = await authorizeEnvironment(
      app,
      operator,
      body.environmentId,
      "secret:mutate",
    );
    const entity = await entityInProject(app, entityId, authorization.scope.projectId);
    const minted = await requireMint(app).mintBearerCredential({
      kind: "entity-bearer-token",
      scope: authorization.scope,
      label: body.label,
      permissions: body.scopes,
      // The OPERATOR who issued it — `createdByUserId`, the column with the
      // foreign key. Distinct from the principal below, which is an end user of
      // the entity and has no Platos account at all. This is the one mint where
      // the two are genuinely different values rather than the same one twice.
      createdByUserId: operator.actorUserId,
      // NULL MEANS "acts as nobody but itself". The contract applies the
      // oracle's `mcp:pat:<credential id>` default, and it applies it there
      // because the credential id is minted there — a default composed here
      // would have to invent a second id, and every token minted for one entity
      // would share a principal.
      principalId: body.mcpUserId === null ? null : (body.mcpUserId as never),
      subjectId: entity.id,
      permissionTier: null,
      ttlSeconds: body.ttlSeconds,
    });
    if (!minted.ok) raise(minted.error);
    return itemEnvelope(mintedTokenResource(minted.value));
  }

  /**
   * One entity's credentials in one environment, newest first.
   *
   * `metadata`, for the reason its platform sibling states: this returns redacted
   * metadata and no secret, so it is a read.
   *
   * THE ENTITY IS A TENANT CLAUSE HERE AND NOT A FILTER. `listBearerCredentials`
   * refuses an `entity-bearer-token` listing that names no subject, and the store
   * puts the entity in the `where` beside the environment — so this route cannot
   * be turned into "every entity token in the environment" by omitting a
   * parameter.
   */
  @Get(":entityId/tokens")
  async list(
    @Req() request: InboundOperatorRequest,
    @Param("entityId") entityId: string,
    @Query(LIST_QUERY_PIPE) query: TokenListQuery,
  ): Promise<CollectionEnvelope<TokenResource>> {
    const app = this.application.app;
    const operator = await authenticateOperator(app, request);
    const authorization = await authorizeEnvironment(app, operator, query.environmentId);
    const entity = await entityInProject(app, entityId, authorization.scope.projectId);
    const page = await requireMint(app).listBearerCredentials({
      kind: "entity-bearer-token",
      scope: authorization.scope,
      // THE ENTITY THE STORE CONFIRMED, not the string from the path. They are the
      // same characters and one of them has been checked against the project.
      subjectId: entity.id,
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
   * Revoke one entity credential, idempotently.
   *
   * A `DELETE` WHERE THE PLATFORM ROUTE IS A `POST :id/revoke`, and the asymmetry
   * is the MANIFEST'S rather than a choice made here: the generated operation
   * table already names `DELETE /mcp/entity/:entityId/tokens/:tokenId` and
   * `POST /mcp/platform/tokens/:id/revoke`, and both spellings have live callers.
   * A V1 surface that regularised them would break one of the two.
   *
   * `200` WITH A BODY AND NOT `204`, for the reason the platform route gives:
   * `alreadyRevoked` is a fact the caller needs and a 204 has nowhere to put it.
   *
   * IT IS NOT `Idempotency-Key`-REQUIRED AND DOES NOT NEED TO BE. A retried mint
   * leaves a second live credential nobody knows about; a retried revocation
   * leaves the same credential revoked at the same instant by the same actor, and
   * says `alreadyRevoked: true` the second time. The idempotency is in the
   * operation rather than in a reservation.
   */
  @Delete(":entityId/tokens/:tokenId")
  @HttpCode(200)
  async revoke(
    @Req() request: InboundOperatorRequest,
    @Param("entityId") entityId: string,
    @Param("tokenId") tokenId: string,
    @Query(REVOKE_QUERY_PIPE) query: TokenScopeQuery,
  ): Promise<ItemEnvelope<RevokedTokenResource>> {
    const app = this.application.app;
    const operator = await mintingOperator(app, request);
    const authorization = await authorizeEnvironment(
      app,
      operator,
      query.environmentId,
      "secret:mutate",
    );
    const entity = await entityInProject(app, entityId, authorization.scope.projectId);
    const revoked = await requireMint(app).revokeBearerCredential({
      kind: "entity-bearer-token",
      credentialId: tokenId,
      scope: authorization.scope,
      subjectId: entity.id,
      // RECORDED ON THE COMMAND EVEN THOUGH `McpBearerToken` HAS NO `revokedBy`
      // COLUMN. The adapter's banner says so outright: the legacy service puts the
      // actor in an `AdminAudit` row, which is `observability`'s table and a
      // context this deployable does not compose. Carrying it means nothing has to
      // be threaded through the day that column or that context arrives.
      revokedByUserId: operator.actorUserId,
    });
    if (!revoked.ok) raise(revoked.error);
    const resource = revokedTokenResource(tokenId, revoked.value);
    if (!resource.ok) raise(resource.error);
    return itemEnvelope(resource.value);
  }
}
