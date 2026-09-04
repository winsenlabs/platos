import { describe, expect, it } from "vitest";

import {
  buildAgentsTestContext,
  seedBoundAgent,
  testMacro,
  testTemplate,
  type AgentsTestContext,
} from "../application/testing/index.js";
import {
  asAgentsIdentifier,
  RUNTIME_ENVELOPE_KEY,
  type AgentId,
  type AgentVersionId,
} from "../domain/index.js";
import {
  AGENTS_ERROR_CODES,
  AGENTS_EVENT_NAMES,
  agentsContract,
  COMPACTION_ROUTE_LABEL,
  DEFAULT_AGENTS_POLICY,
  MAX_CANARY_PERCENT,
  TOOL_CALL_MODES,
  TOOL_DEFAULT_POLICIES,
  TOOL_DISPLAY_MODES,
  TOOL_EXPOSURES,
} from "./index.js";

function build(context: AgentsTestContext) {
  return agentsContract(context.dependencies);
}

describe("the contract is the whole surface", () => {
  it("names itself and is frozen", () => {
    const contract = build(buildAgentsTestContext());
    expect(contract.name).toBe("agents");
    expect(Object.isFrozen(contract)).toBe(true);
  });

  it("publishes the policy and the closed vocabularies as data", () => {
    expect(DEFAULT_AGENTS_POLICY.defaults.model).toBe("anthropic:claude-sonnet-4-6");
    expect([...TOOL_CALL_MODES]).toEqual(["direct", "sub-agent", "execute-tool"]);
    expect([...TOOL_DISPLAY_MODES]).toEqual(["full", "summary", "meta-tool", "hybrid"]);
    expect([...TOOL_EXPOSURES]).toEqual(["direct", "meta"]);
    expect([...TOOL_DEFAULT_POLICIES]).toEqual(["NONE", "ALL"]);
    expect(COMPACTION_ROUTE_LABEL).toBe("compaction");
    expect(MAX_CANARY_PERCENT).toBe(100);
    expect(AGENTS_ERROR_CODES.length).toBeGreaterThan(0);
  });

  it("names every integration event under this context's own prefix", () => {
    for (const name of AGENTS_EVENT_NAMES) {
      expect(name.startsWith("agents.")).toBe(true);
      expect(name).toMatch(/^[a-z]+(?:\.[a-z_]+)+$/u);
    }
    expect(new Set(AGENTS_EVENT_NAMES).size).toBe(AGENTS_EVENT_NAMES.length);
  });

  it("binds every declared method to a use case", () => {
    const contract = build(buildAgentsTestContext());
    for (const [name, member] of Object.entries(contract)) {
      if (name === "name") continue;
      expect(typeof member).toBe("function");
    }
  });
});

describe("views withhold what the boundary must not carry", () => {
  it("NEVER puts the runtime envelope in an agent view", async () => {
    const context = buildAgentsTestContext();
    const seeded = seedBoundAgent(context, { source: { memoryConfig: { retentionDays: 30 } } });
    const contract = build(context);
    const described = await contract.describeAgent({
      authorization: context.tenancy.grant(),
      agentId: seeded.agent.agentId,
    });
    if (!described.ok) throw new Error("unreachable");
    expect(JSON.stringify(described.value)).not.toContain(RUNTIME_ENVELOPE_KEY);
    expect(described.value.configuration.memoryConfig).toEqual({ retentionDays: 30 });
  });

  it("carries no thread count, which belongs to the context that owns Thread", () => {
    const context = buildAgentsTestContext();
    const seeded = seedBoundAgent(context);
    const contract = build(context);
    return contract
      .describeAgent({ authorization: context.tenancy.grant(), agentId: seeded.agent.agentId })
      .then((described) => {
        if (!described.ok) throw new Error("unreachable");
        expect(Object.keys(described.value)).not.toContain("_count");
        expect(Object.keys(described.value)).not.toContain("threadCount");
      });
  });

  it("publishes BOTH version ids on a write that minted one, for the tools hand-off", async () => {
    const context = buildAgentsTestContext();
    const seeded = seedBoundAgent(context);
    const contract = build(context);
    const changed = await contract.enableSkill({
      authorization: context.tenancy.grant(),
      agentId: seeded.agent.agentId,
      environmentSkillId: asAgentsIdentifier("env-skill-mail"),
      changedBy: "operator-1",
    });
    if (!changed.ok) throw new Error("unreachable");
    expect(changed.value.previousVersionId).toBe(seeded.version.agentVersionId);
    expect(changed.value.versionId).not.toBe(changed.value.previousVersionId);
  });

  it("keeps a loadout view thin: an id and its assignment state, no skill name", async () => {
    const context = buildAgentsTestContext();
    const seeded = seedBoundAgent(context);
    context.repository.seedLoadout(seeded.version.agentVersionId, [
      { environmentSkillId: asAgentsIdentifier("env-skill-mail"), enabled: true, config: {} },
    ]);
    const contract = build(context);
    const read = await contract.readLoadout({
      authorization: context.tenancy.grant(),
      agentId: seeded.agent.agentId,
    });
    if (!read.ok) throw new Error("unreachable");
    expect(Object.keys(read.value[0] ?? {}).sort()).toEqual(["config", "enabled", "environmentSkillId"]);
    expect(context.skills.calls).toBe(0);
  });

  it("answers with a model and a key, never with a callable session", async () => {
    const context = buildAgentsTestContext();
    const seeded = seedBoundAgent(context, { source: { model: "openai:gpt-5" } });
    const contract = build(context);
    const resolved = await contract.resolveRoute({
      authorization: context.tenancy.grant(),
      agentId: seeded.agent.agentId,
    });
    if (!resolved.ok) throw new Error("unreachable");
    expect(Object.keys(resolved.value).sort()).toEqual([
      "credentialName",
      "label",
      "model",
      "provider",
      "providerKeyId",
    ]);
  });
});

describe("every method returns a Result rather than throwing", () => {
  it("answers a refusal for an unminted authorization on a read and on a write", async () => {
    const context = buildAgentsTestContext();
    const contract = build(context);
    const read = await contract.listAgents({ authorization: {} });
    expect(read.ok).toBe(false);
    const write = await contract.createAgent({ authorization: {}, name: "x", createdBy: "o" });
    expect(write.ok).toBe(false);
  });

  it("answers a refusal for an agent the caller cannot see", async () => {
    const context = buildAgentsTestContext();
    const contract = build(context);
    const described = await contract.describeAgent({
      authorization: context.tenancy.grant(),
      agentId: asAgentsIdentifier<AgentId>("nope"),
    });
    if (described.ok) throw new Error("unreachable");
    expect(described.error.code).toBe("AGENTS_AGENT_NOT_BOUND");
  });
});

describe("the contract composes a whole agent lifecycle", () => {
  it("creates, saves, canaries, promotes and unbinds through the published surface alone", async () => {
    const context = buildAgentsTestContext();
    const authorization = context.tenancy.grant();
    const contract = build(context);

    const created = await contract.createAgent({
      authorization,
      name: "Customer Support",
      createdBy: "operator-1",
    });
    if (!created.ok) throw new Error("unreachable");
    expect(created.value.currentVersionNumber).toBe(1);

    const saved = await contract.updateAgent({
      authorization,
      agentId: asAgentsIdentifier<AgentId>(created.value.agentId),
      updatedBy: "operator-1",
      maxSteps: 40,
    });
    if (!saved.ok) throw new Error("unreachable");
    expect(saved.value.previousVersionId).toBe(created.value.currentVersionId);

    const canaried = await contract.setCanary({
      authorization,
      agentId: asAgentsIdentifier<AgentId>(created.value.agentId),
      canaryVersionId: asAgentsIdentifier<AgentVersionId>(created.value.currentVersionId),
      canaryPercent: 50,
    });
    if (!canaried.ok) throw new Error("unreachable");
    expect(canaried.value.canaryVersionNumber).toBe(1);

    const promoted = await contract.promoteCanary({
      authorization,
      agentId: asAgentsIdentifier<AgentId>(created.value.agentId),
    });
    if (!promoted.ok) throw new Error("unreachable");
    expect(promoted.value.currentVersionNumber).toBe(1);
    expect(promoted.value.canaryVersionId).toBeNull();

    const removed = await contract.removeAgent({
      authorization,
      agentId: asAgentsIdentifier<AgentId>(created.value.agentId),
    });
    if (!removed.ok) throw new Error("unreachable");
    expect(removed.value.deactivatesAgent).toBe(true);
  });

  it("reads a version history with the live version marked", async () => {
    const context = buildAgentsTestContext();
    const authorization = context.tenancy.grant();
    const seeded = seedBoundAgent(context);
    const contract = build(context);
    const paged = await contract.pageVersions({ authorization, agentId: seeded.agent.agentId });
    if (!paged.ok) throw new Error("unreachable");
    expect(paged.value.items[0]?.isCurrent).toBe(true);
    expect(paged.value.total).toBe(1);
  });

  it("runs a cluster through create, join and describe", async () => {
    const context = buildAgentsTestContext();
    const authorization = context.tenancy.grant();
    const seeded = seedBoundAgent(context);
    const contract = build(context);

    const created = await contract.createCluster({ authorization, name: "Frontline" });
    if (!created.ok) throw new Error("unreachable");
    const joined = await contract.addAgentToCluster({
      authorization,
      clusterId: asAgentsIdentifier(created.value.clusterId),
      agentId: seeded.agent.agentId,
    });
    if (!joined.ok) throw new Error("unreachable");
    expect(joined.value.primaryAgentId).toBe(seeded.agent.agentId);
    expect(joined.value.members).toEqual([seeded.agent.agentId]);
  });

  it("lists a macro with the basis on which the caller may see it", async () => {
    const context = buildAgentsTestContext();
    const authorization = context.tenancy.grant();
    context.scaffolding.seedMacro(testMacro(context.scope, { sharedWithOrganization: true }));
    const contract = build(context);
    const listed = await contract.listMacros({ authorization, actorId: "operator-2" });
    if (!listed.ok) throw new Error("unreachable");
    expect(listed.value[0]?.access).toBe("shared");
  });

  it("pages saved requests with the default first", async () => {
    const context = buildAgentsTestContext();
    const authorization = context.tenancy.grant();
    const seeded = seedBoundAgent(context);
    context.scaffolding.seedTemplate(
      testTemplate(context.scope, seeded.agent.agentId, { isDefault: true }),
    );
    const contract = build(context);
    const paged = await contract.pageTemplates({ authorization, limit: 10, offset: 0 });
    if (!paged.ok) throw new Error("unreachable");
    expect(paged.value.items[0]?.isDefault).toBe(true);
  });

  it("answers a deterministic version choice for a turn", async () => {
    const context = buildAgentsTestContext();
    const authorization = context.tenancy.grant();
    const seeded = seedBoundAgent(context);
    const contract = build(context);
    const chosen = await contract.selectVersion({
      authorization,
      agentId: seeded.agent.agentId,
      threadId: null,
      draw: 0.5,
    });
    if (!chosen.ok) throw new Error("unreachable");
    expect(chosen.value).toEqual({ versionId: seeded.version.agentVersionId, bucket: "current" });
  });

  it("reports a retention plan without deleting anything", async () => {
    const context = buildAgentsTestContext();
    const authorization = context.tenancy.grant();
    const seeded = seedBoundAgent(context);
    const contract = build(context);
    const plan = await contract.planVersionPrune({ authorization, agentId: seeded.agent.agentId });
    if (!plan.ok) throw new Error("unreachable");
    expect(plan.value.dryRun).toBe(true);
    expect(plan.value.eligible).toEqual([]);
  });
});
