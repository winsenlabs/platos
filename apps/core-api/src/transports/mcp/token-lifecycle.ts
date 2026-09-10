// WIN-268 (M4.2) stage 2 — what the FOUR token lifecycle routes share.
//
// `token-mint.ts` is the same file for the two MINTS beside these. The split is
// along the line the contract draws rather than a filing convenience: a mint
// returns the one copy of a secret and is `Idempotency-Key`-required; a listing
// and a revocation return metadata and are not. Keeping the projections in one
// file would put `token` — the raw credential — one property away from the shape
// a listing returns a hundred of.
//
// -----------------------------------------------------------------------------
// THE TENANT TRAVELS IN THE REQUEST, AND NEVER IN A HEADER
//
// The legacy handlers in `apps/agent` read their scope from `X-Platos-*` request
// headers through `ScopeGuard`. `platform-tokens.controller.ts` records why the
// V1 mint does not: an operation whose tenancy arrives in headers cannot be
// described by an OpenAPI request schema, cannot be validated by the chassis
// `ValidationPipe`, and cannot report a missing tenant as `fields[]`.
//
// The same rule applies here, and it lands in two different places because these
// four operations have two different shapes:
//
//   POST /mcp/platform/tokens/:id/revoke   has a body -> `body.environmentId`
//   GET  /mcp/platform/tokens              has none   -> `query.environmentId`
//   GET  /mcp/entity/:entityId/tokens      has none   -> `query.environmentId`
//   DELETE /mcp/entity/:entityId/tokens/:tokenId  none -> `query.environmentId`
//
// One rule stated once: wherever the operation carries a request body the tenant
// is a body field, and where it carries none it is a NAMED query parameter. A
// DELETE with a body would be the third shape and is not worth having; HTTP
// permits one and almost nothing in the path between a browser and this process
// reliably forwards it.
//
// -----------------------------------------------------------------------------
// A LISTING RETURNS NO DIGEST, AND THAT IS THE CONTRACT'S DOING RATHER THAN THIS
// FILE'S
//
// `BearerCredentialView` has no `tokenHash` field to omit. The domain models the
// listing row as a separate type from the verification record for exactly this
// reason, so this projection is a copy and not a redaction — there is nothing
// here for a future `...spread` to leak. `scripts/arch/secret-response-census.mjs`
// counts secret-shaped properties across this whole tree and the two mints are
// its only entries in `transports/mcp`; these routes add none.

import {
  domainError,
  err,
  ok,
  type DomainError,
  type FieldViolation,
  type Result,
} from "@platos/kernel";
import type {
  BearerCredentialPageView,
  BearerCredentialView,
  McpPermissionTier,
  RevokedBearerCredentialView,
} from "@platos/context-identity-access";

import { decodeCursor, encodeCursor } from "../rest/envelope.js";
import { parsePageQuery, type QueryInput } from "../rest/page.js";
import { instant, nullableInstant } from "../rest/resources.js";
import { requestInvalid } from "../rest/transport-errors.js";
import { requiredString } from "./token-mint.js";

/**
 * One credential on the wire.
 *
 * `tokenId` AND NOT `credentialId`, matching `MintedTokenResource.tokenId` and
 * both legacy listings' `id`. A caller that minted a credential and then listed
 * it has to be able to join the two by eye, and a V1 surface that renamed the
 * field between the two operations would break that for no gain.
 */
export interface TokenResource {
  readonly tokenId: string;
  readonly label: string;
  readonly permissions: readonly string[];
  /** `"scope" | "admin"` for a platform token; null for an entity token. */
  readonly tier: McpPermissionTier | null;
  /** Whom it acts as: the minting operator, or the entity's own end-user id. */
  readonly principalId: string;
  /** The entity, for an entity token. Null for a platform one. */
  readonly entityId: string | null;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

export function tokenResource(credential: BearerCredentialView): TokenResource {
  return {
    tokenId: credential.credentialId,
    label: credential.label,
    permissions: credential.permissions,
    tier: credential.permissionTier,
    principalId: credential.principalId,
    entityId: credential.subjectId,
    createdAt: instant(credential.createdAt),
    expiresAt: nullableInstant(credential.expiresAt),
    lastUsedAt: nullableInstant(credential.lastUsedAt),
    revokedAt: nullableInstant(credential.revokedAt),
  };
}

/**
 * What a revocation answers with.
 *
 * `alreadyRevoked` IS ON THE WIRE AS A FIELD RATHER THAN AS A STATUS CODE. Both
 * outcomes are 200 — the request succeeded and the credential is revoked either
 * way — and squeezing the difference into 200-vs-204 would be a distinction no
 * client library surfaces. The contract distinguishes the two because the legacy
 * boolean could not; throwing that away at the transport would put the collapse
 * back one layer down.
 */
export interface RevokedTokenResource {
  readonly tokenId: string;
  readonly alreadyRevoked: boolean;
  readonly revokedAt: string | null;
  readonly token: TokenResource;
}

/** A credential that is not in the caller's environment, or is not there at all. */
export function tokenNotFound(tokenId: string): DomainError {
  return domainError("MCP_TOKEN_NOT_FOUND", "not_found", "No such MCP token in this environment.", {
    // THE ID AND NOTHING ELSE. It came from the caller's own URL, so echoing it
    // tells them nothing they did not send — whereas naming the environment the
    // credential IS in would confirm the existence of a row they may not see,
    // which is the cross-tenant existence oracle the contract's `absent` outcome
    // exists to avoid.
    //
    // THE CODE IS THE LEGACY HANDLER'S OWN. `mcp-platform.controller.revokeToken`
    // throws `{ code: "MCP_TOKEN_NOT_FOUND" }`, and a V1 route that minted a
    // second spelling for the same fact would make a client handle two.
    details: { tokenId },
  });
}

/**
 * The revocation's answer, or the 404.
 *
 * A `Result` rather than a raise, so the mapping from three contract outcomes to
 * two HTTP answers is exercisable without a server and is written ONCE for both
 * revocation routes. The platform route and the entity route differ in method,
 * path and kind and agree on exactly this.
 */
export function revokedTokenResource(
  tokenId: string,
  view: RevokedBearerCredentialView,
): Result<RevokedTokenResource> {
  if (view.outcome === "absent" || view.credential === null) return err(tokenNotFound(tokenId));
  return ok({
    tokenId: view.credential.credentialId,
    alreadyRevoked: view.outcome === "alreadyRevoked",
    revokedAt: nullableInstant(view.credential.revokedAt),
    token: tokenResource(view.credential),
  });
}

/** What both listings read out of the query string. */
export interface TokenListQuery {
  readonly environmentId: string;
  readonly offset: number;
  readonly limit: number;
}

/**
 * The offset inside an opaque cursor.
 *
 * THE SAME RULE `environment-end-users.controller.ts` STATES, and it is repeated
 * rather than imported for a boundary reason: `transports/rest` and
 * `transports/mcp` are two surfaces with two versioning schemes (the REST one is
 * URL-major, the MCP one carries its major in `serverInfo.version`), and a shared
 * cursor grammar between them would be a coupling neither ADR asks for. What must
 * not differ is the REFUSAL: a cursor that decodes to JSON but not to this shape
 * is refused, never treated as offset zero, because silently starting from the
 * beginning is how a client paging a token list re-reads page one forever.
 */
function offsetInCursor(cursor: string | null, violations: FieldViolation[]): number {
  const malformed = (): number => {
    violations.push({
      field: "query.cursor",
      code: "malformed",
      message: "cursor is opaque: send back a nextCursor this service issued.",
    });
    return 0;
  };
  if (cursor === null) return 0;
  const decoded = decodeCursor(cursor);
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return malformed();
  const offset = (decoded as { readonly offset?: unknown }).offset;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) return malformed();
  return offset;
}

/** A query string that is not an object at all. */
function requireQuery(input: unknown): Result<QueryInput> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return err(
      requestInvalid([
        { field: "query", code: "malformed", message: "The query string could not be read." },
      ]),
    );
  }
  return ok(input as QueryInput);
}

/**
 * `?environmentId=…&limit=…&cursor=…`, or every violation at once.
 *
 * THE CHASSIS OWNS `limit` AND `cursor`. `parsePageQuery` holds the integer
 * grammar, the repeated-parameter refusal and the 100-row ceiling; re-implementing
 * any of them here would be a second rule about the same field.
 */
export const tokenListQueryValidator = (input: unknown): Result<TokenListQuery> => {
  const query = requireQuery(input);
  if (!query.ok) return err(query.error);
  const page = parsePageQuery(query.value);
  const violations: FieldViolation[] = page.ok ? [] : [...page.error.fields];
  const environmentId = requiredString(query.value, "environmentId", violations, "query");
  const offset = page.ok ? offsetInCursor(page.value.cursor, violations) : 0;
  if (violations.length > 0) return err(requestInvalid(violations));
  if (!page.ok) return err(page.error);
  return ok({ environmentId, offset, limit: page.value.limit });
};

/** What both revocations need beyond the ids already in the path. */
export interface TokenScopeQuery {
  readonly environmentId: string;
}

/**
 * `?environmentId=…` and nothing else.
 *
 * A `limit` OR A `cursor` HERE IS REFUSED, NOT IGNORED, which is the rule
 * `refuseUnpagedQuery` states for an unpaged collection: an instruction a server
 * cannot carry out must not be accepted silently. A revocation has no page.
 */
export const tokenScopeQueryValidator = (input: unknown): Result<TokenScopeQuery> => {
  const query = requireQuery(input);
  if (!query.ok) return err(query.error);
  const violations: FieldViolation[] = [];
  const environmentId = requiredString(query.value, "environmentId", violations, "query");
  for (const field of ["limit", "cursor", "offset"] as const) {
    if (query.value[field] === undefined) continue;
    violations.push({
      field: `query.${field}`,
      code: "unsupported",
      message: "This operation returns one credential; it has no page to apply this to.",
    });
  }
  if (violations.length > 0) return err(requestInvalid(violations));
  return ok({ environmentId });
};

/**
 * The next page's cursor, or null.
 *
 * DERIVED FROM THE CONTRACT'S `hasMore` and never from arithmetic here. The view
 * already answers "is there another page" from the store's own total, and
 * recomputing it would be a second answer to one question.
 */
export function nextTokenCursor(page: BearerCredentialPageView): string | null {
  return page.hasMore ? encodeCursor({ offset: page.offset + page.limit }) : null;
}

/** The cursor a caller sent, echoed back. Null on the first page. */
export function currentTokenCursor(offset: number): string | null {
  return offset === 0 ? null : encodeCursor({ offset });
}
