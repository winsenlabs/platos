import { describe, expect, it } from "vitest";

import { asAgentsIdentifier, type EnvironmentSkillId } from "../domain/index.js";
import { disableSkill, enableSkill, loadoutNote, readLoadout, removeSkill } from "./loadout.js";
import { buildAgentsTestContext, seedBoundAgent } from "./testing/fixtures.js";

const MAIL = asAgentsIdentifier<EnvironmentSkillId>("env-skill-mail");
const CALENDAR = asAgentsIdentifier<EnvironmentSkillId>("env-skill-calendar");

function newContext() {
  const context = buildAgentsTestContext();
  const authorization = context.tenancy.grant();
  const seeded = seedBoundAgent(context);
  return { context, authorization, seeded };
}

describe("reading a loadout", () => {
  it("reads the LIVE version's entries", async () => {
    const { context, authorization, seeded } = newContext();
    context.repository.seedLoadout(seeded.version.agentVersionId, [
      { environmentSkillId: MAIL, enabled: true, config: { folder: "inbox" } },
    ]);
    const read = await readLoadout(context.dependencies, { authorization, agentId: seeded.agent.agentId });
    if (!read.ok) throw new Error("unreachable");
    expect(read.value).toEqual([{ environmentSkillId: MAIL, enabled: true, config: { folder: "inbox" } }]);
  });

  it("answers empty for a version carrying nothing", async () => {
    const { context, authorization, seeded } = newContext();
    const read = await readLoadout(context.dependencies, { authorization, agentId: seeded.agent.agentId });
    if (!read.ok) throw new Error("unreachable");
    expect(read.value).toEqual([]);
  });

  it("DOES NOT ASK `skills` to describe the entry", async () => {
    // The view is thin, and stays thin now that `skills` is real: this context
    // holds a one-method port and calls none of it. The counter is the control
    // on that claim.
    const { context, authorization, seeded } = newContext();
    context.repository.seedLoadout(seeded.version.agentVersionId, [
      { environmentSkillId: MAIL, enabled: true, config: {} },
    ]);
    await readLoadout(context.dependencies, { authorization, agentId: seeded.agent.agentId });
    expect(context.skills.calls).toBe(0);
  });

  it("refuses an agent this environment cannot see", async () => {
    const { context, authorization } = newContext();
    expect(
      (await readLoadout(context.dependencies, { authorization, agentId: asAgentsIdentifier("nope") })).ok,
    ).toBe(false);
  });
});

describe("every loadout change mints a version", () => {
  it("enables a skill onto a NEW version and moves the binding", async () => {
    const { context, authorization, seeded } = newContext();
    const changed = await enableSkill(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      environmentSkillId: MAIL,
      changedBy: "operator-1",
    });
    if (!changed.ok) throw new Error("unreachable");
    expect(changed.value.previousVersionId).toBe(seeded.version.agentVersionId);
    expect(changed.value.bound.activeVersion.versionNumber).toBe(2);
    expect(changed.value.loadout).toEqual([{ environmentSkillId: MAIL, enabled: true, config: {} }]);
  });

  it("LEAVES THE OLD VERSION'S LOADOUT ALONE, which is what a rollback needs", async () => {
    const { context, authorization, seeded } = newContext();
    await enableSkill(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      environmentSkillId: MAIL,
      changedBy: "operator-1",
    });
    const original = await context.repository.listLoadout(seeded.version.agentVersionId);
    if (!original.ok) throw new Error("unreachable");
    expect(original.value).toEqual([]);
  });

  it("carries the configuration across byte-identically", async () => {
    const { context, authorization, seeded } = newContext();
    const changed = await enableSkill(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      environmentSkillId: MAIL,
      changedBy: "operator-1",
    });
    if (!changed.ok) throw new Error("unreachable");
    expect(changed.value.bound.activeVersion.snapshot).toEqual(seeded.version.snapshot);
  });

  it("records which skill moved in the version note", async () => {
    const { context, authorization, seeded } = newContext();
    const changed = await enableSkill(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      environmentSkillId: MAIL,
      changedBy: "operator-1",
    });
    if (!changed.ok) throw new Error("unreachable");
    expect(changed.value.bound.activeVersion.note).toBe(`Enable Agent Skill ${MAIL}`);
  });

  it("names each change in its own note", () => {
    expect(loadoutNote({ kind: "enable", environmentSkillId: MAIL })).toBe(`Enable Agent Skill ${MAIL}`);
    expect(loadoutNote({ kind: "disable", environmentSkillId: MAIL })).toBe(`Disable Agent Skill ${MAIL}`);
    expect(loadoutNote({ kind: "remove", environmentSkillId: MAIL })).toBe(`Remove Agent Skill ${MAIL}`);
  });

  it("enables with a configuration", async () => {
    const { context, authorization, seeded } = newContext();
    const changed = await enableSkill(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      environmentSkillId: MAIL,
      changedBy: "operator-1",
      config: { folder: "archive" },
    });
    if (!changed.ok) throw new Error("unreachable");
    expect(changed.value.loadout[0]?.config).toEqual({ folder: "archive" });
  });

  it("disables an entry the live version carries, keeping it in the list", async () => {
    const { context, authorization, seeded } = newContext();
    context.repository.seedLoadout(seeded.version.agentVersionId, [
      { environmentSkillId: MAIL, enabled: true, config: {} },
    ]);
    const changed = await disableSkill(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      environmentSkillId: MAIL,
      changedBy: "operator-1",
    });
    if (!changed.ok) throw new Error("unreachable");
    expect(changed.value.loadout).toEqual([{ environmentSkillId: MAIL, enabled: false, config: {} }]);
  });

  it("REFUSES to disable a skill the version does not carry", async () => {
    const { context, authorization, seeded } = newContext();
    const changed = await disableSkill(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      environmentSkillId: CALENDAR,
      changedBy: "operator-1",
    });
    if (changed.ok) throw new Error("unreachable");
    expect(changed.error.code).toBe("AGENTS_SKILL_NOT_LOADED");
    expect(context.repository.writes.filter((write) => write.startsWith("insertVersion"))).toEqual([]);
  });

  it("removes an entry entirely", async () => {
    const { context, authorization, seeded } = newContext();
    context.repository.seedLoadout(seeded.version.agentVersionId, [
      { environmentSkillId: MAIL, enabled: true, config: {} },
      { environmentSkillId: CALENDAR, enabled: true, config: {} },
    ]);
    const changed = await removeSkill(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      environmentSkillId: MAIL,
      changedBy: "operator-1",
    });
    if (!changed.ok) throw new Error("unreachable");
    expect(changed.value.loadout.map((entry) => entry.environmentSkillId)).toEqual([CALENDAR]);
  });

  it("releases the thread holds so live conversations pick up the new version", async () => {
    const { context, authorization, seeded } = newContext();
    await enableSkill(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      environmentSkillId: MAIL,
      changedBy: "operator-1",
    });
    expect(context.versionLock.releases).toHaveLength(1);
  });

  it("keeps the version numbers moving across successive changes", async () => {
    const { context, authorization, seeded } = newContext();
    await enableSkill(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      environmentSkillId: MAIL,
      changedBy: "operator-1",
    });
    const second = await enableSkill(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      environmentSkillId: CALENDAR,
      changedBy: "operator-1",
    });
    if (!second.ok) throw new Error("unreachable");
    expect(second.value.bound.activeVersion.versionNumber).toBe(3);
    expect(second.value.loadout).toHaveLength(2);
  });
});
