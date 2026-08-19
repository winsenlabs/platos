import { describe, expect, it, vi } from "vitest";
import { MCPPermissionGatewayService } from "./permission-gateway.service";

const scope = {
  organizationId: "org-1",
  projectId: "project-1",
  environmentId: "env-1",
};

function harness(
  options: {
    orgPolicies?: Array<{ pattern: string; effect: "ALLOW" | "DENY" }>;
    binding?: unknown;
  } = {}
) {
  const prisma = {
    organizationMcpPolicy: {
      findMany: vi.fn().mockResolvedValue(options.orgPolicies ?? []),
    },
    agentBinding: {
      findFirst: vi.fn().mockResolvedValue(options.binding ?? null),
    },
  };
  return {
    service: new MCPPermissionGatewayService(prisma as any),
    prisma,
  };
}

describe("MCPPermissionGatewayService canonical policies", () => {
  it("scopes organization policies only by authenticated organization ancestry", async () => {
    const { service, prisma } = harness({
      orgPolicies: [{ pattern: "reports.*", effect: "ALLOW" }],
    });

    const resolved = await service.resolve({
      scope,
      agentId: null,
      userId: "user-1",
      toolName: "reports.get",
    });

    expect(prisma.organizationMcpPolicy.findMany).toHaveBeenCalledWith({
      where: { organizationId: "org-1" },
      select: { pattern: true, effect: true },
    });
    expect(resolved.state).toBe("auto_allow");
  });

  it("maps organization DENY to block", async () => {
    const { service } = harness({
      orgPolicies: [{ pattern: "reports.*", effect: "DENY" }],
    });

    await expect(
      service.resolve({
        scope,
        agentId: null,
        userId: "user-1",
        toolName: "reports.get",
      })
    ).resolves.toEqual({ state: "block", tier: 2, reason: "org-policy block" });
  });

  it("maps organization ALLOW to auto_allow", async () => {
    const { service } = harness({
      orgPolicies: [{ pattern: "reports.*", effect: "ALLOW" }],
    });

    const resolved = await service.resolve({
      scope,
      agentId: null,
      userId: "user-1",
      toolName: "reports.get",
    });

    expect(resolved.state).toBe("auto_allow");
  });

  it("fails closed when the scoped AgentBinding is missing", async () => {
    const { service } = harness();

    const resolved = await service.resolve({
      scope,
      agentId: "agent-1",
      userId: "user-1",
      toolName: "reports.get",
    });

    expect(resolved).toEqual({ state: "block", tier: 3, reason: "agent-policy block" });
  });

  it("loads the active AgentVersion through the fully scoped AgentBinding", async () => {
    const { service, prisma } = harness({
      binding: {
        activeAgentVersion: {
          toolDefaultPolicy: "ALL",
          toolPolicies: [],
        },
      },
    });

    const resolved = await service.resolve({
      scope,
      agentId: "agent-1",
      userId: "user-1",
      toolName: "reports.get",
    });

    expect(prisma.agentBinding.findFirst).toHaveBeenCalledWith({
      where: {
        agentId: "agent-1",
        environmentId: "env-1",
        environment: {
          projectId: "project-1",
          project: { organizationId: "org-1" },
        },
        agent: { projectId: "project-1" },
      },
      select: {
        activeAgentVersion: {
          select: {
            toolDefaultPolicy: true,
            toolPolicies: {
              where: { tool: { name: "reports.get" } },
              orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
              take: 1,
              select: { effect: true },
            },
          },
        },
      },
    });
    expect(resolved.state).toBe("auto_allow");
  });

  it.each([
    ["DENY", "block"],
    ["ALLOW", "auto_allow"],
  ] as const)("applies explicit AgentToolPolicy %s as %s", async (effect, expected) => {
    const { service } = harness({
      binding: {
        activeAgentVersion: {
          toolDefaultPolicy: effect === "DENY" ? "ALL" : "NONE",
          toolPolicies: [{ effect }],
        },
      },
    });

    const resolved = await service.resolve({
      scope,
      agentId: "agent-1",
      userId: "user-1",
      toolName: "reports.get",
    });

    expect(resolved.state).toBe(expected);
  });

  it.each([
    ["NONE", "block"],
    ["ALL", "auto_allow"],
  ] as const)("maps AgentVersion default %s to %s", async (toolDefaultPolicy, expected) => {
    const { service } = harness({
      binding: {
        activeAgentVersion: {
          toolDefaultPolicy,
          toolPolicies: [],
        },
      },
    });

    const resolved = await service.resolve({
      scope,
      agentId: "agent-1",
      userId: "user-1",
      toolName: "reports.get",
    });

    expect(resolved.state).toBe(expected);
  });
});
