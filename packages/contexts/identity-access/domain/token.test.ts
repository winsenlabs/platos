import { describe, expect, it } from "vitest";

import {
  TOKEN_KINDS,
  TOKEN_PREFIXES,
  classifyToken,
  hasPrefix,
  noPrefixIsAmbiguous,
  prefixOf,
  requirePrefix,
} from "./token.js";

describe("the prefix registry", () => {
  it("records what the CODE mints, which is not what ADR M0.4 spells", () => {
    // M0.4 says `pk_mcp_`; every call site says `plt_mcp_`, and rows exist.
    expect(TOKEN_PREFIXES.mcpToken).toBe("plt_mcp_");
    expect(TOKEN_PREFIXES.entityBearerToken).toBe("plt_ent_");
    expect(TOKEN_PREFIXES.operatorSession).toBe("plt_os_");
    expect(TOKEN_PREFIXES.magicLink).toBe("plt_ml_");
    expect(TOKEN_PREFIXES.invitation).toBe("plt_inv_");
  });

  it("carries all six OAuth prefixes", () => {
    expect(TOKEN_PREFIXES.oauthAccessToken).toBe("plt_oa_");
    expect(TOKEN_PREFIXES.oauthRefreshToken).toBe("plt_or_");
    expect(TOKEN_PREFIXES.oauthClientId).toBe("plt_oac_");
    expect(TOKEN_PREFIXES.oauthClientSecret).toBe("plt_ocs_");
    expect(TOKEN_PREFIXES.oauthAuthorizationCode).toBe("plt_ocd_");
    expect(TOKEN_PREFIXES.oauthConsentTransaction).toBe("plt_octx_");
  });

  it("HAS NO AMBIGUITY: no prefix is a prefix of another", () => {
    expect(noPrefixIsAmbiguous()).toBe(true);
  });

  it("routes every registered kind back to itself", () => {
    for (const kind of TOKEN_KINDS) {
      expect(classifyToken(`${prefixOf(kind)}abc`)).toBe(kind);
    }
  });

  it("does not confuse the access token with the client identifier", () => {
    expect(classifyToken("plt_oa_secret")).toBe("oauthAccessToken");
    expect(classifyToken("plt_oac_secret")).toBe("oauthClientId");
    expect(classifyToken("plt_ocs_secret")).toBe("oauthClientSecret");
    expect(classifyToken("plt_octx_secret")).toBe("oauthConsentTransaction");
  });

  it("classifies an unprefixed string as nothing at all", () => {
    expect(classifyToken("plt_unknown_x")).toBeNull();
    expect(classifyToken("")).toBeNull();
    expect(classifyToken("plt_")).toBeNull();
  });

  it("refuses a token that does not claim the expected kind", () => {
    expect(hasPrefix("plt_os_abc", "operatorSession")).toBe(true);
    const wrong = requirePrefix("plt_ml_abc", "operatorSession");
    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    expect(wrong.error.code).toBe("INVALID_GRANT");
  });
});
