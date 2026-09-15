import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateAgentEnv } from "./env";

// WIN-293 — the control-plane trust anchor must not boot in production with the
// public `.env.example` placeholder, or the fail-closed operator guard is
// defeated by a well-known token.
const SENTINEL =
  "feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface";

const PROD_BASE = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://localhost:5432/platos",
  REDIS_URL: "redis://localhost:6379",
  SESSION_SECRET: "prod-session-secret-long-enough",
  PLATOS_ENCRYPTION_KEY: "11".repeat(32),
  PLATOS_MESSAGE_ENCRYPTION_KEY: "22".repeat(32),
  PLATOS_ERASURE_HASH_SALT: "44".repeat(32),
  PLATOS_COMPONENT_AUTH_SECRET: "prod-component-secret-strong",
  PLATOS_CREDENTIAL_ROOT_KEY_VERSION: "1",
  PLATOS_CREDENTIAL_ROOT_KEYS: JSON.stringify({ "1": "33".repeat(32) }),
};

describe("PLATOS_INTERNAL_AUTH_TOKEN production sentinel", () => {
  it("rejects the .env.example placeholder in production", () => {
    const result = validateAgentEnv({
      ...PROD_BASE,
      PLATOS_INTERNAL_AUTH_TOKEN: SENTINEL,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(JSON.stringify(result)).toContain("PLATOS_INTERNAL_AUTH_TOKEN");
      expect(JSON.stringify(result)).toContain("sentinel");
    }
  });

  it("requires the token to be present in production", () => {
    const { PLATOS_INTERNAL_AUTH_TOKEN, ...noToken } = {
      ...PROD_BASE,
      PLATOS_INTERNAL_AUTH_TOKEN: SENTINEL,
    };
    void PLATOS_INTERNAL_AUTH_TOKEN;
    const result = validateAgentEnv(noToken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(JSON.stringify(result)).toContain("PLATOS_INTERNAL_AUTH_TOKEN");
    }
  });

  it("raises NO token-specific issue for a real random token in production", () => {
    // Isolates the token rule from other prod-env requirements: a real random
    // value must produce zero PLATOS_INTERNAL_AUTH_TOKEN issues (the env may
    // still be invalid for unrelated reasons, which this test does not assert).
    const result = validateAgentEnv({
      ...PROD_BASE,
      PLATOS_INTERNAL_AUTH_TOKEN: "aa".repeat(32),
    });
    const tokenIssue = result.ok
      ? false
      : JSON.stringify(result).includes("PLATOS_INTERNAL_AUTH_TOKEN");
    expect(tokenIssue).toBe(false);
  });
});

describe("PLATOS_COMPONENT_AUTH_SECRET production placeholder", () => {
  // `.env.example` gives this compose-required secret a development value so a
  // copied `.env` evaluates, and says the agent refuses that value in production.
  // Read the value from the file itself, so the claim holds for whatever the
  // example ships rather than for a literal copied into this suite.
  const example = readFileSync(new URL("../../../../.env.example", import.meta.url), "utf8");
  const shipped = /^PLATOS_COMPONENT_AUTH_SECRET=(.*)$/mu.exec(example)?.[1];

  it("rejects the value .env.example ships, in production", () => {
    expect(shipped, ".env.example must assign PLATOS_COMPONENT_AUTH_SECRET").toMatch(/\S/u);
    const result = validateAgentEnv({
      ...PROD_BASE,
      PLATOS_INTERNAL_AUTH_TOKEN: "aa".repeat(32),
      PLATOS_COMPONENT_AUTH_SECRET: shipped,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(JSON.stringify(result)).toContain("PLATOS_COMPONENT_AUTH_SECRET must be set to a strong random value in production");
    }
  });

  it("raises NO component-secret issue for a generated value, in production (control)", () => {
    const result = validateAgentEnv({
      ...PROD_BASE,
      PLATOS_INTERNAL_AUTH_TOKEN: "aa".repeat(32),
      PLATOS_COMPONENT_AUTH_SECRET: "bb".repeat(32),
    });
    const componentIssue = result.ok ? false : JSON.stringify(result).includes("PLATOS_COMPONENT_AUTH_SECRET");
    expect(componentIssue).toBe(false);
  });
});

describe("PLATOS_BOOTSTRAP_TOKEN expiry contract", () => {
  const bootstrapBase = {
    ...PROD_BASE,
    PLATOS_INTERNAL_AUTH_TOKEN: "aa".repeat(32),
    PLATOS_BOOTSTRAP_TOKEN: "bootstrap-secret-long-enough",
  };

  it("rejects an absent or malformed expiry when bootstrap is enabled", () => {
    for (const expiry of [undefined, "not-a-date"]) {
      const result = validateAgentEnv({
        ...bootstrapBase,
        ...(expiry ? { PLATOS_BOOTSTRAP_TOKEN_EXPIRES_AT: expiry } : {}),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(JSON.stringify(result)).toContain("PLATOS_BOOTSTRAP_TOKEN_EXPIRES_AT");
      }
    }
  });

  it("rejects an expired bootstrap window", () => {
    const result = validateAgentEnv({
      ...bootstrapBase,
      PLATOS_BOOTSTRAP_TOKEN_EXPIRES_AT: "2000-01-01T00:00:00.000Z",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(JSON.stringify(result)).toContain("must be in the future");
  });

  it("accepts a future bootstrap expiry", () => {
    const result = validateAgentEnv({
      ...bootstrapBase,
      PLATOS_BOOTSTRAP_TOKEN_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString(),
    });
    const expiryIssue = result.ok
      ? false
      : JSON.stringify(result).includes("PLATOS_BOOTSTRAP_TOKEN_EXPIRES_AT");
    expect(expiryIssue).toBe(false);
  });
});
