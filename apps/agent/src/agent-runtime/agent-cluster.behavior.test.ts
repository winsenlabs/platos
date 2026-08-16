import { describe, expect, it, vi } from "vitest";
import type { RequestScope } from "../auth/scope.guard";
import { AgentClusterService } from "./agent-cluster.service";

const scope: RequestScope = {
  organizationId: "org-a",
  projectId: "project-a",
  environmentId: "env-a",
  userId: "operator-a",
};

const now = new Date("2026-08-15T00:00:00.000Z");

function clusterRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cluster-a",
    environmentId: "env-a",
    name: "Cluster A",
    slug: "cluster-a",
    description: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
    environment: {
      projectId: "project-a",
      project: { id: "project-a", organizationId: "org-a" },
    },
    bindings: [],
    ...overrides,
  };
}

describe("AgentClusterService transaction and scope mechanics", () => {
  it("creates the cluster and attaches only same-Environment project agents in one transaction", async () => {
    const tx = {
      environment: {
        findFirst: vi.fn().mockResolvedValue({ id: "env-a" }),
      },
      agentBinding: {
        findFirst: vi.fn().mockResolvedValue({ id: "binding-primary" }),
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
      agentCluster: {
        create: vi.fn().mockResolvedValue({ id: "cluster-a" }),
        findUnique: vi.fn().mockResolvedValue(
          clusterRow({
            metadata: { primaryAgentId: "agent-a" },
            bindings: [
              {
                agentId: "agent-a",
                agent: { id: "agent-a", name: "Ada", slug: "ada" },
              },
              {
                agentId: "agent-b",
                agent: { id: "agent-b", name: "Bob", slug: "bob" },
              },
            ],
          }),
        ),
      },
    };
    const transaction = vi.fn(
      async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    );
    const service = new AgentClusterService({ $transaction: transaction } as any);

    const result = await service.create(scope, {
      name: "Cluster A",
      slug: "cluster-a",
      primaryAgentId: "agent-a",
      agentIds: ["agent-a", "agent-b", "foreign-agent"],
    });

    expect(tx.environment.findFirst).toHaveBeenCalledWith({
      where: {
        id: "env-a",
        project: { id: "project-a", organizationId: "org-a" },
      },
      select: { id: true },
    });
    expect(tx.agentBinding.findFirst).toHaveBeenCalledWith({
      where: {
        agentId: "agent-a",
        environmentId: "env-a",
        agent: { projectId: "project-a" },
      },
      select: { id: true },
    });
    expect(tx.agentBinding.updateMany).toHaveBeenCalledWith({
      where: {
        agentId: { in: ["agent-a", "agent-b", "foreign-agent"] },
        environmentId: "env-a",
        agent: { projectId: "project-a" },
      },
      data: { clusterId: "cluster-a" },
    });
    expect(result).toMatchObject({
      id: "cluster-a",
      organizationId: "org-a",
      projectId: "project-a",
      environmentId: "env-a",
      metadata: { primaryAgentId: "agent-a" },
      agents: [
        { id: "agent-a", name: "Ada", slug: "ada" },
        { id: "agent-b", name: "Bob", slug: "bob" },
      ],
    });
  });

  it("rejects a cross-scope primary agent before updating the cluster", async () => {
    const update = vi.fn();
    const bindingFindFirst = vi.fn().mockResolvedValue(null);
    const service = new AgentClusterService({
      agentCluster: {
        findFirst: vi.fn().mockResolvedValue(clusterRow()),
        update,
      },
      agentBinding: { findFirst: bindingFindFirst },
    } as any);

    await expect(
      service.update("cluster-a", scope, {
        name: "Renamed",
        primaryAgentId: "foreign-agent",
      }),
    ).rejects.toThrow("Primary agent not found or access denied");
    expect(bindingFindFirst).toHaveBeenCalledWith({
      where: {
        agentId: "foreign-agent",
        environmentId: "env-a",
        agent: { projectId: "project-a" },
        environment: {
          project: { id: "project-a", organizationId: "org-a" },
        },
      },
      select: { id: true },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("returns false for a foreign cluster without unbinding or deleting anything", async () => {
    const transaction = vi.fn();
    const updateMany = vi.fn();
    const remove = vi.fn();
    const service = new AgentClusterService({
      agentCluster: { findFirst: vi.fn().mockResolvedValue(null), delete: remove },
      agentBinding: { updateMany },
      $transaction: transaction,
    } as any);

    await expect(service.delete("foreign-cluster", scope)).resolves.toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("unbinds only this Environment before deleting a scoped cluster", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    const remove = vi.fn().mockResolvedValue(clusterRow());
    const transaction = vi.fn().mockResolvedValue([]);
    const service = new AgentClusterService({
      agentCluster: {
        findFirst: vi.fn().mockResolvedValue(clusterRow()),
        delete: remove,
      },
      agentBinding: { updateMany },
      $transaction: transaction,
    } as any);

    await expect(service.delete("cluster-a", scope)).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: { clusterId: "cluster-a", environmentId: "env-a" },
      data: { clusterId: null },
    });
    expect(remove).toHaveBeenCalledWith({ where: { id: "cluster-a" } });
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("assigns the first added agent as primary and keeps both mutations atomic", async () => {
    const clusterFindFirst = vi
      .fn()
      .mockResolvedValueOnce(clusterRow())
      .mockResolvedValueOnce(
        clusterRow({
          metadata: { primaryAgentId: "agent-a" },
          bindings: [
            {
              agentId: "agent-a",
              agent: { id: "agent-a", name: "Ada", slug: "ada" },
            },
          ],
        }),
      );
    const bindingUpdate = vi.fn().mockResolvedValue({ id: "binding-a" });
    const clusterUpdate = vi.fn().mockResolvedValue(clusterRow());
    const transaction = vi.fn().mockResolvedValue([]);
    const service = new AgentClusterService({
      agentCluster: { findFirst: clusterFindFirst, update: clusterUpdate },
      agentBinding: {
        findFirst: vi.fn().mockResolvedValue({ id: "binding-a" }),
        update: bindingUpdate,
      },
      $transaction: transaction,
    } as any);

    const result = await service.addAgent("cluster-a", "agent-a", scope);

    expect(bindingUpdate).toHaveBeenCalledWith({
      where: { id: "binding-a" },
      data: { clusterId: "cluster-a" },
    });
    expect(clusterUpdate).toHaveBeenCalledWith({
      where: { id: "cluster-a" },
      data: { metadata: { primaryAgentId: "agent-a" } },
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(result.metadata).toEqual({ primaryAgentId: "agent-a" });
  });

  it("promotes another bound agent when removing the primary", async () => {
    const clusterFindFirst = vi
      .fn()
      .mockResolvedValueOnce(
        clusterRow({
          metadata: { primaryAgentId: "agent-a", label: "support" },
          bindings: [
            {
              agentId: "agent-a",
              agent: { id: "agent-a", name: "Ada", slug: "ada" },
            },
            {
              agentId: "agent-b",
              agent: { id: "agent-b", name: "Bob", slug: "bob" },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        clusterRow({
          metadata: { primaryAgentId: "agent-b", label: "support" },
          bindings: [
            {
              agentId: "agent-b",
              agent: { id: "agent-b", name: "Bob", slug: "bob" },
            },
          ],
        }),
      );
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const update = vi.fn().mockResolvedValue(clusterRow());
    const service = new AgentClusterService({
      agentCluster: { findFirst: clusterFindFirst, update },
      agentBinding: { updateMany },
    } as any);

    const result = await service.removeAgent("cluster-a", "agent-a", scope);

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        agentId: "agent-a",
        clusterId: "cluster-a",
        environmentId: "env-a",
        agent: { projectId: "project-a" },
      },
      data: { clusterId: null },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "cluster-a" },
      data: { metadata: { primaryAgentId: "agent-b", label: "support" } },
    });
    expect(result.metadata).toEqual({
      primaryAgentId: "agent-b",
      label: "support",
    });
  });
});
