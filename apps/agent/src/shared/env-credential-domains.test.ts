import { describe, expect, it } from "vitest";
import { validateAgentEnv } from "./env";
import { decodeScopedEnvEncryptionKey } from "../providers/scoped-env.service";

const BASE_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://localhost:5432/platos",
  REDIS_URL: "redis://localhost:6379",
  SESSION_SECRET: "test-session-secret-long-enough",
  PLATOS_ENCRYPTION_KEY: "11".repeat(32),
};

describe("credential-domain environment validation", () => {
  it("accepts existing 32-byte UTF-8 ENCRYPTION_KEY bytes", () => {
    const legacy = "legacy-key-material-32-bytes!!!!";
    const result = validateAgentEnv({
      ...BASE_ENV,
      ENCRYPTION_KEY: legacy,
    });

    expect(result.ok).toBe(true);
    expect(decodeScopedEnvEncryptionKey(legacy)).toEqual(Buffer.from(legacy, "utf8"));
  });

  it("rejects reused encryption material across every configured domain", () => {
    const result = validateAgentEnv({
      ...BASE_ENV,
      ENCRYPTION_KEY: "22".repeat(32).toUpperCase(),
      PLATOS_MESSAGE_ENCRYPTION_KEY: "22".repeat(32),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toMatch(/must differ from ENCRYPTION_KEY/i);
  });

  it("rejects reused material across legacy UTF-8 and canonical hex representations", () => {
    const legacy = "legacy-key-material-32-bytes!!!!";
    const result = validateAgentEnv({
      ...BASE_ENV,
      ENCRYPTION_KEY: legacy,
      PLATOS_MESSAGE_ENCRYPTION_KEY: Buffer.from(legacy, "utf8").toString("hex"),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toMatch(/must differ from ENCRYPTION_KEY/i);
  });

  it("requires message encryption in production", () => {
    const result = validateAgentEnv({
      ...BASE_ENV,
      NODE_ENV: "production",
      PLATOS_ERASURE_HASH_SALT: "s".repeat(32),
      PLATOS_CORS_ORIGIN: "https://platos.example.com",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain(
        "PLATOS_MESSAGE_ENCRYPTION_KEY: PLATOS_MESSAGE_ENCRYPTION_KEY is required in production"
      );
    }
  });
});
