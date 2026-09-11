// The scoped bearer credentials: McpToken, McpBearerToken, PersonalAccessToken
// and EndUserSession.
//
// These four rows differ in which table they live in and almost nothing else.
// Each is a hashed opaque secret with an optional expiry, an optional
// revocation, a tier, a scope and a permission list, and each was being
// verified by its own hand-written sequence of null checks. Modelling them once
// means the expired-before-revoked ordering, the scope check and the permission
// check cannot drift apart between them.
//
// MODELLING NOTE — PersonalAccessToken and EndUserSession.
// Both tables exist in the baseline schema and both have ZERO production call
// sites: nothing mints them and nothing verifies them. They therefore have no
// behavioural oracle, and everything below about them is derived from the schema
// alone rather than from observed behaviour. They are modelled minimally and
// deliberately: the shared lifecycle, the scope, and nothing invented. When a
// call site appears, whatever it needs beyond this is new design and should be
// recorded as such rather than back-fitted onto a guess made here.

import {
  assertAuthorizes,
  assertPermission,
  scopeKindOf,
  type AuthorizationScope,
} from "./authorization-scope.js";
import { requireUsableAt, type RevocableCredential } from "./credential.js";
import { credentialMaterialInvalid, credentialSubjectMismatch } from "./errors.js";
import type { PrincipalTier, TokenHash } from "./principal.js";
import { err, ok, type PrincipalId, type Result, type TenantScope } from "@platos/kernel";

export type BearerCredentialKind =
  /** McpToken — a minted platform MCP credential. Oracle: token.service. */
  | "mcp-token"
  /** McpBearerToken — an entity-scoped MCP credential. Oracle: mcp-bearer-token.service. */
  | "entity-bearer-token"
  /** PersonalAccessToken — schema only; see the modelling note above. */
  | "personal-access-token"
  /** EndUserSession — schema only; see the modelling note above. */
  | "end-user-session";

export interface BearerCredentialRecord extends RevocableCredential {
  readonly credentialId: string;
  readonly kind: BearerCredentialKind;
  readonly tokenHash: TokenHash;
  readonly tier: PrincipalTier;
  readonly principalId: PrincipalId;
  readonly scope: AuthorizationScope;
  readonly permissions: readonly string[];
  readonly lastUsedAt: Date | null;
}

export interface BearerAuthorization {
  readonly credentialId: string;
  readonly kind: BearerCredentialKind;
  readonly tier: PrincipalTier;
  readonly principalId: PrincipalId;
  readonly scope: AuthorizationScope;
  readonly permissions: readonly string[];
}

export interface BearerAuthenticationRequest {
  readonly credential: BearerCredentialRecord;
  /** Where the request is addressed. Null for a scope-agnostic introspection. */
  readonly requestedScope: TenantScope | null;
  /** The permission the operation needs, when it names one. */
  readonly requiredPermission: string | null;
  readonly now: Date;
}

/**
 * Lifecycle, then scope, then permission — in that order.
 *
 * Checking permission before scope would let a caller learn which permissions a
 * credential carries by probing an environment it cannot reach: the answers
 * would differ by permission rather than being uniformly "not authorized for
 * this scope". Lifecycle first, because a revoked credential must not be
 * evaluated for anything at all.
 */
export function authenticateBearerCredential(
  request: BearerAuthenticationRequest,
): Result<BearerAuthorization> {
  const usable = requireUsableAt(request.credential, request.now);
  if (!usable.ok) return err(usable.error);

  const credential = usable.value;
  if (request.requestedScope !== null) {
    const authorized = assertAuthorizes(credential.scope, request.requestedScope);
    if (!authorized.ok) return err(authorized.error);
  }
  if (request.requiredPermission !== null) {
    const permitted = assertPermission(credential.permissions, request.requiredPermission);
    if (!permitted.ok) return err(permitted.error);
  }

  return ok({
    credentialId: credential.credentialId,
    kind: credential.kind,
    tier: credential.tier,
    principalId: credential.principalId,
    scope: credential.scope,
    permissions: credential.permissions,
  });
}

export function touchedCredential(
  credential: BearerCredentialRecord,
  now: Date,
): BearerCredentialRecord {
  return { ...credential, lastUsedAt: now };
}

export function revokedCredential(
  credential: BearerCredentialRecord,
  now: Date,
): BearerCredentialRecord {
  return { ...credential, revokedAt: now };
}

// ---------------------------------------------------------------------------
// WIN-268 (M4.2) P1 — MINTING, AND THE TWO KINDS A V1 TRANSPORT MAY MINT.
//
// Everything above this line reads an existing credential. This half plans a NEW
// one, and it exists because `idempotency-policy.ts` classes exactly eight
// operations `required` and two of them — `POST /mcp/platform/tokens` and
// `POST /mcp/entity/:entityId/tokens` — had no handler in `apps/core-api`, where
// the gate runs. The gate was therefore refusing a keyless mint and then handing
// the winner of an idempotency race to the framework's own 404.
//
// ONLY TWO OF THE FOUR KINDS CAN BE MINTED HERE, and the two that cannot are
// excluded for the reason recorded at the top of this file rather than for
// convenience. `PersonalAccessToken` and `EndUserSession` have ZERO production
// call sites: nothing mints them and nothing verifies them, so there is no
// behavioural oracle for what a minted one should contain. Inventing a `role`
// for a PAT or an `identityId` for an end-user session would be design dressed
// as extraction. `MINTABLE_BEARER_KINDS` is the enumeration, and the type is what
// stops a caller naming one of the other two.

/** The kinds a published mint accepts. See the banner directly above. */
export const MINTABLE_BEARER_KINDS = ["mcp-token", "entity-bearer-token"] as const;
export type MintableBearerKind = (typeof MINTABLE_BEARER_KINDS)[number];

export function isMintableBearerKind(value: unknown): value is MintableBearerKind {
  return typeof value === "string" && (MINTABLE_BEARER_KINDS as readonly string[]).includes(value);
}

/**
 * `McpToken.tier` — AND IT IS NOT A `PrincipalTier`.
 *
 * The adapter's banner records the trap: the column is a String holding
 * `"scope"` or `"admin"`, the MCP PERMISSION tier, an entirely different axis
 * from the OPERATOR/END_USER enum the domain means by `tier`. Reading one as the
 * other would make an authorization decision from a value that does not answer
 * the question asked. It is modelled here under its own name so the two can
 * never be passed to each other's parameter.
 */
export const MCP_PERMISSION_TIERS = ["scope", "admin"] as const;
export type McpPermissionTier = (typeof MCP_PERMISSION_TIERS)[number];

/**
 * The longest name the oracle accepts, and the shortest.
 *
 * `token.service.ts`: "token name must be 1–80 chars". Extracted rather than
 * chosen: a mint that accepted a name the legacy surface refuses would let one
 * deployable write a row the other cannot display.
 */
export const MAX_BEARER_LABEL_LENGTH = 80;

/**
 * Ninety days, in seconds.
 *
 * BOTH oracles say ninety days and they say it in different units —
 * `token.service.ts` as `90 * 24 * 3600` seconds and
 * `mcp-bearer-token.service.ts` as `90 * 24 * 60 * 60 * 1000` milliseconds — so
 * the two agreed by coincidence of arithmetic rather than by sharing a constant.
 * One constant, in seconds, because the wire field is `ttlSeconds`.
 */
export const DEFAULT_BEARER_TTL_SECONDS = 90 * 24 * 60 * 60;

/**
 * The longest lifetime a mint will issue.
 *
 * NEITHER ORACLE HAS ONE, and that is a finding rather than a rule inherited.
 * `token.service.ts` clamps nothing above zero and `mcp-bearer-token.service.ts`
 * only refuses an instant in the past, so both will issue a credential that
 * outlives the company. A one-time secret with an unbounded lifetime is the
 * failure that makes a leaked token permanent, so the V1 mint caps it — at one
 * year, which is longer than the ninety-day default by a factor a caller can
 * plausibly want and short enough that a forgotten credential expires.
 */
export const MAX_BEARER_TTL_SECONDS = 365 * 24 * 60 * 60;

/** What the store is asked to insert. Every column the two tables require. */
export interface BearerCredentialMint {
  readonly credentialId: string;
  readonly kind: MintableBearerKind;
  readonly tokenHash: TokenHash;
  /** The environment the credential is bounded by, re-derived by the caller. */
  readonly scope: AuthorizationScope;
  /** `McpToken.name` / `McpBearerToken.label`. */
  readonly label: string;
  /** `McpToken.permissions` / `McpBearerToken.scopes`. */
  readonly permissions: readonly string[];
  /** `McpToken.mintedByUserId` / `McpBearerToken.createdByUserId`. The OPERATOR. */
  readonly createdByUserId: string;
  /**
   * Whom the credential acts AS. Equal to `createdByUserId` for an
   * `mcp-token`, whose principal is the operator who minted it; the entity's
   * own `mcpUserId` for an `entity-bearer-token`, whose principal is an END USER
   * of that entity and is not a Platos user at all.
   */
  readonly principalId: PrincipalId;
  /** `McpBearerToken.entityId`. Null for an `mcp-token`, which has no subject. */
  readonly subjectId: string | null;
  /** `McpToken.tier`. Null for an `entity-bearer-token`, whose table has no such column. */
  readonly permissionTier: McpPermissionTier | null;
  readonly expiresAt: Date;
}

export interface PlanBearerCredentialInput {
  readonly credentialId: string;
  readonly kind: MintableBearerKind;
  readonly tokenHash: TokenHash;
  readonly scope: AuthorizationScope;
  readonly label: string;
  readonly permissions: readonly string[];
  readonly createdByUserId: string;
  readonly principalId: PrincipalId;
  readonly subjectId: string | null;
  readonly permissionTier: McpPermissionTier | null;
  /** Null means "use the ninety-day default"; a number is clamped and checked. */
  readonly ttlSeconds: number | null;
  readonly now: Date;
}

/**
 * Validate a mint and turn it into the row the store will write.
 *
 * A TOTAL FUNCTION OF ITS ARGUMENTS, which is why the instant and the id arrive
 * rather than being taken: ADR M0.3 §2 keeps the clock and the generator out of
 * the domain so a mint can be replayed exactly in a test.
 *
 * THE SHAPE CHECKS ARE THE ORACLES' AND THE TTL CAP IS NOT. Every refusal below
 * except `MAX_BEARER_TTL_SECONDS` is extracted from `token.service.mint` or
 * `mcp-bearer-token.generate`; the cap is new and is named as new in the
 * constant's own note.
 */
export function planBearerCredential(
  input: PlanBearerCredentialInput,
): Result<BearerCredentialMint> {
  const label = input.label.trim();
  if (label.length < 1 || label.length > MAX_BEARER_LABEL_LENGTH) {
    return err(
      credentialMaterialInvalid(
        "label",
        `must be 1-${String(MAX_BEARER_LABEL_LENGTH)} characters after trimming`,
      ),
    );
  }
  if (input.permissions.length === 0) {
    return err(credentialMaterialInvalid("permissions", "must name at least one permission"));
  }
  if (input.permissions.some((permission) => permission.trim() === "")) {
    return err(credentialMaterialInvalid("permissions", "must not contain a blank entry"));
  }
  // A SUBJECT IS REQUIRED FOR EXACTLY ONE KIND, AND FORBIDDEN FOR THE OTHER.
  // `McpBearerToken.entityId` is NOT NULL with a foreign key, so a mint without
  // one cannot be written; `McpToken` has no such column, so a subject supplied
  // for it would be silently dropped — a caller believing it had scoped a
  // credential to an entity when it had not.
  if (input.kind === "entity-bearer-token" && input.subjectId === null) {
    return err(credentialSubjectMismatch(input.kind, "requires the entity it is scoped to"));
  }
  if (input.kind === "mcp-token" && input.subjectId !== null) {
    return err(credentialSubjectMismatch(input.kind, "is scoped to an environment, not to a subject"));
  }
  // The same rule for the permission tier, and for the same reason: `McpToken`
  // requires the column and `McpBearerToken` has none.
  if (input.principalId.trim() === "") {
    return err(credentialMaterialInvalid("principalId", "must name whom the credential acts as"));
  }
  if (input.kind === "mcp-token" && input.permissionTier === null) {
    return err(credentialMaterialInvalid("tier", "an MCP platform token must declare its tier"));
  }
  if (input.kind === "entity-bearer-token" && input.permissionTier !== null) {
    return err(credentialMaterialInvalid("tier", "an entity bearer token has no permission tier"));
  }
  if (scopeKindOf(input.scope) !== "ENVIRONMENT") {
    return err(
      credentialMaterialInvalid("scope", "a bearer credential is bounded by ONE environment"),
    );
  }

  const ttl = input.ttlSeconds ?? DEFAULT_BEARER_TTL_SECONDS;
  if (!Number.isSafeInteger(ttl) || ttl <= 0) {
    return err(credentialMaterialInvalid("ttlSeconds", "must be a positive whole number of seconds"));
  }
  if (ttl > MAX_BEARER_TTL_SECONDS) {
    return err(
      credentialMaterialInvalid(
        "ttlSeconds",
        `must not exceed ${String(MAX_BEARER_TTL_SECONDS)} seconds`,
      ),
    );
  }

  return ok({
    credentialId: input.credentialId,
    kind: input.kind,
    tokenHash: input.tokenHash,
    scope: input.scope,
    label,
    permissions: [...input.permissions],
    createdByUserId: input.createdByUserId,
    principalId: input.principalId,
    subjectId: input.subjectId,
    permissionTier: input.permissionTier,
    expiresAt: new Date(input.now.getTime() + ttl * 1000),
  });
}

// ---------------------------------------------------------------------------
// WIN-268 (M4.2) — THE OTHER HALF OF A CREDENTIAL'S LIFE: LISTING IT, AND ENDING
// IT.
//
// MINT and VERIFY were already here. LIST and REVOKE were not, and the gap was
// not cosmetic: `apps/agent/src/mcp-platform/mcp-bearer-token.service.ts` and
// `token.service.ts` hold the only implementations, so the four operations
// `GET /mcp/platform/tokens`, `POST /mcp/platform/tokens/:id/revoke`,
// `GET /mcp/entity/:entityId/tokens` and
// `DELETE /mcp/entity/:entityId/tokens/:tokenId` are in the generated operation
// manifest with an `apps/agent` implementation and NOTHING in `apps/core-api` —
// the same shape the two mints had before P1, and the reason a V1 route could not
// be built for them: a V1 route may only reach a contract method.
//
// -----------------------------------------------------------------------------
// A LISTING PROJECTION THAT CANNOT CARRY THE VERIFIER
//
// `BearerCredentialRecord` holds `tokenHash`. A listing must not, and "must not"
// is worth more as a TYPE than as a review comment: `BearerCredentialSummary` has
// no such field, so a store that projected the digest could not compile, and
// `scripts/arch/secret-response-census.mjs` never has to be argued with about
// this route. It is not the raw secret — that exists once, at mint — but it is
// the value every verification compares against, and a listing that leaked it
// would hand a reader offline guessing material for every credential at once.
//
// It carries what `BearerCredentialRecord` cannot instead: `label` and
// `createdAt`, which both oracles' listings return and which the shared
// authentication record has no use for.

/**
 * One credential as a LISTING renders it. No digest, and no raw secret.
 *
 * `principalId` is the one field whose column differs by kind —
 * `McpToken.mintedByUserId` and `McpBearerToken.mcpUserId` — and it is named for
 * what the domain means rather than for either column, because that is the axis
 * `BearerCredentialRecord` already models. For a platform token it is the
 * operator who minted it; for an entity token it is an END USER of the entity and
 * is not a Platos user at all.
 */
export interface BearerCredentialSummary extends RevocableCredential {
  readonly credentialId: string;
  readonly kind: MintableBearerKind;
  readonly label: string;
  readonly permissions: readonly string[];
  readonly principalId: PrincipalId;
  /** `McpToken.tier`. Null for an entity token, whose table has no such column. */
  readonly permissionTier: McpPermissionTier | null;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  /**
   * `McpToken.revokedBy`, read back from the row.
   *
   * ALWAYS NULL FOR AN ENTITY TOKEN, AND THAT IS A SCHEMA FACT RATHER THAN A
   * MISSING FEATURE: `McpBearerToken` has no `revokedBy` column at all — the
   * legacy service records the actor in an `AdminAudit` row instead, which is
   * `observability`'s and is not composed. Reporting the null is what stops a
   * caller believing an attribution was stored when the table cannot hold one.
   */
  readonly revokedBy: string | null;
}

/**
 * The default page, and the largest one.
 *
 * BOTH EXTRACTED, from `token.service.list` and `mcp-bearer-token.list`, which
 * agree: `boundedInteger(options.limit, 50, 1, 100)`.
 *
 * THE ORACLES CLAMP AND THIS REFUSES, which is the one deliberate divergence.
 * `boundedInteger` silently turns `limit=5000` into 100, and a caller that asked
 * for five thousand rows, received one hundred and was told nothing believes it
 * has seen everything. `planEndUserPage` already made the same call for the same
 * reason, and `transports/rest/page.ts` states it as the chassis rule: "malformed
 * pagination and filter values now return HTTP 400 instead of being silently
 * coerced".
 */
export const DEFAULT_BEARER_PAGE_SIZE = 50;
export const MAX_BEARER_PAGE_SIZE = 100;

/**
 * A validated window over one environment's credentials of one kind.
 *
 * THE SCOPE IS AN `AuthorizationScope` AND NOT AN ENVIRONMENT ID, so the store
 * derives the leaf from the same value the mint does and there is no second
 * spelling of "which environment". `subjectId` is the entity for an
 * `entity-bearer-token` and is refused for an `mcp-token`, by the same rule
 * `planBearerCredential` applies to a mint: `McpToken` has no subject column, so
 * a subject supplied for it could only be silently dropped.
 */
export interface BearerCredentialQuery {
  readonly kind: MintableBearerKind;
  /**
   * The environment the credentials are bounded by, DERIVED FROM THE AUTHORIZED
   * SCOPE by the planner below and never read off a request.
   *
   * The leaf rather than the whole scope, and this is the one place the two
   * differ from `BearerCredentialMint`. A mint WRITES a row whose tenancy the
   * store then re-derives from the environment's own ancestry and reads back, so
   * it has to carry the scope it claimed in order for the two to be comparable. A
   * listing only FILTERS, and a token row's `environmentId` IS its tenancy — so
   * carrying the whole triple here would give every store the same derivation to
   * repeat and one of them the chance to do it differently.
   */
  readonly environmentId: string;
  readonly subjectId: string | null;
  readonly limit: number;
  readonly offset: number;
}

export interface PlanBearerCredentialPageInput {
  readonly kind: MintableBearerKind;
  readonly scope: AuthorizationScope;
  readonly subjectId: string | null;
  /** Null means "the fifty-row default"; a number is checked, never clamped. */
  readonly limit: number | null;
  readonly offset: number | null;
}

/**
 * The kind/subject pairing and the environment rule, shared by the page and the
 * revocation.
 *
 * ONE FUNCTION BECAUSE THEY ARE ONE RULE. Written twice, the day somebody
 * narrowed the mint's subject rule would be the day a listing and a revocation
 * disagreed about which credentials belong to an entity — and a revocation that
 * ignored `entityId` would let an operator holding one entity end another
 * entity's credentials inside the same environment.
 */
function checkBearerAddress(input: {
  readonly kind: MintableBearerKind;
  readonly scope: AuthorizationScope;
  readonly subjectId: string | null;
}): Result<string> {
  if (input.kind === "entity-bearer-token" && input.subjectId === null) {
    return err(credentialSubjectMismatch(input.kind, "requires the entity it is scoped to"));
  }
  if (input.kind === "mcp-token" && input.subjectId !== null) {
    return err(
      credentialSubjectMismatch(input.kind, "is scoped to an environment, not to a subject"),
    );
  }
  if (input.scope.kind !== "ENVIRONMENT" || input.scope.tenant.level !== "environment") {
    return err(
      credentialMaterialInvalid("scope", "a bearer credential is bounded by ONE environment"),
    );
  }
  // BOTH HALVES OF THE CHECK ARE LOAD-BEARING. `scopeKindOf` alone would satisfy
  // the compiler and leave `tenant` typed as any of the three levels, so the
  // narrowing is written against the discriminant the leaf id actually lives on.
  return ok(input.scope.tenant.environmentId);
}

export function planBearerCredentialPage(
  input: PlanBearerCredentialPageInput,
): Result<BearerCredentialQuery> {
  const address = checkBearerAddress(input);
  if (!address.ok) return err(address.error);

  const limit = input.limit ?? DEFAULT_BEARER_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    return err(credentialMaterialInvalid("limit", "must be a positive whole number of rows"));
  }
  if (limit > MAX_BEARER_PAGE_SIZE) {
    return err(
      credentialMaterialInvalid(
        "limit",
        `must not exceed ${String(MAX_BEARER_PAGE_SIZE)} rows`,
      ),
    );
  }
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return err(credentialMaterialInvalid("offset", "must be a whole number of rows, or zero"));
  }
  return ok({
    kind: input.kind,
    environmentId: address.value,
    subjectId: input.subjectId,
    limit,
    offset,
  });
}

/**
 * What the store is asked to END.
 *
 * `revokedAt` ARRIVES rather than being taken, for the reason ADR M0.3 §2 gives
 * and `planBearerCredential` already obeys: the clock stays out of the domain so a
 * revocation can be replayed exactly in a test. It is also the instant the
 * CONDITIONAL update writes, which is what makes a concurrent second revoke a
 * no-op rather than a rewrite of the first one's timestamp.
 */
export interface BearerCredentialRevocation {
  readonly kind: MintableBearerKind;
  readonly credentialId: string;
  /** The environment leaf, derived from the authorized scope. See the query above. */
  readonly environmentId: string;
  readonly subjectId: string | null;
  /**
   * `McpToken.revokedBy`. Null when the caller is not a Platos user, and ignored
   * by `McpBearerToken`, which has no such column — see
   * `BearerCredentialSummary.revokedBy`.
   */
  readonly revokedByUserId: string | null;
  readonly revokedAt: Date;
}

/**
 * What the store answers with, having written.
 *
 * `credential` IS READ BACK AFTER THE WRITE, never assembled from the request.
 * That is what lets the caller report the instant the ROW holds — the same bar
 * `revokeOperatorSession` set for server-side sign-out, whose view's own note
 * says "`revokedAt` is the instant the store now holds, not the instant the
 * caller asked".
 *
 * `newlyRevoked` is whether THIS call made the transition, and it comes from the
 * conditional update's own row count rather than from comparing timestamps. Two
 * operators revoking at once therefore see one `true` and one `false`, and the
 * `revokedAt` they both read is the winner's.
 */
export interface BearerCredentialRevocationResult {
  readonly credential: BearerCredentialSummary;
  readonly newlyRevoked: boolean;
}

export function planBearerCredentialRevocation(input: {
  readonly kind: MintableBearerKind;
  readonly credentialId: string;
  readonly scope: AuthorizationScope;
  readonly subjectId: string | null;
  readonly revokedByUserId: string | null;
  readonly now: Date;
}): Result<BearerCredentialRevocation> {
  const address = checkBearerAddress(input);
  if (!address.ok) return err(address.error);
  if (input.credentialId.trim() === "") {
    return err(credentialMaterialInvalid("credentialId", "must name the credential to revoke"));
  }
  return ok({
    kind: input.kind,
    credentialId: input.credentialId,
    environmentId: address.value,
    subjectId: input.subjectId,
    revokedByUserId: input.revokedByUserId,
    revokedAt: input.now,
  });
}
