import { describe, expect, it, vi } from "vitest";
import type { RequestScope } from "../auth/scope.guard";
import { AgentService } from "./agent.service";

const scope: RequestScope = {
  organizationId: "org-a",
  projectId: "project-a",
  environmentId: "env-a",
  userId: "user-a",
  agentId: "agent-a",
};

function makeService(options?: {
  profileRows?: any[];
  clusterId?: string | null;
  members?: string[];
}) {
  const profileRows = options?.profileRows ?? [];
  const list = vi.fn(async () => profileRows);
  const add = vi.fn(async (_scope, input) => ({ id: "memory-new", ...input }));
  const update = vi.fn(async (_scope, id, patch) => ({ id, ...patch }));
  const memoryService = { list, add, update };
  const prisma = {
    agentBinding: {
      findFirst: vi.fn(async () => ({ clusterId: options?.clusterId ?? null })),
      findMany: vi.fn(async () => (options?.members ?? ["agent-a"]).map((agentId) => ({ agentId }))),
    },
  };
  const profileCache = {
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    invalidate: vi.fn(async () => undefined),
  };
  const service = new AgentService(
    {} as any,
    prisma as any,
    { get: vi.fn() } as any,
    { get: vi.fn(() => null) } as any,
  );
  Object.assign(service as any, { memoryService, profileCache });
  return { service, prisma, memoryService, profileCache };
}

describe("AgentService clean memory transport", () => {
  it("does not use Redis as compatibility storage when clean Memory is unavailable", async () => {
    const redis = {
      lpush: vi.fn(),
      ltrim: vi.fn(),
      expire: vi.fn(),
      lrange: vi.fn(),
    };
    const service = new AgentService(
      redis as any,
      {} as any,
      { get: vi.fn() } as any,
      { get: vi.fn(() => null) } as any,
    );
    const tools = (service as any).buildMetaTools(scope, { metaTools: {} });

    await expect(tools.remember.execute({ content: "remember this" })).resolves.toEqual({
      saved: false,
      error: "clean memory service unavailable",
    });
    await expect(tools.recall.execute({ query: "remember" })).resolves.toEqual({
      query: "remember",
      total: 0,
      results: [],
      error: "clean memory service unavailable",
    });
    expect(redis.lpush).not.toHaveBeenCalled();
    expect(redis.ltrim).not.toHaveBeenCalled();
    expect(redis.expire).not.toHaveBeenCalled();
    expect(redis.lrange).not.toHaveBeenCalled();
  });

  it("derives cluster expansion from the persisted acting AgentBinding", async () => {
    const { service, prisma } = makeService({
      clusterId: "cluster-a",
      members: ["agent-a", "agent-b"],
    });

    await expect((service as any).memoryAgentFilter("agent-a", scope)).resolves.toEqual({
      agentIds: ["agent-a", "agent-b"],
    });
    expect(prisma.agentBinding.findFirst).toHaveBeenCalledWith({
      where: {
        agentId: "agent-a",
        environmentId: "env-a",
        agent: { projectId: "project-a" },
        environment: {
          project: { id: "project-a", organizationId: "org-a" },
        },
      },
      select: { clusterId: true },
    });
    expect(prisma.agentBinding.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ clusterId: "cluster-a" }),
      }),
    );
  });

  it("recalls profile rows through MemoryService with the acting Agent in scope", async () => {
    const { service, memoryService } = makeService({
      profileRows: [
        { id: "memory-1", content: "Ada", metadata: { profileKey: "name" } },
      ],
    });
    const tools = (service as any).buildMetaTools(scope, { metaTools: {} });

    await expect(tools.recall_user_profile.execute({})).resolves.toEqual({
      found: true,
      profile: { name: "Ada" },
    });
    expect(memoryService.list).toHaveBeenCalledWith(
      {
        organizationId: "org-a",
        projectId: "project-a",
        environmentId: "env-a",
        agentId: "agent-a",
      },
      {
        userId: "user-a",
        agentId: "agent-a",
        kind: "profile",
        limit: 100,
      },
    );
  });

  it("updates an existing profile atom without a legacy delete-and-reinsert", async () => {
    const prior = {
      id: "memory-1",
      content: "old",
      metadata: { profileKey: "role" },
    };
    const { service, memoryService } = makeService({ profileRows: [prior] });
    const tools = (service as any).buildMetaTools(scope, { metaTools: {} });

    await expect(tools.update_user_profile.execute({ key: "role", value: "engineer" }))
      .resolves.toMatchObject({ saved: true, key: "role", value: "engineer" });
    expect(memoryService.update).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-a" }),
      "memory-1",
      expect.objectContaining({
        kind: "profile",
        content: "engineer",
        metadata: expect.objectContaining({ profileKey: "role" }),
      }),
      "user-a",
    );
    expect(memoryService.add).not.toHaveBeenCalled();
  });
});
