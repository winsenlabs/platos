// WHAT THE FOUR MCP TOKEN LIFECYCLE ROUTES SHARE.
//
// `token-mint.ts` is this file's sibling and holds what the two MINTS share. This
// holds what the two LISTINGS and the two REVOCATIONS share, and the split is the
// same one the contract makes: a mint returns the one copy of a secret, and
// nothing here returns any material at all.
//
// -----------------------------------------------------------------------------
// THE LIST DTO SATISFIES THE SECRET-RESPONSE CENSUS BY HAVING NOTHING TO HIDE
//
// `scripts/arch/secret-response-census.mjs` scans every file under
// `apps/core-api/src/transports/**` — a rule widened in P1 precisely because the
// mints' projection lives in a sibling module rather than in a `.controller.ts` —
// and counts a property in a returned object literal whose NAME says the value is
// material. `token` is on that list; `tokenId` explicitly is not, and the census's
// own note says why ("a `tokenId` in a response are all untouched").
//
// `BearerCredentialResource` NAMES NO SUCH PROPERTY, and it cannot acquire one by
// accident: the contract view it is built from (`BearerCredentialView`) carries no
// secret and no digest, and the DOMAIN projection under that
// (`BearerCredentialSummary`) has no `tokenHash` field at all. So this is not a
// route that satisfies the census by remembering to redact — it is a route with
// nothing to redact, checked three layers down.
//
// -----------------------------------------------------------------------------
// WHERE THE ENVIRONMENT ARRIVES, AND WHY IT DIFFERS BY ROUTE
//
// The two mints take `environmentId` in the BODY, for the reason
// `platform-tokens.controller.ts` records: WIN-249 §2 fixes the V1 request shape,
// and tenancy arriving in `X-Platos-*` headers — which is what the legacy
// `ScopeGuard` reads — cannot be described by an OpenAPI request schema, cannot be
// validated by the chassis pipe, and cannot report a missing tenant as `fields[]`.
//
// THE SAME RULE, APPLIED TO METHODS THAT HAVE NO BODY, PUTS IT IN THE QUERY. Two of
// these four are `GET` and one is `DELETE`, and their templates are not a free
// choice: `http/idempotency-policy.ts` binds `POST /mcp/platform/tokens/:id/revoke`
// and `DELETE /mcp/entity/:entityId/tokens/:tokenId` by TEMPLATE, compared as
// strings against the generated manifest. So the platform revocation — a POST —
// reads `environmentId` from its body like the mints, and the two GETs and the
// DELETE read it from the query string. Neither reads a header.

import { err, ok, type FieldViolation, type Result } from "@platos/kernel";
import type {
  BearerCredentialPageView,
  BearerCredentialView,
  CredentialState,
  McpPermissionTier,
  MintableBearerKind,
  RevokedBearerCredentialView,
} from "@platos/context-identity-access";

import { encodeCursor } from "../rest/envelope.js";
import { parsePageQuery, type QueryInput } from "../rest/page.js";
import { instant, nullableInstant } from "../rest/resources.js";
import { requestInvalid } from "../rest/transport-errors.js";
import { offsetInCursor } from "../rest/environment-end-users.controller.js";

/**
 * One credential as a listing renders it. NOTHING HERE IS MATERIAL.
 *
 * `tokenId` and not `id`, matching `MintedTokenResource.tokenId` so a client that
 * minted a credential can find the same row in the listing under the same field
 * name — and matching the one spelling the census explicitly excludes.
 */
export interface BearerCredentialResource {
  readonly tokenId: string;
  readonly label: string;
  readonly permissions: readonly string[];
  /**
   * Whom the credential acts as: the operator who minted a PLATFORM token, an end
   * user of the entity — with no Platos account — for an ENTITY token.
   */
  readonly principalId: string;
  /** `"scope" | "admin"` for a platform token; null for an entity token. */
  readonly tier: McpPermissionTier | null;
  /**
   * `active`, `revoked` or `expired`, as the CONTRACT derived it.
   *
   * Not recomputed here from the two instants below. `domain/credential.ts` fixes
   * once, for every credential in the system, that a revocation beats an expiry
   * when both are true — and a transport that compared the timestamps itself would
   * be a second answer to that question, free to get the order wrong.
   */
  readonly state: CredentialState;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  /** The operator who ended it, where the table records one; else null. */
  readonly revokedBy: string | null;
}

export function bearerCredentialResource(
  credential: BearerCredentialView,
): BearerCredentialResource {
  return {
    tokenId: credential.credentialId,
    label: credential.label,
    permissions: credential.permissions,
    principalId: credential.principalId,
    tier: credential.permissionTier,
    state: credential.state,
    createdAt: instant(credential.createdAt),
    expiresAt: nullableInstant(credential.expiresAt),
    lastUsedAt: nullableInstant(credential.lastUsedAt),
    revokedAt: nullableInstant(credential.revokedAt),
    revokedBy: credential.revokedBy,
  };
}

/** What a revocation answers with. Also no material — there is none to return. */
export interface RevokedTokenResource {
  readonly tokenId: string;
  readonly label: string;
  /** The instant the ROW holds, never the instant this request asked. */
  readonly revokedAt: string;
  /** True when THIS call ended it; false when it was already ended. */
  readonly newlyRevoked: boolean;
  /**
   * What the credential was immediately before this call: `active`, `expired` or
   * `revoked`. The three operator stories a bare boolean could not tell apart.
   */
  readonly previousState: CredentialState;
  readonly revokedBy: string | null;
}

export function revokedTokenResource(
  revoked: RevokedBearerCredentialView,
): RevokedTokenResource {
  return {
    tokenId: revoked.credentialId,
    label: revoked.label,
    revokedAt: instant(revoked.revokedAt),
    newlyRevoked: revoked.newlyRevoked,
    previousState: revoked.previousState,
    revokedBy: revoked.revokedBy,
  };
}

/**
 * `?environmentId=&limit=&cursor=` — WHAT A CALLER SENDS.
 *
 * SEPARATE FROM `TokenListQuery` BECAUSE THE TWO GENUINELY DIFFER, and the
 * difference used to be a documented gap rather than a published schema.
 * `TokenListQuery` is the POST-PARSE shape: it carries `offset`, a number
 * `offsetInCursor` decoded out of `?cursor=`, and it has no `cursor` at all. A
 * document that published it would name a parameter nobody can send and omit two
 * every caller does — so `apps/agent/scripts/rest-schema-derivation.mjs` marked
 * these routes `not-derived` instead.
 *
 * THIS interface is what the pipe declares as its `Wire` argument, so the
 * derivation reads it off the decorator through the type checker and the ratchet
 * guards it like any other field. Every property is a STRING because that is what
 * Express hands across from a query string; the derivation refuses a wire property
 * that is not one, which is what stops the post-parse shape being published by
 * accident.
 *
 * `environmentId` IS REQUIRED, and that is the field whose absence mattered most:
 * an undocumented optional filter costs a generated client nothing, while an
 * undocumented required parameter means a generated client cannot call the route
 * at all.
 */
export interface TokenListWireQuery {
  readonly environmentId: string;
  readonly limit?: string;
  readonly cursor?: string;
}

/** `?environmentId=` alone, for the DELETE that has no page. */
export interface TokenScopeWireQuery {
  readonly environmentId: string;
}

/** The page window plus the environment, read off a query string. */
export interface TokenListQuery {
  readonly environmentId: string;
  readonly offset: number;
  readonly limit: number;
}

/**
 * A required single-valued query parameter.
 *
 * REFUSED BY NAME WHEN ABSENT, so a client that forgot the tenant gets
 * `fields[]` naming `query.environmentId` rather than a 403 about an environment
 * called `undefined`. A repeated value is refused too: `?environmentId=a&environmentId=b`
 * is two instructions, and every rule for picking one is a rule the caller did not
 * agree to — the same reasoning `page.ts` records for a repeated `limit`.
 */
export function requiredQueryString(
  query: QueryInput,
  name: string,
  violations: FieldViolation[],
): string {
  const value = query[name];
  if (value === undefined || value === null) {
    violations.push({
      field: `query.${name}`,
      code: "missing",
      message: "Send a non-empty string.",
    });
    return "";
  }
  if (Array.isArray(value)) {
    violations.push({
      field: `query.${name}`,
      code: "repeated",
      message: "Send this parameter once; it was sent more than once.",
    });
    return "";
  }
  if (typeof value !== "string" || value.trim() === "") {
    violations.push({
      field: `query.${name}`,
      code: "invalid",
      message: "Send a non-empty string.",
    });
    return "";
  }
  return value;
}

/**
 * `?environmentId=&limit=&cursor=`, or every violation at once.
 *
 * THE CHASSIS OWNS `limit` AND `cursor`. `parsePageQuery` is the one integer
 * grammar and the one `MAX_PAGE_SIZE`; re-implementing either here would be a
 * second rule about the same field. `offsetInCursor` is likewise the end-user
 * listing's, reused rather than re-derived, so the two collections agree about what
 * an opaque cursor decodes to and neither silently restarts at page one.
 */
export const tokenListQueryValidator = (input: unknown): Result<TokenListQuery> => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return err(
      requestInvalid([
        { field: "query", code: "malformed", message: "The query string could not be read." },
      ]),
    );
  }
  const query = input as QueryInput;
  const page = parsePageQuery(query);
  const violations: FieldViolation[] = page.ok ? [] : [...page.error.fields];
  const environmentId = requiredQueryString(query, "environmentId", violations);
  const offset = page.ok ? offsetInCursor(page.value.cursor, violations) : 0;
  if (violations.length > 0) return err(requestInvalid(violations));
  if (!page.ok) return err(page.error);
  return ok({ environmentId, offset, limit: page.value.limit });
};

/** `?environmentId=` alone, for the DELETE that has no page. */
export const tokenScopeQueryValidator = (input: unknown): Result<{ readonly environmentId: string }> => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return err(
      requestInvalid([
        { field: "query", code: "malformed", message: "The query string could not be read." },
      ]),
    );
  }
  const violations: FieldViolation[] = [];
  const environmentId = requiredQueryString(input as QueryInput, "environmentId", violations);
  if (violations.length > 0) return err(requestInvalid(violations));
  return ok({ environmentId });
};

/**
 * The next page's cursor, DERIVED FROM THE CONTRACT'S `hasMore`.
 *
 * Never from arithmetic here: the view already answers "is there another page"
 * from the store's own total, and recomputing `offset + limit < total` would be a
 * second answer to one question. `environment-end-users.controller.ts` states the
 * same rule for the same reason.
 */
export function nextTokenCursor(page: BearerCredentialPageView): string | null {
  return page.hasMore ? encodeCursor({ offset: page.offset + page.limit }) : null;
}

/** The `kind` each surface lists. Written once so a controller cannot spell it. */
export const PLATFORM_TOKEN_KIND: MintableBearerKind = "mcp-token";
export const ENTITY_TOKEN_KIND: MintableBearerKind = "entity-bearer-token";
