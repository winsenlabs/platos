import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpToolAclService } from "./mcp-tool-acl.service";

function createPrisma() {
  const prisma: any = {
    environmentEntityTool: { count: vi.fn(), findMany: vi.fn() },
    entityToolPolicy: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    entityMcpConfig: { updateMany: vi.fn() },
  };
  prisma.$transaction = vi.fn(async (operation: ((tx: any) => unknown) | Promise<unknown>[]) =>
    Array.isArray(operation) ? Promise.all(operation) : operation(prisma),
  );
  return prisma;
}

describe("McpToolAclService clean policy cutover", () => {
  let prisma: ReturnType<typeof createPrisma>;
  let service: McpToolAclService;

  beforeEach(() => {
    prisma = createPrisma();
    service = new McpToolAclService(prisma);
    prisma.environmentEntityTool.count.mockResolvedValue(1);
    prisma.entityToolPolicy.findMany.mockResolvedValue([]);
    prisma.entityMcpConfig.updateMany.mockResolvedValue({ count: 1 });
  });

  it("lists enabled EnvironmentEntityTool rows as default-deny policies", async () => {
    prisma.environmentEntityTool.findMany.mockResolvedValue([
      { id: "mapping_1", toolId: "tool_1", tool: { name: "calendar.create" } },
    ]);

    await expect(service.list("entity_1", "env_1")).resolves.toEqual({
      total: 1,
      limit: 200,
      offset: 0,
      tools: [{
        id: "mapping_1",
        entityPk: "entity_1",
        toolId: "mapping_1",
        toolName: "calendar.create",
        exposed: false,
        minIdentityMode: "bearer",
        allowedPatIds: [],
        scopeLabels: ["mcp:tools"],
        addedAt: null,
        lastReviewedAt: null,
      }],
    });
    expect(prisma.environmentEntityTool.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { entityId: "entity_1", environmentId: "env_1", enabled: true },
        orderBy: [{ tool: { name: "asc" } }, { id: "asc" }],
        skip: 0,
        take: 200,
      }),
    );
    expect(prisma.environmentEntityTool.count).toHaveBeenCalledWith({
      where: { entityId: "entity_1", environmentId: "env_1", enabled: true },
    });
  });

  it("stores PAT restrictions as internal labels without treating them as OAuth scopes", async () => {
    prisma.entityToolPolicy.findUnique.mockResolvedValue({
      scopeLabels: ["mcp:tools"],
    });
    prisma.entityToolPolicy.upsert.mockResolvedValue({
      id: "policy_1",
      entityId: "entity_1",
      toolId: "tool_1",
      effect: "ALLOW",
      minIdentityMode: "bearer",
      scopeLabels: ["mcp:tools", "platos:pat:pat_1"],
      addedBy: "user_1",
      addedAt: new Date("2026-08-15T00:00:00.000Z"),
      lastReviewedAt: null,
      tool: { name: "calendar.create" },
    });
    prisma.entityToolPolicy.findMany.mockResolvedValue([
      { tool: { name: "calendar.create" } },
    ]);

    const row = await service.upsert(
      "entity_1",
      "env_1",
      "tool_1",
      "calendar.create",
      "user_1",
      { exposed: true, allowedPatIds: ["pat_1"] },
    );

    expect(prisma.entityToolPolicy.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { environmentId_entityId_toolId: { environmentId: "env_1", entityId: "entity_1", toolId: "tool_1" } },
        update: expect.objectContaining({
          effect: "ALLOW",
          scopeLabels: ["mcp:tools", "platos:pat:pat_1"],
        }),
      }),
    );
    expect(prisma.entityToolPolicy.upsert.mock.calls[0]?.[0]).not.toHaveProperty("include");
    expect(row.toolName).toBe("calendar.create");
    expect(row.allowedPatIds).toEqual(["pat_1"]);
    expect(row.scopeLabels).toEqual(["mcp:tools"]);
  });

  it("denies cross-scope and wrong-PAT callers while allowing a stronger identity", () => {
    const row = {
      id: "policy_1",
      entityPk: "entity_1",
      toolId: "tool_1",
      toolName: "calendar.create",
      exposed: true,
      minIdentityMode: "bearer",
      allowedPatIds: ["pat_1"],
      scopeLabels: ["mcp:tools", "calendar:write"],
      addedAt: new Date(),
      lastReviewedAt: null,
    };

    expect(
      service.filterByIdentity([row], {
        identityMode: "bearer",
        mcpUserId: "mcp:pat:pat_2",
        scopes: ["mcp:tools", "calendar:write"],
      }),
    ).toEqual([]);
    expect(
      service.filterByIdentity([row], {
        identityMode: "bearer",
        mcpUserId: "mcp:pat:pat_1",
        scopes: ["mcp:tools"],
      }),
    ).toEqual([]);
    expect(
      service.filterByIdentity([row], {
        identityMode: "oidc",
        mcpUserId: "mcp:oidc:user",
        scopes: ["mcp:tools", "calendar:write"],
      }),
    ).toEqual([row]);
  });

  it("loads runtime ALLOW rows only from the selected Environment", async () => {
    prisma.entityToolPolicy.findMany.mockResolvedValue([]);

    await expect(
      service.getExposedPoliciesByName("entity_1", "env_selected", "calendar.create"),
    ).resolves.toEqual([]);

    expect(prisma.entityToolPolicy.findMany).toHaveBeenCalledWith({
      where: {
        entityId: "entity_1",
        environmentId: "env_selected",
        effect: "ALLOW",
        tool: { name: "calendar.create" },
      },
      include: { tool: { select: { name: true } } },
    });
  });

  it("bulk mutation resolves only mappings owned by the requested entity", async () => {
    prisma.environmentEntityTool.findMany.mockResolvedValue([
      { toolId: "tool_owned" },
    ]);
    prisma.entityToolPolicy.upsert.mockResolvedValue({});

    await expect(
      service.bulk("entity_1", "env_1", ["mapping_owned", "mapping_foreign"], "expose", {
        addedBy: "user_1",
      }),
    ).resolves.toBe(1);

    expect(prisma.environmentEntityTool.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["mapping_owned", "mapping_foreign"] },
        entityId: "entity_1",
        environmentId: "env_1",
      },
      select: { toolId: true },
    });
    expect(prisma.entityToolPolicy.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          environmentId_entityId_toolId: { environmentId: "env_1", entityId: "entity_1", toolId: "tool_owned" },
        },
      }),
    );
  });

  it("replays the same ACL upsert to one stable policy and allowlist", async () => {
    let policy: any = null;
    let allowlist: string[] = [];
    prisma.entityToolPolicy.findUnique.mockImplementation(async () =>
      policy ? { scopeLabels: [...policy.scopeLabels] } : null,
    );
    prisma.entityToolPolicy.upsert.mockImplementation(async ({ create, update }: any) => {
      policy = policy
        ? { ...policy, ...update }
        : {
            ...create,
            id: "policy_1",
            addedAt: new Date("2026-08-25T00:00:00.000Z"),
            lastReviewedAt: null,
          };
      return { ...policy, tool: { name: "calendar.create" } };
    });
    prisma.entityToolPolicy.findMany.mockImplementation(async () =>
      policy?.effect === "ALLOW" ? [{ tool: { name: "calendar.create" } }] : [],
    );
    prisma.entityMcpConfig.updateMany.mockImplementation(async ({ data }: any) => {
      allowlist = [...data.toolAllowlist];
      return { count: 1 };
    });
    const mutation = {
      exposed: true,
      minIdentityMode: "oidc",
      allowedPatIds: ["pat_1"],
      scopeLabels: ["mcp:tools", "calendar:write"],
    };

    const first = await service.upsert("entity_1", "env_1", "tool_1", "calendar.create", "user_1", mutation);
    const replay = await service.upsert("entity_1", "env_1", "tool_1", "calendar.create", "user_1", mutation);

    expect(replay).toEqual(first);
    expect(policy).toMatchObject({ environmentId: "env_1", entityId: "entity_1", toolId: "tool_1", effect: "ALLOW" });
    expect(allowlist).toEqual(["calendar.create"]);
  });
});
