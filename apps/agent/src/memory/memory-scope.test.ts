import { describe, expect, it, vi } from "vitest";
import { resolveReadAgentIds } from "./memory-scope";

const scope = {
  organizationId: "org",
  projectId: "project",
  environmentId: "environment",
};

function prisma(bindings: Array<{ agentId: string; clusterId: string | null }>) {
  return {
    agentBinding: {
      findMany: vi.fn(async ({ where }: any) => where.agentId
        ? bindings.filter((binding) => where.agentId.in.includes(binding.agentId))
        : bindings,
      ),
    },
  } as any;
}

describe("clean memory Agent/AgentCluster isolation", () => {
  it("allows the current Agent", async () => {
    await expect(resolveReadAgentIds(
      prisma([{ agentId: "agent-a", clusterId: null }]),
      scope,
      "agent-a",
    )).resolves.toEqual(["agent-a"]);
  });

  it("defaults reads to the authoritative acting Agent", async () => {
    await expect(resolveReadAgentIds(
      prisma([{ agentId: "agent-a", clusterId: null }]),
      { ...scope, agentId: "agent-a" },
    )).resolves.toEqual(["agent-a"]);
  });

  it("allows different Agents only when persisted bindings share one cluster", async () => {
    await expect(resolveReadAgentIds(
      prisma([
        { agentId: "agent-a", clusterId: "cluster-1" },
        { agentId: "agent-b", clusterId: "cluster-1" },
      ]),
      scope,
      undefined,
      ["agent-a", "agent-b"],
    )).resolves.toEqual(["agent-a", "agent-b"]);
  });

  it("denies standalone cross-Agent reads", async () => {
    await expect(resolveReadAgentIds(
      prisma([
        { agentId: "agent-a", clusterId: null },
        { agentId: "agent-b", clusterId: null },
      ]),
      scope,
      undefined,
      ["agent-a", "agent-b"],
    )).rejects.toThrow("requires one shared AgentCluster");
  });

  it("denies cross-cluster reads", async () => {
    await expect(resolveReadAgentIds(
      prisma([
        { agentId: "agent-a", clusterId: "cluster-1" },
        { agentId: "agent-b", clusterId: "cluster-2" },
      ]),
      scope,
      undefined,
      ["agent-a", "agent-b"],
    )).rejects.toThrow("requires one shared AgentCluster");
  });

  it("denies a caller-selected Agent outside the acting Agent cluster", async () => {
    await expect(resolveReadAgentIds(
      prisma([
        { agentId: "agent-a", clusterId: "cluster-1" },
        { agentId: "agent-b", clusterId: "cluster-2" },
      ]),
      { ...scope, agentId: "agent-a" },
      "agent-b",
    )).rejects.toThrow("outside the acting AgentCluster");
  });

  it("derives a single persisted Agent when no acting Agent is available", async () => {
    await expect(resolveReadAgentIds(
      prisma([{ agentId: "agent-a", clusterId: null }]),
      scope,
    )).resolves.toEqual(["agent-a"]);
  });

  it("derives one complete persisted cluster when no acting Agent is available", async () => {
    await expect(resolveReadAgentIds(
      prisma([
        { agentId: "agent-a", clusterId: "cluster-1" },
        { agentId: "agent-b", clusterId: "cluster-1" },
      ]),
      scope,
    )).resolves.toEqual(["agent-a", "agent-b"]);
  });

  it("fails closed instead of widening an unpinned read across standalone Agents", async () => {
    await expect(resolveReadAgentIds(
      prisma([
        { agentId: "agent-a", clusterId: null },
        { agentId: "agent-b", clusterId: null },
      ]),
      scope,
    )).rejects.toThrow("require one persisted Agent or AgentCluster scope");
  });

  it("denies a requested Agent missing from canonical Environment bindings", async () => {
    await expect(resolveReadAgentIds(
      prisma([{ agentId: "agent-a", clusterId: "cluster-1" }]),
      scope,
      undefined,
      ["agent-a", "agent-foreign"],
    )).rejects.toThrow("not found or access denied");
  });
});
