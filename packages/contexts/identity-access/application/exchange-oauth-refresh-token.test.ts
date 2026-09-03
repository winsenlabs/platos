import { describe, expect, it } from "vitest";

import {
  GLOBAL_SCOPE,
  type OAuthClientId,
  type OAuthTokenId,
  type RotationFamilyId,
} from "../domain/index.js";
import {
  DAY_MS,
  SIBLING_ENVIRONMENT,
  T0,
  aRefreshToken,
  at,
  tokenHash,
} from "../domain/testing.js";
import { exchangeOAuthRefreshToken } from "./exchange-oauth-refresh-token.js";
import { testPorts, type TestPorts } from "./testing.js";
import { asIdentifier } from "@platos/kernel";

const CLIENT = asIdentifier<OAuthClientId>("plt_oac_client");
const OTHER_CLIENT = asIdentifier<OAuthClientId>("plt_oac_other");
const RAW = "plt_or_raw-refresh-token";
const SIBLING_FAMILY = asIdentifier<RotationFamilyId>("family-2");

function arrange(overrides: Parameters<typeof aRefreshToken>[0] = {}): TestPorts {
  const ports = testPorts();
  const presented = aRefreshToken({ tokenHash: ports.hasher.hash(RAW), ...overrides });
  ports.repository.state.refreshTokens.set(presented.tokenHash, presented);
  // A second, unrelated family, so a family revoke can be shown not to over-reach.
  const bystander = aRefreshToken({
    tokenId: asIdentifier<OAuthTokenId>("refresh-9"),
    tokenHash: tokenHash("bystander-hash"),
    rotationFamilyId: SIBLING_FAMILY,
  });
  ports.repository.state.refreshTokens.set(bystander.tokenHash, bystander);
  return ports;
}

describe("rotating a refresh token", () => {
  it("mints a prefixed pair and consumes the presented token", async () => {
    const ports = arrange();
    const result = await exchangeOAuthRefreshToken(ports, {
      clientId: CLIENT,
      presentedToken: RAW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.accessToken.startsWith("plt_oa_")).toBe(true);
    expect(result.value.refreshToken.startsWith("plt_or_")).toBe(true);
    expect(result.value.expiresInSeconds).toBe(3600);
    expect(ports.repository.state.refreshTokens.get(ports.hasher.hash(RAW))?.consumedAt).toEqual(
      T0,
    );
  });

  it("keeps the rotation family, so the chain stays linked", async () => {
    const ports = arrange();
    const result = await exchangeOAuthRefreshToken(ports, {
      clientId: CLIENT,
      presentedToken: RAW,
    });
    expect(result.ok && result.value.plan.refreshToken.rotationFamilyId).toBe("family-1");
  });
});

describe("REPLAY DETECTION", () => {
  async function replay(ports: TestPorts): Promise<ReturnType<typeof exchangeOAuthRefreshToken>> {
    await exchangeOAuthRefreshToken(ports, { clientId: CLIENT, presentedToken: RAW });
    return exchangeOAuthRefreshToken(ports, { clientId: CLIENT, presentedToken: RAW });
  }

  it("refuses a token presented a second time", async () => {
    const ports = arrange();
    const result = await replay(ports);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TOKEN_REPLAYED");
  });

  it("REVOKES THE WHOLE ROTATION FAMILY, not just the replayed token", async () => {
    const ports = arrange();
    await replay(ports);
    const family = [...ports.repository.state.refreshTokens.values()].filter(
      (token) => token.rotationFamilyId === "family-1",
    );
    expect(family.length).toBeGreaterThan(1);
    for (const token of family) {
      expect(token.revokedAt).not.toBeNull();
      expect(token.replayDetectedAt).not.toBeNull();
    }
  });

  it("does not touch an unrelated rotation family", async () => {
    const ports = arrange();
    await replay(ports);
    expect(ports.repository.state.refreshTokens.get(tokenHash("bystander-hash"))?.revokedAt).toBe(
      null,
    );
  });

  it("reports the replay through the kernel safety sink", async () => {
    const ports = arrange();
    await replay(ports);
    const observation = ports.safety.observations.at(-1);
    expect(observation?.rule).toBe("identity.oauth.refresh_token_replayed");
    expect(observation?.outcome).toBe("blocked");
    expect(observation?.details).toMatchObject({ rotationFamilyId: "family-1" });
  });

  it("treats a revoked token as a replay too", async () => {
    const ports = arrange({ revokedAt: T0 });
    const result = await exchangeOAuthRefreshToken(ports, {
      clientId: CLIENT,
      presentedToken: RAW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TOKEN_REPLAYED");
  });

  it("skips the observation for a GLOBAL grant but still revokes the family", async () => {
    const ports = arrange({ scope: GLOBAL_SCOPE, consumedAt: T0 });
    const result = await exchangeOAuthRefreshToken(ports, {
      clientId: CLIENT,
      presentedToken: RAW,
    });
    expect(result.ok).toBe(false);
    expect(ports.safety.observations).toHaveLength(0);
    expect(ports.repository.state.refreshTokens.get(ports.hasher.hash(RAW))?.revokedAt).toEqual(T0);
  });
});

describe("negative controls that must NOT destroy the family", () => {
  it("refuses a stranger's client without revoking anything", async () => {
    const ports = arrange();
    const result = await exchangeOAuthRefreshToken(ports, {
      clientId: OTHER_CLIENT,
      presentedToken: RAW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_GRANT");
    expect(ports.repository.state.refreshTokens.get(ports.hasher.hash(RAW))?.revokedAt).toBeNull();
  });

  it("REFUSES A CROSS-SCOPE EXCHANGE at a sibling environment's endpoint", async () => {
    const ports = arrange();
    const result = await exchangeOAuthRefreshToken(ports, {
      clientId: CLIENT,
      presentedToken: RAW,
      expectedScope: SIBLING_ENVIRONMENT,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_GRANT");
    expect(ports.repository.state.refreshTokens.get(ports.hasher.hash(RAW))?.revokedAt).toBeNull();
  });

  it("refuses an unknown token", async () => {
    const result = await exchangeOAuthRefreshToken(arrange(), {
      clientId: CLIENT,
      presentedToken: "plt_or_invented",
    });
    expect(result.ok).toBe(false);
  });

  it("refuses an unspent but expired token as a plain invalid grant", async () => {
    const ports = arrange();
    ports.clock.set(at(91 * DAY_MS));
    const result = await exchangeOAuthRefreshToken(ports, {
      clientId: CLIENT,
      presentedToken: RAW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_GRANT");
    expect(ports.safety.observations).toHaveLength(0);
  });
});
