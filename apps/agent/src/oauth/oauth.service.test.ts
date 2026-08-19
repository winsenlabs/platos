import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthService } from "./oauth.service";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function createPrisma() {
  const prisma: any = {
    entity: { findUnique: vi.fn() },
    environment: { findFirst: vi.fn() },
    organizationMembership: { findFirst: vi.fn() },
    oAuthClient: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    oAuthAuthorizationCode: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    oAuthConsentTransaction: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    oAuthAccessToken: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    oAuthRefreshToken: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    mcpAnonymousSession: { findFirst: vi.fn() },
    mcpOidcSession: { findFirst: vi.fn() },
  };
  prisma.$transaction = vi.fn(async (arg: any) =>
    Array.isArray(arg) ? Promise.all(arg) : arg(prisma),
  );
  return prisma;
}

const scope = {
  organizationId: "10000000-0000-4000-8000-000000000001",
  projectId: "20000000-0000-4000-8000-000000000001",
  environmentId: "30000000-0000-4000-8000-000000000001",
};
const userId = "40000000-0000-4000-8000-000000000001";
const entityId = "50000000-0000-4000-8000-000000000001";
const clientDbId = "60000000-0000-4000-8000-000000000001";

function mockCanonicalScope(prisma: ReturnType<typeof createPrisma>) {
  prisma.environment.findFirst.mockResolvedValue({
    id: scope.environmentId,
    project: { id: scope.projectId, organizationId: scope.organizationId },
  });
}

describe("OAuthService clean entity lifecycle", () => {
  let prisma: ReturnType<typeof createPrisma>;
  let service: OAuthService;

  beforeEach(() => {
    prisma = createPrisma();
    service = new OAuthService(prisma);
  });

  it("registers an entity client through canonical Organization/User/Entity relations", async () => {
    prisma.entity.findUnique.mockResolvedValue({
      project: { organizationId: scope.organizationId },
    });
    prisma.organizationMembership.findFirst.mockResolvedValue({ userId });
    prisma.oAuthClient.create.mockImplementation(async ({ data }: any) => ({
      ...data,
      id: clientDbId,
      createdAt: new Date("2026-08-15T00:00:00.000Z"),
    }));

    const result = await service.register({
      clientName: "Claude",
      redirectUris: ["https://client.example/callback"],
      tokenEndpointAuthMethod: "none",
      scope: "mcp:tools",
      organizationId: scope.organizationId,
      entityPk: entityId,
    });

    expect(result.client_id).toMatch(/^plt_oac_/);
    expect(result).not.toHaveProperty("client_secret");
    expect(prisma.oAuthClient.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: scope.organizationId,
        registeredByUserId: userId,
        entityId,
        scopes: ["mcp:tools"],
      }),
    });
    expect(JSON.stringify(prisma.oAuthClient.create.mock.calls[0][0])).not.toContain(
      "anonymous",
    );
  });

  it("rejects caller-defined privileged labels during dynamic registration", async () => {
    prisma.entity.findUnique.mockResolvedValue({
      project: { organizationId: scope.organizationId },
    });
    prisma.organizationMembership.findFirst.mockResolvedValue({ userId });

    await expect(service.register({
      clientName: "Untrusted client",
      redirectUris: ["https://client.example/callback"],
      scope: "mcp:tools admin:all",
      organizationId: scope.organizationId,
      entityPk: entityId,
    })).rejects.toMatchObject({ code: "invalid_client_metadata" });
    expect(prisma.oAuthClient.create).not.toHaveBeenCalled();
  });

  it("persists exact effective consent scopes and rejects tamper and replay", async () => {
    mockCanonicalScope(prisma);
    prisma.oAuthClient.findUnique.mockResolvedValue({
      id: clientDbId,
      clientId: "client_1",
      entityId,
      organizationId: scope.organizationId,
      redirectUris: ["https://client.example/callback"],
      scopes: ["mcp:tools"],
      deletedAt: null,
    });
    prisma.oAuthConsentTransaction.create.mockResolvedValue({});

    const transaction = await service.createConsentTransaction({
      clientId: "client_1",
      redirectUri: "https://client.example/callback",
      codeChallenge: "challenge",
      codeChallengeMethod: "S256",
      scopes: ["mcp:tools"],
      scopeTuple: scope,
      entityPk: entityId,
      state: "state_1",
    });
    expect(prisma.oAuthConsentTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        scopes: ["mcp:tools"],
        entityId,
        environmentId: scope.environmentId,
        state: "state_1",
      }),
    });
    await expect(service.inspectConsentTransaction(`${transaction}tampered`)).resolves.toBeNull();

    const persisted = {
      id: "consent_1",
      tokenHash: "hash",
      clientId: clientDbId,
      redirectUri: "https://client.example/callback",
      codeChallenge: "challenge",
      codeChallengeMethod: "S256",
      scopes: ["mcp:tools"],
      entityId,
      ...scope,
      state: "state_1",
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      client: { clientId: "client_1", registeredByUserId: userId, deletedAt: null },
    };
    prisma.oAuthConsentTransaction.findUnique.mockResolvedValue(persisted);
    prisma.oAuthConsentTransaction.updateMany.mockResolvedValueOnce({ count: 1 });
    await expect(service.consumeConsentTransaction(transaction)).resolves.toMatchObject({ id: "consent_1" });
    prisma.oAuthConsentTransaction.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.consumeConsentTransaction(transaction)).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("hashes authorization codes and persists normalized scope columns", async () => {
    mockCanonicalScope(prisma);
    prisma.oAuthClient.findUnique.mockResolvedValue({
      id: clientDbId,
      organizationId: scope.organizationId,
      entityId,
      deletedAt: null,
      redirectUris: ["https://client.example/callback"],
      scopes: ["mcp:tools"],
    });
    prisma.organizationMembership.findFirst.mockResolvedValue({ userId });

    const result = await service.issueAuthCode({
      clientId: "plt_oac_client",
      userId,
      scopeTuple: scope,
      codeChallenge: "challenge",
      codeChallengeMethod: "S256",
      redirectUri: "https://client.example/callback",
      scopes: ["mcp:tools"],
      entityPk: entityId,
      mcpIdentity: {
        kind: "anonymous",
        sessionId: "70000000-0000-4000-8000-000000000001",
      },
    });

    const create = prisma.oAuthAuthorizationCode.create.mock.calls[0][0].data;
    expect(result.code).toMatch(/^plt_ocd_/);
    expect(create).not.toHaveProperty("code");
    expect(create.codeHash).toBe(sha256(result.code));
    expect(create).toMatchObject({
      clientId: clientDbId,
      userId,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      scopeKind: "ENVIRONMENT",
    });
    expect(create.scopes).toContain(
      "platos:mcp-identity:anonymous:70000000-0000-4000-8000-000000000001",
    );
  });

  it("rejects authorization scopes the client did not register", async () => {
    mockCanonicalScope(prisma);
    prisma.oAuthClient.findUnique.mockResolvedValue({
      id: clientDbId,
      organizationId: scope.organizationId,
      entityId,
      deletedAt: null,
      redirectUris: ["https://client.example/callback"],
      scopes: ["mcp:tools"],
    });

    await expect(
      service.issueAuthCode({
        clientId: "plt_oac_client",
        userId,
        scopeTuple: scope,
        codeChallenge: "challenge",
        codeChallengeMethod: "S256",
        redirectUri: "https://client.example/callback",
        scopes: ["mcp:write"],
        entityPk: entityId,
      }),
    ).rejects.toMatchObject({ code: "invalid_scope" });
    expect(prisma.oAuthAuthorizationCode.create).not.toHaveBeenCalled();
  });

  it("rotates a refresh token atomically with family and parent lineage", async () => {
    prisma.oAuthRefreshToken.findUnique.mockResolvedValue({
      id: "70000000-0000-4000-8000-000000000001",
      clientId: clientDbId,
      userId,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      scopes: ["mcp:tools"],
      rotationFamilyId: "80000000-0000-4000-8000-000000000001",
      consumedAt: null,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      client: { clientId: "plt_oac_client", entityId },
    });
    prisma.oAuthRefreshToken.updateMany.mockResolvedValue({ count: 1 });
    prisma.oAuthAccessToken.create.mockResolvedValue({
      id: "90000000-0000-4000-8000-000000000001",
    });
    prisma.oAuthRefreshToken.create.mockResolvedValue({});

    const result = await service.exchangeRefreshToken({
      clientId: "plt_oac_client",
      refreshToken: "plt_or_original",
    });

    expect(result.accessToken).toMatch(/^plt_oa_/);
    expect(result.refreshToken).toMatch(/^plt_or_/);
    expect(prisma.oAuthRefreshToken.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "70000000-0000-4000-8000-000000000001",
        consumedAt: null,
        revokedAt: null,
      }),
      data: { consumedAt: expect.any(Date) },
    });
    const child = prisma.oAuthRefreshToken.create.mock.calls[0][0].data;
    expect(child).toMatchObject({
      accessTokenId: "90000000-0000-4000-8000-000000000001",
      rotationFamilyId: "80000000-0000-4000-8000-000000000001",
      parentRefreshTokenId: "70000000-0000-4000-8000-000000000001",
      clientId: clientDbId,
    });
    expect(child.tokenHash).toBe(sha256(result.refreshToken));
  });

  it("rejects an entity token exchange through a different environment endpoint", async () => {
    const verifier = "entity-pkce-verifier";
    prisma.oAuthAuthorizationCode.findUnique.mockResolvedValue({
      id: "70000000-0000-4000-8000-000000000002",
      clientId: clientDbId,
      userId,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      scopes: ["mcp:tools"],
      codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
      redirectUri: "https://client.example/callback",
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      client: { clientId: "plt_oac_client", entityId },
    });

    await expect(
      service.exchangeAuthCode({
        clientId: "plt_oac_client",
        code: "plt_ocd_environment_pinned",
        codeVerifier: verifier,
        redirectUri: "https://client.example/callback",
        expectedScope: { ...scope, environmentId: "30000000-0000-4000-8000-000000000002" },
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
    expect(prisma.oAuthAuthorizationCode.updateMany).not.toHaveBeenCalled();
    expect(prisma.oAuthAccessToken.create).not.toHaveBeenCalled();
  });

  it("does not consume a refresh token through a different environment endpoint", async () => {
    prisma.oAuthRefreshToken.findUnique.mockResolvedValue({
      id: "70000000-0000-4000-8000-000000000003",
      clientId: clientDbId,
      userId,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      scopes: ["mcp:tools"],
      rotationFamilyId: "80000000-0000-4000-8000-000000000003",
      consumedAt: null,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      client: { clientId: "plt_oac_client", entityId },
    });

    await expect(
      service.exchangeRefreshToken({
        clientId: "plt_oac_client",
        refreshToken: "plt_or_environment_pinned",
        expectedScope: { ...scope, environmentId: "30000000-0000-4000-8000-000000000002" },
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
    expect(prisma.oAuthRefreshToken.updateMany).not.toHaveBeenCalled();
    expect(prisma.oAuthAccessToken.create).not.toHaveBeenCalled();
  });

  it("revokes an entire refresh family and linked access tokens on replay", async () => {
    prisma.oAuthRefreshToken.findUnique.mockResolvedValue({
      id: "70000000-0000-4000-8000-000000000001",
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      rotationFamilyId: "80000000-0000-4000-8000-000000000001",
      consumedAt: new Date(),
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      client: { clientId: "plt_oac_client", entityId },
    });
    prisma.oAuthRefreshToken.updateMany.mockResolvedValue({ count: 2 });
    prisma.oAuthAccessToken.updateMany.mockResolvedValue({ count: 2 });

    await expect(
      service.exchangeRefreshToken({
        clientId: "plt_oac_client",
        refreshToken: "plt_or_replayed",
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });

    expect(prisma.oAuthRefreshToken.updateMany).toHaveBeenCalledWith({
      where: { rotationFamilyId: "80000000-0000-4000-8000-000000000001" },
      data: { replayDetectedAt: expect.any(Date), revokedAt: expect.any(Date) },
    });
    expect(prisma.oAuthAccessToken.updateMany).toHaveBeenCalledWith({
      where: {
        refreshTokens: {
          some: { rotationFamilyId: "80000000-0000-4000-8000-000000000001" },
        },
        revokedAt: null,
      },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it("resolves anonymous MCP identity without exposing the internal marker as a scope", async () => {
    const raw = "plt_oa_valid";
    prisma.oAuthAccessToken.findUnique.mockResolvedValue({
      tokenHash: sha256(raw),
      userId,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      scopes: [
        "mcp:tools",
        "platos:mcp-identity:anonymous:70000000-0000-4000-8000-000000000001",
      ],
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      client: { clientId: "plt_oac_client", entityId, deletedAt: null },
    });
    prisma.mcpAnonymousSession.findFirst.mockResolvedValue({
      mcpUserId: "mcp:anon:canonical",
    });

    await expect(service.verifyAccessToken(raw)).resolves.toMatchObject({
      userId,
      mcpUserId: "mcp:anon:canonical",
      identityMode: "anonymous",
      scopes: ["mcp:tools"],
      entityPk: entityId,
      scope,
    });
  });
});
