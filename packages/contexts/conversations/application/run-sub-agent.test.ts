// Delegation, through the use case: the ceilings, the narrowing, and where the
// money lands.
//
// Mutations M-SA1 (the ceilings reaching the use case), M-SA2 (the catalogue
// intersection — deleting it makes delegation a privilege-escalation seam),
// M-SA3 (the delegation tool being withheld at the depth ceiling), M-SA4 (the
// delegated steps taking the sequence they were given).

import { describe, expect, it } from "vitest";
import { asIdentifier, type EnvironmentScope } from "@platos/kernel";

import { DELEGATION_TOOL_NAMES, narrowToParentCatalogue, runSubAgent } from "./run-sub-agent.js";
import { buildConversationsTestContext, runtimeGrant, THREAD_ID } from "./testing/index.js";
import {
  buildToolCatalogue,
  DEFAULT_CONVERSATIONS_POLICY,
  rootChain,
  type AgentId,
  type OfferedTool,
  type TurnId,
} from "../domain/index.js";

const SCOPE = {
  level: "environment",
  organizationId: "org-1",
  projectId: "proj-1",
  environmentId: "env-1",
} as EnvironmentScope;

const agent = (name: string) => asIdentifier<AgentId>(name);

function catalogue(names: readonly string[]) {
  const offers: OfferedTool[] = names.map((name) => ({
    name,
    description: name,
    inputSchema: { type: "object" },
    source: "tools",
  }));
  const built = buildToolCatalogue(offers, 100);
  if (!built.ok) throw new Error(built.error.code);
  return built.value;
}

function command(overrides: Record<string, unknown> = {}) {
  return {
    authorization: runtimeGrant(),
    scope: SCOPE,
    parentTurnId: asIdentifier<TurnId>("turn-1"),
    threadId: THREAD_ID,
    chain: rootChain(agent("a")),
    childAgentId: agent("b"),
    fanOutSoFar: 0,
    instruction: "do the sub-task",
    systemPrompt: "You are a helper.",
    parentCatalogue: catalogue(["search", "spawn_agent"]),
    allowedToolNames: null,
    model: "anthropic:claude-test",
    providerKeyId: null,
    firstStepSequence: 2,
    ...overrides,
  } as Parameters<typeof runSubAgent>[1];
}

describe("narrowToParentCatalogue", () => {
  it("intersects with the allow-list and never widens", () => {
    const narrowed = narrowToParentCatalogue(catalogue(["a", "b", "c"]), ["b", "z"], 100);
    expect(narrowed.ok).toBe(true);
    if (!narrowed.ok) return;
    // `z` was not the parent's, so the child does not get it either.
    expect(narrowed.value.tools.map((tool) => tool.name)).toEqual(["b"]);
  });

  it("a null allow-list means the PARENT's tools, which is still an intersection", () => {
    const narrowed = narrowToParentCatalogue(catalogue(["a", "b"]), null, 100);
    if (!narrowed.ok) throw new Error(narrowed.error.code);
    expect(narrowed.value.tools.map((tool) => tool.name)).toEqual(["a", "b"]);
  });

  it("has no parameter that could ADD a tool", () => {
    expect(narrowToParentCatalogue.length).toBe(3);
  });
});

describe("runSubAgent", () => {
  it("runs the child and returns the steps for the PARENT's turn", async () => {
    const context = buildConversationsTestContext();
    const ran = await runSubAgent(context.dependencies, command());
    expect(ran.ok).toBe(true);
    if (!ran.ok) return;
    expect(ran.value.text).toBe("the answer");
    expect(ran.value.steps).toHaveLength(1);
    // The delegated spend is work the parent's turn caused, so it lands on the
    // parent's turn at the sequence it was given.
    expect(ran.value.steps[0]?.turnId).toBe("turn-1");
    expect(ran.value.steps[0]?.sequence).toBe(2);
    expect(ran.value.steps[0]?.cost?.microCents).toBe(600_000n);
    expect(ran.value.chain.agentIds).toEqual(["a", "b"]);
  });

  it("refuses when the KILL SWITCH is off, and calls no provider", async () => {
    const context = buildConversationsTestContext({
      ...DEFAULT_CONVERSATIONS_POLICY,
      subAgent: { ...DEFAULT_CONVERSATIONS_POLICY.subAgent, subAgentsEnabled: false },
    });
    const refused = await runSubAgent(context.dependencies, command());
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_SUB_AGENTS_DISABLED");
    expect(context.providers.generated).toHaveLength(0);
  });

  it("refuses a CYCLE before any money is spent", async () => {
    const context = buildConversationsTestContext();
    const refused = await runSubAgent(
      context.dependencies,
      command({ chain: { agentIds: [agent("a"), agent("b")] }, childAgentId: agent("a") }),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_SUB_AGENT_CYCLE");
    expect(context.providers.generated).toHaveLength(0);
  });

  it("refuses past the DEPTH ceiling and past the FAN-OUT ceiling, distinctly", async () => {
    const context = buildConversationsTestContext();
    const tooDeep = await runSubAgent(
      context.dependencies,
      command({
        chain: { agentIds: [agent("a"), agent("b"), agent("c")] },
        childAgentId: agent("d"),
      }),
    );
    const tooWide = await runSubAgent(
      context.dependencies,
      command({ fanOutSoFar: DEFAULT_CONVERSATIONS_POLICY.subAgent.maxFanOut }),
    );
    expect(tooDeep.ok).toBe(false);
    expect(tooWide.ok).toBe(false);
    if (tooDeep.ok || tooWide.ok) return;
    expect(tooDeep.error.code).toBe("CONVERSATIONS_SUB_AGENT_DEPTH_EXCEEDED");
    expect(tooWide.error.code).toBe("CONVERSATIONS_SUB_AGENT_FAN_OUT_EXCEEDED");
  });

  it("offers the child a NARROWED catalogue and nothing the parent lacked", async () => {
    const context = buildConversationsTestContext();
    await runSubAgent(
      context.dependencies,
      command({ allowedToolNames: ["search", "a_tool_the_parent_never_had"] }),
    );
    expect(context.providers.generated[0]?.toolNames).toEqual(["search"]);
  });

  it("WITHHOLDS the delegation tools at the depth ceiling, rather than refusing later", async () => {
    const context = buildConversationsTestContext();
    const ran = await runSubAgent(
      context.dependencies,
      command({ chain: { agentIds: [agent("a"), agent("b")] }, childAgentId: agent("c") }),
    );
    expect(ran.ok).toBe(true);
    // A model cannot ask for what it was not offered, which is the source's
    // better mechanism and the one kept.
    const offered = context.providers.generated[0]?.toolNames ?? [];
    for (const name of DELEGATION_TOOL_NAMES) expect(offered).not.toContain(name);
    expect(offered).toContain("search");
  });

  it("OFFERS the delegation tools while there is depth left", async () => {
    const context = buildConversationsTestContext();
    await runSubAgent(context.dependencies, command());
    expect(context.providers.generated[0]?.toolNames).toContain("spawn_agent");
  });

  it("clamps the delegated step budget to the sub-agent ceiling", async () => {
    const context = buildConversationsTestContext();
    await runSubAgent(context.dependencies, command({ requestedMaxSteps: 10_000 }));
    expect(context.providers.generated[0]?.maxSteps).toBe(
      DEFAULT_CONVERSATIONS_POLICY.subAgent.maxStepsPerSubAgent,
    );
  });

  it("reports a provider refusal as this context's own generation failure", async () => {
    const context = buildConversationsTestContext();
    context.providers.failWith("the provider is down");
    const refused = await runSubAgent(context.dependencies, command());
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_GENERATION_FAILED");
  });
});
