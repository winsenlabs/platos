import { describe, expect, it } from "vitest";
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
      deleteMany: async ({ where }: any) => {
        const before = mappings.length;
        const keepIds = new Set(where.id?.notIn ?? []);
        for (let i = mappings.length - 1; i >= 0; i -= 1) {
          const row = mappings[i]!;
          if (
            row.environmentId === where.environmentId &&
            row.entityId === where.entityId &&
            (!where.id?.notIn || !keepIds.has(row.id))
          ) {
            mappings.splice(i, 1);
          }
        }
        return { count: before - mappings.length };
      },
    },
  };

  const prisma: any = {
    state: { tools, mappings, entity, bindings },
    $transaction: async (fn: (client: any) => unknown) => fn(tx),
    entity: {
      findFirst: async ({ where }: any) =>
        where.id === entity.id &&
        where.externalId === entity.externalId &&
        where.projectId === entity.projectId
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
      deleteMany: async ({ where }: any) => {
        const before = mappings.length;
        const ids = where.id?.in ? new Set(where.id.in) : null;
        for (let i = mappings.length - 1; i >= 0; i -= 1) {
          const row = mappings[i]!;
          if (
            (where.entityId === undefined || row.entityId === where.entityId) &&
            (where.environmentId === undefined ||
              row.environmentId === where.environmentId) &&
            (!ids || ids.has(row.id))
          ) {
            mappings.splice(i, 1);
          }
        }
        return { count: before - mappings.length };
      },
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

  it("purges mappings, cache buckets, and BM25 documents on entity deletion", async () => {
    const { prisma, declare } = makeDatabase();
    const service = new ToolRegistryService(prisma);
    await declare(service, [tool("a"), tool("b")]);

    await expect(service.purgeEntity("entity-pk")).resolves.toEqual({
      mappingsRemoved: 2,
      bucketsEvicted: 1,
    });
    expect(prisma.state.mappings).toEqual([]);
    expect(service.getScopedTools(SCOPE)).toEqual([]);
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
