import { describe, expect, it, vi } from "vitest";
import { MemoryController } from "./memory.controller";
import {
  MemoryEndUserContextError,
  resolveEndUser,
  resolveOperatorSelectedEndUser,
  resolveReadAgentIds,
} from "./memory-scope";

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

function memoryController(options: {
  selectedEndUser?: { id: string; identities: Array<{ subject: string }> } | null;
  listPage?: ReturnType<typeof vi.fn>;
} = {}) {
  const database = {
    environment: { findFirst: vi.fn().mockResolvedValue({ id: scope.environmentId }) },
    endUser: { findFirst: vi.fn().mockResolvedValue(options.selectedEndUser ?? null) },
    endUserIdentity: { findFirst: vi.fn().mockResolvedValue({ endUserId: "end-user-own", subject: "verified-user" }) },
  };
  const memoryService = {
    listPage: options.listPage ?? vi.fn().mockResolvedValue({
      items: [], total: 0, limit: 50, offset: 0, hasNext: false,
    }),
  };
  return {
    database,
    memoryService,
    controller: new MemoryController(
      memoryService as any,
      {} as any,
      {} as any,
      {} as any,
      database as any,
      {} as any,
    ),
  };
}

describe("clean memory Agent/AgentCluster isolation", () => {
  it("returns a stable typed error when no canonical end-user context exists", async () => {
    const database = {
      endUser: { findFirst: vi.fn().mockResolvedValue(null) },
      endUserIdentity: { findFirst: vi.fn().mockResolvedValue(null) },
    } as any;

    const error = await resolveEndUser(database, scope, "operator-id").catch((value) => value);

    expect(error).toBeInstanceOf(MemoryEndUserContextError);
    expect(error).toMatchObject({
      code: "MEMORY_END_USER_CONTEXT_REQUIRED",
      message: "Memory end user not found or access denied",
    });
  });

  it("resolves a non-UUID verified external subject without querying the UUID EndUser id column", async () => {
    const database = {
      endUser: { findFirst: vi.fn() },
      endUserIdentity: {
        findFirst: vi.fn().mockResolvedValue({
          endUserId: "3ec2a3f1-10f9-41a7-9e21-3b6739e84ca1",
          subject: "operator-selected-external-user",
        }),
      },
    } as any;

    await expect(resolveEndUser(database, scope, "operator-selected-external-user")).resolves.toEqual({
      id: "3ec2a3f1-10f9-41a7-9e21-3b6739e84ca1",
      externalId: "operator-selected-external-user",
    });
    expect(database.endUser.findFirst).not.toHaveBeenCalled();
  });

  it("projects a missing operator end-user as an explicit context state", async () => {
    const { controller, memoryService } = memoryController();

    await expect(controller.listMemories({
      scope: {
        ...scope,
        userId: "operator-id",
        principal: "operator",
      },
    } as any)).resolves.toEqual({
      memories: [],
      total: 0,
      requiresEndUserContext: true,
      code: "MEMORY_END_USER_CONTEXT_REQUIRED",
    });
    expect(memoryService.listPage).not.toHaveBeenCalled();
  });

  it("accepts only a direct active same-organization EndUser selection for operators", async () => {
    const database = {
      environment: { findFirst: vi.fn().mockResolvedValue({ id: scope.environmentId }) },
      endUser: {
        findFirst: vi.fn().mockResolvedValue({
          id: "end-user-selected",
          identities: [{ subject: "external-selected" }],
        }),
      },
    } as any;

    await expect(resolveOperatorSelectedEndUser(
      database,
      scope,
      "end-user-selected",
    )).resolves.toEqual({ id: "end-user-selected", externalId: "external-selected" });
    expect(database.endUser.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "end-user-selected",
        organizationId: scope.organizationId,
        disabledAt: null,
      },
    }));
  });

  it("rejects an operator selection outside the canonical scope", async () => {
    const database = {
      environment: { findFirst: vi.fn().mockResolvedValue({ id: scope.environmentId }) },
      endUser: { findFirst: vi.fn().mockResolvedValue(null) },
    } as any;

    await expect(resolveOperatorSelectedEndUser(
      database,
      scope,
      "foreign-user",
    )).rejects.toBeInstanceOf(MemoryEndUserContextError);
  });

  it("uses a validated operator selection and never substitutes the operator identity", async () => {
    const listPage = vi.fn().mockResolvedValue({
      items: [], total: 0, limit: 50, offset: 0, hasNext: false,
    });
    const { controller, memoryService } = memoryController({
      selectedEndUser: { id: "end-user-selected", identities: [{ subject: "external-selected" }] },
      listPage,
    });

    await controller.listMemories({
      scope: { ...scope, userId: "operator-id", principal: "operator" },
    } as any, "end-user-selected");

    expect(memoryService.listPage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: "external-selected",
    }));
  });

  it("forces non-operators to their verified scope userId", async () => {
    const listPage = vi.fn().mockResolvedValue({
      items: [], total: 0, limit: 50, offset: 0, hasNext: false,
    });
    const { controller, memoryService, database } = memoryController({ listPage });

    await controller.listMemories({
      scope: { ...scope, userId: "46123e5c-e5b2-4829-898d-00ec8a6ae1ce", principal: "end-user" },
    } as any, "forged-user");

    expect(database.endUser.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "46123e5c-e5b2-4829-898d-00ec8a6ae1ce" }),
    }));
    expect(memoryService.listPage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: "verified-user",
    }));
  });

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
