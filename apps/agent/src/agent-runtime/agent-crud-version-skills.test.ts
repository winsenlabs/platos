import { describe, expect, it, vi } from "vitest";
import type { RequestScope } from "../auth/scope.guard";
import { AgentCrudService } from "./agent-crud.service";

const scope: RequestScope = {
  organizationId: "org-a",
  projectId: "project-a",
  environmentId: "env-a",
  userId: "user-a",
};

function version(id: string, versionNumber: number, systemPrompt: string) {
  return {
    id,
    agentId: "agent-a",
    versionNumber,
    model: "anthropic:claude-sonnet-4-6",
    systemPrompt,
    promptBlocks: [],
    dynamicBlocks: [],
    maxSteps: 20,
    contextLimit: 20,
    toolsBlockConfig: {},
    modelRoutes: [],
    memoryConfig: {},
    outputSchema: null,
    note: null,
    createdBy: "user-a",
    createdAt: new Date("2026-08-15T00:00:00.000Z"),
  };
}

function bindingRow(activeVersion = version("version-current", 2, "current")) {
  const now = new Date("2026-08-15T00:00:00.000Z");
  return {
    id: "binding-a",
    environmentId: "env-a",
    agentId: "agent-a",
    activeAgentVersionId: activeVersion.id,
    canaryAgentVersionId: "version-canary",
    canaryPercent: 25,
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
      name: "Agent",
      slug: "agent",
      isActive: true,
      createdAt: now,
      _count: { threads: 0 },
    },
    activeAgentVersion: activeVersion,
    canaryAgentVersion: version("version-canary", 3, "canary"),
    cluster: null,
  };
}

const assignedSkills = [
  {
    environmentSkillId: "environment-skill-a",
    enabled: true,
    config: { mode: "strict" },
  },
  {
    environmentSkillId: "environment-skill-b",
    enabled: false,
    config: { threshold: 2 },
  },
];

function makeHarness(options: { cloneError?: Error; targetVersion?: ReturnType<typeof version> } = {}) {
  const binding = bindingRow();
  const createdVersion = version("version-new", 4, "updated");
  const targetVersion = options.targetVersion ?? version("version-target", 1, "target");
  const tx = {
    agent: { update: vi.fn() },
    agentCluster: { findFirst: vi.fn() },
    agentVersion: {
      findFirst: vi.fn().mockResolvedValue({ versionNumber: 3 }),
      create: vi.fn().mockResolvedValue(createdVersion),
    },
    agentSkill: {
      findMany: vi.fn().mockResolvedValue(assignedSkills),
      createMany: options.cloneError
        ? vi.fn().mockRejectedValue(options.cloneError)
        : vi.fn().mockResolvedValue({ count: assignedSkills.length }),
    },
    agentBinding: { update: vi.fn().mockResolvedValue({}) },
    adminAudit: { create: vi.fn().mockResolvedValue({}) },
  };
  const findBinding = vi.fn().mockResolvedValue(binding);
  const prisma = {
    agentBinding: { findFirst: findBinding },
    agentVersion: { findFirst: vi.fn().mockResolvedValue(targetVersion) },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  const redis = { del: vi.fn().mockResolvedValue(0) };
  return {
    binding,
    createdVersion,
    targetVersion,
    tx,
    prisma,
    redis,
    service: new AgentCrudService(prisma as any, redis as any),
  };
}

describe("AgentCrudService AgentSkill version rollover", () => {
  it("clones active-version skills before advancing the binding on ordinary update", async () => {
    const h = makeHarness();

    await h.service.update("agent-a", scope, { systemPrompt: "updated" });

    expect(h.tx.agentSkill.findMany).toHaveBeenCalledWith({
      where: { agentVersionId: "version-current" },
      select: {
        environmentSkillId: true,
        enabled: true,
        config: true,
      },
    });
    expect(h.tx.agentSkill.createMany).toHaveBeenCalledWith({
      data: assignedSkills.map((skill) => ({
        agentVersionId: "version-new",
        ...skill,
      })),
    });
    expect(h.tx.agentBinding.update).toHaveBeenCalledWith({
      where: { id: "binding-a" },
      data: { activeAgentVersionId: "version-new" },
    });
    expect(h.tx.agentSkill.createMany.mock.invocationCallOrder[0]).toBeLessThan(
      h.tx.agentBinding.update.mock.invocationCallOrder[0],
    );
    // Clean Turn attribution still has distinct, stable current/canary pointers.
    expect(h.binding.canaryAgentVersionId).toBe("version-canary");
    expect(h.binding.canaryPercent).toBe(25);
  });

  it("clones skills from the selected rollback target rather than the current version", async () => {
    const h = makeHarness();

    await h.service.rollbackToVersion("agent-a", "version-target", scope);

    expect(h.prisma.agentVersion.findFirst).toHaveBeenCalledWith({
      where: { id: "version-target", agentId: "agent-a" },
    });
    expect(h.tx.agentSkill.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { agentVersionId: "version-target" } }),
    );
    expect(h.tx.agentSkill.createMany).toHaveBeenCalledWith({
      data: assignedSkills.map((skill) => ({
        agentVersionId: "version-new",
        ...skill,
      })),
    });
    expect(h.tx.agentSkill.createMany.mock.invocationCallOrder[0]).toBeLessThan(
      h.tx.agentBinding.update.mock.invocationCallOrder[0],
    );
  });

  it("does not advance the binding or invalidate caches when skill cloning fails", async () => {
    const h = makeHarness({ cloneError: new Error("skill clone failed") });

    await expect(
      h.service.update("agent-a", scope, { systemPrompt: "updated" }),
    ).rejects.toThrow("skill clone failed");

    expect(h.tx.agentVersion.create).toHaveBeenCalledOnce();
    expect(h.tx.agentSkill.createMany).toHaveBeenCalledOnce();
    expect(h.tx.agentBinding.update).not.toHaveBeenCalled();
    expect(h.redis.del).not.toHaveBeenCalled();
  });
});

describe("AgentCrudService canary promotion audit", () => {
  it("writes the binding promotion and immutable audit in one transaction", async () => {
    const h = makeHarness();
    vi.spyOn(h.service, "findById").mockResolvedValue({ id: "agent-a" } as any);

    await h.service.promoteCanary("agent-a", scope);

    expect(h.tx.agentBinding.update).toHaveBeenCalledWith({
      where: { id: "binding-a" },
      data: {
        activeAgentVersionId: "version-canary",
        canaryAgentVersionId: null,
        canaryPercent: 0,
      },
    });
    expect(h.tx.adminAudit.create).toHaveBeenCalledWith({
      data: {
        environmentId: "env-a",
        actorUserId: "user-a",
        action: "agent.canary.promote",
        subjectType: "Agent",
        subjectId: "agent-a",
        before: {
          previousCurrentVersionId: "version-current",
          previousCanaryVersionId: "version-canary",
          previousCanaryPercent: 25,
        },
        after: { currentVersionId: "version-canary" },
        source: "api",
      },
    });
    expect(h.tx.agentBinding.update.mock.invocationCallOrder[0]).toBeLessThan(
      h.tx.adminAudit.create.mock.invocationCallOrder[0],
    );
  });

  it("fails promotion without cache invalidation when the audit insert fails", async () => {
    const h = makeHarness();
    h.tx.adminAudit.create.mockRejectedValueOnce(new Error("audit unavailable"));

    await expect(h.service.promoteCanary("agent-a", scope)).rejects.toThrow("audit unavailable");

    expect(h.tx.agentBinding.update).toHaveBeenCalledOnce();
    expect(h.redis.del).not.toHaveBeenCalled();
  });
});
