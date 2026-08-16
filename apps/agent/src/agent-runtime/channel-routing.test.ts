import { describe, expect, it } from "vitest";
import { MAX_AGENT_ROUTING_RULES, validateAgentRouting } from "./channel-routing";

const scope = {
  organizationId: "org1",
  projectId: "project1",
  environmentId: "environment1",
};

describe("validateAgentRouting clean AgentBinding scope", () => {
  it("normalizes ordered rules and validates clean Agent bindings canonically", async () => {
    let observedWhere: any;
    const prisma = {
      agent: {
        findMany: async ({ where }: any) => {
          observedWhere = where;
          return [{ id: "agent1" }, { id: "agent2" }];
        },
      },
    };

    const result = await validateAgentRouting(prisma, scope, [
      {
        match: { type: "prefix", value: "  Ada  ", ignored: true },
        agentId: "agent1",
        ignored: true,
      },
      { match: { type: "channel", id: " C123 " }, agentId: "agent2" },
      { match: { type: "channel", id: "C999" }, agentId: "agent1" },
    ]);

    expect(result).toEqual({
      ok: true,
      rules: [
        { match: { type: "prefix", value: "ada" }, agentId: "agent1" },
        { match: { type: "channel", id: "C123" }, agentId: "agent2" },
        { match: { type: "channel", id: "C999" }, agentId: "agent1" },
      ],
    });
    expect(observedWhere).toEqual({
      id: { in: ["agent1", "agent2"] },
      projectId: "project1",
      bindings: {
        some: {
          environmentId: "environment1",
          environment: {
            project: { id: "project1", organizationId: "org1" },
          },
        },
      },
    });
  });

  it("rejects every forged or missing agent id in one batched query", async () => {
    const prisma = {
      agent: {
        findMany: async () => [{ id: "agent1" }],
      },
    };

    const result = await validateAgentRouting(prisma, scope, [
      { match: { type: "channel", id: "C1" }, agentId: "agent1" },
      { match: { type: "prefix", value: "x" }, agentId: "foreign-agent" },
      { match: { type: "channel", id: "C2" }, agentId: "missing-agent" },
    ]);

    expect(result).toEqual({
      ok: false,
      error: "unknown_agent_id",
      message: "agentRouting references agent id(s) not in scope: foreign-agent, missing-agent",
    });
  });

  it("preserves validation limits and rejects malformed match clauses", async () => {
    const prisma = { agent: { findMany: async () => [] } };
    expect(
      await validateAgentRouting(
        prisma,
        scope,
        Array.from({ length: MAX_AGENT_ROUTING_RULES + 1 }, () => ({}))
      )
    ).toMatchObject({ ok: false, error: "invalid_agent_routing" });
    expect(
      await validateAgentRouting(prisma, scope, [
        { match: { type: "prefix", value: "" }, agentId: "agent1" },
      ])
    ).toEqual({
      ok: false,
      error: "invalid_agent_routing",
      message: 'rule[0].match.value is required for a "prefix" rule',
    });
  });
});
