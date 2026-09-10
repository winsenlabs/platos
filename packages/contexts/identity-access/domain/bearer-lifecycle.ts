// WIN-268 (M4.2) stage 2 — THE OTHER HALF OF A BEARER CREDENTIAL'S LIFE.
//
// `bearer-token.ts` reads one credential (`authenticateBearerCredential`) and
// plans a new one (`planBearerCredential`). Between those two there was nothing:
// no way to see which credentials an environment holds and no way to take one
// away. `scripts/arch/mcp-store-ownership.mjs` states the consequence in its own
// words — "`list` and `revoke` are not published by `identity-access` at all,
// which is what keeps `GET /mcp/platform/tokens` and
// `POST /mcp/platform/tokens/:id/revoke` in this deployable" — and the same
// sentence covers the two entity-token routes beside them. Four operations sat
// in the generated manifest with no V1 handler because the two methods below did
// not exist.
//
// -----------------------------------------------------------------------------
// A LISTING IS A TENANCY READ AND IT IS PLANNED, NOT ASSEMBLED
//
// The environment is taken from an `AuthorizationScope` the caller was already
// granted, never from a request field, and it is the ONLY tenant input: a query
// object built here cannot name an organization or a project at all, so a store
// implementing this port has no way to widen the answer even if it wanted to.
// That is the same shape `planEndUserPage` has and it is here for the same
// reason.
//
// -----------------------------------------------------------------------------
// THREE OUTCOMES FOR A REVOCATION, BECAUSE THE ORACLE COLLAPSES TWO
//
// `token.service.revoke` returns a boolean: `false` when no row matched and
// `true` for BOTH "this call revoked it" and "somebody had already revoked it".
// The caller cannot tell those last two apart, and they are different facts — one
// says the credential died just now by this operator's hand, the other says it
// was already dead and this request changed nothing. `mcp-bearer-token.revoke`
// has the identical shape. `BearerRevocationOutcome` below is three-valued so
// the difference survives to a transport, which is the lesson this programme
// keeps re-learning: two states behind one code cannot be told apart.
//
// The idempotence itself is PRESERVED, not removed. Revoking a revoked
// credential is still a success; it just says which kind.

import type { AuthorizationScope } from "./authorization-scope.js";
import { scopeKindOf } from "./authorization-scope.js";
import { credentialQueryInvalid } from "./errors.js";
import type { McpPermissionTier } from "./bearer-token.js";
import type { PrincipalId } from "@platos/kernel";
import { err, ok, type Result } from "@platos/kernel";

/**
 * The kinds a published listing or revocation can answer for.
 *
 * THE SAME TWO `MINTABLE_BEARER_KINDS` NAMES, AND FOR THE SAME REASON RATHER
 * THAN BY COPYING IT. `PersonalAccessToken` and `EndUserSession` exist in the
 * schema with zero production call sites (see the modelling note at the top of
 * `bearer-token.ts`), so nothing in the extraction source says what a listing of
 * them should project or what revoking one should mean. They are refused under
 * their own code rather than served with an invented shape.
 *
 * It is a SEPARATE constant from `MINTABLE_BEARER_KINDS` because the two answer
 * different questions and could legitimately diverge: the day something mints a
 * PAT, that constant grows and this one should not follow automatically.
 */
export const LISTABLE_BEARER_KINDS = ["mcp-token", "entity-bearer-token"] as const;
export type ListableBearerKind = (typeof LISTABLE_BEARER_KINDS)[number];

export function isListableBearerKind(value: unknown): value is ListableBearerKind {
  return typeof value === "string" && (LISTABLE_BEARER_KINDS as readonly string[]).includes(value);
}

/**
 * The page size when a caller names none, and the largest one it may name.
 *
 * BOTH FIGURES ARE THE ORACLES', extracted rather than chosen:
 * `token.service.list` and `mcp-bearer-token.list` both call
 * `boundedInteger(options.limit, 50, 1, 100)`. What changes here is what happens
 * ABOVE the ceiling — see `planBearerCredentialPage`.
 */
export const DEFAULT_BEARER_PAGE_SIZE = 50;
export const MAX_BEARER_PAGE_SIZE = 100;

/**
 * One credential as a LISTING shows it.
 *
 * `tokenHash` IS ABSENT AND ITS ABSENCE IS THE POINT. `BearerCredentialRecord`
 * carries the digest because verification needs it; a listing does not, and a
 * projection that carried it would put a verifier for every live credential in
 * an environment into one JSON response. The two types are therefore separate
 * rather than one type with an optional field, so no store can hand a caller the
 * digest by forgetting to strip it.
 *
 * Every field below names the column it comes from on each of the two tables,
 * because the two tables spell almost everything differently and a reader
 * checking this against the schema needs to know which is which.
 */
export interface BearerCredentialSummary {
  /** `McpToken.id` / `McpBearerToken.id`. */
  readonly credentialId: string;
  readonly kind: ListableBearerKind;
  /** `McpToken.name` / `McpBearerToken.label`. Human-facing; never parsed. */
  readonly label: string;
  /** `McpToken.mintedByUserId` / `McpBearerToken.mcpUserId`. Whom it acts AS. */
  readonly principalId: PrincipalId;
  /** `McpToken.permissions` / `McpBearerToken.scopes`. */
  readonly permissions: readonly string[];
  /** `McpToken.tier`. Null for an entity token, whose table has no such column. */
  readonly permissionTier: McpPermissionTier | null;
  /** `McpBearerToken.entityId`. Null for a platform token, which has no subject. */
  readonly subjectId: string | null;
  /**
   * RE-DERIVED BY THE STORE from the environment's own ancestry, never echoed
   * from the query. It is on the summary so a caller can see the tenancy of a
   * row it is about to revoke without a second read.
   */
  readonly scope: AuthorizationScope;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
}

/** What a caller asks for. Carries no tenant field; see the header. */
export interface BearerCredentialListRequest {
  readonly kind: ListableBearerKind;
  /**
   * The entity, for `entity-bearer-token`. It is REQUIRED for that kind and
   * REFUSED for `mcp-token`, which is stricter than either oracle and is
   * deliberate: `McpBearerToken` is keyed by (entity, environment) and
   * `McpToken` has no entity column at all, so a subject accepted and ignored on
   * a platform listing would answer a question the caller did not ask.
   */
  readonly subjectId?: string | null;
  readonly limit?: number;
  readonly offset?: number;
}

/** The validated read a store is handed. Nothing here is caller-supplied text. */
export interface BearerCredentialQuery {
  readonly kind: ListableBearerKind;
  /** From the authorized scope. The one and only tenant clause. */
  readonly environmentId: string;
  readonly subjectId: string | null;
  readonly limit: number;
  readonly offset: number;
}

/**
 * Validate a listing, or refuse it by field.
 *
 * AN OVER-LARGE PAGE IS A REFUSAL AND NOT A CLAMP, which is the ONE place this
 * plan deliberately departs from both oracles. `boundedInteger(limit, 50, 1,
 * 100)` silently answers a request for 500 rows with 100 and reports `limit:
 * 100`, so a caller paging by the number it sent walks off the end of the
 * collection and believes it has seen everything. `listEndUsers` already made
 * this call for the same reason and its contract says so in those words. The
 * DEFAULT and the CEILING are still the oracles' numbers; only the behaviour at
 * the ceiling changes.
 */
export function planBearerCredentialPage(
  scope: AuthorizationScope,
  request: BearerCredentialListRequest,
): Result<BearerCredentialQuery> {
  if (!isListableBearerKind(request.kind)) {
    return err(
      credentialQueryInvalid(
        "kind",
        `only ${LISTABLE_BEARER_KINDS.join(" and ")} credentials can be listed`,
      ),
    );
  }
  const environment = environmentOf(scope);
  if (!environment.ok) return environment;

  const subject = request.subjectId ?? null;
  if (request.kind === "entity-bearer-token" && subject === null) {
    return err(
      credentialQueryInvalid("subjectId", "an entity token listing must name its entity"),
    );
  }
  if (request.kind === "mcp-token" && subject !== null) {
    return err(
      credentialQueryInvalid("subjectId", "a platform token is not scoped to an entity"),
    );
  }

  const limit = request.limit ?? DEFAULT_BEARER_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    return err(credentialQueryInvalid("limit", "limit must be a positive integer"));
  }
  if (limit > MAX_BEARER_PAGE_SIZE) {
    return err(
      credentialQueryInvalid("limit", `limit must be at most ${String(MAX_BEARER_PAGE_SIZE)}`),
    );
  }

  const offset = request.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return err(credentialQueryInvalid("offset", "offset must be a non-negative integer"));
  }

  return ok({
    kind: request.kind,
    environmentId: environment.value,
    subjectId: subject,
    limit,
    offset,
  });
}

/** What a revocation is asked to do, after the same validation. */
export interface BearerCredentialRevocation {
  readonly kind: ListableBearerKind;
  readonly credentialId: string;
  /** From the authorized scope. A row in another environment reads as absent. */
  readonly environmentId: string;
  readonly subjectId: string | null;
  /** The operator who asked. Written to `McpToken.revokedBy` where the column exists. */
  readonly revokedByUserId: string;
  readonly now: Date;
}

/**
 * The three states a revocation can end in.
 *
 * `absent` COVERS "no such credential" AND "not in this environment" ON PURPOSE,
 * and that is the opposite decision from the one above. Distinguishing them
 * would tell a caller that a credential id it does not own exists somewhere,
 * which is an existence oracle across tenants; collapsing them is what makes the
 * cross-environment probe indistinguishable from a typo.
 */
export type BearerRevocationOutcome =
  | { readonly kind: "revoked"; readonly credential: BearerCredentialSummary }
  | { readonly kind: "alreadyRevoked"; readonly credential: BearerCredentialSummary }
  | { readonly kind: "absent" };

export interface PlanBearerRevocationInput {
  readonly kind: ListableBearerKind;
  readonly credentialId: string;
  readonly subjectId?: string | null;
  readonly revokedByUserId: string;
  readonly now: Date;
}

/** Validate a revocation against the caller's scope, or refuse it by field. */
export function planBearerRevocation(
  scope: AuthorizationScope,
  input: PlanBearerRevocationInput,
): Result<BearerCredentialRevocation> {
  if (!isListableBearerKind(input.kind)) {
    return err(
      credentialQueryInvalid(
        "kind",
        `only ${LISTABLE_BEARER_KINDS.join(" and ")} credentials can be revoked`,
      ),
    );
  }
  const environment = environmentOf(scope);
  if (!environment.ok) return environment;

  if (input.credentialId.trim() === "") {
    return err(credentialQueryInvalid("credentialId", "name the credential to revoke"));
  }
  const subject = input.subjectId ?? null;
  if (input.kind === "entity-bearer-token" && subject === null) {
    return err(
      credentialQueryInvalid("subjectId", "an entity token revocation must name its entity"),
    );
  }
  if (input.kind === "mcp-token" && subject !== null) {
    return err(
      credentialQueryInvalid("subjectId", "a platform token is not scoped to an entity"),
    );
  }

  return ok({
    kind: input.kind,
    credentialId: input.credentialId,
    environmentId: environment.value,
    subjectId: subject,
    revokedByUserId: input.revokedByUserId,
    now: input.now,
  });
}

/**
 * Whether a row the store returned belongs in this caller's answer.
 *
 * DEFENCE IN DEPTH, and the same one `matchesEndUserQuery` provides: the tenant
 * clause is also in the store's WHERE, and keeping it here means a store that
 * leaks across environments is a FAILING TEST rather than a breach. The
 * environment is checked off the summary's re-derived scope, so a row whose
 * ancestry disagrees with its own `environmentId` column cannot pass either.
 */
export function belongsToBearerQuery(
  summary: BearerCredentialSummary,
  query: BearerCredentialQuery,
): boolean {
  if (summary.kind !== query.kind) return false;
  const environment = environmentIdIn(summary.scope);
  if (environment === null || environment !== query.environmentId) return false;
  return summary.subjectId === query.subjectId;
}

/** The environment a scope names, or a refusal saying which scope it is instead. */
function environmentOf(scope: AuthorizationScope): Result<string> {
  const environmentId = environmentIdIn(scope);
  if (environmentId === null) {
    return err(
      credentialQueryInvalid(
        "scope",
        `a bearer credential is bounded by ONE environment; this scope is ${scopeKindOf(scope)}`,
      ),
    );
  }
  return ok(environmentId);
}

/**
 * The environment id inside a grant, or null when the grant is not one.
 *
 * BOTH DISCRIMINANTS ARE CHECKED — the scope's `kind` and the kernel tenant's
 * own `level` — because they are two independently-written fields and a value
 * carrying `kind: "ENVIRONMENT"` over a project-level tenant is representable.
 * `tenantAuthorizationScope` derives one from the other and cannot produce that
 * pair, but a store projecting a row is not obliged to go through it.
 */
function environmentIdIn(scope: AuthorizationScope): string | null {
  if (scope.kind !== "ENVIRONMENT") return null;
  return scope.tenant.level === "environment" ? scope.tenant.environmentId : null;
}
