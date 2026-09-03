// `AgentSkill` — a version's skill loadout.
//
// ADR M0.3 §7 decision 5 places this row in `agents` rather than in `skills`,
// because a loadout is AUTHORING: which skills a configuration carries is part
// of that configuration, and putting it here is what keeps `skills` the lower,
// more-reused context. The consequence is the rule below.
//
// A LOADOUT BELONGS TO AN IMMUTABLE VERSION, SO EVERY SAVE MUST CARRY IT
// FORWARD. `AgentSkill.agentVersionId` is the owner; a new version starts with
// no rows at all. So a save that mints a version and moves the binding, without
// copying the loadout, silently strips every skill from a live agent — and the
// operator's diff shows only the field they edited. `carryForward` is that copy,
// and it is the reason this file exists as its own module rather than as three
// lines inside an update path.
//
// THE COPY IS VERBATIM, INCLUDING `enabled: false`. A disabled skill is a
// decision an operator made, and dropping the disabled rows on each save would
// make a skill silently re-appear the first time anyone renamed the agent.
//
// `EnvironmentSkillId` IS THE IDENTITY, NOT `AgentSkill.id`. The unique
// constraint is `[agentVersionId, environmentSkillId]`, so the same skill is one
// row per version and the new row's own id is minted fresh. Copying the source
// row's id would collide on the very first save.

import { err, ok, type Result } from "@platos/kernel";

import { skillNotLoaded } from "./errors.js";
import type { AgentSkillId, AgentVersionId, EnvironmentSkillId } from "./identifiers.js";
import type { JsonObject } from "./snapshot.js";

export interface AgentSkill {
  readonly agentSkillId: AgentSkillId;
  readonly agentVersionId: AgentVersionId;
  readonly environmentSkillId: EnvironmentSkillId;
  readonly enabled: boolean;
  readonly config: JsonObject;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The assignment state of one skill, without the row identity. */
export interface SkillAssignment {
  readonly environmentSkillId: EnvironmentSkillId;
  readonly enabled: boolean;
  readonly config: JsonObject;
}

/** An empty configuration. The column's own default. */
export const EMPTY_SKILL_CONFIG: JsonObject = Object.freeze({});

export function assignmentOf(skill: AgentSkill): SkillAssignment {
  return {
    environmentSkillId: skill.environmentSkillId,
    enabled: skill.enabled,
    config: skill.config,
  };
}

/**
 * The assignments a new version inherits from the version it replaces.
 *
 * Deduplicated on `environmentSkillId`, keeping the FIRST occurrence, because
 * the destination's unique constraint would refuse the second and the whole
 * carry-forward — and therefore the whole save — with it.
 */
export function carryForward(source: readonly AgentSkill[]): readonly SkillAssignment[] {
  const bySkill = new Map<string, SkillAssignment>();
  for (const skill of source) {
    if (!bySkill.has(skill.environmentSkillId)) bySkill.set(skill.environmentSkillId, assignmentOf(skill));
  }
  return [...bySkill.values()];
}

/**
 * Apply one enable/disable/remove to a set of assignments.
 *
 * Returns the WHOLE resulting set rather than a delta, so a caller writing the
 * next version's loadout writes one list and cannot half-apply a change.
 */
export type LoadoutChange =
  | { readonly kind: "enable"; readonly environmentSkillId: EnvironmentSkillId; readonly config?: JsonObject }
  | { readonly kind: "disable"; readonly environmentSkillId: EnvironmentSkillId }
  | { readonly kind: "remove"; readonly environmentSkillId: EnvironmentSkillId };

/**
 * Enabling is an UPSERT and disabling is not.
 *
 * The source upserts on enable — a skill an agent has never carried becomes a
 * row — and only updates on disable, so disabling a skill the version does not
 * carry writes nothing. Refusing the second is the difference between "this is
 * off" and "this was never here", and a surface that showed the first for the
 * second would tell an operator a skill is installed and switched off when it is
 * not installed at all.
 */
export function applyLoadoutChange(
  assignments: readonly SkillAssignment[],
  change: LoadoutChange,
  agentVersionId: AgentVersionId,
): Result<readonly SkillAssignment[]> {
  const index = assignments.findIndex(
    (assignment) => assignment.environmentSkillId === change.environmentSkillId,
  );
  if (change.kind === "enable") {
    const next: SkillAssignment = {
      environmentSkillId: change.environmentSkillId,
      enabled: true,
      config: change.config ?? assignments[index]?.config ?? EMPTY_SKILL_CONFIG,
    };
    if (index === -1) return ok([...assignments, next]);
    return ok(assignments.map((assignment, at) => (at === index ? next : assignment)));
  }
  if (index === -1) {
    return err(skillNotLoaded(agentVersionId, change.environmentSkillId));
  }
  if (change.kind === "remove") {
    return ok(assignments.filter((_, at) => at !== index));
  }
  return ok(
    assignments.map((assignment, at) => (at === index ? { ...assignment, enabled: false } : assignment)),
  );
}

/** The skills a turn actually loads: the enabled ones, in skill-id order. */
export function activeLoadout(assignments: readonly SkillAssignment[]): readonly SkillAssignment[] {
  return assignments
    .filter((assignment) => assignment.enabled)
    .sort((left, right) =>
      left.environmentSkillId === right.environmentSkillId
        ? 0
        : left.environmentSkillId < right.environmentSkillId
          ? -1
          : 1,
    );
}
