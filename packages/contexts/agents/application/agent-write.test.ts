// The WRITE half of the agent lifecycle: create, save, unbind.
//
// Split from the read half so each file stays inside the ADR M0.3 §6 budget.
// The seam is the one the budget was pointing at: these cases assert what a
// write PUT IN THE STORE — the transaction, the version, the carried loadout —
// and the read half asserts what a caller can SEE.

import { describe, expect, it } from "vitest";

import { asAgentsIdentifier, type AgentId, type RouteLabel } from "../domain/index.js";
import { createAgent } from "./create-agent.js";
import { removeAgent } from "./delete-agent.js";
import { buildAgentsTestContext, seedBoundAgent, testAgent, testEnvironmentScope } from "./testing/fixtures.js";
import { updateAgent } from "./update-agent.js";

function newContext() {
  const context = buildAgentsTestContext();
  return { context, authorization: context.tenancy.grant() };
}

describe("creating an agent", () => {
  it("writes the row, its first version and the binding in ONE transaction", async () => {
    const { context, authorization } = newContext();
    const created = await createAgent(context.dependencies, {
      authorization,
      name: "Customer Support",
      createdBy: "operator-1",
    });
    if (!created.ok) throw new Error("unreachable");
    expect(created.value.agent.slug).toBe("customer-support");
    expect(created.value.activeVersion.versionNumber).toBe(1);
    expect(created.value.binding.activeVersionId).toBe(created.value.activeVersion.agentVersionId);
    expect(context.unitOfWork.transactions).toHaveLength(1);
    expect(context.repository.writes).toEqual([
      "insertAgent:txn-1",
      "insertVersion:txn-1",
      "replaceLoadout:txn-1",
      "insertBinding:txn-1",
    ]);
  });

  it("resolves the slug against the WHOLE project, not this environment's agents", async () => {
    const { context, authorization } = newContext();
    // An agent in the same project with no binding here still takes the slug.
    context.repository.seedAgent(
      testAgent(context.scope, { agentId: asAgentsIdentifier<AgentId>("agent-elsewhere") }),
    );
    const created = await createAgent(context.dependencies, {
      authorization,
      name: "Support",
      createdBy: "operator-1",
    });
    if (!created.ok) throw new Error("unreachable");
    expect(created.value.agent.slug).not.toBe("support");
    expect(created.value.agent.slug).toMatch(/^support-/u);
  });

  it("takes the model from the DEFAULT route when the request names none", async () => {
    const { context, authorization } = newContext();
    const created = await createAgent(context.dependencies, {
      authorization,
      name: "Router",
      createdBy: "operator-1",
      modelRoutes: [
        { label: "slow", model: "openai:gpt-5" },
        { label: "fast", model: "openai:gpt-5-mini", isDefault: true },
      ],
    });
    if (!created.ok) throw new Error("unreachable");
    expect(created.value.activeVersion.snapshot.model).toBe("openai:gpt-5-mini");
  });

  it("serializes prompt blocks into a system prompt when the request has none", async () => {
    const { context, authorization } = newContext();
    const created = await createAgent(context.dependencies, {
      authorization,
      name: "Blocked",
      createdBy: "operator-1",
      promptBlocks: [{ id: "b", type: "identity", name: "", content: "You are X.", enabled: true, order: 1 }],
    });
    if (!created.ok) throw new Error("unreachable");
    expect(created.value.activeVersion.snapshot.systemPrompt).toBe("You are X.");
  });

  it("prefers an explicit system prompt over the blocks", async () => {
    const { context, authorization } = newContext();
    const created = await createAgent(context.dependencies, {
      authorization,
      name: "Blocked",
      createdBy: "operator-1",
      systemPrompt: "Explicit.",
      promptBlocks: [{ id: "b", type: "identity", name: "", content: "Derived.", enabled: true, order: 1 }],
    });
    if (!created.ok) throw new Error("unreachable");
    expect(created.value.activeVersion.snapshot.systemPrompt).toBe("Explicit.");
  });

  it("refuses a blank name and an unusable slug before it touches the store", async () => {
    const { context, authorization } = newContext();
    expect((await createAgent(context.dependencies, { authorization, name: "  ", createdBy: "o" })).ok).toBe(
      false,
    );
    expect((await createAgent(context.dependencies, { authorization, name: "!!!", createdBy: "o" })).ok).toBe(
      false,
    );
    expect(context.repository.writes).toEqual([]);
  });

  it("refuses a routing table with two routes carrying the same label", async () => {
    const { context, authorization } = newContext();
    const created = await createAgent(context.dependencies, {
      authorization,
      name: "Router",
      createdBy: "operator-1",
      modelRoutes: [
        { label: "fast", model: "a" },
        { label: "fast", model: "b" },
      ],
    });
    if (created.ok) throw new Error("unreachable");
    expect(created.error.code).toBe("AGENTS_ROUTE_INVALID");
  });

  it("refuses an unminted authorization before anything else", async () => {
    const { context } = newContext();
    expect((await createAgent(context.dependencies, { authorization: {}, name: "x", createdBy: "o" })).ok).toBe(
      false,
    );
  });
});

describe("saving an agent", () => {
  it("renames WITHOUT minting a version", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context);
    const saved = await updateAgent(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      updatedBy: "operator-1",
      name: "Renamed",
    });
    if (!saved.ok) throw new Error("unreachable");
    expect(saved.value.renamed).toBe(true);
    expect(saved.value.previousVersionId).toBeNull();
    expect(saved.value.bound.activeVersion.agentVersionId).toBe(seeded.version.agentVersionId);
  });

  it("mints a version when the CONFIGURATION changes, and moves the binding", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context);
    const saved = await updateAgent(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      updatedBy: "operator-1",
      maxSteps: 42,
    });
    if (!saved.ok) throw new Error("unreachable");
    expect(saved.value.previousVersionId).toBe(seeded.version.agentVersionId);
    expect(saved.value.bound.activeVersion.versionNumber).toBe(2);
    expect(saved.value.bound.activeVersion.snapshot.maxSteps).toBe(42);
    expect(saved.value.bound.binding.activeVersionId).toBe(saved.value.bound.activeVersion.agentVersionId);
  });

  it("mints NOTHING when the save changes nothing", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context);
    const saved = await updateAgent(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      updatedBy: "operator-1",
      maxSteps: seeded.version.snapshot.maxSteps,
    });
    if (!saved.ok) throw new Error("unreachable");
    expect(saved.value.previousVersionId).toBeNull();
    expect(context.repository.writes.filter((write) => write.startsWith("insertVersion"))).toEqual([]);
  });

  it("CARRIES THE LOADOUT FORWARD onto the new version", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context);
    context.repository.seedLoadout(seeded.version.agentVersionId, [
      { environmentSkillId: asAgentsIdentifier("env-skill-mail"), enabled: true, config: {} },
      { environmentSkillId: asAgentsIdentifier("env-skill-cal"), enabled: false, config: {} },
    ]);
    const saved = await updateAgent(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      updatedBy: "operator-1",
      maxSteps: 42,
    });
    if (!saved.ok) throw new Error("unreachable");
    const carried = await context.repository.listLoadout(saved.value.bound.activeVersion.agentVersionId);
    if (!carried.ok) throw new Error("unreachable");
    expect(carried.value.map((entry) => entry.environmentSkillId).sort()).toEqual([
      "env-skill-cal",
      "env-skill-mail",
    ]);
    expect(carried.value.find((entry) => entry.environmentSkillId === "env-skill-cal")?.enabled).toBe(false);
  });

  it("MERGES a partial tools patch instead of replacing the stored object", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context, {
      source: { toolsBlockConfig: { mode: "sub-agent", displayMode: "full" } },
    });
    const saved = await updateAgent(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      updatedBy: "operator-1",
      toolsBlockConfig: { displayMode: "summary" },
    });
    if (!saved.ok) throw new Error("unreachable");
    const config = saved.value.bound.activeVersion.snapshot.toolsBlockConfig;
    expect(config?.displayMode).toBe("summary");
    expect(config?.mode).toBe("sub-agent");
  });

  it("syncs the model to the default route when routes are supplied and no model is", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context, { source: { model: "openai:gpt-5" } });
    const saved = await updateAgent(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      updatedBy: "operator-1",
      modelRoutes: [{ label: "fast", model: "anthropic:haiku", isDefault: true }],
    });
    if (!saved.ok) throw new Error("unreachable");
    expect(saved.value.bound.activeVersion.snapshot.model).toBe("anthropic:haiku");
  });

  it("keeps an explicitly supplied model even when routes are also supplied", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context);
    const saved = await updateAgent(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      updatedBy: "operator-1",
      model: "openai:gpt-5",
      modelRoutes: [{ label: "fast", model: "anthropic:haiku", isDefault: true }],
    });
    if (!saved.ok) throw new Error("unreachable");
    expect(saved.value.bound.activeVersion.snapshot.model).toBe("openai:gpt-5");
  });

  it("refuses a cluster from ANOTHER environment rather than writing the binding", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context);
    const saved = await updateAgent(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      updatedBy: "operator-1",
      clusterId: "cluster-elsewhere",
    });
    if (saved.ok) throw new Error("unreachable");
    expect(saved.error.code).toBe("AGENTS_CLUSTER_NOT_FOUND");
  });

  it("releases the thread holds only when a version was minted", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context);
    await updateAgent(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      updatedBy: "operator-1",
      name: "Renamed",
    });
    expect(context.versionLock.releases).toEqual([]);
    await updateAgent(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      updatedBy: "operator-1",
      maxSteps: 99,
    });
    expect(context.versionLock.releases).toHaveLength(1);
  });

  it("refuses a save against an agent this environment cannot see", async () => {
    const { context, authorization } = newContext();
    const saved = await updateAgent(context.dependencies, {
      authorization,
      agentId: asAgentsIdentifier<AgentId>("agent-nope"),
      updatedBy: "operator-1",
      name: "x",
    });
    if (saved.ok) throw new Error("unreachable");
    expect(saved.error.code).toBe("AGENTS_AGENT_NOT_BOUND");
  });
});

describe("removing an agent from an environment", () => {
  it("removes the BINDING and deactivates the agent when it was the last one", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context);
    const removed = await removeAgent(context.dependencies, { authorization, agentId: seeded.agent.agentId });
    if (!removed.ok) throw new Error("unreachable");
    expect(removed.value.deactivatesAgent).toBe(true);
    expect(context.repository.agents.get(seeded.agent.agentId)?.isActive).toBe(false);
    expect(context.repository.bindings.size).toBe(0);
  });

  it("leaves the agent ACTIVE while another environment still binds it", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context);
    context.repository.seedBinding({
      ...seeded.binding,
      agentBindingId: asAgentsIdentifier("binding-2"),
      environmentId: asAgentsIdentifier("env-9"),
    });
    const removed = await removeAgent(context.dependencies, { authorization, agentId: seeded.agent.agentId });
    if (!removed.ok) throw new Error("unreachable");
    expect(removed.value.deactivatesAgent).toBe(false);
    expect(context.repository.agents.get(seeded.agent.agentId)?.isActive).toBe(true);
  });

  it("mints no version: the configuration did not change", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context);
    await removeAgent(context.dependencies, { authorization, agentId: seeded.agent.agentId });
    expect(context.repository.writes.filter((write) => write.startsWith("insertVersion"))).toEqual([]);
  });

  // WIN-256 verification defect, 2026-09-03. `removeAgent` was the ONE of the
  // five `releaseHolds` call sites with no control: deleting its call line left
  // all 513 cases in this package green, so the release was decorative here —
  // it had a caller, but nothing asserted its effect. The other four
  // (updateAgent above, canary, loadout, version-history) each pin theirs.
  //
  // The consequence of the missing release is worse on THIS path than on a
  // save. A save moves live threads onto a newer version of an agent that is
  // still bound; an unbind leaves them pinned to a version of an agent that
  // this environment no longer serves at all, until each hold lapses on its own
  // timetable. So these assert the EFFECT on the lock — that the hold is gone —
  // rather than merely that a release was attempted, because a `releaseAll`
  // that recorded the call and freed nothing would pass the weaker check.
  it("RELEASES every thread hold for the agent it just unbound", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context);
    const key = { scope: context.scope, agentId: seeded.agent.agentId, threadId: "thread-1" };
    context.versionLock.seed(key, seeded.version.agentVersionId);
    expect((await context.versionLock.read(key)).ok && (await context.versionLock.read(key)).value).toBe(
      seeded.version.agentVersionId,
    );

    const removed = await removeAgent(context.dependencies, { authorization, agentId: seeded.agent.agentId });
    expect(removed.ok).toBe(true);

    const held = await context.versionLock.read(key);
    if (!held.ok) throw new Error("unreachable");
    expect(held.value).toBeNull();
    expect(context.versionLock.releases).toEqual([`${context.scope.environmentId}/${seeded.agent.agentId}`]);
  });

  it("releases NOTHING when the unbind was refused", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context);
    const key = { scope: context.scope, agentId: seeded.agent.agentId, threadId: "thread-1" };
    context.versionLock.seed(key, seeded.version.agentVersionId);

    // Refused: this environment cannot see that agent at all.
    const refused = await removeAgent(context.dependencies, {
      authorization,
      agentId: asAgentsIdentifier<AgentId>("nope"),
    });
    expect(refused.ok).toBe(false);

    const held = await context.versionLock.read(key);
    if (!held.ok) throw new Error("unreachable");
    expect(held.value).toBe(seeded.version.agentVersionId);
    expect(context.versionLock.releases).toEqual([]);
  });

  // The `if (removed.ok)` guard on the release is its own protective mechanism,
  // and it is NOT the same one as the call site. Dropping the condition — always
  // releasing, committed or not — left the two cases above green, because a
  // removal refused by `requireBound` returns before the release line is ever
  // reached. The only way to the guard is a transaction that STARTS and then
  // fails, which is what `failNextDeleteBinding` injects. `version-writer.ts`
  // states the stake: a hold released inside a transaction that then rolls back
  // sends live conversations onto a version that no longer exists, and the
  // failure is silent.
  it("releases NOTHING when the unbind transaction FAILED after starting", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context);
    const key = { scope: context.scope, agentId: seeded.agent.agentId, threadId: "thread-1" };
    context.versionLock.seed(key, seeded.version.agentVersionId);
    context.repository.failNextDeleteBinding = "store down mid-transaction";

    const removed = await removeAgent(context.dependencies, { authorization, agentId: seeded.agent.agentId });
    if (removed.ok) throw new Error("unreachable");
    expect(removed.error.code).toBe("AGENTS_REPOSITORY_UNAVAILABLE");
    // The transaction was entered — this is not the `requireBound` refusal path.
    expect(context.repository.writes.some((write) => write.startsWith("deleteBinding"))).toBe(true);

    const held = await context.versionLock.read(key);
    if (!held.ok) throw new Error("unreachable");
    expect(held.value).toBe(seeded.version.agentVersionId);
    expect(context.versionLock.releases).toEqual([]);
  });

  it("leaves a hold on a DIFFERENT agent alone", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context);
    const bystander = asAgentsIdentifier<AgentId>("agent-bystander");
    const bystanderKey = { scope: context.scope, agentId: bystander, threadId: "thread-1" };
    context.versionLock.seed(bystanderKey, seeded.version.agentVersionId);

    expect((await removeAgent(context.dependencies, { authorization, agentId: seeded.agent.agentId })).ok).toBe(
      true,
    );

    const held = await context.versionLock.read(bystanderKey);
    if (!held.ok) throw new Error("unreachable");
    expect(held.value).toBe(seeded.version.agentVersionId);
  });

  it("refuses an agent this environment cannot see", async () => {
    const { context, authorization } = newContext();
    expect(
      (await removeAgent(context.dependencies, { authorization, agentId: asAgentsIdentifier<AgentId>("nope") })).ok,
    ).toBe(false);
  });
});
