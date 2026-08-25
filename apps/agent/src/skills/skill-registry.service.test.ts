import { beforeEach, describe, expect, it, vi } from "vitest";
import { SkillRegistryService } from "./skill-registry.service";
import type { ParsedSkill } from "./skill-manifest.types";

const scope = {
  organizationId: "org_1",
  projectId: "proj_1",
  environmentId: "env_1",
};
const now = new Date("2026-08-15T00:00:00.000Z");
const parsed: ParsedSkill = {
  manifest: {
    id: "acme.lookup",
    name: "Lookup",
    description: "Look things up",
    version: "1.0.0",
    origin: "custom",
    required_env: [],
    optional_env: [],
    provides_tools: [],
    tags: ["lookup"],
  },
  promptBlock: "Use lookup.",
  source: "---\nid: acme.lookup\n---\nUse lookup.",
};
const skillRow = {
  id: "skill_1",
  organizationId: "org_1",
  slug: "acme.lookup",
  name: "Lookup",
  description: "Look things up",
  version: "1.0.0",
  author: null,
  origin: "custom",
  isOfficial: false,
  tags: ["lookup"],
  manifest: parsed.manifest,
  promptBlock: "Use lookup.",
  providesTools: [],
  requiredEnvironmentKeys: [],
  optionalEnvironmentKeys: [],
  createdAt: now,
  updatedAt: now,
};

function createPrisma() {
  return {
    environment: {
      findUnique: vi.fn().mockResolvedValue({
        id: "env_1",
        project: { id: "proj_1", organizationId: "org_1" },
      }),
    },
    organization: { findUnique: vi.fn().mockResolvedValue({ id: "org_1" }) },
    skill: {
      upsert: vi.fn().mockResolvedValue(skillRow),
      findFirst: vi.fn().mockResolvedValue(skillRow),
      findMany: vi.fn().mockResolvedValue([skillRow]),
      update: vi.fn(),
    },
    projectSkill: {
      upsert: vi.fn().mockResolvedValue({ id: "project_skill_1" }),
    },
    environmentSkill: {
      upsert: vi.fn().mockResolvedValue({ id: "environment_skill_1" }),
      findFirst: vi.fn().mockResolvedValue({ id: "environment_skill_1" }),
      deleteMany: vi.fn(),
    },
    agentBinding: {
      findFirst: vi.fn().mockResolvedValue({ activeAgentVersionId: "version_1" }),
    },
    agentSkill: {
      upsert: vi.fn().mockResolvedValue({
        id: "agent_skill_1",
        enabled: true,
        createdAt: now,
      }),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
  } as any;
}

describe("SkillRegistryService clean-tenancy normalization", () => {
  let prisma: ReturnType<typeof createPrisma>;
  let registry: SkillRegistryService;

  beforeEach(() => {
    prisma = createPrisma();
    registry = new SkillRegistryService(prisma, { setMap: vi.fn().mockResolvedValue({}) } as any);
  });

  it("registers a catalog Skill and normalized project/environment links", async () => {
    const result = await registry.register(scope, parsed);

    expect(result.skillId).toBe("acme.lookup");
    expect(prisma.skill.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId_slug_version: {
            organizationId: "org_1",
            slug: "acme.lookup",
            version: "1.0.0",
          },
        },
      }),
    );
    expect(prisma.projectSkill.upsert).toHaveBeenCalledWith({
      where: { projectId_skillId: { projectId: "proj_1", skillId: "skill_1" } },
      create: { projectId: "proj_1", skillId: "skill_1", enabled: true },
      update: { enabled: true },
    });
    expect(prisma.environmentSkill.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          environmentId_projectSkillId: {
            environmentId: "env_1",
            projectSkillId: "project_skill_1",
          },
        },
      }),
    );
  });

  it("installs a skill on the active AgentVersion, not directly on Agent", async () => {
    await registry.enableForAgent(scope, "agent_1", "skill_1");

    expect(prisma.agentBinding.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ environmentId: "env_1", agentId: "agent_1" }),
      }),
    );
    expect(prisma.agentSkill.upsert).toHaveBeenCalledWith({
      where: {
        agentVersionId_environmentSkillId: {
          agentVersionId: "version_1",
          environmentSkillId: "environment_skill_1",
        },
      },
      create: {
        agentVersionId: "version_1",
        environmentSkillId: "environment_skill_1",
        enabled: true,
      },
      update: { enabled: true },
    });
  });

  it("rejects a missing or foreign Agent binding before creating an AgentSkill", async () => {
    prisma.agentBinding.findFirst.mockResolvedValueOnce(null);

    await expect(registry.enableForAgent(scope, "foreign_agent", "skill_1")).rejects.toMatchObject({
      reason: "agent_not_found",
    });

    expect(prisma.agentBinding.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ environmentId: "env_1", agentId: "foreign_agent" }),
      }),
    );
    expect(prisma.agentSkill.upsert).not.toHaveBeenCalled();
  });

  it("rejects a forged ancestry tuple before creating links", async () => {
    await expect(
      registry.register({ ...scope, projectId: "forged_project" }, parsed),
    ).rejects.toThrow("Environment not found in scope");
    expect(prisma.skill.upsert).not.toHaveBeenCalled();
  });

  it("registers official skills without fabricated project/environment ids", async () => {
    const official = {
      ...parsed,
      manifest: { ...parsed.manifest, origin: "official" },
    };
    await registry.registerOfficial("org_1", official);

    expect(prisma.environment.findUnique).not.toHaveBeenCalled();
    expect(prisma.projectSkill.upsert).not.toHaveBeenCalled();
    expect(prisma.environmentSkill.upsert).not.toHaveBeenCalled();
  });
});
