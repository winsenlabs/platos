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
  /**
   * WIN-268 (M4.2) stage 2 — THE MINT'S OWN INSTANT, carried rather than left to
   * the database's `@default(now())`.
   *
   * It is here because a LISTING orders on `createdAt` and a mint's response
   * already claims one. Before this field the response's `createdAt` was the
   * application clock's instant and the row's was the database server's, so the
   * two could differ by any clock skew between two hosts — and every assertion
   * that they agreed was reading the same in-process value twice. Writing it
   * explicitly makes the value a caller was handed the value the row bears, and
   * the listing's ordering therefore reproducible from the mint.
   */
  readonly createdAt: Date;
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
    createdAt: input.now,
    expiresAt: new Date(input.now.getTime() + ttl * 1000),
  });
}
