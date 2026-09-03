// Use case: turn a set of environment bindings into what a turn actually sees.
//
// `agents` owns the loadout (`AgentSkill`, per ADR M0.3 §7 decision 5), so it
// arrives here holding the binding ids its agent version has switched on. This
// context resolves them, decides which are still usable, and merges the survivors
// into one prompt block and one namespaced tool catalogue.
//
// READINESS IS A FILTER HERE, NOT A GATE. `bindSkill` REFUSES a skill whose
// required keys are unset; this drops it. The difference is deliberate and it is
// the whole reason readiness is asked twice: a key removed after binding must
// not break every conversation in the environment. The skill silently stops
// being offered, the turn proceeds without it, and the library surface still
// shows it as enabled-but-not-ready so somebody can see why.
//
// A DISABLED BINDING IS DROPPED TOO. Either half of an install being switched
// off removes the skill from the turn. `isInstallationEnabled` is the conjunction
// — a project-level disable takes it out of every environment at once, which is
// what a project-level switch is for.
//
// AN UNRESOLVABLE BINDING IS DROPPED, NOT AN ERROR. A binding id the scope does
// not cover is simply absent from the resolution. Failing the turn because a
// stale loadout names a skill that was uninstalled last week would make an
// uninstall in one place break agents in another; dropping it degrades to
// exactly the behaviour of not having had the skill.
//
// THE MERGE ITSELF IS PURE. Ordering, the character budget and namespacing are
// all in `domain/prompt-composition.ts`, so the same inputs give the same block
// every time — which is what lets a prompt cache key on the skill set.

import { err, ok, type Result } from "@platos/kernel";

import {
  composeSkills,
  composeSystemPrompt,
  isEnvironmentReady,
  isInstallationEnabled,
  distinctRequiredKeys,
  type CatalogueEntry,
  type CatalogueScope,
  type ComposableSkill,
  type ComposedSkills,
  type EnvironmentSkillId,
  type Installation,
} from "../domain/index.js";
import type { SkillsDependencies } from "./dependencies.js";

export interface ComposeRuntimeCommand {
  readonly scope: CatalogueScope;
  /** The bindings the agent version has switched on, in loadout order. */
  readonly environmentSkillIds: readonly EnvironmentSkillId[];
  /** The agent's own system prompt, if the caller wants them spliced. */
  readonly basePrompt?: string | null;
}

export interface RuntimeSkills extends ComposedSkills {
  /** `basePrompt` and the merged block, joined. */
  readonly systemPrompt: string;
  /** Bindings that resolved but were not usable, with the reason. */
  readonly skipped: readonly SkippedSkill[];
}

export interface SkippedSkill {
  readonly environmentSkillId: EnvironmentSkillId;
  readonly reason: "unresolved" | "disabled" | "environment-not-ready";
}

interface Resolved {
  readonly installation: Installation;
  readonly entry: CatalogueEntry;
}

/**
 * Pair each requested binding with its catalogue row, preserving REQUEST ORDER.
 *
 * Order is load-bearing: the character budget admits a prefix, so the sequence
 * the caller asked in decides which skills survive a truncation. Rebuilding the
 * list in store order would make that outcome depend on insertion history.
 */
function pairInRequestOrder(
  requested: readonly EnvironmentSkillId[],
  installations: readonly Installation[],
  entries: readonly CatalogueEntry[],
): { readonly resolved: readonly Resolved[]; readonly unresolved: readonly EnvironmentSkillId[] } {
  const byBinding = new Map(
    installations.map((installation) => [installation.environment.environmentSkillId, installation]),
  );
  const bySkill = new Map(entries.map((entry) => [entry.skillId, entry]));
  const resolved: Resolved[] = [];
  const unresolved: EnvironmentSkillId[] = [];
  for (const environmentSkillId of requested) {
    const installation = byBinding.get(environmentSkillId);
    // An installation names its skill through the PROJECT half: the environment
    // row is keyed by the project row, and only the project row carries the
    // catalogue id.
    const entry = installation === undefined ? undefined : bySkill.get(installation.project.skillId);
    if (installation === undefined || entry === undefined) {
      unresolved.push(environmentSkillId);
      continue;
    }
    resolved.push({ installation, entry });
  }
  return { resolved, unresolved };
}

function composable(resolved: Resolved): ComposableSkill {
  return {
    slug: resolved.entry.identity.slug,
    name: resolved.entry.name,
    promptBlock: resolved.entry.promptBlock,
    // The denormalised column is what the runtime reads, matching the live
    // hydration's preference for it over the manifest's copy.
    providesTools: resolved.entry.providesTools,
  };
}

export async function composeRuntimeSkills(
  dependencies: SkillsDependencies,
  command: ComposeRuntimeCommand,
): Promise<Result<RuntimeSkills>> {
  const skipped: SkippedSkill[] = [];

  if (command.environmentSkillIds.length === 0) {
    return ok(emptyRuntime(command.basePrompt ?? null, dependencies));
  }

  const installations = await dependencies.repository.findInstallationsByIds(
    command.scope,
    command.environmentSkillIds,
  );
  if (!installations.ok) return err(installations.error);

  const entries = await dependencies.repository.findSkillsForInstallations(
    command.scope,
    installations.value,
  );
  if (!entries.ok) return err(entries.error);

  const paired = pairInRequestOrder(command.environmentSkillIds, installations.value, entries.value);
  for (const environmentSkillId of paired.unresolved) {
    skipped.push({ environmentSkillId, reason: "unresolved" });
  }

  const enabled: Resolved[] = [];
  for (const candidate of paired.resolved) {
    if (!isInstallationEnabled(candidate.installation)) {
      skipped.push({
        environmentSkillId: candidate.installation.environment.environmentSkillId,
        reason: "disabled",
      });
      continue;
    }
    enabled.push(candidate);
  }

  const ready = await filterReady(dependencies, command.scope, enabled, skipped);
  if (!ready.ok) return err(ready.error);

  const composed = composeSkills(ready.value.map(composable), dependencies.policy.runtime.maxPromptChars);
  return ok({
    ...composed,
    systemPrompt: composeSystemPrompt(command.basePrompt ?? null, composed.promptBlock),
    skipped,
  });
}

/** One batched presence lookup, then drop whatever is no longer ready. */
async function filterReady(
  dependencies: SkillsDependencies,
  scope: CatalogueScope,
  candidates: readonly Resolved[],
  skipped: SkippedSkill[],
): Promise<Result<readonly Resolved[]>> {
  const keys = distinctRequiredKeys(candidates.map((candidate) => candidate.entry.requiredEnvironmentKeys));
  if (keys.length === 0) return ok(candidates);

  const presence = await dependencies.environmentKeys.presenceOf(scope.environment, keys);
  if (!presence.ok) return err(presence.error);

  const ready: Resolved[] = [];
  for (const candidate of candidates) {
    if (isEnvironmentReady(candidate.entry.requiredEnvironmentKeys, presence.value)) {
      ready.push(candidate);
      continue;
    }
    skipped.push({
      environmentSkillId: candidate.installation.environment.environmentSkillId,
      reason: "environment-not-ready",
    });
  }
  return ok(ready);
}

function emptyRuntime(basePrompt: string | null, dependencies: SkillsDependencies): RuntimeSkills {
  const composed = composeSkills([], dependencies.policy.runtime.maxPromptChars);
  return {
    ...composed,
    systemPrompt: composeSystemPrompt(basePrompt, composed.promptBlock),
    skipped: [],
  };
}
