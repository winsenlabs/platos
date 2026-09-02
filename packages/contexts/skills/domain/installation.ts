// Installing a catalogue entry — the `ProjectSkill` / `EnvironmentSkill` pair.
//
// An install is TWO rows at two levels, and the pair is the whole point.
//
//   ProjectSkill      (projectId, skillId)             — the project adopts the
//                                                        skill from the org
//                                                        catalogue.
//   EnvironmentSkill  (environmentId, projectSkillId)  — one environment of that
//                                                        project switches it on,
//                                                        with its own config.
//
// The second is keyed by the FIRST ROW'S ID, not by the skill id. That is what
// makes `EnvironmentSkill` unreachable without a project adoption and what lets
// production and staging of one project hold different `config` for the same
// skill. It also means an install is created top-down and can never be created
// half-way round: an environment binding whose project binding does not exist is
// not representable.
//
// BOTH ROWS ARE UPSERTS THAT RE-ENABLE. Installing an already-installed skill
// sets `enabled: true` at both levels rather than failing. Delivery is
// at-least-once everywhere in this system and an operator clicking twice is
// normal, so an idempotent repeat must not be an error — and a re-install is the
// documented way to undo a disable.

import type { EnvironmentScope, JsonValue, ProjectScope } from "@platos/kernel";

import type { EnvironmentSkillId, ProjectSkillId, SkillId } from "./identifiers.js";

/** `ProjectSkill` — a project's adoption of one catalogue row. */
export interface ProjectInstallation {
  readonly projectSkillId: ProjectSkillId;
  readonly scope: ProjectScope;
  readonly skillId: SkillId;
  readonly enabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** `EnvironmentSkill` — one environment's binding of a project adoption. */
export interface EnvironmentInstallation {
  readonly environmentSkillId: EnvironmentSkillId;
  readonly scope: EnvironmentScope;
  readonly projectSkillId: ProjectSkillId;
  readonly enabled: boolean;
  /** Environment-specific configuration. Opaque here; the runtime reads it. */
  readonly config: Readonly<Record<string, JsonValue>>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Both halves, resolved together. What a caller almost always wants. */
export interface Installation {
  readonly project: ProjectInstallation;
  readonly environment: EnvironmentInstallation;
}

/**
 * The default `EnvironmentSkill.config`.
 *
 * An empty object, matching the column default. Notably NOT null: the baseline
 * column is `Json @default("{}")`, and a caller that has to distinguish "no
 * config" from "empty config" on every read is a caller that will eventually
 * forget to.
 */
export const EMPTY_SKILL_CONFIG: Readonly<Record<string, JsonValue>> = Object.freeze({});

export function isInstallationEnabled(installation: Installation): boolean {
  return installation.project.enabled && installation.environment.enabled;
}

/**
 * Whether a skill is USABLE in an environment.
 *
 * An official skill is usable without any install at all — that is what makes it
 * official, and it is why a fresh environment can run the seeded catalogue
 * before anyone has installed anything. Everything else needs both halves of an
 * install, both enabled.
 */
export function isUsable(isOfficial: boolean, installation: Installation | null): boolean {
  if (installation === null) return isOfficial;
  return isInstallationEnabled(installation);
}

/**
 * Whether the BINDING path should materialise an install for this row.
 *
 * An official skill has no install until something binds it, so the binding
 * path creates one; a non-official skill can only be bound if it is already
 * installed, because that is what made it visible in the first place.
 *
 * The read/write asymmetry the live `environmentSkillFor(..., createOfficialLinks)`
 * expressed as a flag is structural here instead: the read path
 * (`findBinding`) does not call this at all. A flag that every caller passes
 * the same value is not a decision, and making the read path unable to
 * materialise is stronger than asking it not to.
 */
export function shouldMaterialiseInstall(isOfficial: boolean): boolean {
  return isOfficial;
}

/**
 * Whether this row may be uninstalled through the tenant-facing surface.
 *
 * Official rows may not. They are organization-owned catalogue entries, and
 * "uninstall" for them would either be a no-op that looks like it worked or a
 * catalogue deletion that removes the skill from every other environment too.
 * The live `remove` filters on `isOfficial: false` for exactly this reason.
 */
export function mayUninstall(isOfficial: boolean): boolean {
  return !isOfficial;
}

/**
 * Whether this row may be EDITED through the tenant-facing surface.
 *
 * It may, official or not — and this is a transcription, not an endorsement.
 * The live `updateSkill` gates only on visibility, and visibility includes every
 * official row in the organization, so a patch issued from one environment does
 * reach organization-wide catalogue content. `remove` gates the same surface on
 * `isOfficial: false`; `updateSkill` does not.
 *
 * The asymmetry is preserved deliberately: WIN-256 is a refactor and changing it
 * here would be a behaviour change smuggled in as a boundary extraction. It is
 * reported as a finding against ADR M0.3 rather than absorbed, and this function
 * exists so that the decision has ONE place to be revisited when it is taken.
 */
export function mayEdit(_isOfficial: boolean): boolean {
  return true;
}
