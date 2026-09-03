import { describe, expect, it } from "vitest";

import { asAgentsIdentifier, type AgentVersionId } from "../domain/index.js";
import { promoteCanary, selectVersion, setCanary } from "./canary.js";
import { buildAgentsTestContext, seedBoundAgent, testVersion } from "./testing/fixtures.js";

const CANARY = asAgentsIdentifier<AgentVersionId>("version-canary");

function newContext() {
  const context = buildAgentsTestContext();
  const authorization = context.tenancy.grant();
  const seeded = seedBoundAgent(context);
  const canary = context.repository.seedVersion(
    testVersion(seeded.agent.agentId, { agentVersionId: CANARY, versionNumber: 2 }),
  );
  return { context, authorization, seeded, canary };
}

describe("setting a canary", () => {
  it("moves the binding and MINTS NO VERSION", async () => {
    const { context, authorization, seeded } = newContext();
    const set = await setCanary(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      canaryVersionId: CANARY,
      canaryPercent: 25,
    });
    if (!set.ok) throw new Error("unreachable");
    expect(set.value.binding.canaryVersionId).toBe(CANARY);
    expect(set.value.binding.canaryPercent).toBe(25);
    expect(context.repository.writes.filter((write) => write.startsWith("insertVersion"))).toEqual([]);
  });

  it("carries the canary version onto the read model", async () => {
    const { context, authorization, seeded } = newContext();
    const set = await setCanary(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      canaryVersionId: CANARY,
      canaryPercent: 25,
    });
    if (!set.ok) throw new Error("unreachable");
    expect(set.value.canaryVersion?.versionNumber).toBe(2);
  });

  it("REFUSES a version belonging to another agent", async () => {
    // The foreign key only says the version exists; a version id belonging to a
    // different agent in the same project satisfies it and would put one agent's
    // configuration in front of another agent's users.
    const { context, authorization, seeded } = newContext();
    context.repository.seedVersion(
      testVersion(asAgentsIdentifier("agent-other"), {
        agentVersionId: asAgentsIdentifier<AgentVersionId>("version-foreign"),
      }),
    );
    const set = await setCanary(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      canaryVersionId: asAgentsIdentifier<AgentVersionId>("version-foreign"),
      canaryPercent: 10,
    });
    if (set.ok) throw new Error("unreachable");
    expect(set.error.code).toBe("AGENTS_VERSION_NOT_FOUND");
  });

  it("clears the version at zero percent WITHOUT looking it up", async () => {
    const { context, authorization, seeded } = newContext();
    const set = await setCanary(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      canaryVersionId: asAgentsIdentifier<AgentVersionId>("version-nonexistent"),
      canaryPercent: 0,
    });
    if (!set.ok) throw new Error("unreachable");
    expect(set.value.binding.canaryVersionId).toBeNull();
    expect(set.value.canaryVersion).toBeNull();
  });

  it("releases the thread holds so the split takes effect promptly", async () => {
    const { context, authorization, seeded } = newContext();
    await setCanary(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      canaryVersionId: CANARY,
      canaryPercent: 5,
    });
    expect(context.versionLock.releases).toHaveLength(1);
  });
});

describe("promoting a canary", () => {
  it("moves the canary onto active and clears the split", async () => {
    const { context, authorization, seeded } = newContext();
    await setCanary(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      canaryVersionId: CANARY,
      canaryPercent: 40,
    });
    const promoted = await promoteCanary(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
    });
    if (!promoted.ok) throw new Error("unreachable");
    expect(promoted.value.binding.activeVersionId).toBe(CANARY);
    expect(promoted.value.binding.canaryVersionId).toBeNull();
    expect(promoted.value.binding.canaryPercent).toBe(0);
    expect(promoted.value.activeVersion.agentVersionId).toBe(CANARY);
  });

  it("refuses when nothing is in canary", async () => {
    const { context, authorization, seeded } = newContext();
    const promoted = await promoteCanary(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
    });
    if (promoted.ok) throw new Error("unreachable");
    expect(promoted.error.code).toBe("AGENTS_CANARY_ABSENT");
  });

  it("mints no version: the configuration did not change", async () => {
    const { context, authorization, seeded } = newContext();
    await setCanary(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      canaryVersionId: CANARY,
      canaryPercent: 40,
    });
    const before = context.repository.writes.filter((write) => write.startsWith("insertVersion")).length;
    await promoteCanary(context.dependencies, { authorization, agentId: seeded.agent.agentId });
    expect(context.repository.writes.filter((write) => write.startsWith("insertVersion")).length).toBe(before);
  });
});

describe("selecting the version that answers a turn", () => {
  async function splitAt(percent: number) {
    const held = newContext();
    await setCanary(held.context.dependencies, {
      authorization: held.authorization,
      agentId: held.seeded.agent.agentId,
      canaryVersionId: CANARY,
      canaryPercent: percent,
    });
    return held;
  }

  it("takes the ACTIVE version for a one-off with no thread, whatever the draw", async () => {
    const { context, authorization, seeded } = await splitAt(100);
    const chosen = await selectVersion(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      threadId: null,
      draw: 0,
    });
    if (!chosen.ok) throw new Error("unreachable");
    expect(chosen.value).toEqual({ versionId: seeded.version.agentVersionId, bucket: "current" });
  });

  it("takes the canary on the first turn of a thread at a hundred percent", async () => {
    const { context, authorization, seeded } = await splitAt(100);
    const chosen = await selectVersion(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      threadId: "thread-1",
      draw: 0.9,
    });
    if (!chosen.ok) throw new Error("unreachable");
    expect(chosen.value).toEqual({ versionId: CANARY, bucket: "canary" });
  });

  it("PINS THE THREAD: a second turn follows the first, whatever it draws", async () => {
    const { context, authorization, seeded } = await splitAt(50);
    const first = await selectVersion(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      threadId: "thread-1",
      draw: 0,
    });
    if (!first.ok) throw new Error("unreachable");
    expect(first.value.bucket).toBe("canary");

    const second = await selectVersion(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      threadId: "thread-1",
      draw: 0.99,
    });
    if (!second.ok) throw new Error("unreachable");
    expect(second.value).toEqual({ versionId: CANARY, bucket: "locked" });
  });

  it("keeps two threads independent", async () => {
    const { context, authorization, seeded } = await splitAt(50);
    const canaryThread = await selectVersion(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      threadId: "thread-1",
      draw: 0,
    });
    const activeThread = await selectVersion(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      threadId: "thread-2",
      draw: 0.99,
    });
    if (!canaryThread.ok || !activeThread.ok) throw new Error("unreachable");
    expect(canaryThread.value.versionId).toBe(CANARY);
    expect(activeThread.value.versionId).toBe(seeded.version.agentVersionId);
  });

  it("SERVES THE WINNER when it loses the race to write the hold", async () => {
    // The caller drew the active version; another turn had already claimed the
    // canary. It must serve what the thread is on, not what it picked.
    const { context, authorization, seeded } = await splitAt(50);
    context.versionLock.seed(
      { scope: context.scope, agentId: seeded.agent.agentId, threadId: "thread-1" },
      CANARY,
    );
    const chosen = await selectVersion(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      threadId: "thread-1",
      draw: 0.99,
    });
    if (!chosen.ok) throw new Error("unreachable");
    expect(chosen.value).toEqual({ versionId: CANARY, bucket: "locked" });
  });

  it("falls back to the active version when the canary row is gone", async () => {
    const { context, authorization, seeded } = await splitAt(100);
    // Re-point the binding at a canary version the store cannot load.
    context.repository.seedBinding({
      ...seeded.binding,
      canaryVersionId: asAgentsIdentifier<AgentVersionId>("version-gone"),
      canaryPercent: 100,
    });
    const chosen = await selectVersion(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      threadId: "thread-1",
      draw: 0,
    });
    if (!chosen.ok) throw new Error("unreachable");
    expect(chosen.value.versionId).toBe(seeded.version.agentVersionId);
  });

  it("refuses an agent this environment cannot see", async () => {
    const { context, authorization } = newContext();
    const chosen = await selectVersion(context.dependencies, {
      authorization,
      agentId: asAgentsIdentifier("nope"),
      threadId: null,
      draw: 0,
    });
    if (chosen.ok) throw new Error("unreachable");
    expect(chosen.error.code).toBe("AGENTS_AGENT_NOT_BOUND");
  });

  it("is deterministic: the same draw answers the same way every time", async () => {
    const { context, authorization, seeded } = await splitAt(30);
    const answers = new Set<string>();
    for (let round = 0; round < 5; round += 1) {
      const chosen = await selectVersion(context.dependencies, {
        authorization,
        agentId: seeded.agent.agentId,
        threadId: null,
        draw: 0.2,
      });
      if (!chosen.ok) throw new Error("unreachable");
      answers.add(chosen.value.versionId);
    }
    expect(answers.size).toBe(1);
  });
});
