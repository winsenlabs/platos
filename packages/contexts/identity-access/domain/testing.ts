// Builders for the identity-access aggregates.
//
// Every builder produces a VALID, ACTIVE record and takes a partial override, so
// a test names only the field it is about. A test that reads
// `anOperatorSession({ revokedAt: T0 })` says "a revoked session" in one line;
// the same test spelled as a fourteen-field literal buries the one field that
// matters among thirteen that do not, and stops compiling every time a field is
// added.
//
// These live in `domain/` rather than in a test file because the application
// tests need them too, and a builder imported across layers must obey the same
// layering rule as everything else here: own domain plus kernel, nothing more.
//
// `T0` is a fixed, arbitrary instant. Tests that care about time derive from it
// rather than calling `Date.now()`, so a suite that passes at noon passes at
// midnight and passes in a different time zone.

import type { AccessKeyRecord } from "./access-key.js";
import { GLOBAL_SCOPE, tenantAuthorizationScope, type AuthorizationScope } from "./authorization-scope.js";
import type { BearerCredentialRecord } from "./bearer-token.js";
import type { MagicLinkTokenRecord } from "./magic-link.js";
import type { TotpCredential } from "./mfa.js";
import type { OAuthRefreshTokenRecord } from "./oauth.js";
import { normalizeEmail } from "./principal.js";
import type {
  AccessKeyId,
  EmailAddress,
  OAuthClientId,
  OAuthTokenId,
  OperatorSessionId,
  RotationFamilyId,
  TokenHash,
  UserId,
} from "./principal.js";
import type { RateLimitBucket } from "./rate-limit.js";
import { DEFAULT_SESSION_TTL_MS } from "./session.js";
import type { OperatorSessionRecord, OperatorUserRecord } from "./session.js";
import {
  asIdentifier,
  environmentScope,
  type EnvironmentId,
  type OrganizationId,
  type PrincipalId,
  type ProjectId,
} from "@platos/kernel";

/** 2026-01-01T00:00:00.000Z. Chosen for legibility, not significance. */
export const T0 = new Date("2026-01-01T00:00:00.000Z");

export function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

export const SECOND_MS = 1_000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export const ORGANIZATION_ID = asIdentifier<OrganizationId>("org-1");
export const OTHER_ORGANIZATION_ID = asIdentifier<OrganizationId>("org-2");
export const PROJECT_ID = asIdentifier<ProjectId>("proj-1");
export const ENVIRONMENT_ID = asIdentifier<EnvironmentId>("env-1");
export const OTHER_ENVIRONMENT_ID = asIdentifier<EnvironmentId>("env-2");

export const ENVIRONMENT = environmentScope(ORGANIZATION_ID, PROJECT_ID, ENVIRONMENT_ID);
export const SIBLING_ENVIRONMENT = environmentScope(
  ORGANIZATION_ID,
  PROJECT_ID,
  OTHER_ENVIRONMENT_ID,
);

export const ENVIRONMENT_SCOPE: AuthorizationScope = tenantAuthorizationScope(ENVIRONMENT);

export function userId(value = "user-1"): UserId {
  return asIdentifier<UserId>(value);
}

export function sessionId(value = "session-1"): OperatorSessionId {
  return asIdentifier<OperatorSessionId>(value);
}

export function tokenHash(value = "hash-1"): TokenHash {
  return asIdentifier<TokenHash>(value);
}

export function email(value = "operator@example.com"): EmailAddress {
  return normalizeEmail(value);
}

export function anOperatorUser(
  overrides: Partial<OperatorUserRecord> = {},
): OperatorUserRecord {
  return {
    userId: userId(),
    email: email(),
    platformOperator: false,
    disabledAt: null,
    ...overrides,
  };
}

export function anOperatorSession(
  overrides: Partial<OperatorSessionRecord> = {},
): OperatorSessionRecord {
  return {
    sessionId: sessionId(),
    tokenHash: tokenHash(),
    tier: "OPERATOR",
    userId: userId(),
    impersonatedUserId: null,
    parentSessionId: null,
    mfaVerifiedAt: null,
    expiresAt: at(DEFAULT_SESSION_TTL_MS),
    revokedAt: null,
    lastSeenAt: null,
    createdAt: T0,
    ...overrides,
  };
}

export function aTotpCredential(overrides: Partial<TotpCredential> = {}): TotpCredential {
  return {
    userId: userId(),
    encryptedSecret: "enc:secret",
    enabledAt: T0,
    lastUsedCounter: null,
    pendingEncryptedSecret: null,
    pendingExpiresAt: null,
    ...overrides,
  };
}

export function aMagicLink(overrides: Partial<MagicLinkTokenRecord> = {}): MagicLinkTokenRecord {
  return {
    tokenHash: tokenHash("magic-hash"),
    email: email(),
    expiresAt: at(15 * MINUTE_MS),
    consumedAt: null,
    createdAt: T0,
    ...overrides,
  };
}

export function aRateLimitBucket(overrides: Partial<RateLimitBucket> = {}): RateLimitBucket {
  return {
    action: "LOGIN",
    identifierHash: tokenHash("identifier-hash"),
    windowStart: T0,
    requestCount: 1,
    expiresAt: at(MINUTE_MS),
    ...overrides,
  };
}

export function anAccessKey(overrides: Partial<AccessKeyRecord> = {}): AccessKeyRecord {
  return {
    accessKeyId: asIdentifier<AccessKeyId>("key-1"),
    environmentId: ENVIRONMENT_ID,
    keyPrefix: "platos_live_abc123",
    keyHash: tokenHash("a".repeat(64)),
    allowedOrigins: [],
    validUntil: null,
    replacedById: null,
    revokedAt: null,
    lastUsedAt: null,
    ...overrides,
  };
}

export function aRefreshToken(
  overrides: Partial<OAuthRefreshTokenRecord> = {},
): OAuthRefreshTokenRecord {
  return {
    tokenId: asIdentifier<OAuthTokenId>("refresh-1"),
    tokenHash: tokenHash("refresh-hash"),
    accessTokenId: asIdentifier<OAuthTokenId>("access-1"),
    clientId: asIdentifier<OAuthClientId>("plt_oac_client"),
    userId: userId(),
    scope: ENVIRONMENT_SCOPE,
    scopes: ["mcp:read"],
    rotationFamilyId: asIdentifier<RotationFamilyId>("family-1"),
    parentRefreshTokenId: null,
    issuedAt: T0,
    expiresAt: at(90 * DAY_MS),
    consumedAt: null,
    replayDetectedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

export function aBearerCredential(
  overrides: Partial<BearerCredentialRecord> = {},
): BearerCredentialRecord {
  return {
    credentialId: "mcp-token-1",
    kind: "mcp-token",
    tokenHash: tokenHash("bearer-hash"),
    tier: "OPERATOR",
    principalId: asIdentifier<PrincipalId>("user-1"),
    scope: ENVIRONMENT_SCOPE,
    permissions: ["mcp:read"],
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    ...overrides,
  };
}

/** A credential a platform operator would hold: unbounded scope. */
export function aGlobalBearerCredential(
  overrides: Partial<BearerCredentialRecord> = {},
): BearerCredentialRecord {
  return aBearerCredential({ scope: GLOBAL_SCOPE, ...overrides });
}
