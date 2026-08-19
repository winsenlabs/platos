import { describe, expect, it } from "vitest";
import { AuthService } from "../auth/auth.service";
import { ToolRegistryService, type ToolSchema } from "./tool-registry.service";

const SCOPE = {
  organizationId: "org-1",
  projectId: "project-1",
  environmentId: "env-1",
};

type ToolRow = {
  id: string;
  name: string;
  description: string;
  paramSchema: Record<string, unknown>;
  category: string | null;
  schemaHash: string;
};
type MappingRow = {
  id: string;
  environmentId: string;
  entityId: string;
  toolId: string;
  enabled: boolean;
  callbackUrl: string | null;
};

function makeDatabase(options: { callbackUrl?: string | null } = {}) {
  const tools: ToolRow[] = [];
  const mappings: MappingRow[] = [];
  const entity = {
    id: "entity-pk",
    externalId: "entity-a",
    projectId: SCOPE.projectId,
    connectionKind: "wire",
    project: { organizationId: SCOPE.organizationId },
    mcpConfig: { injectMcpContext: false },
    mcpClient: null,
  };
  const bindings = [
    {
      environmentId: SCOPE.environmentId,
      agentId: "agent-allowed",
      activeAgentVersion: { toolDefaultPolicy: "ALL", toolPolicies: [] },
    },
    {
      environmentId: SCOPE.environmentId,
      agentId: "agent-denied",
      activeAgentVersion: { toolDefaultPolicy: "NONE", toolPolicies: [] },
    },
  ];

  const materialize = (mapping: MappingRow) => ({
    ...mapping,
    tool: tools.find((tool) => tool.id === mapping.toolId)!,
    entity,
    environment: { projectId: SCOPE.projectId },
  });
  const state = {
    tools,
    mappings,
    entity,
    bindings,
    entityDeleted: false,
    credentialsRevoked: false,
    failEntityDelete: false,
  };
  const deleteMappings = (where: any) => {
    const before = mappings.length;
    const keepIds = where.id?.notIn ? new Set(where.id.notIn) : null;
    const ids = where.id?.in ? new Set(where.id.in) : null;
    for (let i = mappings.length - 1; i >= 0; i -= 1) {
      const row = mappings[i]!;
      if (
        (where.entityId === undefined || row.entityId === where.entityId) &&
        (where.environmentId === undefined || row.environmentId === where.environmentId) &&
        (!keepIds || !keepIds.has(row.id)) &&
        (!ids || ids.has(row.id))
      ) {
        mappings.splice(i, 1);
      }
    }
    return { count: before - mappings.length };
  };
  const tx: any = {
    tool: {
      upsert: async ({ where, create }: any) => {
        const key = where.name_schemaHash;
        let row = tools.find(
          (tool) => tool.name === key.name && tool.schemaHash === key.schemaHash,
        );
        if (!row) {
          row = { ...create, id: `tool-${tools.length + 1}` };
          tools.push(row!);
        }
        return { ...row };
      },
    },
    environmentEntityTool: {
      upsert: async ({ where, update, create }: any) => {
        const key = where.environmentId_entityId_toolId;
        let row = mappings.find(
          (mapping) =>
            mapping.environmentId === key.environmentId &&
            mapping.entityId === key.entityId &&
            mapping.toolId === key.toolId,
        );
        if (row) Object.assign(row, update);
        else {
          row = { ...create, id: `mapping-${mappings.length + 1}` };
          mappings.push(row!);
        }
        return { ...row };
      },
      deleteMany: async ({ where }: any) => deleteMappings(where),
    },
    credential: {
      updateMany: async () => {
        state.credentialsRevoked = true;
        return { count: 1 };
      },
    },
    entity: {
      deleteMany: async () => {
        if (state.failEntityDelete) throw new Error("entity delete failed");
        if (state.entityDeleted) return { count: 0 };
        state.entityDeleted = true;
        return { count: 1 };
      },
    },
  };

  const prisma: any = {
    state,
    $transaction: async (fn: (client: any) => unknown) => {
      const mappingSnapshot = mappings.map((mapping) => ({ ...mapping }));
      const entityDeletedSnapshot = state.entityDeleted;
      const credentialsRevokedSnapshot = state.credentialsRevoked;
      try {
        return await fn(tx);
      } catch (error) {
        mappings.splice(0, mappings.length, ...mappingSnapshot);
        state.entityDeleted = entityDeletedSnapshot;
        state.credentialsRevoked = credentialsRevokedSnapshot;
        throw error;
      }
    },
    entity: {
      findFirst: async ({ where }: any) =>
        !state.entityDeleted &&
        (where.id === undefined || where.id === entity.id) &&
        (where.externalId === undefined || where.externalId === entity.externalId) &&
        (where.projectId === undefined || where.projectId === entity.projectId)
          ? entity
          : null,
    },
    environment: {
      findFirst: async ({ where }: any) =>
        where.id === SCOPE.environmentId && where.projectId === SCOPE.projectId
          ? { id: SCOPE.environmentId }
          : null,
    },
    agentBinding: {
      findMany: async ({ where }: any) =>
        bindings.filter((binding) =>
          typeof where.environmentId === "string"
            ? binding.environmentId === where.environmentId
            : where.environmentId.in.includes(binding.environmentId),
        ),
    },
    environmentEntityTool: {
      findMany: async ({ where }: any = {}) => {
        const selected = mappings.filter(
          (mapping) =>
            (!where?.entityId || mapping.entityId === where.entityId) &&
            (!where?.environmentId || mapping.environmentId === where.environmentId),
        );
        return selected.map(materialize);
      },
      update: async ({ where, data }: any) => {
        const key = where.environmentId_entityId_toolId;
        const row = mappings.find(
          (mapping) =>
            mapping.environmentId === key.environmentId &&
            mapping.entityId === key.entityId &&
            mapping.toolId === key.toolId,
        );
        if (!row) throw new Error("mapping missing");
        Object.assign(row, data);
        return { ...row };
      },
      deleteMany: async ({ where }: any) => deleteMappings(where),
    },
  };

  async function declare(service: ToolRegistryService, declaration: ToolSchema[]) {
    return service.registerTools(
      {
        ...SCOPE,
        entityPk: entity.id,
        sourceEntityId: entity.externalId,
      },
      declaration,
      options.callbackUrl === undefined
        ? "https://entity.example/tools"
        : options.callbackUrl,
    );
  }

  return { prisma, declare };
}

const tool = (name: string): ToolSchema => ({
  name,
  description: `${name} description`,
  paramSchema: { type: "object", properties: { query: { type: "string" } } },
});

describe("ToolRegistryService clean tenancy cutover", () => {
  it("initializes successfully on a clean database", async () => {
    const { prisma } = makeDatabase();
    const service = new ToolRegistryService(prisma);
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(service.getIndexStats()).toMatchObject({
      totalDocs: 0,
      cachedScopeEntityPairs: 0,
    });
  });

  it("treats registration as declarative replacement and shrinks cache/index", async () => {
    const { prisma, declare } = makeDatabase();
    const service = new ToolRegistryService(prisma);
    await service.rebuildIndex();

    await declare(service, [tool("a"), tool("b")]);
    expect(service.getScopedTools(SCOPE).map((entry) => entry.toolName)).toEqual([
      "a",
      "b",
    ]);
    expect(service.getIndexStats().totalDocs).toBe(2);

    await declare(service, [tool("b")]);
    expect(prisma.state.mappings).toHaveLength(1);
    expect(service.getScopedTools(SCOPE).map((entry) => entry.toolName)).toEqual([
      "b",
    ]);
    expect(service.findTools("a description", SCOPE).map((entry) => entry.toolName)).not.toContain("a");
    expect(service.getIndexStats().totalDocs).toBe(1);
  });

  it("prepares cache-only eviction, then removes every bucket and BM25 document", async () => {
    const { prisma, declare } = makeDatabase();
    const service = new ToolRegistryService(prisma);
    await declare(service, [tool("a"), tool("b")]);

    const eviction = service.prepareEntityEviction("entity-pk");
    expect(eviction).toMatchObject({
      entityPk: "entity-pk",
      bucketsEvicted: 1,
    });
    expect(prisma.state.mappings).toHaveLength(2);
    expect(service.getScopedTools(SCOPE)).toHaveLength(2);
    expect(service.getIndexStats().totalDocs).toBe(2);

    await prisma.environmentEntityTool.deleteMany({ where: { entityId: "entity-pk" } });
    expect(eviction.apply()).toEqual({ bucketsEvicted: 1 });
    expect(prisma.state.mappings).toEqual([]);
    expect(service.getScopedTools(SCOPE)).toEqual([]);
    expect(service.findTools("a description", SCOPE)).toEqual([]);
    expect(service.getIndexStats()).toMatchObject({
      totalDocs: 0,
      cachedScopeEntityPairs: 0,
    });
  });

  it("does not publish a stale rebuild snapshot after entity deletion", async () => {
    const { prisma, declare } = makeDatabase();
    const service = new ToolRegistryService(prisma);
    await declare(service, [tool("a")]);

    const findMany = prisma.environmentEntityTool.findMany;
    let snapshotRead!: () => void;
    const snapshotWasRead = new Promise<void>((resolve) => {
      snapshotRead = resolve;
    });
    let releaseSnapshot!: () => void;
    const snapshotBarrier = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    let blockFirstRead = true;
    let rebuildReads = 0;
    prisma.environmentEntityTool.findMany = async (args: any) => {
      rebuildReads += 1;
      const snapshot = await findMany(args);
      if (blockFirstRead) {
        blockFirstRead = false;
        snapshotRead();
        await snapshotBarrier;
      }
      return snapshot;
    };

    const staleRebuild = service.rebuildIndex();
    await snapshotWasRead;
    const auth = new AuthService(prisma, {} as any, service);
    await expect(
      auth.deleteEntity(SCOPE.organizationId, SCOPE.projectId, "entity-a"),
    ).resolves.toBe(true);
    releaseSnapshot();
    await staleRebuild;

    expect(rebuildReads).toBe(2);
    expect(prisma.state.mappings).toEqual([]);
    expect(service.getScopedTools(SCOPE)).toEqual([]);
    expect(service.findTools("a description", SCOPE)).toEqual([]);
    expect(service.getIndexStats()).toMatchObject({
      totalDocs: 0,
      cachedScopeEntityPairs: 0,
    });
  });

  it("allows the same external id to be recreated under a different entity PK", async () => {
    const { prisma, declare } = makeDatabase();
    const service = new ToolRegistryService(prisma);
    await declare(service, [tool("old")]);
    const auth = new AuthService(prisma, {} as any, service);
    await auth.deleteEntity(SCOPE.organizationId, SCOPE.projectId, "entity-a");

    prisma.state.entity.id = "entity-pk-recreated";
    prisma.state.entityDeleted = false;
    await declare(service, [tool("new")]);

    expect(service.getScopedTools(SCOPE).map((entry) => entry.entityPk)).toEqual([
      "entity-pk-recreated",
    ]);
    expect(service.findTools("new description", SCOPE).map((entry) => entry.toolName)).toEqual([
      "new",
    ]);
  });

  it("rolls back persisted mappings and credentials and leaves cache/index live when deletion fails", async () => {
    const { prisma, declare } = makeDatabase();
    const service = new ToolRegistryService(prisma);
    await declare(service, [tool("a"), tool("b")]);
    prisma.state.failEntityDelete = true;
    const auth = new AuthService(prisma, {} as any, service);

    await expect(
      auth.deleteEntity(SCOPE.organizationId, SCOPE.projectId, "entity-a"),
    ).rejects.toThrow("entity delete failed");
    expect(prisma.state.entityDeleted).toBe(false);
    expect(prisma.state.credentialsRevoked).toBe(false);
    expect(prisma.state.mappings).toHaveLength(2);
    expect(service.getScopedTools(SCOPE).map((entry) => entry.toolName)).toEqual([
      "a",
      "b",
    ]);
    expect(service.findTools("a description", SCOPE).map((entry) => entry.toolName)).toContain(
      "a",
    );
    expect(service.getIndexStats().totalDocs).toBe(2);
  });

  it("commits entity, credential, and mapping deletion before removing all dispatchable state", async () => {
    const { prisma, declare } = makeDatabase();
    const service = new ToolRegistryService(prisma);
    await declare(service, [tool("a"), tool("b")]);
    const auth = new AuthService(prisma, {} as any, service);

    await expect(
      auth.deleteEntity(SCOPE.organizationId, SCOPE.projectId, "entity-a"),
    ).resolves.toBe(true);
    expect(prisma.state.entityDeleted).toBe(true);
    expect(prisma.state.credentialsRevoked).toBe(true);
    expect(prisma.state.mappings).toEqual([]);
    expect(service.getScopedTools(SCOPE)).toEqual([]);
    expect(service.findTools("a description", SCOPE)).toEqual([]);
    expect(service.getIndexStats()).toMatchObject({
      totalDocs: 0,
      cachedScopeEntityPairs: 0,
    });
  });

  it("rebuild replaces state and never indexes a non-dispatchable mapping", async () => {
    const { prisma, declare } = makeDatabase({ callbackUrl: null });
    const service = new ToolRegistryService(prisma);
    await declare(service, [tool("socket-only")]);
    expect(service.getIndexStats().totalDocs).toBe(1);

    await service.rebuildIndex();
    expect(service.getScopedTools(SCOPE)).toEqual([]);
    expect(service.getScopedTools(SCOPE, { enabledOnly: false })).toHaveLength(1);
    expect(service.getIndexStats().totalDocs).toBe(0);

    prisma.state.mappings.splice(0);
    await service.rebuildIndex();
    expect(service.getIndexStats()).toMatchObject({
      totalDocs: 0,
      cachedScopeEntityPairs: 0,
    });
  });

  it("uses AgentToolPolicy/default policy for direct and meta-tool visibility", async () => {
    const { prisma, declare } = makeDatabase();
    const service = new ToolRegistryService(prisma);
    await declare(service, [tool("search")]);

    expect(
      service.getScopedTools(SCOPE, { agentId: "agent-allowed" }).map((x) => x.toolName),
    ).toEqual(["search"]);
    expect(
      service.findTools("search", SCOPE, 15, undefined, "agent-allowed").map(
        (x) => x.toolName,
      ),
    ).toEqual(["search"]);
    expect(service.getScopedTools(SCOPE, { agentId: "agent-denied" })).toEqual([]);
    expect(service.findTools("search", SCOPE, 15, undefined, "agent-denied")).toEqual([]);

    prisma.state.bindings[1].activeAgentVersion.toolPolicies = [
      { toolId: prisma.state.tools[0].id, effect: "ALLOW" },
    ];
    await expect(service.refreshEnvironmentPolicies(SCOPE)).resolves.toBe(1);
    expect(
      service.getScopedTools(SCOPE, { agentId: "agent-denied" }).map((x) => x.toolName),
    ).toEqual(["search"]);
  });

  it("returns deterministic name ordering regardless of declaration order", async () => {
    const { prisma, declare } = makeDatabase();
    const service = new ToolRegistryService(prisma);
    await declare(service, [tool("zeta"), tool("alpha"), tool("middle")]);
    expect(service.getScopedTools(SCOPE).map((entry) => entry.toolName)).toEqual([
      "alpha",
      "middle",
      "zeta",
    ]);
  });
});
