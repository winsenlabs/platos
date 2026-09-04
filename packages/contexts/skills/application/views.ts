// Turning domain values into the shapes `contracts/` publishes.
//
// One direction only, and no rules: a view is a projection, so anything that
// looks like a decision here belongs in `domain/`. The two things this file DOES
// decide are both about honesty at the boundary.
//
//   `category` is DERIVED here rather than stored, because it is derived in the
//     live system too — a fallback computed from the slug when the author
//     declared none. Storing it would freeze a guess that the rule is free to
//     improve.
//
//   `envReady` stays three-valued. Passing `null` through unflattened is the
//     entire reason `environmentReadiness` takes a nullable presence map: a row
//     read outside any environment was not checked, and saying so is different
//     from saying it failed.

import {
  deriveSkillCategory,
  environmentReadiness,
  namespaceTool,
  type CatalogueEntry,
  type ComposedTool,
  type EnvironmentKey,
  type EnvironmentKeyPresence,
  type Installation,
  type SkillProvidedTool,
  type SkillSlug,
} from "../domain/index.js";
import type {
  SkillBindingView,
  SkillToolView,
  SkillView,
} from "../contracts/index.js";

/** Only the REQUIRED keys' presence is published: optional keys gate nothing. */
function requiredPresence(
  required: readonly EnvironmentKey[],
  presence: EnvironmentKeyPresence | null,
): Readonly<Record<string, boolean>> {
  if (presence === null) return {};
  const out: Record<string, boolean> = {};
  for (const key of required) out[key] = presence[key] === true;
  return out;
}

export function toSkillToolView(slug: SkillSlug, tool: SkillProvidedTool): SkillToolView {
  return {
    name: namespaceTool(slug, tool.name),
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    slug,
  };
}

export function toComposedToolView(tool: ComposedTool): SkillToolView {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    slug: tool.slug,
  };
}

export function toSkillView(
  entry: CatalogueEntry,
  presence: EnvironmentKeyPresence | null,
): SkillView {
  const slug = entry.identity.slug;
  return {
    skillId: entry.skillId,
    slug,
    version: entry.identity.version,
    name: entry.name,
    description: entry.description,
    author: entry.author,
    origin: entry.origin,
    isOfficial: entry.isOfficial,
    tags: entry.tags,
    category: deriveSkillCategory(slug, entry.manifest),
    promptBlock: entry.promptBlock,
    providesTools: entry.providesTools.map((tool) => toSkillToolView(slug, tool)),
    requiredEnvironmentKeys: entry.requiredEnvironmentKeys,
    optionalEnvironmentKeys: entry.optionalEnvironmentKeys,
    envReady: environmentReadiness(entry.requiredEnvironmentKeys, presence),
    environmentKeyPresence: requiredPresence(entry.requiredEnvironmentKeys, presence),
    importedFrom: entry.manifest.importedFrom,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

export function toSkillViews(
  entries: readonly CatalogueEntry[],
  presence: EnvironmentKeyPresence | null,
): readonly SkillView[] {
  return entries.map((entry) => toSkillView(entry, presence));
}

export function toBindingView(
  entry: CatalogueEntry,
  installation: Installation,
  presence: EnvironmentKeyPresence | null,
): SkillBindingView {
  return {
    environmentSkillId: installation.environment.environmentSkillId,
    // BOTH halves, not just the environment row. A project-level disable takes
    // the skill out of every environment, so reporting only the environment flag
    // would show an unusable skill as enabled.
    enabled: installation.project.enabled && installation.environment.enabled,
    config: installation.environment.config,
    skill: toSkillView(entry, presence),
  };
}
