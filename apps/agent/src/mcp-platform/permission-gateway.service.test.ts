// WIN-268 P2 — the harness now drives an `McpPolicyReader`, not a fake
// `PrismaClient`. The two `where`-clause assertions this suite used to make have
// gone to `mcp-policy.integration.test.ts`, where they are made against a real
// PostgreSQL with two tenants — because a `where` clause asserted against a
// mock proves only that a string was spelled a certain way, and the claim worth
// making is that a foreign row is actually excluded.
//
// The lattice cases below are unchanged in substance and are the right thing to
// unit-test: they are pure, and a database would only slow them down.

import { describe, expect, it, vi } from "vitest";
import { MCPPermissionGatewayService, McpScopeRefusedError } from "./permission-gateway.service";
import type { AgentPolicyBinding, McpPolicyReader, OrganizationPolicyRow } from "./mcp-policy.store";
import { MCP_SCOPE_FOREIGN, MCP_SCOPE_UNKNOWN, scopeAllowed, scopeRefused, type ScopeRefusalReason } from "./mcp-scope";

const scope = {
  organizationId: "org-1",
  projectId: "project-1",
  environmentId: "env-1",
};

function policyRow(pattern: string, effect: "ALLOW" | "DENY"): OrganizationPolicyRow {
  return {
    id: `policy-${pattern}`,
    organizationId: scope.organizationId,
    pattern,
    effect,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  };
}

function harness(
  options: {
    orgPolicies?: Array<{ pattern: string; effect: "ALLOW" | "DENY" }>;
    binding?: AgentPolicyBinding | null;
    refuse?: ScopeRefusalReason;
  } = {}
) {
  const guard = <Value>(value: Value) =>
    options.refuse ? scopeRefused(options.refuse) : scopeAllowed(value);
  const reader: McpPolicyReader = {
    listOrganizationPolicies: vi.fn(async () =>
      guard((options.orgPolicies ?? []).map((row) => policyRow(row.pattern, row.effect)) as readonly OrganizationPolicyRow[]),
    ),
    findAgentPolicyBinding: vi.fn(async () => guard(options.binding ?? null)),
    upsertOrganizationPolicy: vi.fn(async (_scope, pattern, effect) =>
      guard(policyRow(pattern, effect)),
    ),
    deleteOrganizationPolicy: vi.fn(async () => guard(true)),
  };
  return { service: new MCPPermissionGatewayService(reader), reader };
}

describe("MCPPermissionGatewayService canonical policies", () => {
  it("scopes organization policies only by authenticated organization ancestry", async () => {
    const { service, reader } = harness({
      orgPolicies: [{ pattern: "reports.*", effect: "ALLOW" }],
    });

    const resolved = await service.resolve({
      scope,
      agentId: null,
      userId: "user-1",
      toolName: "reports.get",
    });

    // The gateway hands the WHOLE claimed triple down. It used to hand down
    // `organizationId` alone, which is what made a forged organization
    // unnoticeable; the store is the thing that resolves it, and
    // `mcp-policy.integration.test.ts` proves it does.
    expect(reader.listOrganizationPolicies).toHaveBeenCalledWith(scope);
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
    const { service, reader } = harness({
      binding: { defaultPolicy: "ALL", explicitEffect: null },
    });

    const resolved = await service.resolve({
      scope,
      agentId: "agent-1",
      userId: "user-1",
      toolName: "reports.get",
    });

    expect(reader.findAgentPolicyBinding).toHaveBeenCalledWith(scope, "agent-1", "reports.get");
    expect(resolved.state).toBe("auto_allow");
  });

  it.each([
    ["DENY", "block"],
    ["ALLOW", "auto_allow"],
  ] as const)("applies explicit AgentToolPolicy %s as %s", async (effect, expected) => {
    const { service } = harness({
      binding: {
        defaultPolicy: effect === "DENY" ? "ALL" : "NONE",
        explicitEffect: effect,
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
      binding: { defaultPolicy: toolDefaultPolicy, explicitEffect: null },
    });

    const resolved = await service.resolve({
      scope,
      agentId: "agent-1",
      userId: "user-1",
      toolName: "reports.get",
    });

    expect(resolved.state).toBe(expected);
  });
  // -------------------------------------------------------------------------
  // WIN-268 P2 — THE FORGED SCOPE, AT THE UNIT LEVEL.
  //
  // These pin the GATEWAY's half of the contract: given a store that refuses,
  // `resolve` must BLOCK and say which tier discovered it, and the three CRUD
  // helpers must throw rather than answer. The store's half — that a forged
  // triple is actually detected against a real tree — is
  // `mcp-policy.integration.test.ts`, against real PostgreSQL with two tenants.
  //
  // WHY BOTH HALVES ARE NEEDED. A unit test alone would prove only that the
  // gateway handles a refusal its own double invented. An integration test
  // alone would prove the store refuses and say nothing about whether the
  // gateway then fails closed or swallows it.
  // -------------------------------------------------------------------------

  it.each([
    [MCP_SCOPE_FOREIGN],
    [MCP_SCOPE_UNKNOWN],
  ])("blocks at tier 2 when the claimed scope is %s, with no agent in play", async (reason) => {
    const { service, reader } = harness({
      orgPolicies: [{ pattern: "reports.*", effect: "ALLOW" }],
      refuse: reason,
    });

    await expect(
      service.resolve({ scope, agentId: null, userId: "user-1", toolName: "reports.get" }),
    ).resolves.toEqual({ state: "block", tier: 2, reason: `scope ${reason}` });

    // Tier 3 is never consulted: a scope that is not a chain cannot be made to
    // do more work by asking it another question.
    expect(reader.findAgentPolicyBinding).not.toHaveBeenCalled();
  });

  it("MUTATION GUARD: the pre-P2 behaviour — abstain on a forged scope — is now RED", async () => {
    // The extraction source read `where: { organizationId: scope.organizationId }`
    // and, for an organization with no policy rows, got `[]` -> `null` -> "this
    // tier has no objection" -> `auto_allow`. That is precisely the outcome this
    // case forbids. An implementation that dropped the refusal branch and fell
    // through to an empty policy list would produce `auto_allow` here and fail.
    const { service } = harness({ refuse: MCP_SCOPE_FOREIGN });
    const resolved = await service.resolve({
      scope,
      agentId: null,
      userId: "user-1",
      toolName: "reports.get",
    });
    expect(resolved.state).not.toBe("auto_allow");
    expect(resolved.state).toBe("block");
  });

  it("the three CRUD helpers throw a named refusal rather than answering falsely", async () => {
    const { service } = harness({ refuse: MCP_SCOPE_FOREIGN });

    await expect(service.listOrgPolicies(scope)).rejects.toThrow(McpScopeRefusedError);
    await expect(service.upsertOrgPolicy(scope, "reports.*", "block")).rejects.toThrow(
      McpScopeRefusedError,
    );
    // `deleteOrgPolicy` is the one that matters most: it already answered
    // `false` for "no such row", so a refusal reported through the return value
    // would have been indistinguishable from a delete of a row already gone.
    await expect(service.deleteOrgPolicy(scope, "policy-1")).rejects.toMatchObject({
      reason: MCP_SCOPE_FOREIGN,
    });
  });
});
