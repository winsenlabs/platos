import { describe, expect, it, vi } from "vitest";
import type { RequestScope } from "../auth/scope.guard";
import { AgentCrudService } from "./agent-crud.service";

const scope: RequestScope = {
  organizationId: "org-a",
  projectId: "project-a",
  environmentId: "env-a",
  userId: "operator-a",
};

function agentVersion(
  id: string,
  agentId: string,
  versionNumber: number,
  toolDefaultPolicy: "NONE" | "ALL" = "ALL",
) {
  return {
    id,
    agentId,
    versionNumber,
    model: "anthropic:claude-sonnet-4-6",
    systemPrompt: null,
    maxSteps: 20,
    contextLimit: 20,
    toolDefaultPolicy,
    promptBlocks: [],
    dynamicBlocks: [],
    toolsBlockConfig: {},
    modelRoutes: [],
    memoryConfig: {},
    outputSchema: null,
    note: null,
    createdBy: "operator-a",
    createdAt: new Date("2026-08-24T00:00:00.000Z"),
  };
}

function harness(agentADefaultPolicy: "NONE" | "ALL" = "ALL") {
  const versions = [
    agentVersion("version-a", "agent-a", 1, agentADefaultPolicy),
    agentVersion("version-b", "agent-b", 1),
  ];
  const bindings = [
    { id: "binding-a", agentId: "agent-a", activeAgentVersionId: "version-a" },
    { id: "binding-b", agentId: "agent-b", activeAgentVersionId: "version-b" },
  ];
  const policies = [
    { agentVersionId: "version-b", toolId: "tool-a", effect: "ALLOW", priority: 0 },
  ];
  const environmentMapping = {
    environmentId: "env-a",
    entityId: "entity-a",
    toolId: "tool-a",
    enabled: true,
  };
  const bindingFindFirst = vi.fn(async ({ where }: any) => {
    const binding = bindings.find((candidate) =>
      candidate.agentId === where.agentId && where.environmentId === scope.environmentId,
    );
    if (!binding || where.environment?.project?.id !== scope.projectId || where.environment?.project?.organizationId !== scope.organizationId) return null;
    const version = versions.find((candidate) => candidate.id === binding.activeAgentVersionId)!;
    return {
      ...binding,
      environmentId: scope.environmentId,
      canaryAgentVersionId: null,
      canaryPercent: 0,
      clusterId: null,
      createdAt: version.createdAt,
      updatedAt: version.createdAt,
      environment: { id: scope.environmentId, projectId: scope.projectId, project: { id: scope.projectId, organizationId: scope.organizationId } },
      agent: { id: binding.agentId, projectId: scope.projectId, name: binding.agentId, slug: binding.agentId, isActive: true, createdAt: version.createdAt, _count: { threads: 0 } },
      activeAgentVersion: version,
      canaryAgentVersion: null,
      cluster: null,
    };
  });
  const mappingFindFirst = vi.fn(async ({ where }: any) =>
    where.environmentId === scope.environmentId &&
    where.toolId === environmentMapping.toolId &&
    where.environment?.project?.id === scope.projectId &&
    where.environment?.project?.organizationId === scope.organizationId &&
    where.entity?.projectId === scope.projectId &&
    where.entity?.project?.organizationId === scope.organizationId
      ? { toolId: environmentMapping.toolId }
      : null,
  );
  const tx = {
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ id: "binding-a" }]),
    agentBinding: {
      findFirst: bindingFindFirst,
      update: vi.fn(async ({ where, data }: any) => {
        const binding = bindings.find((candidate) => candidate.id === where.id)!;
        Object.assign(binding, data);
        return binding;
      }),
    },
    environmentEntityTool: { findFirst: mappingFindFirst },
    agentVersion: {
      findFirst: vi.fn(async ({ where }: any) => {
        const candidates = versions.filter((candidate) => candidate.agentId === where.agentId);
        return candidates.sort((left, right) => right.versionNumber - left.versionNumber)[0] ?? null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const row = { ...data, id: `version-${versions.length + 1}`, createdAt: new Date("2026-08-24T01:00:00.000Z") };
        versions.push(row);
        return row;
      }),
    },
    agentSkill: {
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn(),
    },
    agentToolPolicy: {
      findMany: vi.fn(async ({ where }: any) => policies
        .filter((policy) => policy.agentVersionId === where.agentVersionId)
        .map(({ toolId, effect, priority }) => ({ toolId, effect, priority }))),
      createMany: vi.fn(async ({ data }: any) => {
        policies.push(...data);
        return { count: data.length };
      }),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  const redis = { del: vi.fn().mockResolvedValue(0) };
  return {
    service: new AgentCrudService(prisma as any, redis as any),
    versions,
    bindings,
    policies,
    environmentMapping,
    tx,
    bindingFindFirst,
    mappingFindFirst,
  };
}

function persistedEnabled(
  bindings: Array<{ agentId: string; activeAgentVersionId: string }>,
  versions: Array<{ id: string; toolDefaultPolicy: "NONE" | "ALL" }>,
  policies: Array<{ agentVersionId: string; toolId: string; effect: string }>,
  agentId: string,
  toolId: string,
) {
  const binding = bindings.find((candidate) => candidate.agentId === agentId)!;
  const version = versions.find((candidate) => candidate.id === binding.activeAgentVersionId)!;
  const policy = policies.find((candidate) => candidate.agentVersionId === version.id && candidate.toolId === toolId);
  return policy ? policy.effect === "ALLOW" : version.toolDefaultPolicy === "ALL";
}

describe("AgentCrudService Agent Tool ownership", () => {
  it("persists read-back on a replacement AgentVersion and isolates the other Agent", async () => {
    const h = harness();

    const result = await h.service.setToolEnabled("agent-a", "tool-a", scope, false);

    expect(result).toEqual({
      agentId: "agent-a",
      agentVersionId: "version-3",
      previousAgentVersionId: "version-a",
      toolId: "tool-a",
      enabled: false,
    });
    expect(h.bindings).toEqual([
      { id: "binding-a", agentId: "agent-a", activeAgentVersionId: "version-3" },
      { id: "binding-b", agentId: "agent-b", activeAgentVersionId: "version-b" },
    ]);
    expect(persistedEnabled(h.bindings, h.versions, h.policies, "agent-a", "tool-a")).toBe(false);
    expect(persistedEnabled(h.bindings, h.versions, h.policies, "agent-b", "tool-a")).toBe(true);
    expect(h.environmentMapping.enabled).toBe(true);
    expect(h.tx.agentToolPolicy.createMany).toHaveBeenCalledWith({
      data: [{ agentVersionId: "version-3", toolId: "tool-a", effect: "DENY", priority: 0 }],
    });
    expect(h.mappingFindFirst).toHaveBeenCalledWith({
      where: {
        environmentId: "env-a",
        toolId: "tool-a",
        environment: { project: { id: "project-a", organizationId: "org-a" } },
        entity: { projectId: "project-a", project: { organizationId: "org-a" } },
      },
      select: { toolId: true },
    });
  });

  it("persists an explicit ALLOW when enabling a Tool from a default-deny AgentVersion", async () => {
    const h = harness("NONE");

    const result = await h.service.setToolEnabled("agent-a", "tool-a", scope, true);

    expect(result).toMatchObject({
      agentId: "agent-a",
      agentVersionId: "version-3",
      previousAgentVersionId: "version-a",
      toolId: "tool-a",
      enabled: true,
    });
    expect(persistedEnabled(h.bindings, h.versions, h.policies, "agent-a", "tool-a")).toBe(true);
    expect(persistedEnabled(h.bindings, h.versions, h.policies, "agent-b", "tool-a")).toBe(true);
    expect(h.environmentMapping.enabled).toBe(true);
    expect(h.tx.agentToolPolicy.createMany).toHaveBeenCalledWith({
      data: [{ agentVersionId: "version-3", toolId: "tool-a", effect: "ALLOW", priority: 0 }],
    });
  });

  it("returns the same scoped not-found result without writing for a foreign Tool ID", async () => {
    const h = harness();

    await expect(h.service.setToolEnabled("agent-a", "foreign-tool", scope, false)).resolves.toBeNull();

    expect(h.versions).toHaveLength(2);
    expect(h.tx.agentBinding.update).not.toHaveBeenCalled();
    expect(h.tx.agentToolPolicy.createMany).not.toHaveBeenCalled();
  });
});
