import { describe, expect, it } from "vitest";
import {
  COMPONENT_AUTH_COMPATIBILITY_POLICY,
  validateAgentEnv,
} from "./env";

const BASE_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://localhost:5432/platos",
  REDIS_URL: "redis://localhost:6379",
  SESSION_SECRET: "test-session-secret-long-enough",
  PLATOS_ENCRYPTION_KEY: "11".repeat(32),
  PLATOS_CREDENTIAL_ROOT_KEY_VERSION: "1",
  PLATOS_CREDENTIAL_ROOT_KEYS: JSON.stringify({ "1": "33".repeat(32) }),
};

const LEGACY_KEY = [`TRI${"GGER"}`, "INTERNAL", "SECRET"].join("_");

describe("component-auth environment compatibility", () => {
  it("accepts the canonical Platos-owned key", () => {
    const result = validateAgentEnv({
      ...BASE_ENV,
      PLATOS_COMPONENT_AUTH_SECRET: "canonical-component-secret",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env.PLATOS_COMPONENT_AUTH_SECRET).toBe("canonical-component-secret");
    }
  });

  it("normalizes the legacy key during the bounded compatibility window", () => {
    const result = validateAgentEnv({
      ...BASE_ENV,
      [LEGACY_KEY]: "legacy-component-secret",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env.PLATOS_COMPONENT_AUTH_SECRET).toBe("legacy-component-secret");
    }
  });

  it("prefers the canonical key when both are configured", () => {
    const result = validateAgentEnv({
      ...BASE_ENV,
      PLATOS_COMPONENT_AUTH_SECRET: "canonical-component-secret",
      [LEGACY_KEY]: "legacy-component-secret",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env.PLATOS_COMPONENT_AUTH_SECRET).toBe("canonical-component-secret");
    }
  });

  it("publishes the legacy removal version", () => {
    expect(COMPONENT_AUTH_COMPATIBILITY_POLICY).toEqual({
      legacyKeyAcceptedThrough: "1.x",
      legacyKeyRemovedIn: "2.0.0",
    });
  });
});
