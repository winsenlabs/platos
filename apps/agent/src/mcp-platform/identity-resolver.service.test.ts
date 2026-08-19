import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import { McpIdentityResolverService } from "./identity-resolver.service";

function request(
  headers: Record<string, string> = {},
  query: Record<string, string> = {},
): Request {
  return {
    headers,
    query,
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as Request;
}

function createPrisma() {
  return {
    entityMcpConfig: { findUnique: vi.fn() },
    mcpAnonymousSession: {
      findFirst: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      create: vi.fn(),
    },
    environment: { findMany: vi.fn() },
  } as any;
}

describe("McpIdentityResolverService authentication order", () => {
  let prisma: ReturnType<typeof createPrisma>;
  let bearer: { validate: ReturnType<typeof vi.fn> };
  let service: McpIdentityResolverService;

  beforeEach(() => {
    prisma = createPrisma();
    bearer = { validate: vi.fn() };
    service = new McpIdentityResolverService(prisma, bearer as any);
    prisma.entityMcpConfig.findUnique.mockResolvedValue({
      enabled: true,
      identityMode: "bearer+oidc+anonymous",
    });
  });

  it("validates a plt_ent_ PAT before considering OAuth or anonymous identity", async () => {
    bearer.validate.mockResolvedValue({
      id: "token_1",
      entityPk: "entity_1",
      environmentId: "env_1",
      mcpUserId: "mcp:pat:token_1",
      scopes: ["mcp:tools"],
    });

    await expect(
      service.resolve(
        request({ authorization: "Bearer plt_ent_secret" }),
        "entity_1",
      ),
    ).resolves.toEqual({
      mcpUserId: "mcp:pat:token_1",
      environmentId: "env_1",
      identityMode: "bearer",
      metadata: {
        tokenId: "token_1",
        scopes: ["mcp:tools"],
        environmentId: "env_1",
      },
    });
    expect(prisma.mcpAnonymousSession.create).not.toHaveBeenCalled();
  });

  it("uses an upstream verified OAuth identity before anonymous fallback", async () => {
    const req = request();
    (req as any).mcpIdentity = {
      mcpUserId: "mcp:oidc:user",
      environmentId: "env_1",
      identityMode: "oidc",
      metadata: { clientId: "client_1" },
    };

    await expect(service.resolve(req, "entity_1")).resolves.toEqual(
      (req as any).mcpIdentity,
    );
    expect(prisma.mcpAnonymousSession.create).not.toHaveBeenCalled();
  });

  it("creates an environment-owned anonymous session only when enabled", async () => {
    prisma.environment.findMany.mockResolvedValue([{ id: "env_1" }]);
    prisma.mcpAnonymousSession.create.mockImplementation(async ({ data }: any) => ({
      id: "session_1",
      mcpUserId: data.mcpUserId,
    }));

    const result = await service.resolve(request({}, { environmentId: "env_1" }), "entity_1");

    expect(result).toMatchObject({
      identityMode: "anonymous",
      environmentId: "env_1",
      metadata: { sessionId: "session_1", environmentId: "env_1" },
    });
    expect(prisma.mcpAnonymousSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityId: "entity_1",
        environmentId: "env_1",
        firstSeenIp: "127.0.0.1",
      }),
      select: { id: true, mcpUserId: true },
    });
  });

  it("requires an explicit environment when anonymous scope is ambiguous", async () => {
    await expect(service.resolve(request(), "entity_1")).resolves.toEqual({
      error: "environmentId is required for anonymous MCP authentication",
      status: 400,
    });
    expect(prisma.mcpAnonymousSession.create).not.toHaveBeenCalled();
  });

  it("accepts a canonical anonymous environment selector and verifies ancestry", async () => {
    prisma.environment.findMany.mockResolvedValue([{ id: "env_2" }]);
    prisma.mcpAnonymousSession.create.mockResolvedValue({
      id: "session_2",
      mcpUserId: "mcp:anon:user",
    });

    const req = request();
    (req as any).query = { environmentId: "env_2" };
    const result = await service.resolve(req, "entity_1");
    expect(result).toMatchObject({ environmentId: "env_2" });
    expect(prisma.environment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          project: { entities: { some: { id: "entity_1" } } },
        }),
      }),
    );
  });

  it("rejects anonymous and bearer credentials when their modes are disabled", async () => {
    prisma.entityMcpConfig.findUnique.mockResolvedValue({
      enabled: true,
      identityMode: "oidc",
    });

    await expect(service.resolve(request(), "entity_1")).resolves.toEqual({
      error: "This entity requires authentication",
      status: 401,
    });
    await expect(
      service.resolve(
        request({ authorization: "Bearer plt_ent_secret" }),
        "entity_1",
      ),
    ).resolves.toEqual({
      error: "Bearer tokens not enabled for this entity",
      status: 403,
    });
    expect(bearer.validate).not.toHaveBeenCalled();
  });
});
