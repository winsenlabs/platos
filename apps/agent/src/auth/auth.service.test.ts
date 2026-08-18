import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "./auth.service";

const SCOPE = {
  organizationId: "org_1",
  projectId: "proj_1",
  environmentId: "env_1",
  userId: "user_1",
  entityId: "entity_1",
} as const;

type BearerState = {
  id: string;
  environmentId: string;
  revokedAt: Date | null;
  expiresAt: Date | null;
  entity: {
    externalId: string;
    project: { id: string; organizationId: string };
  };
};

function makeSessionHarness() {
  const state: {
    bearer: BearerState | null;
    environment: { project: { id: string; organizationId: string } } | null;
    activeCount: number;
  } = {
    bearer: {
      id: "bearer_1",
      environmentId: SCOPE.environmentId,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 90_000),
      entity: {
        externalId: SCOPE.entityId,
        project: { id: SCOPE.projectId, organizationId: SCOPE.organizationId },
      },
    },
    environment: {
      project: { id: SCOPE.projectId, organizationId: SCOPE.organizationId },
    },
    activeCount: 1,
  };
  const prisma = {
    mcpBearerToken: {
      findUnique: vi.fn(async () => state.bearer),
      updateMany: vi.fn(async () => ({ count: state.activeCount })),
    },
    environment: {
      findUnique: vi.fn(async () => state.environment),
    },
  };
  return {
    state,
    prisma,
    auth: new AuthService(prisma as any, {} as any),
  };
}

function entityClaims(overrides: Record<string, unknown> = {}) {
  return {
    ...SCOPE,
    ...overrides,
  } as any;
}

describe("AuthService — clean bearer-backed session tokens", () => {
  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", "platform-shared-secret-32-chars-xx");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("mints a standard three-part HS256 JWT and validates active authorization", async () => {
    const h = makeSessionHarness();
    const token = await h.auth.createEntitySessionToken(entityClaims(), "bearer_1", 60);

    expect(token).toBeTruthy();
    expect(token!.split(".")).toHaveLength(3);
    const [header, payload] = token!.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString("utf8"))).toEqual({
      alg: "HS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))).toMatchObject({
      iss: "platos-platform",
      authorizationId: "bearer_1",
      ...SCOPE,
    });

    await expect(h.auth.validateSessionToken(token!)).resolves.toMatchObject({
      authorizationId: "bearer_1",
      ...SCOPE,
    });
    expect(h.prisma.mcpBearerToken.updateMany).toHaveBeenCalledOnce();
  });

  it("rejects a payload changed without a matching signature", async () => {
    const h = makeSessionHarness();
    const token = (await h.auth.createEntitySessionToken(entityClaims(), "bearer_1", 60))!;
    const [header, payload, signature] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    claims.userId = "attacker";
    const tamperedPayload = Buffer.from(JSON.stringify(claims)).toString("base64url");

    await expect(
      h.auth.validateSessionToken(`${header}.${tamperedPayload}.${signature}`),
    ).resolves.toBeNull();
  });

  it("rejects JWT expiry independently of bearer lifetime", async () => {
    const h = makeSessionHarness();
    const token = await h.auth.createEntitySessionToken(entityClaims(), "bearer_1", -1);
    await expect(h.auth.validateSessionToken(token!)).resolves.toBeNull();
  });

  it("immediately rejects bearer expiry and revocation", async () => {
    const h = makeSessionHarness();
    const token = (await h.auth.createEntitySessionToken(entityClaims(), "bearer_1", 60))!;

    h.state.bearer!.expiresAt = new Date(Date.now() - 1);
    await expect(h.auth.validateSessionToken(token)).resolves.toBeNull();

    h.state.bearer!.expiresAt = new Date(Date.now() + 60_000);
    h.state.bearer!.revokedAt = new Date();
    await expect(h.auth.validateSessionToken(token)).resolves.toBeNull();
  });

  it("fails closed when revocation wins the lookup-to-use race", async () => {
    const h = makeSessionHarness();
    h.state.activeCount = 0;
    const token = await h.auth.createEntitySessionToken(entityClaims(), "bearer_1", 60);
    await expect(h.auth.validateSessionToken(token!)).resolves.toBeNull();
  });

  it.each([
    ["entity", { entityId: "forged" }, undefined],
    ["project", { projectId: "forged" }, undefined],
    ["organization", { organizationId: "forged" }, undefined],
    [
      "environment",
      {},
      { project: { id: "other-project", organizationId: SCOPE.organizationId } },
    ],
  ])("rejects forged %s ancestry", async (_axis, overrides, environment) => {
    const h = makeSessionHarness();
    if (environment) h.state.environment = environment;
    const token = await h.auth.createEntitySessionToken(
      entityClaims(overrides),
      "bearer_1",
      60,
    );
    await expect(h.auth.validateSessionToken(token!)).resolves.toBeNull();
  });

  it("rejects a session whose environment differs from its PAT owner in the same project", async () => {
    const h = makeSessionHarness();
    h.state.bearer!.environmentId = "env_2";
    const token = await h.auth.createEntitySessionToken(entityClaims(), "bearer_1", 60);

    await expect(h.auth.validateSessionToken(token!)).resolves.toBeNull();
    expect(h.prisma.mcpBearerToken.updateMany).not.toHaveBeenCalled();
  });

  it("accepts operator platform tokens without an entity authorization", async () => {
    const h = makeSessionHarness();
    const token = await h.auth.createPlatformSessionToken({
      organizationId: SCOPE.organizationId,
      projectId: SCOPE.projectId,
      environmentId: SCOPE.environmentId,
      userId: SCOPE.userId,
    });
    await expect(h.auth.validateSessionToken(token!)).resolves.toMatchObject({
      iss: "platos-platform",
      userId: SCOPE.userId,
    });
    expect(h.prisma.mcpBearerToken.findUnique).not.toHaveBeenCalled();
  });

  it("rejects legacy two-part and entity-issuer tokens", async () => {
    const h = makeSessionHarness();
    expect(await h.auth.validateSessionToken("payload.signature")).toBeNull();

    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
      "base64url",
    );
    const payload = Buffer.from(JSON.stringify({
      organizationId: SCOPE.organizationId,
      projectId: SCOPE.projectId,
      environmentId: SCOPE.environmentId,
      userId: SCOPE.userId,
      iss: "entity",
      iat: now,
      exp: now + 60,
    })).toString("base64url");
    const signature = createHmac("sha256", process.env.SESSION_SECRET!)
      .update(`${header}.${payload}`)
      .digest("base64url");
    expect(await h.auth.validateSessionToken(`${header}.${payload}.${signature}`)).toBeNull();
  });
});

describe("AuthService — platform-signed session tokens", () => {
  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", "platform-shared-secret-32-chars-xx");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("mint + validate round-trip", async () => {
    const auth = makeSessionHarness().auth;
    const token = await auth.createPlatformSessionToken({
      organizationId: SCOPE.organizationId,
      projectId: SCOPE.projectId,
      environmentId: SCOPE.environmentId,
      userId: SCOPE.userId,
    }, 60);
    expect(token).toBeTruthy();
    const payload = await auth.validateSessionToken(token!);
    expect(payload).not.toBeNull();
    expect(payload!.iss).toBe("platos-platform");
    expect(payload!.entityId).toBeUndefined();
  });

  it("createPlatformSessionToken returns null when SESSION_SECRET unset", async () => {
    delete process.env.SESSION_SECRET;
    const auth = makeSessionHarness().auth;
    const token = await auth.createPlatformSessionToken({
      organizationId: SCOPE.organizationId,
      projectId: SCOPE.projectId,
      environmentId: SCOPE.environmentId,
      userId: SCOPE.userId,
    });
    expect(token).toBeNull();
  });
});

describe("AuthService — HMAC sign/verify for entity webhooks", () => {
  const auth = new AuthService({} as any, {} as any);
  const secret = "entity-webhook-secret-xyz";

  it("signRequest produces deterministic HMAC", () => {
    const ts = "1700000000";
    const body = '{"foo":"bar"}';
    const s1 = auth.signRequest(body, secret, ts);
    const s2 = auth.signRequest(body, secret, ts);
    expect(s1).toBe(s2);
    expect(s1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifySignature accepts signRequest output", () => {
    const ts = "1700000000";
    const body = '{"foo":"bar"}';
    const sig = auth.signRequest(body, secret, ts);
    expect(auth.verifySignature(body, sig, secret, ts)).toBe(true);
  });

  it("verifySignature rejects tampered body", () => {
    const ts = "1700000000";
    const body = '{"foo":"bar"}';
    const sig = auth.signRequest(body, secret, ts);
    expect(auth.verifySignature('{"foo":"BAZ"}', sig, secret, ts)).toBe(false);
  });

  it("verifySignature rejects wrong secret", () => {
    const ts = "1700000000";
    const body = '{"foo":"bar"}';
    const sig = auth.signRequest(body, secret, ts);
    expect(auth.verifySignature(body, sig, "other-secret", ts)).toBe(false);
  });

  it("verifySignature rejects replay with different timestamp", () => {
    const ts = "1700000000";
    const body = '{"foo":"bar"}';
    const sig = auth.signRequest(body, secret, ts);
    expect(auth.verifySignature(body, sig, secret, "1700000001")).toBe(false);
  });
});

describe("AuthService — clean-tenancy access keys", () => {
  function accessKeyPrisma() {
    const prisma: any = {
      environment: {
        findUnique: async () => ({
          id: "env_1",
          project: { id: "proj_1", organizationId: "org_1" },
        }),
      },
      accessKey: {
        create: async () => ({}),
        findFirst: async () => null,
        updateMany: async () => ({ count: 1 }),
      },
    };
    prisma.$transaction = async (callback: (tx: any) => unknown) => callback(prisma);
    return prisma;
  }

  it("stores only browser-generated hash material under Environment ownership", async () => {
    const prisma = accessKeyPrisma();
    let created: any;
    prisma.accessKey.create = async (args: any) => {
      created = args.data;
      return { ...args.data, id: "key-1", allowedOrigins: [], validUntil: null };
    };
    prisma.$queryRaw = async () => [{ id: "env_1" }];
    const auth = new AuthService(prisma, {} as any);
    auth.authorizeEnvironmentOperatorScope = async () => ({ environmentId: "env_1" } as any);

    const result = await auth.createOrRotateAccessKey(
      {
        organizationId: "org_1",
        projectId: "proj_1",
        environmentId: "env_1",
        userId: "user_1",
        principal: "operator",
      } as any,
      { keyHash: "a".repeat(64), keyPrefix: "platos_live_test" },
    );

    expect(result).not.toHaveProperty("rawKey");
    expect(created.environmentId).toBe("env_1");
    expect(created.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(created).not.toHaveProperty("organizationId");
    expect(created).not.toHaveProperty("projectId");
    expect(created).not.toHaveProperty("rawKey");
  });

  it("fails closed for a forged ancestry tuple", async () => {
    const prisma = accessKeyPrisma();
    const auth = new AuthService(prisma, {} as any);

    await expect(
      auth.verifyAccessKey(
        { organizationId: "forged", projectId: "proj_1", environmentId: "env_1" },
        "platos_live_forged",
        undefined,
      ),
    ).resolves.toBe(false);
  });
});

describe("AuthService — clean Entity registry", () => {
  function entityPrisma() {
    const prisma: any = {
      project: { findFirst: vi.fn() },
      entity: {
        create: vi.fn(),
        findFirst: vi.fn(),
        findMany: vi.fn(),
        findUniqueOrThrow: vi.fn(),
        update: vi.fn(),
        deleteMany: vi.fn(),
      },
      credential: {
        create: vi.fn(),
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
        upsert: vi.fn(),
      },
    };
    prisma.$transaction = vi.fn(async (callback: (tx: any) => unknown) => callback(prisma));
    return prisma;
  }

  const project = {
    id: "proj_1",
    organizationId: "org_1",
    environments: [{ id: "env_1" }, { id: "env_2" }],
  };
  const cleanEntity = {
    id: "entity_pk",
    externalId: "support-core",
    displayName: "Support Core",
    mcpUrls: ["https://entity.example/mcp"],
    projectId: "proj_1",
    connectionStatus: "disconnected",
    lastConnectedAt: null,
    connectionKind: "wire",
    allowedOrigins: [],
    mcpConfig: null,
    mcpClient: null,
    project: { organizationId: "org_1" },
    createdAt: new Date("2026-08-15T00:00:00.000Z"),
    updatedAt: new Date("2026-08-15T00:00:00.000Z"),
  };
  const operatorScope = {
    organizationId: "org_1",
    projectId: "proj_1",
    environmentId: "env_1",
    userId: "user_1",
    principal: "operator" as const,
  };

  function secretStore() {
    return {
      createInTransaction: vi.fn(async (_tx: any, params: any) => ({
        id: `credential-${params.authorization.environmentId}`,
      })),
      rotateInTransaction: vi.fn(async (_tx: any, params: any) => ({
        id: params.credentialId,
      })),
    };
  }

  it("creates a clean Entity and one Environment-owned wire credential per active environment", async () => {
    const prisma = entityPrisma();
    prisma.project.findFirst.mockResolvedValue(project);
    prisma.entity.create.mockResolvedValue({ id: cleanEntity.id });
    prisma.entity.findUniqueOrThrow.mockResolvedValue(cleanEntity);
    const store = secretStore();
    const auth = new AuthService(prisma, {} as any, undefined, store as any);
    auth.authorizeEnvironmentOperatorScope = async (scope) => ({
      environmentId: scope.environmentId,
    } as any);

    const result = await auth.registerEntity(
      {
        organizationId: "org_1",
        projectId: "proj_1",
        environmentId: "env_1",
        entityId: "support-core",
        displayName: "Support Core",
        mcpUrls: ["https://entity.example/mcp"],
        serviceSecret: "wire-secret",
      },
      operatorScope,
    );

    expect(prisma.entity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: "proj_1",
        externalId: "support-core",
        connectionKind: "wire",
      }),
    });
    expect(store.createInTransaction).toHaveBeenCalledTimes(2);
    expect(store.createInTransaction).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        authorization: expect.objectContaining({ environmentId: "env_1" }),
        kind: "ENTITY_SECRET",
        name: "support-core",
        plaintext: "wire-secret",
      }),
    );
    expect(prisma.credential.update).toHaveBeenCalledWith({
      where: { id: "credential-env_1" },
      data: expect.objectContaining({
        secretHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        permissions: ["entity:wire"],
      }),
    });
    expect(result).toMatchObject({
      entityId: "support-core",
      organizationId: "org_1",
      plaintextSecret: "wire-secret",
    });
    expect(JSON.stringify(prisma.entity.create.mock.calls[0][0])).not.toContain("wire-secret");
  });

  it("projects clean Entity ancestry without credential material", async () => {
    const prisma = entityPrisma();
    prisma.entity.findFirst.mockResolvedValue(cleanEntity);
    const auth = new AuthService(prisma, {} as any, undefined, secretStore() as any);

    const result = await auth.getEntity("org_1", "proj_1", "support-core");

    expect(prisma.entity.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          projectId: "proj_1",
          externalId: "support-core",
          project: { organizationId: "org_1" },
        },
      }),
    );
    expect(result).toMatchObject({
      entityId: "support-core",
      organizationId: "org_1",
      linkedAgentIds: [],
    });
    expect(result).not.toHaveProperty("externalId");
    expect(JSON.stringify(result)).not.toContain("encryptedReference");
  });

  it("lists clean project Entities through canonical Organization ancestry", async () => {
    const prisma = entityPrisma();
    prisma.entity.findMany.mockResolvedValue([cleanEntity]);
    const auth = new AuthService(prisma, {} as any, undefined, secretStore() as any);

    const result = await auth.listEntities("org_1", "proj_1");

    expect(prisma.entity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: "proj_1", project: { organizationId: "org_1" } },
      }),
    );
    expect(result).toEqual([
      expect.objectContaining({
        id: "entity_pk",
        entityId: "support-core",
        organizationId: "org_1",
      }),
    ]);
  });

  it("updates only the scoped clean Entity row", async () => {
    const prisma = entityPrisma();
    prisma.entity.findFirst.mockResolvedValue({ id: cleanEntity.id });
    prisma.entity.update.mockResolvedValue({
      ...cleanEntity,
      displayName: "Renamed",
      allowedOrigins: ["https://app.example"],
    });
    const auth = new AuthService(prisma, {} as any, undefined, secretStore() as any);

    const result = await auth.updateEntity("org_1", "proj_1", "support-core", {
      displayName: "Renamed",
      allowedOrigins: ["https://app.example/", "https://app.example"],
    });

    expect(prisma.entity.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: cleanEntity.id },
        data: {
          displayName: "Renamed",
          allowedOrigins: ["https://app.example"],
        },
      }),
    );
    expect(result).toMatchObject({
      entityId: "support-core",
      displayName: "Renamed",
      allowedOrigins: ["https://app.example"],
    });
  });

  it("rotates every active Environment credential and returns the raw value once", async () => {
    const prisma = entityPrisma();
    prisma.entity.findFirst.mockResolvedValue({
      id: cleanEntity.id,
      project: { environments: project.environments },
    });
    prisma.credential.findUnique
      .mockResolvedValueOnce({ id: "credential-env_1", activeSecretVersionId: "version-1", revokedAt: null })
      .mockResolvedValueOnce({ id: "credential-env_2", activeSecretVersionId: "version-2", revokedAt: null });
    const store = secretStore();
    const auth = new AuthService(prisma, {} as any, undefined, store as any);
    auth.authorizeEnvironmentOperatorScope = async (scope) => ({
      environmentId: scope.environmentId,
    } as any);

    const result = await auth.regenerateServiceSecret(
      "org_1",
      "proj_1",
      "support-core",
      operatorScope,
    );

    expect(result?.serviceSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(store.rotateInTransaction).toHaveBeenCalledTimes(2);
    expect(prisma.credential.update).toHaveBeenCalledTimes(2);
    for (const call of prisma.credential.update.mock.calls) {
      expect(call[0].data).toMatchObject({
        secretHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        permissions: ["entity:wire"],
      });
      expect(call[0].data).not.toHaveProperty("serviceSecret");
      expect(call[0].data).not.toHaveProperty("encryptedReference");
    }
  });

  it("revokes scoped Entity credentials before deleting the clean Entity", async () => {
    const prisma = entityPrisma();
    prisma.entity.findFirst.mockResolvedValue({ id: cleanEntity.id });
    prisma.entity.deleteMany.mockResolvedValue({ count: 1 });
    const auth = new AuthService(prisma, {} as any, undefined, secretStore() as any);

    await expect(auth.deleteEntity("org_1", "proj_1", "support-core")).resolves.toBe(true);
    expect(prisma.credential.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        kind: "ENTITY_SECRET",
        name: "support-core",
        environment: { projectId: "proj_1", project: { organizationId: "org_1" } },
      }),
      data: { revokedAt: expect.any(Date) },
    });
    expect(prisma.entity.deleteMany).toHaveBeenCalledWith({
      where: {
        id: cleanEntity.id,
        projectId: "proj_1",
        project: { organizationId: "org_1" },
      },
    });
  });
});
