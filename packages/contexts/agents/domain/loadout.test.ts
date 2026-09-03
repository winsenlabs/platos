import { describe, expect, it } from "vitest";

import {
  asAgentsIdentifier,
  type AgentSkillId,
  type AgentVersionId,
  type EnvironmentSkillId,
} from "./identifiers.js";
import {
  activeLoadout,
  applyLoadoutChange,
  assignmentOf,
  carryForward,
  EMPTY_SKILL_CONFIG,
  type AgentSkill,
  type SkillAssignment,
} from "./loadout.js";

const VERSION = asAgentsIdentifier<AgentVersionId>("version-1");
const MAIL = asAgentsIdentifier<EnvironmentSkillId>("env-skill-mail");
const CALENDAR = asAgentsIdentifier<EnvironmentSkillId>("env-skill-calendar");
const NOW = new Date("2026-01-01T00:00:00.000Z");

function row(overrides: Partial<AgentSkill> = {}): AgentSkill {
  return {
    agentSkillId: asAgentsIdentifier<AgentSkillId>("skill-row-1"),
    agentVersionId: VERSION,
    environmentSkillId: MAIL,
    enabled: true,
    config: EMPTY_SKILL_CONFIG,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("carrying a loadout forward", () => {
  it("copies the assignment state and DROPS the row identity", () => {
    // `AgentSkill.id` must be minted fresh: the destination's unique constraint
    // is on `[agentVersionId, environmentSkillId]`, and copying the source row's
    // own id would collide on the very first save.
    const carried = carryForward([row({ config: { folder: "inbox" } })]);
    expect(carried).toEqual([{ environmentSkillId: MAIL, enabled: true, config: { folder: "inbox" } }]);
    expect(carried[0]).not.toHaveProperty("agentSkillId");
  });

  it("CARRIES A DISABLED SKILL, because being off is a decision an operator made", () => {
    const carried = carryForward([row({ enabled: false })]);
    expect(carried[0]?.enabled).toBe(false);
  });

  it("deduplicates on the skill id, keeping the first", () => {
    const carried = carryForward([
      row({ config: { first: true } }),
      row({ agentSkillId: asAgentsIdentifier<AgentSkillId>("skill-row-2"), config: { second: true } }),
    ]);
    expect(carried).toHaveLength(1);
    expect(carried[0]?.config).toEqual({ first: true });
  });

  it("carries an empty loadout as an empty loadout", () => {
    expect(carryForward([])).toEqual([]);
  });

  it("projects one row to its assignment", () => {
    expect(assignmentOf(row())).toEqual({ environmentSkillId: MAIL, enabled: true, config: EMPTY_SKILL_CONFIG });
  });
});

describe("changing a loadout", () => {
  const held: readonly SkillAssignment[] = [
    { environmentSkillId: MAIL, enabled: true, config: { folder: "inbox" } },
  ];

  it("ENABLING is an upsert: a skill the version never carried becomes an entry", () => {
    const next = applyLoadoutChange(held, { kind: "enable", environmentSkillId: CALENDAR }, VERSION);
    if (!next.ok) throw new Error("unreachable");
    expect(next.value).toHaveLength(2);
    expect(next.value[1]).toEqual({ environmentSkillId: CALENDAR, enabled: true, config: EMPTY_SKILL_CONFIG });
  });

  it("enabling an entry that exists flips it on and keeps its configuration", () => {
    const off: readonly SkillAssignment[] = [{ environmentSkillId: MAIL, enabled: false, config: { folder: "inbox" } }];
    const next = applyLoadoutChange(off, { kind: "enable", environmentSkillId: MAIL }, VERSION);
    if (!next.ok) throw new Error("unreachable");
    expect(next.value[0]).toEqual({ environmentSkillId: MAIL, enabled: true, config: { folder: "inbox" } });
  });

  it("enabling with a configuration replaces the one held", () => {
    const next = applyLoadoutChange(
      held,
      { kind: "enable", environmentSkillId: MAIL, config: { folder: "archive" } },
      VERSION,
    );
    if (!next.ok) throw new Error("unreachable");
    expect(next.value[0]?.config).toEqual({ folder: "archive" });
  });

  it("DISABLING is not an upsert: a skill the version does not carry is refused", () => {
    // "This is off" and "this was never here" are different answers, and a
    // surface that showed the first for the second would tell an operator a
    // skill is installed and switched off when it is not installed at all.
    const next = applyLoadoutChange(held, { kind: "disable", environmentSkillId: CALENDAR }, VERSION);
    if (next.ok) throw new Error("unreachable");
    expect(next.error.code).toBe("AGENTS_SKILL_NOT_LOADED");
  });

  it("disabling an entry that exists flips it off and keeps it in the list", () => {
    const next = applyLoadoutChange(held, { kind: "disable", environmentSkillId: MAIL }, VERSION);
    if (!next.ok) throw new Error("unreachable");
    expect(next.value).toHaveLength(1);
    expect(next.value[0]?.enabled).toBe(false);
  });

  it("removing takes the entry out of the list", () => {
    const next = applyLoadoutChange(held, { kind: "remove", environmentSkillId: MAIL }, VERSION);
    if (!next.ok) throw new Error("unreachable");
    expect(next.value).toEqual([]);
  });

  it("refuses to remove a skill the version does not carry", () => {
    expect(applyLoadoutChange(held, { kind: "remove", environmentSkillId: CALENDAR }, VERSION).ok).toBe(false);
  });

  it("returns the WHOLE resulting set, so a caller cannot half-apply a change", () => {
    const two: readonly SkillAssignment[] = [
      { environmentSkillId: MAIL, enabled: true, config: EMPTY_SKILL_CONFIG },
      { environmentSkillId: CALENDAR, enabled: true, config: EMPTY_SKILL_CONFIG },
    ];
    const next = applyLoadoutChange(two, { kind: "disable", environmentSkillId: MAIL }, VERSION);
    if (!next.ok) throw new Error("unreachable");
    expect(next.value).toHaveLength(2);
  });

  it("does not mutate the loadout it was given", () => {
    applyLoadoutChange(held, { kind: "remove", environmentSkillId: MAIL }, VERSION);
    expect(held).toHaveLength(1);
  });
});

describe("the active loadout", () => {
  it("keeps only the enabled entries", () => {
    const held: readonly SkillAssignment[] = [
      { environmentSkillId: MAIL, enabled: true, config: EMPTY_SKILL_CONFIG },
      { environmentSkillId: CALENDAR, enabled: false, config: EMPTY_SKILL_CONFIG },
    ];
    expect(activeLoadout(held).map((entry) => entry.environmentSkillId)).toEqual([MAIL]);
  });

  it("orders by skill id, so a turn's loadout is stable across reads", () => {
    const held: readonly SkillAssignment[] = [
      { environmentSkillId: MAIL, enabled: true, config: EMPTY_SKILL_CONFIG },
      { environmentSkillId: CALENDAR, enabled: true, config: EMPTY_SKILL_CONFIG },
    ];
    expect(activeLoadout(held).map((entry) => entry.environmentSkillId)).toEqual([CALENDAR, MAIL]);
  });

  it("answers empty for a loadout with nothing enabled", () => {
    expect(activeLoadout([{ environmentSkillId: MAIL, enabled: false, config: EMPTY_SKILL_CONFIG }])).toEqual([]);
  });
});
