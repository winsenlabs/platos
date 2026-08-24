import { createHmac } from "node:crypto";
import { mintSessionToken } from "@platosdev/token-mint";
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

/**
 * Mint a token the way @platosdev/token-mint does: signed with the ENTITY's
 * service secret, and carrying no `iss` claim.
 */
function entitySignedToken(claims: Record<string, unknown>, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
    "base64url",
  );
  const iat = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ ...claims, iat, exp: iat + 300 }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
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

  it("unwraps the cutover's aggregate secret envelope, and leaves bare secrets alone", () => {
    // The cutover stored {"serviceSecret":"…"} where the mint path stores the
    // bare string, while Credential.secretHash kept the hash of the BARE
    // secret. Hash-comparing readers (tool-sync) kept working; HMAC readers
    // signed with the JSON envelope. Proven on test.platos: an 84-char JSON
    // plaintext whose sha256 did not match secretHash, but whose nested
    // serviceSecret value did.
    const bare = "a".repeat(64);

    expect(AuthService.unwrapEntitySecretMaterial(JSON.stringify({ serviceSecret: bare }))).toBe(bare);
    expect(
      AuthService.unwrapEntitySecretMaterial(
        JSON.stringify({ "PlatosConnectedEntity.serviceSecret": bare, other: 1 }),
      ),
    ).toBe(bare);

    // Freshly minted credentials must pass through untouched...
    expect(AuthService.unwrapEntitySecretMaterial(bare)).toBe(bare);
    // ...including a secret that merely looks JSON-ish, or an envelope with
    // no recognised key — guessing would swap a valid secret for a wrong one.
    expect(AuthService.unwrapEntitySecretMaterial("{not json")).toBe("{not json");
    expect(AuthService.unwrapEntitySecretMaterial('{"somethingElse":"x"}')).toBe('{"somethingElse":"x"}');
    expect(AuthService.unwrapEntitySecretMaterial('{"serviceSecret":42}')).toBe('{"serviceSecret":42}');
    // Idempotent.
    expect(
      AuthService.unwrapEntitySecretMaterial(AuthService.unwrapEntitySecretMaterial(JSON.stringify({ serviceSecret: bare }))),
    ).toBe(bare);
  });

  it("accepts a token signed with the entity's own service secret and no iss", async () => {
    // This is exactly what @platosdev/token-mint emits. Before per-entity
    // verification the agent required SESSION_SECRET + iss=platos-platform,
    // so EVERY externally minted token was rejected — a Slack turn through
    // Walle failed on the claims check before signature was even reached.
    // Requiring SESSION_SECRET instead would hand every integrator one key
    // that unlocks every tenant on the deployment.
    const h = makeSessionHarness();
    const entitySecret = "walle-entity-service-secret-abcdef";
    vi.spyOn(h.auth, "resolveEntityServiceSecret").mockResolvedValue(entitySecret);

    await expect(
      h.auth.validateSessionToken(mintSessionToken({
        serviceSecret: entitySecret,
        claims: SCOPE,
        ttlSeconds: 300,
      })),
    ).resolves.toMatchObject({
      organizationId: SCOPE.organizationId,
      projectId: SCOPE.projectId,
      entityId: SCOPE.entityId,
    });
  });

  it("names the stale environment id when a migrated deployment re-keys its scopes", async () => {
    // A cutover that re-keys Organization/Project/Environment (cuid -> uuid on
    // test.platos) leaves every integrator minting tokens against ids that no
    // longer exist. That failure is indistinguishable from a bad secret unless
    // the log prints the id, so it must.
    const h = makeSessionHarness();
    h.prisma.environment.findUnique = vi.fn(async () => null);
    const warn = vi
      .spyOn((h.auth as any).logger, "warn")
      .mockImplementation(() => undefined);

    const stale = { ...SCOPE, environmentId: "cmrci97ty000dpb0jq01pbdac" };
    await expect(
      h.auth.validateSessionToken(entitySignedToken(stale, "any-secret-abcdefghijkl")),
    ).resolves.toBeNull();

    const reason = String(warn.mock.calls.at(-1)?.[0] ?? "");
    expect(reason).toContain("cmrci97ty000dpb0jq01pbdac");
    expect(reason).toMatch(/pre-migration ids/i);
  });

  it("names both sides when the claimed project/org do not own the environment", async () => {
    const h = makeSessionHarness();
    const warn = vi
      .spyOn((h.auth as any).logger, "warn")
      .mockImplementation(() => undefined);

    await expect(
      h.auth.validateSessionToken(
        entitySignedToken({ ...SCOPE, organizationId: "org_someone_else" }, "any-secret-abcdefghijkl"),
      ),
    ).resolves.toBeNull();

    const reason = String(warn.mock.calls.at(-1)?.[0] ?? "");
    expect(reason).toContain("org_someone_else");
    expect(reason).toContain(SCOPE.organizationId);
  });

  it("refuses an entity-signed token for a scope that entity does not own", async () => {
    // resolveEntityServiceSecret re-derives organization/project from the
    // Environment and returns null when they disagree with the claims. That
    // is the guard stopping a valid entity secret becoming a cross-tenant key.
    const h = makeSessionHarness();
    vi.spyOn(h.auth, "resolveEntityServiceSecret").mockResolvedValue(null);

    await expect(
      h.auth.validateSessionToken(
        entitySignedToken({ ...SCOPE, organizationId: "org_someone_else" }, "any-secret-abcdefghijkl"),
      ),
    ).resolves.toBeNull();
  });

  it("refuses a token signed with the wrong entity secret", async () => {
    const h = makeSessionHarness();
    vi.spyOn(h.auth, "resolveEntityServiceSecret").mockResolvedValue(
      "the-real-entity-secret-0000000000",
    );

    await expect(
      h.auth.validateSessionToken(entitySignedToken(SCOPE, "an-attackers-guess-1111111111")),
    ).resolves.toBeNull();
  });

  it("records a distinct reason for each rejection, and never the token itself", async () => {
    // validateSessionToken had sixteen silent `return null` paths, so a Slack
    // turn failing on test.platos surfaced as "Invalid or expired session
    // token." with nothing in the agent log to say which of the sixteen fired.
    const h = makeSessionHarness();
    const warn = vi
      .spyOn((h.auth as any).logger, "warn")
      .mockImplementation(() => undefined);
    const lastReason = () => String(warn.mock.calls.at(-1)?.[0] ?? "");

    const expired = await h.auth.createEntitySessionToken(entityClaims(), "bearer_1", -1);
    await expect(h.auth.validateSessionToken(expired!)).resolves.toBeNull();
    const expiredReason = lastReason();
    expect(expiredReason).toMatch(/expired/i);

    // A forged signature must fail against BOTH signing authorities before it
    // can be reported as a signature problem, so give the entity a real secret
    // the forgery still will not match.
    vi.spyOn(h.auth, "resolveEntityServiceSecret").mockResolvedValue(
      "the-real-entity-secret-0000000000",
    );
    const valid = (await h.auth.createEntitySessionToken(entityClaims(), "bearer_1", 60))!;
    const [header, payload] = valid.split(".");
    const forged = `${header}.${payload}.${"A".repeat(43)}`;
    await expect(h.auth.validateSessionToken(forged)).resolves.toBeNull();
    const forgedReason = lastReason();
    expect(forgedReason).toMatch(/signature does not verify/i);

    // An expiry and a bad signature are different operator problems and must
    // not be reported with the same words.
    expect(expiredReason).not.toBe(forgedReason);

    // A reason is for the log, so it must never carry token material.
    for (const call of warn.mock.calls) {
      const line = String(call[0] ?? "");
      expect(line).not.toContain(header);
      expect(line).not.toContain(payload);
    }
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

  it("updates allowed origins only on the active Environment-owned key", async () => {
    const prisma = accessKeyPrisma();
    prisma.accessKey.updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const auth = new AuthService(prisma, {} as any);
    auth.authorizeEnvironmentOperatorScope = async () => ({ environmentId: "env_1" } as any);

    await auth.setAllowedOrigins(
      {
        organizationId: "org_1",
        projectId: "proj_1",
        environmentId: "env_1",
        userId: "user_1",
        principal: "operator",
      } as any,
      ["https://app.example"],
    );

    expect(prisma.accessKey.updateMany).toHaveBeenCalledWith({
      where: { environmentId: "env_1", revokedAt: null, validUntil: null },
      data: { allowedOrigins: ["https://app.example"] },
    });
  });

  it("revokes every active or overlap AccessKey in the authorized Environment", async () => {
    const prisma = accessKeyPrisma();
    prisma.accessKey.updateMany = vi.fn().mockResolvedValue({ count: 2 });
    const auth = new AuthService(prisma, {} as any);
    auth.authorizeEnvironmentOperatorScope = async () => ({ environmentId: "env_1" } as any);

    await auth.deleteAccessKey({
      organizationId: "org_1",
      projectId: "proj_1",
      environmentId: "env_1",
      userId: "user_1",
      principal: "operator",
    } as any);

    expect(prisma.accessKey.updateMany).toHaveBeenCalledWith({
      where: { environmentId: "env_1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
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
      environmentEntityTool: {
        deleteMany: vi.fn(),
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

  function toolRegistry() {
    const apply = vi.fn(() => ({ bucketsEvicted: 1 }));
    return {
      apply,
      registry: {
        prepareEntityEviction: vi.fn(() => ({
          entityPk: cleanEntity.id,
          bucketsEvicted: 1,
          apply,
        })),
        rebuildIndex: vi.fn(),
      },
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

  it("accepts the canonical Entity UUID while retaining externalId compatibility", async () => {
    const prisma = entityPrisma();
    const canonicalId = "11111111-1111-4111-8111-111111111111";
    prisma.entity.findFirst.mockResolvedValue({ ...cleanEntity, id: canonicalId });
    const auth = new AuthService(prisma, {} as any, undefined, secretStore() as any);

    const result = await auth.getEntity("org_1", "proj_1", canonicalId);

    expect(prisma.entity.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          projectId: "proj_1",
          id: canonicalId,
          project: { organizationId: "org_1" },
        },
      }),
    );
    expect(result).toMatchObject({ id: canonicalId, entityId: "support-core" });
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
    prisma.entity.findFirst.mockResolvedValue({
      id: cleanEntity.id,
      externalId: cleanEntity.externalId,
    });
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
      externalId: cleanEntity.externalId,
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

  it("atomically revokes credentials, removes mappings, and deletes the Entity before cache eviction", async () => {
    const prisma = entityPrisma();
    prisma.entity.findFirst.mockResolvedValue({
      id: cleanEntity.id,
      externalId: cleanEntity.externalId,
    });
    prisma.entity.deleteMany.mockResolvedValue({ count: 1 });
    prisma.environmentEntityTool.deleteMany.mockResolvedValue({ count: 2 });
    const tools = toolRegistry();
    const auth = new AuthService(
      prisma,
      {} as any,
      tools.registry as any,
      secretStore() as any,
    );

    await expect(auth.deleteEntity("org_1", "proj_1", "support-core")).resolves.toBe(true);
    expect(tools.registry.prepareEntityEviction).toHaveBeenCalledWith(cleanEntity.id);
    expect(prisma.credential.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        kind: "ENTITY_SECRET",
        name: "support-core",
        environment: { projectId: "proj_1", project: { organizationId: "org_1" } },
      }),
      data: { revokedAt: expect.any(Date) },
    });
    expect(prisma.environmentEntityTool.deleteMany).toHaveBeenCalledWith({
      where: { entityId: cleanEntity.id },
    });
    expect(prisma.entity.deleteMany).toHaveBeenCalledWith({
      where: {
        id: cleanEntity.id,
        projectId: "proj_1",
        project: { organizationId: "org_1" },
      },
    });
    expect(tools.apply).toHaveBeenCalledOnce();
  });

  it("does not start a database transaction when registry eviction cannot be prepared", async () => {
    const prisma = entityPrisma();
    prisma.entity.findFirst.mockResolvedValue({
      id: cleanEntity.id,
      externalId: cleanEntity.externalId,
    });
    const tools = toolRegistry();
    tools.registry.prepareEntityEviction.mockImplementation(() => {
      throw new Error("index build failed");
    });
    const auth = new AuthService(prisma, {} as any, tools.registry as any);

    await expect(
      auth.deleteEntity("org_1", "proj_1", "support-core"),
    ).rejects.toThrow("index build failed");
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.credential.updateMany).not.toHaveBeenCalled();
    expect(prisma.environmentEntityTool.deleteMany).not.toHaveBeenCalled();
    expect(prisma.entity.deleteMany).not.toHaveBeenCalled();
  });

  it("does not evict cache/index when the entity transaction fails", async () => {
    const prisma = entityPrisma();
    prisma.entity.findFirst.mockResolvedValue({
      id: cleanEntity.id,
      externalId: cleanEntity.externalId,
    });
    prisma.$transaction.mockRejectedValue(new Error("transaction failed"));
    const tools = toolRegistry();
    const auth = new AuthService(prisma, {} as any, tools.registry as any);

    await expect(
      auth.deleteEntity("org_1", "proj_1", "support-core"),
    ).rejects.toThrow("transaction failed");
    expect(tools.apply).not.toHaveBeenCalled();
    expect(tools.registry.rebuildIndex).not.toHaveBeenCalled();
  });

  it("returns success after recovering a post-commit eviction failure from canonical DB", async () => {
    const prisma = entityPrisma();
    prisma.entity.findFirst.mockResolvedValue({
      id: cleanEntity.id,
      externalId: cleanEntity.externalId,
    });
    prisma.environmentEntityTool.deleteMany.mockResolvedValue({ count: 1 });
    prisma.entity.deleteMany.mockResolvedValue({ count: 1 });
    const tools = toolRegistry();
    tools.apply.mockImplementation(() => {
      throw new Error("cache swap failed");
    });
    const auth = new AuthService(prisma, {} as any, tools.registry as any);

    await expect(
      auth.deleteEntity("org_1", "proj_1", "support-core"),
    ).resolves.toBe(true);
    expect(tools.registry.rebuildIndex).toHaveBeenCalledOnce();
  });

  it("fails loudly only when post-commit eviction and canonical recovery both fail", async () => {
    const prisma = entityPrisma();
    prisma.entity.findFirst.mockResolvedValue({
      id: cleanEntity.id,
      externalId: cleanEntity.externalId,
    });
    prisma.environmentEntityTool.deleteMany.mockResolvedValue({ count: 1 });
    prisma.entity.deleteMany.mockResolvedValue({ count: 1 });
    const tools = toolRegistry();
    tools.apply.mockImplementation(() => {
      throw new Error("cache swap failed");
    });
    tools.registry.rebuildIndex.mockRejectedValue(new Error("rebuild failed"));
    const auth = new AuthService(prisma, {} as any, tools.registry as any);

    await expect(
      auth.deleteEntity("org_1", "proj_1", "support-core"),
    ).rejects.toThrow("entity_deleted_but_registry_recovery_failed");
    expect(tools.registry.rebuildIndex).toHaveBeenCalledOnce();
  });

  it("returns false for an unknown Entity without touching registry or persistence", async () => {
    const prisma = entityPrisma();
    prisma.entity.findFirst.mockResolvedValue(null);
    const tools = toolRegistry();
    const auth = new AuthService(prisma, {} as any, tools.registry as any);

    await expect(
      auth.deleteEntity("org_1", "proj_1", "missing"),
    ).resolves.toBe(false);
    expect(tools.registry.prepareEntityEviction).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
