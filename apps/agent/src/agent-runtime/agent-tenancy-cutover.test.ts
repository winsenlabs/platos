import { describe, expect, it, vi } from "vitest";
import type { RequestScope } from "../auth/scope.guard";
import { AgentClusterService } from "./agent-cluster.service";
import { AgentCrudService } from "./agent-crud.service";

const scope: RequestScope = {
  organizationId: "org-a",
  projectId: "project-a",
  environmentId: "env-a",
  userId: "user-a",
};

function bindingRow() {
  const now = new Date("2026-08-15T00:00:00.000Z");
  return {
    id: "binding-a",
    environmentId: "env-a",
    activeAgentVersionId: "version-a",
    canaryAgentVersionId: null,
    canaryPercent: 0,
    clusterId: null,
    createdAt: now,
    updatedAt: now,
    environment: {
      id: "env-a",
      projectId: "project-a",
      project: { id: "project-a", organizationId: "org-a" },
    },
    agent: {
      id: "agent-a",
      projectId: "project-a",
      name: "Canonical agent",
      slug: "canonical-agent",
      isActive: true,
      createdAt: now,
      _count: { threads: 0 },
    },
    activeAgentVersion: {
      id: "version-a",
      model: "anthropic:claude-sonnet-4-6",
      modelRoutes: [],
      systemPrompt: null,
      promptBlocks: [],
      dynamicBlocks: [],
      maxSteps: 20,
      contextLimit: 20,
      toolsBlockConfig: {},
      memoryConfig: {},
      outputSchema: null,
    },
    canaryAgentVersion: null,
    cluster: null,
  };
}

describe("Agent CRUD canonical tenancy", () => {
  it("creates project-owned Agent identity plus an Environment-owned AgentBinding", async () => {
    const tx = {
      environment: {
        findFirst: vi.fn().mockResolvedValue({ id: "env-a", projectId: "project-a" }),
      },
      agent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "agent-a" }),
      },
      agentVersion: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "version-a" }),
      },
      agentBinding: { create: vi.fn().mockResolvedValue({ id: "binding-a" }) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
      agentBinding: { findFirst: vi.fn().mockResolvedValue(bindingRow()) },
    };
    const redis = { del: vi.fn().mockResolvedValue(0) };
    const service = new AgentCrudService(prisma as any, redis as any);

    const result = await service.create(scope, {
      name: "Canonical agent",
      model: "anthropic:claude-sonnet-4-6",
    });

    expect(tx.environment.findFirst).toHaveBeenCalledWith({
      where: {
        id: "env-a",
        project: { id: "project-a", organizationId: "org-a" },
      },
      select: { id: true, projectId: true },
    });
    expect(tx.agent.create).toHaveBeenCalledWith({
      data: {
        projectId: "project-a",
        name: "Canonical agent",
        slug: "canonical-agent",
        isActive: true,
      },
    });
    expect(tx.agentBinding.create).toHaveBeenCalledWith({
      data: {
        environmentId: "env-a",
        agentId: "agent-a",
        activeAgentVersionId: "version-a",
      },
    });
    expect(result).toMatchObject({
      id: "agent-a",
      organizationId: "org-a",
      projectId: "project-a",
      environmentId: "env-a",
      currentVersionId: "version-a",
    });
  });

  it("reads through AgentBinding and requires persisted organization/project/environment ancestry", async () => {
    const findFirst = vi.fn().mockResolvedValue(bindingRow());
    const service = new AgentCrudService(
      { agentBinding: { findFirst } } as any,
      { del: vi.fn() } as any,
    );

    const result = await service.findById("agent-a", scope);

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          agentId: "agent-a",
          environmentId: "env-a",
          environment: {
            project: { id: "project-a", organizationId: "org-a" },
          },
          agent: { projectId: "project-a" },
        },
      }),
    );
    expect(result).toMatchObject({
      id: "agent-a",
      organizationId: "org-a",
      projectId: "project-a",
      environmentId: "env-a",
    });
  });
});

describe("AgentClusterService canonical tenancy", () => {
  it("projects cluster and agent identity from Environment and AgentBinding relations", async () => {
    const createdAt = new Date("2026-08-15T00:00:00.000Z");
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "cluster-a",
        environmentId: "env-a",
        name: "Cluster A",
        slug: "cluster-a",
        description: null,
        metadata: null,
        createdAt,
        updatedAt: createdAt,
        environment: {
          projectId: "project-a",
          project: { organizationId: "org-a" },
        },
        bindings: [
          { agent: { id: "agent-a", name: "Canonical agent", slug: "canonical-agent" } },
        ],
      },
    ]);
    const service = new AgentClusterService({ agentCluster: { findMany } } as any);

    const result = await service.list(scope);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          environmentId: "env-a",
          environment: {
            project: { id: "project-a", organizationId: "org-a" },
          },
        },
      }),
    );
    expect(result[0]).toMatchObject({
      organizationId: "org-a",
      projectId: "project-a",
      environmentId: "env-a",
      agents: [{ id: "agent-a", name: "Canonical agent", slug: "canonical-agent" }],
    });
  });

  it("rejects a forged cross-scope agent binding before mutating cluster membership", async () => {
    const findFirstCluster = vi.fn().mockResolvedValue({
      id: "cluster-a",
      metadata: null,
    });
    const findFirstBinding = vi.fn().mockResolvedValue(null);
    const transaction = vi.fn();
    const service = new AgentClusterService({
      agentCluster: { findFirst: findFirstCluster },
      agentBinding: { findFirst: findFirstBinding },
      $transaction: transaction,
    } as any);

    await expect(
      service.addAgent("cluster-a", "agent-from-org-b", scope),
    ).rejects.toThrow("Agent not found or access denied");
    expect(findFirstBinding).toHaveBeenCalledWith({
      where: {
        agentId: "agent-from-org-b",
        environmentId: "env-a",
        agent: { projectId: "project-a" },
        environment: {
          project: { id: "project-a", organizationId: "org-a" },
        },
      },
      select: { id: true },
    });
    expect(transaction).not.toHaveBeenCalled();
  });
});
