import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "./auth.service";

const INSTALL_SECRET = "first-install-secret-value-32-chars";
const KEY_HASH = "a".repeat(64);
const KEY_PREFIX = "platos_live_test";
const SCOPE = {
  organizationId: "org_1",
  projectId: "proj_1",
  environmentId: "env_1",
  userId: "user_1",
  principal: "operator" as const,
  accessKeyBootstrapAuthenticated: true as const,
};

function makeAuth(options?: { existingKeys?: number; failKeyCreate?: boolean }) {
  const writes: string[] = [];
  const safeKey = {
    id: "key_1",
    environmentId: SCOPE.environmentId,
    keyPrefix: KEY_PREFIX,
    allowedOrigins: [],
    lastUsedAt: null,
    validUntil: null,
    replacedById: null,
    revokedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const tx = {
    accessKey: {
      count: vi.fn(async () => options?.existingKeys ?? 0),
      create: vi.fn(async () => {
        if (options?.failKeyCreate) throw new Error("key_create_failed");
        writes.push("key");
        return safeKey;
      }),
    },
    accessKeyBootstrapGrant: {
      create: vi.fn(async () => {
        writes.push("grant");
        return { id: "grant_1" };
      }),
    },
    adminAudit: {
      create: vi.fn(async () => {
        writes.push("audit");
        return { id: "audit_1" };
      }),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => {
      const checkpoint = writes.length;
      try {
        return await fn(tx);
      } catch (error) {
        writes.splice(checkpoint);
        throw error;
      }
    }),
  };
  const auth = new AuthService(prisma as any, {} as any);
  vi.spyOn(auth as any, "authorizeEnvironmentOperatorScope").mockResolvedValue({
    organizationId: SCOPE.organizationId,
    projectId: SCOPE.projectId,
    environmentId: SCOPE.environmentId,
  });
  return { auth, prisma, tx, writes };
}

describe("WIN-296 first-install AccessKey bootstrap", () => {
  let previousToken: string | undefined;
  let previousExpiry: string | undefined;

  beforeEach(() => {
    previousToken = process.env.PLATOS_BOOTSTRAP_TOKEN;
    previousExpiry = process.env.PLATOS_BOOTSTRAP_TOKEN_EXPIRES_AT;
    process.env.PLATOS_BOOTSTRAP_TOKEN = INSTALL_SECRET;
    process.env.PLATOS_BOOTSTRAP_TOKEN_EXPIRES_AT = new Date(
      Date.now() + 60_000,
    ).toISOString();
  });

  afterEach(() => {
    if (previousToken === undefined) delete process.env.PLATOS_BOOTSTRAP_TOKEN;
    else process.env.PLATOS_BOOTSTRAP_TOKEN = previousToken;
    if (previousExpiry === undefined) delete process.env.PLATOS_BOOTSTRAP_TOKEN_EXPIRES_AT;
    else process.env.PLATOS_BOOTSTRAP_TOKEN_EXPIRES_AT = previousExpiry;
    vi.restoreAllMocks();
  });

  it("fails closed when disabled, missing, malformed-expiry, or expired", () => {
    const { auth } = makeAuth();
    delete process.env.PLATOS_BOOTSTRAP_TOKEN;
    expect(auth.validateAccessKeyBootstrap(INSTALL_SECRET)).toEqual({
      ok: false,
      reason: "disabled",
    });

    process.env.PLATOS_BOOTSTRAP_TOKEN = INSTALL_SECRET;
    delete process.env.PLATOS_BOOTSTRAP_TOKEN_EXPIRES_AT;
    expect(auth.validateAccessKeyBootstrap(INSTALL_SECRET)).toEqual({
      ok: false,
      reason: "invalid_expiry",
    });
    process.env.PLATOS_BOOTSTRAP_TOKEN_EXPIRES_AT = "not-a-date";
    expect(auth.validateAccessKeyBootstrap(INSTALL_SECRET)).toEqual({
      ok: false,
      reason: "invalid_expiry",
    });
    process.env.PLATOS_BOOTSTRAP_TOKEN_EXPIRES_AT = "2000-01-01T00:00:00.000Z";
    expect(auth.validateAccessKeyBootstrap(INSTALL_SECRET)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("accepts only the configured credential before its expiry", () => {
    const { auth } = makeAuth();
    expect(auth.validateAccessKeyBootstrap("wrong")).toEqual({
      ok: false,
      reason: "invalid_token",
    });
    expect(auth.validateAccessKeyBootstrap(INSTALL_SECRET)).toEqual({ ok: true });
  });

  it("commits grant, audit, and first key in one transaction", async () => {
    const { auth, prisma, writes } = makeAuth();
    const result = await auth.createOrRotateAccessKey(
      SCOPE,
      { keyHash: KEY_HASH, keyPrefix: KEY_PREFIX },
      INSTALL_SECRET,
    );

    expect(result.key.environmentId).toBe(SCOPE.environmentId);
    expect(writes).toEqual(["grant", "audit", "key"]);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("rolls the grant and audit back when first-key creation fails", async () => {
    const { auth, writes } = makeAuth({ failKeyCreate: true });
    await expect(
      auth.createOrRotateAccessKey(
        SCOPE,
        { keyHash: KEY_HASH, keyPrefix: KEY_PREFIX },
        INSTALL_SECRET,
      ),
    ).rejects.toThrow("key_create_failed");
    expect(writes).toEqual([]);
  });

  it("self-disables when an active key already exists", async () => {
    const { auth, writes } = makeAuth({ existingKeys: 1 });
    await expect(
      auth.createOrRotateAccessKey(
        SCOPE,
        { keyHash: KEY_HASH, keyPrefix: KEY_PREFIX },
        INSTALL_SECRET,
      ),
    ).rejects.toThrow("access_key_bootstrap_not_zero_state");
    expect(writes).toEqual([]);
  });
});
