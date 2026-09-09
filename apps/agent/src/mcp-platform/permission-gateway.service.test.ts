import { describe, expect, it, vi } from "vitest";
import { MCPPermissionGatewayService } from "./permission-gateway.service";

const scope = {
  organizationId: "org-1",
  projectId: "project-1",
  environmentId: "env-1",
};

/**
 * The chain the doubled store reports for `env-1`, COHERENT by default.
 *
 * WIN-268 (M4.2). This double did not exist, and its absence is why this suite
 * could not have seen the tier-2 defect: with no `environment` delegate at all,
 * every case here asserted what `organizationMcpPolicy.findMany` was HANDED,
 * never which organization the environment actually belongs to. The forged case
 * lives in `permission-gateway-forged-scope.integration.test.ts` against a real
 * database, because a doubled client answers any where-clause however it was
 * told to; what is doubled here is the chain, so the REFUSAL BRANCH is reachable
 * without one.
 */
const COHERENT_CHAIN = {
  id: "env-1",
  project: { id: "project-1", organizationId: "org-1" },
};

function harness(
  options: {
    orgPolicies?: Array<{ pattern: string; effect: "ALLOW" | "DENY" }>;
    binding?: unknown;
    /** `null` for "no such environment"; omit for the coherent chain. */
    chain?: { id: string; project: { id: string; organizationId: string } } | null;
  } = {}
) {
  const prisma = {
    environment: {
      findUnique: vi
        .fn()
        .mockResolvedValue(options.chain === undefined ? COHERENT_CHAIN : options.chain),
    },
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
    // WIN-268 (M4.2). THE CASE NAME WAS TRUE AND ITS ASSERTION WAS NOT. It said
    // "ancestry" and asserted that the id from the REQUEST reached the
    // where-clause — which is exactly what the defect did. The two are told
    // apart by reading the chain FIRST: `org-1` reaches the policy read here
    // only because the environment's own project says so.
    const { service, prisma } = harness({
      orgPolicies: [{ pattern: "reports.*", effect: "ALLOW" }],
    });

    const resolved = await service.resolve({
      scope,
      agentId: null,
      userId: "user-1",
      toolName: "reports.get",
    });

    expect(prisma.environment.findUnique).toHaveBeenCalledWith({
      where: { id: "env-1" },
      select: { id: true, project: { select: { id: true, organizationId: true } } },
    });
    expect(prisma.organizationMcpPolicy.findMany).toHaveBeenCalledWith({
      where: { organizationId: "org-1" },
      select: { pattern: true, effect: true },
    });
    expect(resolved.state).toBe("auto_allow");
  });

  it("refuses at tier 2, and reads no policy at all, when the claimed chain is broken", async () => {
    // The store says `env-1` belongs to another organization. The old code read
    // the CLAIMED `org-1`, found nothing, and abstained. The refusal must happen
    // BEFORE any policy read, which is why the second assertion is on a call that
    // never happened rather than only on the verdict.
    const { service, prisma } = harness({
      orgPolicies: [{ pattern: "reports.*", effect: "DENY" }],
      chain: { id: "env-1", project: { id: "project-1", organizationId: "org-OTHER" } },
    });

    const resolved = await service.resolve({
      scope,
      agentId: null,
      userId: "user-1",
      toolName: "reports.get",
    });

    expect(resolved).toEqual({
      state: "block",
      tier: 2,
      reason: "scope project-outside-claimed-organization",
    });
    expect(prisma.organizationMcpPolicy.findMany).not.toHaveBeenCalled();
  });

  it("distinguishes a wrong project from a wrong organization from a missing environment", async () => {
    // Distinct codes. Two guards answering the same code cannot be told apart in
    // an audit line, and the three causes call for three different responses.
    const wrongProject = await harness({
      chain: { id: "env-1", project: { id: "project-OTHER", organizationId: "org-1" } },
    }).service.resolve({ scope, agentId: null, userId: "user-1", toolName: "reports.get" });
    expect(wrongProject.reason).toBe("scope environment-outside-claimed-project");

    const missing = await harness({ chain: null }).service.resolve({
      scope,
      agentId: null,
      userId: "user-1",
      toolName: "reports.get",
    });
    expect(missing.reason).toBe("scope environment-not-found");
  });

  it("a broken chain wins over a tier-1 require_approval rather than softening to it", async () => {
    // ORDERING, PINNED. `gdpr.*` carries a tier-1 MINIMUM of `require_approval`,
    // which is not terminal — only `block` is — so tier 2 still runs and its
    // refusal must be the answer. A fix that let the tier-1 minimum stand would
    // turn "I cannot verify the tenant you named" into "ask a human", which is a
    // question no human can answer because the scope in front of them is not a
    // real chain.
    //
    // TIER 1 HAS NO `block` ENTRY AT ALL TODAY: every row in
    // PLATFORM_TIER_MINIMUMS is `require_approval`, so the terminal tier-1 branch
    // in `resolve` is unreachable from the table. That is recorded here rather
    // than asserted as a property, because it is a fact about the table's
    // contents and not about this code.
    const { service } = harness({ chain: null });
    const resolved = await service.resolve({
      scope,
      agentId: null,
      userId: "user-1",
      toolName: "gdpr.purge",
    });
    expect(resolved).toEqual({ state: "block", tier: 2, reason: "scope environment-not-found" });
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
