// WHAT BOTH MCP TOKEN MINTS SHARE, AND THE ONE REFUSAL THAT IS THIS TRANSPORT'S
// OWN.
//
// `POST /mcp/platform/tokens` and `POST /mcp/entity/:entityId/tokens` are the
// two operations `http/idempotency-policy.ts` classes `required` that WIN-260's
// clause (d) has been waiting on. They differ in which table they write and in
// almost nothing else, so everything they share is here and each controller is
// left holding only its own route.
//
// -----------------------------------------------------------------------------
// AN IMPERSONATED SESSION MAY NOT MINT A DURABLE CREDENTIAL
//
// This is the one rule in this tranche that no context could make, and it is
// worth reading the reason rather than the code.
//
// `McpToken` has ONE actor column — `mintedByUserId` — and the store reads it
// back as the credential's PRINCIPAL. So a mint has to decide, once, whether the
// credential acts as the real human or as the account they are impersonating,
// and both answers are wrong:
//
//   AS THE IMPERSONATED USER: an admin borrows an account for ten minutes and
//   walks away with a ninety-day credential that authenticates as that account,
//   long after the impersonation session they were audited under has ended. The
//   audit trail says the admin impersonated somebody; it does not say a token
//   left the building.
//
//   AS THE REAL ADMIN: the environment access was decided for the EFFECTIVE
//   user, so the credential would carry the admin's identity and an authorization
//   somebody else's memberships earned. `operator.ts` is explicit that dropping
//   either id is a security defect rather than an omission, and this would be
//   dropping one at the moment it is written to a row that outlives the request.
//
// The third answer is to refuse, and it costs an impersonating operator nothing
// they cannot get by acting as themselves. `identity-access` cannot make this
// call — `mintBearerCredential` receives ids, not a session — and neither can
// `tenancy`, whose four gates evaluate memberships and are indifferent to how
// the principal was established. It is a transport rule because the transport is
// the only layer that still knows the request came from an impersonated session.
//
// IT HAS ITS OWN CODE. `TENANCY_ENVIRONMENT_FORBIDDEN` would tell an operator to
// go and fix their memberships, which would not help and is not true.

import { domainError, err, ok, type DomainError, type FieldViolation, type Result } from "@platos/kernel";
import {
  MCP_PERMISSION_TIERS,
  type IdentityAccessContract,
  type McpPermissionTier,
  type MintedBearerCredentialView,
  type OperatorAuthorizationView,
} from "@platos/context-identity-access";

import type { AppModule } from "../../app.module.js";
import { raise } from "../rest/fault.js";
import { authenticateOperator, requireIdentityAccess, type InboundOperatorRequest } from "../rest/operator.js";
import { requestInvalid } from "../rest/transport-errors.js";

/**
 * The refusal above, as a value.
 *
 * `forbidden` and not `unauthenticated`: the session is real, live and correctly
 * authenticated. What it may not do is this one thing, and a 401 would send a
 * client into a re-authentication loop that cannot help.
 */
export function mintWhileImpersonating(targetUserId: string): DomainError {
  return domainError(
    "MCP_TOKEN_MINT_WHILE_IMPERSONATING",
    "forbidden",
    "An impersonated session may not mint an MCP token.",
    {
      details: {
        targetUserId,
        reason:
          "The credential would outlive the impersonation session, and its one actor column cannot record both the operator and the account being impersonated. Stop impersonating and mint as yourself.",
      },
    },
  );
}

/**
 * The operator behind a mint, refused if they are impersonating.
 *
 * Both mint routes call this and neither repeats it, which is the same rule
 * `operator.ts` states for authentication: two guards returning the same code
 * cannot be told apart, and two guards spelling the SAME rule differently is how
 * one of them ends up not spelling it at all.
 */
export async function mintingOperator(
  app: AppModule,
  request: InboundOperatorRequest,
): Promise<OperatorAuthorizationView> {
  const operator = await authenticateOperator(app, request);
  if (operator.impersonating !== null) {
    raise(mintWhileImpersonating(operator.impersonating.targetUserId));
  }
  return operator;
}

/** `identity-access`, or the 503 that says which context is missing. */
export function requireMint(app: AppModule): IdentityAccessContract {
  return requireIdentityAccess(app);
}

/** What a mint hands back on the wire. THE SECRET IS THE POINT. */
export interface MintedTokenResource {
  readonly tokenId: string;
  /**
   * The raw bearer secret, returned ONCE.
   *
   * Named `token` because that is what both legacy handlers return and what
   * every existing client reads; a V1 route that renamed it would break the one
   * field the two surfaces must agree on. `scripts/arch/secret-response-census.mjs`
   * counts this property by name and requires a recorded disposition for it,
   * which is the register that keeps "a route returns a secret" a deliberate,
   * reviewed fact rather than an accident.
   */
  readonly token: string;
  readonly label: string;
  readonly permissions: readonly string[];
  /** `"scope" | "admin"` for a platform token; null for an entity token. */
  readonly tier: McpPermissionTier | null;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export function mintedTokenResource(minted: MintedBearerCredentialView): MintedTokenResource {
  return {
    tokenId: minted.credentialId,
    token: minted.token,
    label: minted.label,
    permissions: minted.permissions,
    tier: minted.permissionTier,
    expiresAt: minted.expiresAt.toISOString(),
    createdAt: minted.createdAt.toISOString(),
  };
}

/** A body that is not a JSON object at all. */
export function requireObject(input: unknown): Result<Record<string, unknown>> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return err(
      requestInvalid([
        { field: "body", code: "malformed", message: "Send a JSON object." },
      ]),
    );
  }
  return ok(input as Record<string, unknown>);
}

/**
 * A required non-empty string field.
 *
 * `location` NAMES WHERE THE FIELD LIVES and defaults to `body`, which is where
 * both mints read theirs. WIN-268 (M4.2) stage 2 added the parameter because the
 * two token LISTINGS and the entity revocation carry no body at all — they are a
 * GET and a DELETE — so their `environmentId` is a query parameter, and M0.4 §2's
 * `fields[]` has to say `query.environmentId` for a client to point at the right
 * thing. A hard-coded `body.` prefix on a violation about a query string is a
 * client sent to look in a place the request does not have.
 */
export function requiredString(
  body: Record<string, unknown>,
  field: string,
  violations: FieldViolation[],
  location: "body" | "query" = "body",
): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") {
    violations.push({
      field: `${location}.${field}`,
      code: value === undefined ? "missing" : "invalid",
      message: "Send a non-empty string.",
    });
    return "";
  }
  return value;
}

/**
 * A required array of non-empty strings.
 *
 * REFUSED RATHER THAN DEFAULTED WHEN ABSENT on the platform mint, because the
 * legacy handler defaults `permissions` to `[]` and then throws deep inside the
 * service — a 500 for a request the caller could have been told about. The
 * entity mint has a real default and passes one in.
 *
 * THE FALLBACK APPLIES TO AN ABSENT FIELD AND NEVER TO AN EMPTY ARRAY. See the
 * refusal below: those are two different things a caller can mean, and treating
 * them alike would silently upgrade "grant nothing" into "grant the default".
 */
export function stringArray(
  body: Record<string, unknown>,
  field: string,
  violations: FieldViolation[],
  fallback: readonly string[] | null,
): readonly string[] {
  const value = body[field];
  if (value === undefined || value === null) {
    if (fallback !== null) return fallback;
    violations.push({
      field: `body.${field}`,
      code: "missing",
      message: "Send at least one value.",
    });
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    violations.push({
      field: `body.${field}`,
      code: "invalid",
      message: "Send an array of non-empty strings.",
    });
    return [];
  }
  // AN EXPLICIT `[]` IS NOT THE DEFAULT, and the difference matters on both
  // routes. A fallback answers "the caller did not mention this field"; an empty
  // array is the caller SAYING the credential should grant nothing, which mints
  // something that can call nothing. The domain refuses it too — it is the
  // authority — but by then the refusal is `CREDENTIAL_MATERIAL_INVALID` with no
  // `body.<field>` name on it, so a client learns the request was wrong without
  // learning WHICH field. Refusing here is what puts the field in `fields[]`.
  if (value.length === 0) {
    violations.push({
      field: `body.${field}`,
      code: "empty",
      message: "Send at least one value, or omit the field.",
    });
    return [];
  }
  return value as readonly string[];
}

/**
 * An optional positive-integer lifetime.
 *
 * NULL MEANS "the contract's default" and is not the same as zero or as a
 * malformed value: the domain owns the ninety-day default and the one-year cap,
 * and a transport that substituted its own number would be a second declaration
 * of a lifetime policy.
 */
export function optionalTtlSeconds(
  body: Record<string, unknown>,
  violations: FieldViolation[],
): number | null {
  const value = body["ttlSeconds"];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    violations.push({
      field: "body.ttlSeconds",
      code: "invalid",
      message: "Send a positive whole number of seconds, or omit the field.",
    });
    return null;
  }
  return value;
}

/**
 * The MCP permission tier, defaulting to the weaker one.
 *
 * `"scope"` IS THE DEFAULT AND `"admin"` IS NEVER INFERRED. The legacy handler
 * normalises anything that is not the string `"admin"` to `"scope"`, which means
 * a typo'd `"adminn"` silently mints a weaker token — safe, but silent. This
 * refuses an unrecognised value instead, because a caller that asked for admin
 * and got scope will find out at the first cross-scope call rather than here.
 */
export function permissionTier(
  body: Record<string, unknown>,
  violations: FieldViolation[],
): McpPermissionTier {
  const value = body["tier"];
  if (value === undefined || value === null) return "scope";
  if (typeof value !== "string" || !(MCP_PERMISSION_TIERS as readonly string[]).includes(value)) {
    violations.push({
      field: "body.tier",
      code: "invalid",
      message: `Send one of: ${MCP_PERMISSION_TIERS.join(", ")}.`,
    });
    return "scope";
  }
  return value as McpPermissionTier;
}
