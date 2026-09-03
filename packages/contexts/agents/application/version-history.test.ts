import { describe, expect, it } from "vitest";

import { asAgentsIdentifier, type AgentVersionId } from "../domain/index.js";
import { buildAgentsTestContext, seedBoundAgent, testVersion } from "./testing/fixtures.js";
import { updateAgent } from "./update-agent.js";
import {
  describeVersion,
  pageVersions,
  planVersionPrune,
  rollbackToVersion,
} from "./version-history.js";

function newContext() {
  const context = buildAgentsTestContext();
  return { context, authorization: context.tenancy.grant() };
}

describe("reading history", () => {
  it("marks which version is live and which is in canary", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context);
    const canary = context.repository.seedVersion(
      testVersion(seeded.agent.agentId, {
        agentVersionId: asAgentsIdentifier<AgentVersionId>("version-2"),
        versionNumber: 2,
      }),
    );
    context.repository.seedBinding({ ...seeded.binding, canaryVersionId: canary.agentVersionId });

    const paged = await pageVersions(context.dependencies, { authorization, agentId: seeded.agent.agentId });
    if (!paged.ok) throw new Error("unreachable");
    expect(paged.value.items.map((entry) => entry.version.versionNumber)).toEqual([2, 1]);
    expect(paged.value.items[0]?.isCanary).toBe(true);
    expect(paged.value.items[1]?.isCurrent).toBe(true);
  });

  it("clamps the page size and reports the window it used", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context);
    const paged = await pageVersions(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      take: 10_000,
      offset: -1,
    });
    if (!paged.ok) throw new Error("unreachable");
    expect(paged.value.limit).toBe(context.dependencies.policy.versions.maxPageSize);
    expect(paged.value.offset).toBe(0);
  });

  it("reports offset zero whenever a cursor was supplied", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context);
    const paged = await pageVersions(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      cursor: "version-1",
      offset: 40,
    });
    if (!paged.ok) throw new Error("unreachable");
    expect(paged.value.offset).toBe(0);
  });

  it("describes one version", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context);
    const described = await describeVersion(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      versionId: seeded.version.agentVersionId,
    });
    if (!described.ok) throw new Error("unreachable");
    expect(described.value.isCurrent).toBe(true);
  });

  it("refuses a version id belonging to ANOTHER agent", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context);
    context.repository.seedVersion(
      testVersion(asAgentsIdentifier("agent-other"), {
        agentVersionId: asAgentsIdentifier<AgentVersionId>("version-elsewhere"),
      }),
    );
    const described = await describeVersion(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      versionId: asAgentsIdentifier<AgentVersionId>("version-elsewhere"),
    });
    if (described.ok) throw new Error("unreachable");
    expect(described.error.code).toBe("AGENTS_VERSION_NOT_FOUND");
  });

  it("refuses history for an agent this environment cannot see", async () => {
    const { context, authorization } = newContext();
    expect(
      (await pageVersions(context.dependencies, { authorization, agentId: asAgentsIdentifier("nope") })).ok,
    ).toBe(false);
  });
});

describe("rollback writes FORWARD", () => {
  it("mints a new version carrying the old snapshot, and moves the binding onto it", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context, { source: { maxSteps: 5 } });
    const saved = await updateAgent(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      updatedBy: "operator-1",
      maxSteps: 50,
    });
    if (!saved.ok) throw new Error("unreachable");

    const restored = await rollbackToVersion(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      versionId: seeded.version.agentVersionId,
      restoredBy: "operator-1",
    });
    if (!restored.ok) throw new Error("unreachable");
    expect(restored.value.activeVersion.versionNumber).toBe(3);
    expect(restored.value.activeVersion.snapshot.maxSteps).toBe(5);
    expect(restored.value.binding.activeVersionId).toBe(restored.value.activeVersion.agentVersionId);
  });

  it("does NOT move the binding backwards onto the old version", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context, { source: { maxSteps: 5 } });
    await updateAgent(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      updatedBy: "operator-1",
      maxSteps: 50,
    });
    const restored = await rollbackToVersion(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      versionId: seeded.version.agentVersionId,
      restoredBy: "operator-1",
    });
    if (!restored.ok) throw new Error("unreachable");
    expect(restored.value.binding.activeVersionId).not.toBe(seeded.version.agentVersionId);
  });

  it("records the version it restored in the note, with the source's wording", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context, { source: { maxSteps: 5 } });
    await updateAgent(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      updatedBy: "operator-1",
      maxSteps: 50,
    });
    const restored = await rollbackToVersion(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      versionId: seeded.version.agentVersionId,
      restoredBy: "operator-1",
    });
    if (!restored.ok) throw new Error("unreachable");
    expect(restored.value.activeVersion.note).toBe("Rollback to v1");
  });

  it("RESTORES THE TARGET'S LOADOUT, not the one being replaced", async () => {
    // Restoring a configuration from before a skill was added must restore the
    // loadout from before it was added too, or the operator gets an old prompt
    // with a new toolset and nothing says so.
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context, { source: { maxSteps: 5 } });
    context.repository.seedLoadout(seeded.version.agentVersionId, [
      { environmentSkillId: asAgentsIdentifier("env-skill-mail"), enabled: true, config: {} },
    ]);
    const saved = await updateAgent(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      updatedBy: "operator-1",
      maxSteps: 50,
    });
    if (!saved.ok) throw new Error("unreachable");
    // A second skill is added to the version that replaced it.
    await context.repository.replaceLoadout(
      saved.value.bound.activeVersion.agentVersionId,
      [
        { environmentSkillId: asAgentsIdentifier("env-skill-mail"), enabled: true, config: {} },
        { environmentSkillId: asAgentsIdentifier("env-skill-cal"), enabled: true, config: {} },
      ],
      { transactionId: asAgentsIdentifier("txn-seed") },
    );

    const restored = await rollbackToVersion(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      versionId: seeded.version.agentVersionId,
      restoredBy: "operator-1",
    });
    if (!restored.ok) throw new Error("unreachable");
    const loadout = await context.repository.listLoadout(restored.value.activeVersion.agentVersionId);
    if (!loadout.ok) throw new Error("unreachable");
    expect(loadout.value.map((entry) => entry.environmentSkillId)).toEqual(["env-skill-mail"]);
  });

  it("carries the target's tool-default policy, not the live version's", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context, { version: { toolDefaultPolicy: "NONE" } });
    context.repository.seedVersion(
      testVersion(seeded.agent.agentId, {
        agentVersionId: asAgentsIdentifier<AgentVersionId>("version-2"),
        versionNumber: 2,
        toolDefaultPolicy: "ALL",
      }),
    );
    context.repository.seedBinding({
      ...seeded.binding,
      activeVersionId: asAgentsIdentifier<AgentVersionId>("version-2"),
    });
    const restored = await rollbackToVersion(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      versionId: seeded.version.agentVersionId,
      restoredBy: "operator-1",
    });
    if (!restored.ok) throw new Error("unreachable");
    expect(restored.value.activeVersion.toolDefaultPolicy).toBe("NONE");
  });

  it("releases the thread holds so the restored version takes effect promptly", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context);
    await rollbackToVersion(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      versionId: seeded.version.agentVersionId,
      restoredBy: "operator-1",
    });
    expect(context.versionLock.releases).toHaveLength(1);
  });

  it("refuses a version the agent does not own", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context);
    const restored = await rollbackToVersion(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      versionId: asAgentsIdentifier<AgentVersionId>("version-nope"),
      restoredBy: "operator-1",
    });
    if (restored.ok) throw new Error("unreachable");
    expect(restored.error.code).toBe("AGENTS_VERSION_NOT_FOUND");
  });
});

describe("the prune plan", () => {
  it("reports a plan and deletes nothing", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context);
    for (const number of [2, 3, 4]) {
      context.repository.seedVersion(
        testVersion(seeded.agent.agentId, {
          agentVersionId: asAgentsIdentifier<AgentVersionId>(`version-${number}`),
          versionNumber: number,
          createdAt: new Date("2025-01-01T00:00:00.000Z"),
        }),
      );
    }
    const before = context.repository.writes.length;
    const plan = await planVersionPrune(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      keepNewest: 1,
      keepDays: 1,
    });
    if (!plan.ok) throw new Error("unreachable");
    expect(plan.value.dryRun).toBe(true);
    expect(plan.value.eligible.length).toBeGreaterThan(0);
    expect(context.repository.writes.length).toBe(before);
  });

  it("never proposes the live version", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context, { version: { createdAt: new Date("2020-01-01T00:00:00.000Z") } });
    const plan = await planVersionPrune(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      keepNewest: 1,
      keepDays: 1,
    });
    if (!plan.ok) throw new Error("unreachable");
    expect(plan.value.eligible).toEqual([]);
  });

  it("dates the cutoff from the injected clock, never the wall clock", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context);
    context.clock.set(new Date("2030-06-01T00:00:00.000Z"));
    const plan = await planVersionPrune(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      keepDays: 1,
    });
    if (!plan.ok) throw new Error("unreachable");
    expect(plan.value.cutoff).toEqual(new Date("2030-05-31T00:00:00.000Z"));
  });

  it("refuses a plan for an agent this environment cannot see", async () => {
    const { context, authorization } = newContext();
    expect(
      (await planVersionPrune(context.dependencies, { authorization, agentId: asAgentsIdentifier("nope") })).ok,
    ).toBe(false);
  });
});
