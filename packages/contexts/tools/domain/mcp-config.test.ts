import { asIdentifier, type EntityId } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import { asToolsIdentifier, type ToolName } from "./identifiers.js";
import {
  admitRateLimit,
  DEFAULT_MCP_RATE_LIMIT_PER_MINUTE,
  effectiveIdentityMode,
  injectContext,
  isHostReady,
  MAX_MCP_RATE_LIMIT_PER_MINUTE,
  MCP_CONTEXT_KEY,
  permitsRedirect,
  type EntityMcpConfig,
} from "./mcp-config.js";

const AT = new Date("2026-01-01T00:00:00.000Z");

function config(overrides: Partial<EntityMcpConfig> = {}): EntityMcpConfig {
  return {
    entityId: asIdentifier<EntityId>("entity-pk-1"),
    enabled: true,
    identityMode: "bearer",
    identityProviders: [],
    branding: {},
    toolAllowlist: [asToolsIdentifier<ToolName>("files.upload")],
    redirectUriAllowlist: ["https://tenant.example.com/callback"],
    rateLimitPerMinute: DEFAULT_MCP_RATE_LIMIT_PER_MINUTE,
    injectMcpContext: false,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

describe("the rate limit", () => {
  it("carries the column default", () => {
    expect(DEFAULT_MCP_RATE_LIMIT_PER_MINUTE).toBe(60);
  });

  it("refuses a limit that cannot bind", () => {
    expect(admitRateLimit(0).ok).toBe(false);
    expect(admitRateLimit(-1).ok).toBe(false);
    expect(admitRateLimit(MAX_MCP_RATE_LIMIT_PER_MINUTE + 1).ok).toBe(false);
    expect(admitRateLimit(Number.POSITIVE_INFINITY).ok).toBe(false);
  });

  it("truncates a fractional limit rather than passing it to an Int column", () => {
    const admitted = admitRateLimit(30.9);
    expect(admitted.ok && admitted.value).toBe(30);
  });
});

describe("the redirect allowlist", () => {
  it("matches EXACTLY, so a suffix cannot open a redirect", () => {
    const held = config();
    expect(permitsRedirect(held, "https://tenant.example.com/callback")).toBe(true);
    expect(permitsRedirect(held, "https://tenant.example.com/callback.attacker.test")).toBe(false);
    expect(permitsRedirect(held, "https://tenant.example.com/callback/evil")).toBe(false);
    expect(permitsRedirect(held, "https://tenant.example.com")).toBe(false);
  });
});

describe("whether a hosted surface is reachable", () => {
  it("needs BOTH the flag and something to offer", () => {
    expect(isHostReady(config())).toBe(true);
    expect(isHostReady(config({ enabled: false }))).toBe(false);
    expect(isHostReady(config({ toolAllowlist: [] }))).toBe(false);
  });
});

describe("the identity mode a surface will accept", () => {
  it("takes the STRONGER of the surface's and the tool's", () => {
    expect(effectiveIdentityMode(config({ identityMode: "oidc" }), "bearer")).toBe("oidc");
    expect(effectiveIdentityMode(config({ identityMode: "bearer" }), "oidc")).toBe("oidc");
    expect(effectiveIdentityMode(config({ identityMode: "anonymous" }), "bearer")).toBe("bearer");
  });

  it("never lets a per-tool setting downgrade the surface", () => {
    expect(effectiveIdentityMode(config({ identityMode: "oidc" }), "anonymous")).toBe("oidc");
  });
});

describe("the injected context envelope", () => {
  it("goes under a reserved key", () => {
    expect(injectContext({ path: "/a" }, { endUserId: "u1" })).toEqual({
      path: "/a",
      [MCP_CONTEXT_KEY]: { endUserId: "u1" },
    });
  });

  it("wins over a caller's own key, so a backend can trust what it reads there", () => {
    const merged = injectContext({ [MCP_CONTEXT_KEY]: { endUserId: "someone-else" } }, { endUserId: "u1" });
    expect(merged[MCP_CONTEXT_KEY]).toEqual({ endUserId: "u1" });
  });

  it("leaves every other argument untouched", () => {
    const original = { path: "/a", nested: { keep: true } };
    const merged = injectContext(original, {});
    expect(merged["nested"]).toBe(original.nested);
  });
});
