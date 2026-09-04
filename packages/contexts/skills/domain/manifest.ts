// The skill manifest — the durable JSON this context stores in `Skill.manifest`.
//
// FIELD NAMES ARE THE PERSISTED CONTRACT, NOT A STYLE CHOICE. `required_env`,
// `optional_env`, `provides_tools` and `spec_version` are snake_case because
// they are the frontmatter keys a skill author writes AND the keys already
// serialised into every `Skill.manifest` column in the live system. The registry
// reads `manifest.provides_tools`, `manifest.importedFrom` and
// `manifest.category` straight back out of that column. Renaming any of them
// here would be a silent data migration disguised as a tidy-up: old rows would
// keep the old keys and read back as undefined. So the shape is transcribed, not
// improved. `importedFrom` is camelCase for exactly the same reason — that is
// how it was written.
//
// A manifest is a VALUE. It is validated once, at the edge, by
// `parseSkillSource`; everything downstream receives a `SkillManifest` and may
// assume its invariants hold rather than re-checking them.

import type { JsonValue } from "@platos/kernel";

import type { EnvironmentKey, SkillSlug, SkillVersion, ToolName } from "./identifiers.js";

/**
 * One tool a skill contributes to the runtime catalogue.
 *
 * `inputSchema` and `outputSchema` are stored as supplied. This context does not
 * interpret them: it is the registry, not the executor, and a JSON Schema
 * dialect is the executor's problem.
 */
export interface SkillProvidedTool {
  readonly name: ToolName;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, JsonValue>> | null;
  readonly outputSchema: Readonly<Record<string, JsonValue>> | null;
  /**
   * How the runtime resolves an executor for this tool. Opaque here — a durable
   * job identifier or a module reference, both of which mean something only to
   * the sandbox that receives it.
   */
  readonly handler: string | null;
}

/** Where a catalogue row came from. */
export type SkillOrigin = "official" | "community" | "custom";

export const SKILL_ORIGINS: readonly SkillOrigin[] = Object.freeze([
  "official",
  "community",
  "custom",
]);

export function isSkillOrigin(value: unknown): value is SkillOrigin {
  return typeof value === "string" && (SKILL_ORIGINS as readonly string[]).includes(value);
}

export interface SkillManifest {
  /** The namespaced id. Becomes `Skill.slug`. */
  readonly id: SkillSlug;
  readonly name: string;
  readonly description: string;
  readonly version: SkillVersion;
  readonly author: string | null;
  readonly origin: SkillOrigin | null;
  readonly spec_version: string | null;
  readonly required_env: readonly EnvironmentKey[];
  readonly optional_env: readonly EnvironmentKey[];
  readonly provides_tools: readonly SkillProvidedTool[];
  readonly tags: readonly string[];
  /** The URL an import came from; null for a manifest supplied as raw source. */
  readonly importedFrom: string | null;
  /** A grouping hint. Absent means "derive one" — see `domain/category.ts`. */
  readonly category: string | null;
}

/** A manifest plus the markdown body beneath it, and the source both came from. */
export interface ParsedSkill {
  readonly manifest: SkillManifest;
  /** The body below the frontmatter, spliced into the system prompt. */
  readonly promptBlock: string;
  /** The raw source, retained verbatim so a re-parse round-trips. */
  readonly source: string;
}

/**
 * The default when an author omits `version`.
 *
 * Transcribed from the live parser. It matters because `version` is part of the
 * `(organizationId, slug, version)` uniqueness key: two version-less uploads of
 * the same slug are ONE row that upserts, not two rows that accumulate.
 */
export const DEFAULT_SKILL_VERSION = "0.0.1";

/**
 * The namespacing rule for a manifest id: at least two dot-separated segments,
 * each of letters, digits, underscore or hyphen.
 *
 * Case-insensitive, matching the live parser. It does NOT lowercase the id — the
 * slug is stored as written, and normalising it here would silently merge two
 * rows that the database's unique index treats as distinct.
 */
const NAMESPACED_ID = /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/iu;

export function isNamespacedSkillId(id: string): boolean {
  return NAMESPACED_ID.test(id);
}
