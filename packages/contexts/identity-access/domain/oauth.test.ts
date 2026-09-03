import { describe, expect, it } from "vitest";

import {
  OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  OAUTH_AUTHORIZATION_CODE_TTL_SECONDS,
  OAUTH_CONSENT_TTL_SECONDS,
  OAUTH_REFRESH_TOKEN_TTL_SECONDS,
  PKCE_CHALLENGE_METHOD,
  assertIssuedToClient,
  assertScopeMatches,
  classifyRefreshToken,
  familyRevocation,
  planTokenPair,
  verifyAuthorizationCode,
  type OAuthAuthorizationCodeRecord,
} from "./oauth.js";
import {
  DAY_MS,
  ENVIRONMENT,
  ENVIRONMENT_SCOPE,
  MINUTE_MS,
  SIBLING_ENVIRONMENT,
  T0,
  aRefreshToken,
  at,
  tokenHash,
  userId,
} from "./testing.js";
import { asIdentifier } from "@platos/kernel";
import type { OAuthClientId, OAuthTokenId, RotationFamilyId } from "./principal.js";

const client = asIdentifier<OAuthClientId>("plt_oac_client");
const otherClient = asIdentifier<OAuthClientId>("plt_oac_other");
const family = asIdentifier<RotationFamilyId>("family-1");

describe("the TTLs the extraction source uses", () => {
  it("is 600 / 3600 / 90 days / 60 seconds", () => {
    expect(OAUTH_CONSENT_TTL_SECONDS).toBe(600);
    expect(OAUTH_ACCESS_TOKEN_TTL_SECONDS).toBe(3600);
    expect(OAUTH_REFRESH_TOKEN_TTL_SECONDS).toBe(90 * 24 * 3600);
    expect(OAUTH_AUTHORIZATION_CODE_TTL_SECONDS).toBe(60);
  });
});

describe("classifying a presented refresh token", () => {
  it("rotates a fresh, unspent token", () => {
    expect(classifyRefreshToken(aRefreshToken(), T0)).toEqual({ kind: "rotate" });
  });

  it("DETECTS A REPLAY when the token was already consumed", () => {
    expect(classifyRefreshToken(aRefreshToken({ consumedAt: T0 }), at(MINUTE_MS))).toEqual({
      kind: "replay",
      rotationFamilyId: family,
    });
  });

  it("detects a replay when the token was revoked", () => {
    expect(classifyRefreshToken(aRefreshToken({ revokedAt: T0 }), at(MINUTE_MS)).kind).toBe(
      "replay",
    );
  });

  it("REPORTS A SPENT-AND-EXPIRED TOKEN AS A REPLAY, not as expired", () => {
    const spent = aRefreshToken({ consumedAt: T0, expiresAt: at(MINUTE_MS) });
    expect(classifyRefreshToken(spent, at(100 * DAY_MS)).kind).toBe("replay");
  });

  it("reports an unspent expired token as expired", () => {
    expect(classifyRefreshToken(aRefreshToken(), at(91 * DAY_MS)).kind).toBe("expired");
  });
});

describe("ownership and scope are checked before state", () => {
  it("refuses a token presented by a different client", () => {
    const refused = assertIssuedToClient(aRefreshToken(), otherClient);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("INVALID_GRANT");
  });

  it("accepts a token presented by its own client", () => {
    expect(assertIssuedToClient(aRefreshToken(), client).ok).toBe(true);
  });

  it("REFUSES A CROSS-SCOPE EXCHANGE at a sibling environment's endpoint", () => {
    const refused = assertScopeMatches(aRefreshToken(), SIBLING_ENVIRONMENT);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("INVALID_GRANT");
  });

  it("accepts an exchange at its own endpoint, and skips the check when unscoped", () => {
    expect(assertScopeMatches(aRefreshToken(), ENVIRONMENT).ok).toBe(true);
    expect(assertScopeMatches(aRefreshToken(), null).ok).toBe(true);
  });
});

describe("rotation inherits the family so a later replay still reaches everything", () => {
  const plan = planTokenPair({
    accessTokenId: asIdentifier<OAuthTokenId>("access-2"),
    accessTokenHash: tokenHash("access-2-hash"),
    refreshTokenId: asIdentifier<OAuthTokenId>("refresh-2"),
    refreshTokenHash: tokenHash("refresh-2-hash"),
    clientId: client,
    userId: userId(),
    scope: ENVIRONMENT_SCOPE,
    scopes: ["mcp:read"],
    rotationFamilyId: family,
    parent: aRefreshToken(),
    now: T0,
  });

  it("keeps the rotation family identifier", () => {
    expect(plan.refreshToken.rotationFamilyId).toBe(family);
  });

  it("links the new token to its parent and consumes the parent", () => {
    expect(plan.refreshToken.parentRefreshTokenId).toBe("refresh-1");
    expect(plan.consumedRefreshToken?.consumedAt).toEqual(T0);
  });

  it("applies both TTLs from the same instant", () => {
    expect(plan.accessToken.expiresAt).toEqual(at(OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1000));
    expect(plan.refreshToken.expiresAt).toEqual(at(OAUTH_REFRESH_TOKEN_TTL_SECONDS * 1000));
    expect(plan.expiresInSeconds).toBe(OAUTH_ACCESS_TOKEN_TTL_SECONDS);
  });

  it("ties the refresh token to the access token so a family revoke reaches both", () => {
    expect(plan.refreshToken.accessTokenId).toBe(plan.accessToken.tokenId);
  });

  it("stamps a family revocation with one instant for both columns", () => {
    const revocation = familyRevocation(family, T0);
    expect(revocation.replayDetectedAt).toEqual(T0);
    expect(revocation.revokedAt).toEqual(T0);
  });
});

describe("an authorization code is single-use and PKCE-bound", () => {
  const code: OAuthAuthorizationCodeRecord = {
    codeHash: tokenHash("code-hash"),
    clientId: client,
    userId: userId(),
    scope: ENVIRONMENT_SCOPE,
    scopes: ["mcp:read"],
    codeChallenge: "challenge(verifier)",
    codeChallengeMethod: PKCE_CHALLENGE_METHOD,
    redirectUri: "https://app.example.com/callback",
    expiresAt: at(OAUTH_AUTHORIZATION_CODE_TTL_SECONDS * 1000),
    usedAt: null,
  };
  const request = {
    code,
    clientId: client,
    redirectUri: "https://app.example.com/callback",
    derivedChallenge: "challenge(verifier)",
    now: T0,
  };

  it("accepts a well-formed exchange and marks the code used", () => {
    const accepted = verifyAuthorizationCode(request);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.value.usedAt).toEqual(T0);
  });

  it("refuses a code that was already used", () => {
    expect(verifyAuthorizationCode({ ...request, code: { ...code, usedAt: T0 } }).ok).toBe(false);
  });

  it("refuses a code past its sixty seconds", () => {
    expect(
      verifyAuthorizationCode({
        ...request,
        now: at(OAUTH_AUTHORIZATION_CODE_TTL_SECONDS * 1000),
      }).ok,
    ).toBe(false);
  });

  it("refuses a code presented by another client", () => {
    expect(verifyAuthorizationCode({ ...request, clientId: otherClient }).ok).toBe(false);
  });

  it("refuses a mismatched redirect", () => {
    expect(
      verifyAuthorizationCode({ ...request, redirectUri: "https://evil.example.com/cb" }).ok,
    ).toBe(false);
  });

  it("REFUSES A FAILED PKCE VERIFICATION", () => {
    const refused = verifyAuthorizationCode({ ...request, derivedChallenge: "challenge(wrong)" });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.message).toContain("PKCE");
  });

  it("refuses a plain challenge method outright", () => {
    const refused = verifyAuthorizationCode({
      ...request,
      code: { ...code, codeChallengeMethod: "plain" },
    });
    expect(refused.ok).toBe(false);
  });
});
