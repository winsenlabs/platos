// The READ half of the agent lifecycle: what a caller can see, and what it
// cannot.
//
// Split from the write half so each file stays inside the ADR M0.3 §6 budget.
// Every case here turns on the same rule: an agent is PRESENT in an environment
// only where a binding exists, whatever its project row says.

import { describe, expect, it } from "vitest";

import { asAgentsIdentifier, type AgentId, type RouteLabel } from "../domain/index.js";
import { createAgent } from "./create-agent.js";
import { removeAgent } from "./delete-agent.js";
import { describeAgent, describeAgentBySlug, listAgents, pageAgents } from "./read-agents.js";
import { buildAgentsTestContext, seedBoundAgent, testAgent, testEnvironmentScope } from "./testing/fixtures.js";
import { updateAgent } from "./update-agent.js";

function newContext() {
  const context = buildAgentsTestContext();
  return { context, authorization: context.tenancy.grant() };
}

describe("reading agents", () => {
  it("shows an agent bound in this environment", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context);
    const described = await describeAgent(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
    });
    if (!described.ok) throw new Error("unreachable");
    expect(described.value.agent.agentId).toBe(seeded.agent.agentId);
  });

  it("HIDES an agent whose project row exists but has no binding here", async () => {
    const { context, authorization } = newContext();
    const orphan = context.repository.seedAgent(
      testAgent(context.scope, { agentId: asAgentsIdentifier<AgentId>("agent-unbound") }),
    );
    const described = await describeAgent(context.dependencies, {
      authorization,
      agentId: orphan.agentId,
    });
    if (described.ok) throw new Error("unreachable");
    expect(described.error.code).toBe("AGENTS_AGENT_NOT_BOUND");
  });

  it("hides an agent bound in ANOTHER environment", async () => {
    const { context, authorization } = newContext();
    const elsewhere = testEnvironmentScope("env-9");
    const seeded = seedBoundAgent(context, { binding: { environmentId: elsewhere.environmentId } });
    expect((await describeAgent(context.dependencies, { authorization, agentId: seeded.agent.agentId })).ok).toBe(
      false,
    );
    const listed = await listAgents(context.dependencies, { authorization });
    if (!listed.ok) throw new Error("unreachable");
    expect(listed.value).toEqual([]);
  });

  it("resolves a slug through the same binding filter", async () => {
    const { context, authorization } = newContext();
    seedBoundAgent(context);
    const described = await describeAgentBySlug(context.dependencies, { authorization, slug: " support " });
    if (!described.ok) throw new Error("unreachable");
    expect(described.value.agent.slug).toBe("support");
  });

  it("refuses a slug this environment cannot see", async () => {
    const { context, authorization } = newContext();
    expect((await describeAgentBySlug(context.dependencies, { authorization, slug: "nope" })).ok).toBe(false);
  });

  it("clamps a page request and treats a blank search as no search", async () => {
    const { context, authorization } = newContext();
    seedBoundAgent(context);
    const paged = await pageAgents(context.dependencies, {
      authorization,
      limit: 10_000,
      offset: -4,
      search: "   ",
    });
    if (!paged.ok) throw new Error("unreachable");
    expect(paged.value.items).toHaveLength(1);
    expect(paged.value.total).toBe(1);
  });

  it("narrows by status, using the surface's own vocabulary", async () => {
    const { context, authorization } = newContext();
    seedBoundAgent(context, { agent: { isActive: false } });
    const active = await pageAgents(context.dependencies, { authorization, limit: 10, offset: 0, status: "active" });
    const paused = await pageAgents(context.dependencies, { authorization, limit: 10, offset: 0, status: "paused" });
    if (!active.ok || !paused.ok) throw new Error("unreachable");
    expect(active.value.total).toBe(0);
    expect(paused.value.total).toBe(1);
  });
});

describe("the skills handle is held and never called", () => {
  it("counts zero calls across a whole create, save and remove", async () => {
    const { context, authorization } = newContext();
    const created = await createAgent(context.dependencies, {
      authorization,
      name: "Support",
      createdBy: "operator-1",
      loadout: [{ environmentSkillId: asAgentsIdentifier("env-skill-mail"), enabled: true, config: {} }],
    });
    if (!created.ok) throw new Error("unreachable");
    await updateAgent(context.dependencies, {
      authorization,
      agentId: created.value.agent.agentId,
      updatedBy: "operator-1",
      maxSteps: 9,
    });
    await removeAgent(context.dependencies, { authorization, agentId: created.value.agent.agentId });
    expect(context.skills.calls).toBe(0);
  });
});

describe("route labels survive the whole write path", () => {
  it("round-trips a pinned route through create and read", async () => {
    const { context, authorization } = newContext();
    const created = await createAgent(context.dependencies, {
      authorization,
      name: "Router",
      createdBy: "operator-1",
      modelRoutes: [
        { label: "fast", model: "openai:gpt-5-mini", providerKeyId: "key-1", isDefault: true },
      ],
    });
    if (!created.ok) throw new Error("unreachable");
    const described = await describeAgent(context.dependencies, {
      authorization,
      agentId: created.value.agent.agentId,
    });
    if (!described.ok) throw new Error("unreachable");
    const route = described.value.activeVersion.snapshot.modelRoutes?.[0];
    expect(route?.label).toBe(asAgentsIdentifier<RouteLabel>("fast"));
    expect(route?.providerKeyId).toBe("key-1");
  });
});
