// THE ENTITY MCP CREDENTIAL SURFACE: MINT, LIST, REVOKE.
//
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
//
// -----------------------------------------------------------------------------
// GET :entityId/tokens AND DELETE :entityId/tokens/:tokenId
//
// WIN-268 (M4.2). Both were in the generated operation manifest with an
// `apps/agent` implementation and none here. THE PAIR CHECK ABOVE APPLIES TO BOTH
// OF THEM, and that is the reason they live in this controller rather than a new
// one: an entity/environment pair is wrong in exactly the same way for a listing
// and a revocation as it is for a mint, and a second controller would have had to
// spell the check again.

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
  encodeCursor,
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
  bearerCredentialResource,
  nextTokenCursor,
  revokedTokenResource,
  tokenListQueryValidator,
  tokenScopeQueryValidator,
  ENTITY_TOKEN_KIND,
  type BearerCredentialResource,
  type RevokedTokenResource,
  type TokenListQuery,
  type TokenListWireQuery,
  type TokenScopeWireQuery,
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
 * Where `environmentId` was read from, so the refusal below can point at it.
 *
 * WIN-268 (M4.2). The mint takes it in the body; the listing and the revocation
 * take it in the query, because a `GET` and a `DELETE` have no body and their
 * templates are fixed by `http/idempotency-policy.ts`. A `fields[]` entry that
 * always said `body.environmentId` would send a client reading a 400 from the
 * listing to look at a request part that route does not have — which is exactly
 * the ambiguity `page.ts` says the dotted paths exist to remove ("`limit` alone
 * would be ambiguous the first time a body carries one too").
 */
export type EnvironmentFieldLocation = "body" | "query";

/**
 * The pair that does not belong together.
 *
 * ITS OWN CODE, and not `TENANCY_ENVIRONMENT_FORBIDDEN`. That code means "you
 * may not administer this environment", which is false here — the operator may.
 * What is wrong is that the entity lives in a different project, and an operator
 * told "forbidden" would go and check their memberships, find them correct, and
 * be stuck.
 */
export function entityEnvironmentMismatch(
  entityId: string,
  projectId: string,
  location: EnvironmentFieldLocation = "body",
): DomainError {
  return domainError(
    "MCP_ENTITY_ENVIRONMENT_MISMATCH",
    "invalid_input",
    "The entity and the environment do not share a project.",
    {
      fields: [
        {
          field: `${location}.environmentId`,
          code: "mismatch",
          message: "This environment does not belong to the entity's project.",
        },
      ],
      details: { entityId, entityProjectId: projectId },
    },
  );
}

/**
 * The pair check, made once and reached by all three routes.
 *
 * IT RAISES RATHER THAN RETURNING, so a route cannot forget to branch on it — the
 * failure this whole check exists against is one where every individual answer is
 * `ok` and the PAIR is wrong, and a boolean somebody ignored would restore it.
 */
async function entityInAuthorizedProject(
  app: AppModule,
  entityId: string,
  authorizedProjectId: string,
  location: EnvironmentFieldLocation,
): Promise<EntityRecord> {
  const entity = await findEntity(app, entityId);
  if (entity.projectId !== authorizedProjectId) {
    raise(entityEnvironmentMismatch(entityId, entity.projectId, location));
  }
  return entity;
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
const LIST_QUERY_PIPE = new DomainValidationPipe<TokenListQuery, TokenListWireQuery>(
  tokenListQueryValidator,
);
const SCOPE_QUERY_PIPE = new DomainValidationPipe<TokenScopeWireQuery, TokenScopeWireQuery>(
  tokenScopeQueryValidator,
);

/** The entity named in the path, or tenancy's own refusal. */
async function findEntity(app: AppModule, entityId: string): Promise<EntityRecord> {
  const found = await requireTenancy(app).findEntity(asIdentifier<EntityId>(entityId));
  if (!found.ok) raise(found.error);
  return found.value;
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
    const entity = await entityInAuthorizedProject(
      app,
      entityId,
      authorization.scope.projectId,
      "body",
    );
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
   * `GET /mcp/entity/:entityId/tokens` — the listing the entity MCP page reads.
   *
   * THE PAIR CHECK IS THE SAME ONE THE MINT MAKES, AND IT IS NOT OPTIONAL HERE.
   * `McpBearerToken` carries both `entityId` and `environmentId`; every individual
   * check can pass while the PAIR is wrong — an entity from one project and an
   * environment from another — and a listing that authorized only the environment
   * and then filtered on a path-supplied entity would answer with the credentials
   * of an entity the operator's authorization says nothing about. `authorizeEnvironment`
   * first and `findEntity` second, for the reason the mint records: reversed, an
   * unauthorized caller could probe which entity ids exist out of the difference
   * between a not-found and a forbidden.
   *
   * `metadata`, not `secret:mutate`. See the platform listing: this answers with an
   * inventory and no material, and asking for more than a route needs is how a
   * viewer-shaped role stops being able to read anything.
   *
   * THE ENTITY IS PART OF THE ADDRESS PASSED TO THE CONTRACT, not a filter applied
   * to its answer. `subjectId` is the entity's own id — the value tenancy just
   * confirmed shares the authorization's project — and the store's WHERE carries
   * both columns; the adapter REFUSES a null subject on this kind rather than
   * widening to the environment, because widening is precisely the cross-entity
   * leak this paragraph is about.
   */
  @Get(":entityId/tokens")
  async list(
    @Req() request: InboundOperatorRequest,
    @Param("entityId") entityId: string,
    @Query(LIST_QUERY_PIPE) query: TokenListQuery,
  ): Promise<CollectionEnvelope<BearerCredentialResource>> {
    const app = this.application.app;
    const operator = await authenticateOperator(app, request);
    const authorization = await authorizeEnvironment(app, operator, query.environmentId);
    const entity = await entityInAuthorizedProject(
      app,
      entityId,
      authorization.scope.projectId,
      "query",
    );
    const page = await requireMint(app).listBearerCredentials({
      kind: ENTITY_TOKEN_KIND,
      scope: authorization.scope,
      subjectId: entity.id,
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
   * `DELETE /mcp/entity/:entityId/tokens/:tokenId` — and it REVOKES rather than
   * deletes, which the method name does not say and this note must.
   *
   * `idempotency-policy.ts` classes this template `exempt` and its recorded reason
   * reads "the second call addresses a row that is already gone". THE ROW IS NOT
   * GONE. `mcp-bearer-token.revoke` sets `revokedAt` and leaves the row, this does
   * the same, and the difference matters to the holder: a revoked row answers
   * `CREDENTIAL_REVOKED` — a decision somebody made — where a deleted one would
   * answer `UNAUTHENTICATED` and read as a typo worth retrying. The exemption's
   * conclusion is still right for the reason the platform sibling gives (revoking
   * twice is revoking, and no secret is returned); only its wording assumes a delete.
   *
   * `secret:mutate`, and the environment comes from the QUERY because a DELETE has
   * no body — the same rule that puts it in the platform revocation's body, applied
   * to a method whose template `idempotency-policy.ts` fixes as a DELETE.
   */
  @Delete(":entityId/tokens/:tokenId")
  @HttpCode(200)
  async revoke(
    @Req() request: InboundOperatorRequest,
    @Param("entityId") entityId: string,
    @Param("tokenId") tokenId: string,
    @Query(SCOPE_QUERY_PIPE) query: { readonly environmentId: string },
  ): Promise<ItemEnvelope<RevokedTokenResource>> {
    const app = this.application.app;
    const operator = await authenticateOperator(app, request);
    const authorization = await authorizeEnvironment(
      app,
      operator,
      query.environmentId,
      "secret:mutate",
    );
    const entity = await entityInAuthorizedProject(
      app,
      entityId,
      authorization.scope.projectId,
      "query",
    );
    const revoked = await requireMint(app).revokeBearerCredential({
      kind: ENTITY_TOKEN_KIND,
      credentialId: tokenId,
      scope: authorization.scope,
      subjectId: entity.id,
      // PASSED AND REPORTED AS NULL, because `McpBearerToken` HAS NO `revokedBy`
      // COLUMN — the legacy service records the actor in an `AdminAudit` row, which
      // is `observability`'s and is not composed. Sending the actor here would be
      // sending a value the table cannot hold, and the view would then have to
      // report an attribution nothing stored.
      revokedByUserId: null,
    });
    if (!revoked.ok) raise(revoked.error);
    return itemEnvelope(revokedTokenResource(revoked.value));
  }
}
