// Identifiers owned by the `skills` context (ADR M0.3 §1, context 6).
//
// The kernel brands the tenancy tree; these brand the rows this context is sole
// writer of, plus the opaque strings that are NOT primary keys and are the
// easiest to mix up: the manifest slug, the version, an environment-variable
// NAME, and a tool name before and after namespacing. Every one of them is a
// plain `String` column or a plain `string` field in the baseline system, and
// every one of them silently substitutes for another when it is typed `string`.
//
// The distinction that matters most here is `SkillId` vs `SkillSlug`.
// `Skill.id` is a uuid; `Skill.slug` is the namespaced manifest id
// (`platos.web_search`). The live registry accepts EITHER at one entry point
// (`getBySlugOrId`) and only the uuid at every other, and passing a slug where a
// row id belongs is the defect this branding makes impossible to write.

import type { Branded } from "@platos/kernel";

/** `Skill.id` — uuid. NOT the manifest id. */
export type SkillId = Branded<string, "SkillId">;

/**
 * `Skill.slug` — the namespaced manifest id, `org.skill_name`. Many rows share
 * one slug: the `@@unique([organizationId, slug, version])` key is what makes a
 * slug plus a version a single row and a slug alone a family of them.
 */
export type SkillSlug = Branded<string, "SkillSlug">;

/** `Skill.version` — an opaque author-supplied string, never parsed as semver. */
export type SkillVersion = Branded<string, "SkillVersion">;

/** `ProjectSkill.id` — uuid. The project-level half of an install. */
export type ProjectSkillId = Branded<string, "ProjectSkillId">;

/** `EnvironmentSkill.id` — uuid. The environment-level half of an install. */
export type EnvironmentSkillId = Branded<string, "EnvironmentSkillId">;

/**
 * The NAME of an environment variable a skill declares, never its value. The
 * baseline invariant is that a skill sees names only; the values stay in the
 * secrets boundary and never enter this context (ADR M0.3 §1, context 3).
 */
export type EnvironmentKey = Branded<string, "EnvironmentKey">;

/** A tool name as the manifest declares it, before namespacing. */
export type ToolName = Branded<string, "ToolName">;

/**
 * A tool name after the skill slug is folded into it. Branded separately from
 * `ToolName` because handing an un-namespaced name to the runtime is exactly the
 * collision with entity-provided tools that namespacing exists to prevent.
 */
export type NamespacedToolName = Branded<string, "NamespacedToolName">;
