// The `Skill` aggregate — one catalogue row.
//
// A catalogue entry is ORGANIZATION-scoped, and that is the fact the rest of
// this context is shaped around. `Skill.organizationId` is the only tenancy
// column the table carries; a project and an environment enter the picture only
// through the install rows (`domain/installation.ts`). So "which skills exist"
// and "which skills are usable here" are two different questions with two
// different answers, and conflating them is how an official skill either
// disappears from a fresh environment or leaks across an organization boundary.
//
// IDENTITY IS `(organizationId, slug, version)`. Not the uuid — the uuid is the
// row's handle, but the uniqueness key is the triple, and it is what makes
// registering the same manifest twice an UPDATE rather than a second row. A
// version-less manifest defaults to one fixed version, so repeated uploads of an
// unversioned skill converge on one row instead of accumulating.

import { resolvePath, type OrganizationScope } from "@platos/kernel";

import type { EnvironmentKey, SkillId, SkillSlug, SkillVersion } from "./identifiers.js";
import type { SkillManifest, SkillOrigin, SkillProvidedTool } from "./manifest.js";

/**
 * The uniqueness key, as a value.
 *
 * Built by the domain and compared by the domain, so the `@@unique` index is the
 * last line of defence rather than the only statement of the rule.
 */
export interface SkillIdentity {
  readonly organization: OrganizationScope;
  readonly slug: SkillSlug;
  readonly version: SkillVersion;
}

export function skillIdentity(
  organization: OrganizationScope,
  slug: SkillSlug,
  version: SkillVersion,
): SkillIdentity {
  return { organization, slug, version };
}

/** The canonical string form of an identity — one place a triple becomes a key. */
export function skillIdentityPath(identity: SkillIdentity): string {
  return `${resolvePath(identity.organization)}/skill/${identity.slug}@${identity.version}`;
}

export function sameSkillIdentity(left: SkillIdentity, right: SkillIdentity): boolean {
  return skillIdentityPath(left) === skillIdentityPath(right);
}

export interface CatalogueEntry {
  readonly skillId: SkillId;
  readonly identity: SkillIdentity;
  readonly name: string;
  readonly description: string;
  readonly author: string | null;
  readonly origin: SkillOrigin;
  /**
   * Official rows are catalogue-owned: seeded, visible everywhere in the
   * organization without an install, and not editable or uninstallable through
   * the tenant-facing surface.
   */
  readonly isOfficial: boolean;
  readonly tags: readonly string[];
  /** The verbatim source, retained so a re-parse round-trips. */
  readonly source: string;
  readonly manifest: SkillManifest;
  readonly promptBlock: string;
  /**
   * Denormalised from `manifest.provides_tools` into its own column in the
   * baseline schema, and read back in preference to the manifest. Kept as its
   * own field for the same reason: the column is what the runtime reads.
   */
  readonly providesTools: readonly SkillProvidedTool[];
  readonly requiredEnvironmentKeys: readonly EnvironmentKey[];
  readonly optionalEnvironmentKeys: readonly EnvironmentKey[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What a registration supplies. The row id and the timestamps are minted. */
export interface CatalogueDraft {
  readonly identity: SkillIdentity;
  readonly origin: SkillOrigin;
  readonly isOfficial: boolean;
  readonly source: string;
  readonly manifest: SkillManifest;
  readonly promptBlock: string;
}

/**
 * Decide the origin and the official flag for a registration.
 *
 * PRECEDENCE, TRANSCRIBED: an explicit option wins; otherwise the manifest's own
 * declaration; otherwise `custom`. `isOfficial` follows the resolved origin
 * unless it too was given explicitly. The consequence worth naming is that a
 * manifest CANNOT make itself official by declaring `origin: official` and
 * arriving through the tenant-facing register path — that path passes an
 * explicit origin, and only the seeding path passes `official`.
 */
export function resolveOrigin(
  manifest: SkillManifest,
  overrides: { readonly origin?: SkillOrigin | null; readonly isOfficial?: boolean | null } = {},
): { readonly origin: SkillOrigin; readonly isOfficial: boolean } {
  const origin = overrides.origin ?? manifest.origin ?? "custom";
  const isOfficial = overrides.isOfficial ?? origin === "official";
  return { origin, isOfficial };
}

export function draftFrom(
  organization: OrganizationScope,
  parsed: { readonly manifest: SkillManifest; readonly promptBlock: string; readonly source: string },
  overrides: { readonly origin?: SkillOrigin | null; readonly isOfficial?: boolean | null } = {},
): CatalogueDraft {
  const { origin, isOfficial } = resolveOrigin(parsed.manifest, overrides);
  return {
    identity: skillIdentity(organization, parsed.manifest.id, parsed.manifest.version),
    origin,
    isOfficial,
    source: parsed.source,
    manifest: parsed.manifest,
    promptBlock: parsed.promptBlock,
  };
}

/** The columns a re-registration of an existing identity overwrites. */
export interface CatalogueRevision {
  readonly name: string;
  readonly description: string;
  readonly author: string | null;
  readonly origin: SkillOrigin;
  readonly isOfficial: boolean;
  readonly tags: readonly string[];
  readonly source: string;
  readonly manifest: SkillManifest;
  readonly promptBlock: string;
  readonly providesTools: readonly SkillProvidedTool[];
  readonly requiredEnvironmentKeys: readonly EnvironmentKey[];
  readonly optionalEnvironmentKeys: readonly EnvironmentKey[];
}

/**
 * What re-registering an existing identity changes.
 *
 * Everything the manifest describes is overwritten; `slug`, `version` and
 * `organizationId` are NOT, because they ARE the identity being matched on.
 * `createdAt` survives, so a re-register does not make an old skill look new.
 */
export function revisionFrom(draft: CatalogueDraft): CatalogueRevision {
  const manifest = draft.manifest;
  return {
    name: manifest.name,
    description: manifest.description,
    author: manifest.author,
    origin: draft.origin,
    isOfficial: draft.isOfficial,
    tags: manifest.tags,
    source: draft.source,
    manifest,
    promptBlock: draft.promptBlock,
    providesTools: manifest.provides_tools,
    requiredEnvironmentKeys: manifest.required_env,
    optionalEnvironmentKeys: manifest.optional_env,
  };
}

/** The editable columns of the tenant-facing patch. Nothing else may move. */
export interface CataloguePatch {
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly tags?: readonly string[] | undefined;
}

export function applyPatch(entry: CatalogueEntry, patch: CataloguePatch): CatalogueEntry {
  return {
    ...entry,
    name: patch.name ?? entry.name,
    description: patch.description ?? entry.description,
    tags: patch.tags ?? entry.tags,
  };
}

export function patchIsEmpty(patch: CataloguePatch): boolean {
  return patch.name === undefined && patch.description === undefined && patch.tags === undefined;
}

/**
 * The catalogue ordering: official first, then slug, then version descending,
 * then row id.
 *
 * Transcribed from the live `orderBy`. The final id comparison is not
 * decoration — without it two rows sharing a slug and a version (which the
 * unique index forbids in one organization but not across a result set built
 * from several) would order non-deterministically, and a paged read would drop
 * or repeat a row between pages.
 */
export function compareCatalogueEntries(left: CatalogueEntry, right: CatalogueEntry): number {
  if (left.isOfficial !== right.isOfficial) return left.isOfficial ? -1 : 1;
  if (left.identity.slug !== right.identity.slug) {
    return left.identity.slug < right.identity.slug ? -1 : 1;
  }
  if (left.identity.version !== right.identity.version) {
    return left.identity.version > right.identity.version ? -1 : 1;
  }
  if (left.skillId === right.skillId) return 0;
  return left.skillId < right.skillId ? -1 : 1;
}

/** Case-insensitive substring search over name, slug and description. */
export function matchesSearch(entry: CatalogueEntry, search: string | null): boolean {
  if (search === null || search.trim() === "") return true;
  const needle = search.trim().toLowerCase();
  return (
    entry.name.toLowerCase().includes(needle) ||
    entry.identity.slug.toLowerCase().includes(needle) ||
    entry.description.toLowerCase().includes(needle)
  );
}
