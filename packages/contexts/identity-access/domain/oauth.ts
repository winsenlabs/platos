// OAuth 2.1 token lifecycle: rotation families and replay detection.
//
// Extracted from `apps/agent/src/oauth/oauth.service.ts`.
//
// REFRESH TOKENS ROTATE, AND A REPLAY DESTROYS THE FAMILY. Each exchange
// consumes the presented refresh token and mints a new pair carrying the SAME
// `rotationFamilyId`. Presenting a token that is already consumed or revoked
// means two parties hold it — the legitimate client and somebody else — and
// there is no way to tell from the request which one is calling. So the whole
// family is revoked, along with every access token linked to it, and both
// parties are forced back through the authorization endpoint where a human is.
//
// This is the only place in the context where one bad request invalidates
// credentials the caller did not present. It is deliberate: the alternative,
// refusing just the replayed token, leaves the thief holding a working one.
//
// SCOPE IS CHECKED BEFORE STATE. A refresh token belonging to another client or
// another environment is refused as an unknown grant, without revealing whether
// it was otherwise valid — so the token endpoint cannot be used to probe which
// tokens exist in an environment the caller cannot reach.

import { assertAuthorizes, type AuthorizationScope } from "./authorization-scope.js";
import { instantAfter } from "./credential.js";
import { invalidGrant } from "./errors.js";
import type { OAuthClientId, OAuthTokenId, RotationFamilyId, TokenHash, UserId } from "./principal.js";
import { err, ok, type Result, type TenantScope } from "@platos/kernel";

export const OAUTH_CONSENT_TTL_SECONDS = 600;
export const OAUTH_ACCESS_TOKEN_TTL_SECONDS = 3600;
export const OAUTH_REFRESH_TOKEN_TTL_SECONDS = 90 * 24 * 3600;
export const OAUTH_AUTHORIZATION_CODE_TTL_SECONDS = 60;

/** PKCE is mandatory and only the hashed challenge method is accepted. */
export const PKCE_CHALLENGE_METHOD = "S256";

export interface OAuthAccessTokenRecord {
  readonly tokenId: OAuthTokenId;
  readonly tokenHash: TokenHash;
  readonly clientId: OAuthClientId;
  readonly userId: UserId;
  readonly scope: AuthorizationScope;
  readonly scopes: readonly string[];
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface OAuthRefreshTokenRecord {
  readonly tokenId: OAuthTokenId;
  readonly tokenHash: TokenHash;
  /** The access token minted alongside it, so a family revoke reaches both. */
  readonly accessTokenId: OAuthTokenId | null;
  readonly clientId: OAuthClientId;
  readonly userId: UserId;
  readonly scope: AuthorizationScope;
  readonly scopes: readonly string[];
  /** Constant for the life of a grant; every rotation inherits it. */
  readonly rotationFamilyId: RotationFamilyId;
  readonly parentRefreshTokenId: OAuthTokenId | null;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly replayDetectedAt: Date | null;
  readonly revokedAt: Date | null;
}

export type RefreshTokenVerdict =
  | { readonly kind: "rotate" }
  | { readonly kind: "replay"; readonly rotationFamilyId: RotationFamilyId }
  | { readonly kind: "expired" };

/**
 * Consumed-or-revoked is checked BEFORE expiry.
 *
 * An expired token that was already consumed is still a replay: the thief's copy
 * ageing out does not make the theft less real, and the family must still die.
 */
export function classifyRefreshToken(
  token: OAuthRefreshTokenRecord,
  now: Date,
): RefreshTokenVerdict {
  if (token.consumedAt !== null || token.revokedAt !== null) {
    return { kind: "replay", rotationFamilyId: token.rotationFamilyId };
  }
  if (token.expiresAt.getTime() <= now.getTime()) return { kind: "expired" };
  return { kind: "rotate" };
}

export interface FamilyRevocation {
  readonly rotationFamilyId: RotationFamilyId;
  readonly replayDetectedAt: Date;
  readonly revokedAt: Date;
}

export function familyRevocation(
  rotationFamilyId: RotationFamilyId,
  now: Date,
): FamilyRevocation {
  return { rotationFamilyId, replayDetectedAt: now, revokedAt: now };
}

export interface TokenPairPlan {
  readonly accessToken: OAuthAccessTokenRecord;
  readonly refreshToken: OAuthRefreshTokenRecord;
  readonly consumedRefreshToken: OAuthRefreshTokenRecord | null;
  readonly expiresInSeconds: number;
}

export function planTokenPair(input: {
  readonly accessTokenId: OAuthTokenId;
  readonly accessTokenHash: TokenHash;
  readonly refreshTokenId: OAuthTokenId;
  readonly refreshTokenHash: TokenHash;
  readonly clientId: OAuthClientId;
  readonly userId: UserId;
  readonly scope: AuthorizationScope;
  readonly scopes: readonly string[];
  readonly rotationFamilyId: RotationFamilyId;
  readonly parent: OAuthRefreshTokenRecord | null;
  readonly now: Date;
}): TokenPairPlan {
  const scopes = [...input.scopes];
  const accessToken: OAuthAccessTokenRecord = {
    tokenId: input.accessTokenId,
    tokenHash: input.accessTokenHash,
    clientId: input.clientId,
    userId: input.userId,
    scope: input.scope,
    scopes,
    issuedAt: input.now,
    expiresAt: instantAfter(input.now, OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1000),
    revokedAt: null,
  };
  const refreshToken: OAuthRefreshTokenRecord = {
    tokenId: input.refreshTokenId,
    tokenHash: input.refreshTokenHash,
    accessTokenId: input.accessTokenId,
    clientId: input.clientId,
    userId: input.userId,
    scope: input.scope,
    scopes,
    rotationFamilyId: input.rotationFamilyId,
    parentRefreshTokenId: input.parent?.tokenId ?? null,
    issuedAt: input.now,
    expiresAt: instantAfter(input.now, OAUTH_REFRESH_TOKEN_TTL_SECONDS * 1000),
    consumedAt: null,
    replayDetectedAt: null,
    revokedAt: null,
  };
  return {
    accessToken,
    refreshToken,
    consumedRefreshToken: input.parent === null ? null : { ...input.parent, consumedAt: input.now },
    expiresInSeconds: OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  };
}

/** The presenting client must be the one the token was issued to. */
export function assertIssuedToClient(
  token: OAuthRefreshTokenRecord,
  clientId: OAuthClientId,
): Result<OAuthRefreshTokenRecord> {
  if (token.clientId !== clientId) {
    return err(invalidGrant("refresh token was issued to a different client"));
  }
  return ok(token);
}

/** The token endpoint a request arrived at must be inside the token's scope. */
export function assertScopeMatches(
  token: OAuthRefreshTokenRecord,
  requested: TenantScope | null,
): Result<OAuthRefreshTokenRecord> {
  if (requested === null) return ok(token);
  const authorized = assertAuthorizes(token.scope, requested);
  if (!authorized.ok) return err(invalidGrant("refresh token scope does not match this endpoint"));
  return ok(token);
}

/** An authorization code is single-use, PKCE-bound and lives 60 seconds. */
export interface OAuthAuthorizationCodeRecord {
  readonly codeHash: TokenHash;
  readonly clientId: OAuthClientId;
  readonly userId: UserId;
  readonly scope: AuthorizationScope;
  readonly scopes: readonly string[];
  readonly codeChallenge: string;
  readonly codeChallengeMethod: string;
  readonly redirectUri: string;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
}

/**
 * Every reason to refuse a code, in the order the extraction source checks them:
 * already used, expired, wrong client, wrong redirect, failed PKCE. The
 * challenge comparison itself is a hash the caller supplies, because computing
 * it needs a digest and digests live behind `SecretHasher`.
 */
export function verifyAuthorizationCode(input: {
  readonly code: OAuthAuthorizationCodeRecord;
  readonly clientId: OAuthClientId;
  readonly redirectUri: string;
  readonly derivedChallenge: string;
  readonly now: Date;
}): Result<OAuthAuthorizationCodeRecord> {
  const { code } = input;
  if (code.usedAt !== null) return err(invalidGrant("code already used"));
  if (code.expiresAt.getTime() <= input.now.getTime()) return err(invalidGrant("code expired"));
  if (code.clientId !== input.clientId) {
    return err(invalidGrant("code was issued to a different client"));
  }
  if (code.redirectUri !== input.redirectUri) return err(invalidGrant("redirect_uri mismatch"));
  if (code.codeChallengeMethod !== PKCE_CHALLENGE_METHOD) {
    return err(invalidGrant("unsupported code_challenge_method"));
  }
  if (code.codeChallenge !== input.derivedChallenge) {
    return err(invalidGrant("PKCE verification failed"));
  }
  return ok({ ...code, usedAt: input.now });
}
