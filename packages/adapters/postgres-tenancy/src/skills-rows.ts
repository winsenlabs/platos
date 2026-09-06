// Stored row in, domain value out — and every column VALIDATED rather than cast.
//
// WHY VALIDATION AND NOT A CAST. Three of this context's columns are typed far
// more loosely in PostgreSQL than in the domain, and a cast would let the
// looseness through into code that assumes the tight type:
//
//   `Skill.origin` is a plain `TEXT`. The closed set `SkillOrigin` lives ONLY in
//     `skills/domain/manifest.ts`; there is no enum behind the column. A cast
//     would put a fourth value into `compareCatalogueEntries`, whose first
//     comparison is on `isOfficial` and whose callers read `origin` to decide
//     whether a row may be uninstalled.
//
//   `Skill.manifest` is `JSONB` behind one CHECK — that its root is an object.
//     Nothing checks a single field inside it. A cast would hand a caller a
//     `SkillManifest` whose `provides_tools` was a string.
//
//   `Skill.providesTools` is `JSONB` behind one CHECK — that its root is an
//     array. Nothing checks an element. It is the column the runtime reads in
//     preference to the manifest (`domain/catalogue.ts` says so), so a bad
//     element there is a tool the sandbox is asked to run.
//
// *** THE THREE `TEXT[]` COLUMNS ARE NULLABLE AND THE GENERATED TYPES SAY THEY
// ARE NOT. *** `00000000000000_initial/migration.sql` declares
//
//     "tags"                    TEXT[] DEFAULT ARRAY[]::TEXT[],
//     "requiredEnvironmentKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
//     "optionalEnvironmentKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
//
// with no `NOT NULL` on any of the three, while `schema.prisma` presents all
// three as `String[]`. A row holding SQL NULL is therefore representable, the
// client's types deny that it is, and the in-memory double — which holds
// JavaScript arrays — cannot produce one at all. Every read here goes through
// `readTextList`, which answers `[]`, because the column DEFAULT says `[]` is
// what the absence means and rule 7 of the expand/contract discipline says a row
// written without a newer column must still read.
//
// *** AN ABSENT MANIFEST KEY IS NOT A CORRUPT MANIFEST. *** `SkillManifest`
// declares `author`, `origin`, `spec_version`, `importedFrom` and `category` as
// REQUIRED properties of a nullable type, so a manifest serialised before one of
// them existed reads back with the key missing rather than null. Refusing that
// row would make this binary unable to read what an older one wrote. So an
// absent nullable key normalises to `null` and an absent list to `[]`, while a
// key that is PRESENT with the wrong type is refused: the first is a version
// skew and the second is corruption, and collapsing them would hide the second.
//
// UNKNOWN KEYS SURVIVE. Every reader spreads the stored object before
// normalising, so a manifest carrying a field this binary has never heard of
// round-trips through a read and a re-registration unchanged. Rebuilding from a
// known key list would silently DELETE the newer release's data on the next
// write — an expand/contract failure in the contract direction.

import type {
  CatalogueEntry,
  EnvironmentInstallation,
  EnvironmentKey,
  EnvironmentScope,
  EnvironmentSkillId,
  JsonValue,
  ProjectInstallation,
  ProjectSkillId,
  SkillId,
  SkillIdentity,
  SkillManifest,
  SkillOrigin,
  SkillProvidedTool,
  SkillSlug,
  SkillVersion,
  ToolName,
} from "@platos/context-skills/application/ports/index.js";
import {
  asIdentifier,
  isSkillOrigin,
  skillIdentity,
} from "@platos/context-skills/application/ports/index.js";

/** `Skill.origin` held a value outside the closed `SkillOrigin` set. */
export const UNKNOWN_SKILL_ORIGIN = "skills.row.unknown_origin";

/** `Skill.manifest` is not a readable manifest. */
export const UNREADABLE_MANIFEST = "skills.row.unreadable_manifest";

/** `Skill.providesTools` is not a readable list of tool descriptors. */
export const UNREADABLE_PROVIDED_TOOLS = "skills.row.unreadable_provided_tools";

/** `EnvironmentSkill.config` is not a JSON object. */
export const UNREADABLE_INSTALL_CONFIG = "skills.row.unreadable_install_config";

/** A `TEXT[]` column held something that is neither NULL nor a list of text. */
export const UNREADABLE_TEXT_LIST = "skills.row.unreadable_text_list";

/**
 * A stored row this binary cannot read.
 *
 * Separate from `UnreadableRowError` in `./mapping.js` — which `tenancy` and
 * `identity-access` share — because its codes are that half's vocabulary and
 * because a store that answered with another owner's code would send an operator
 * to the wrong table.
 */
export class UnreadableSkillsRowError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "UnreadableSkillsRowError";
    this.code = code;
  }
}

/** The `Skill` columns every read of this table projects. */
export const SKILL_COLUMNS = {
  id: true,
  organizationId: true,
  slug: true,
  name: true,
  description: true,
  version: true,
  author: true,
  origin: true,
  isOfficial: true,
  tags: true,
  source: true,
  manifest: true,
  promptBlock: true,
  providesTools: true,
  requiredEnvironmentKeys: true,
  optionalEnvironmentKeys: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** The `ProjectSkill` columns every read of that table projects. */
export const PROJECT_SKILL_COLUMNS = {
  id: true,
  projectId: true,
  skillId: true,
  enabled: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** The `EnvironmentSkill` columns every read of that table projects. */
export const ENVIRONMENT_SKILL_COLUMNS = {
  id: true,
  environmentId: true,
  projectSkillId: true,
  enabled: true,
  config: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface SkillRow {
  readonly id: string;
  readonly organizationId: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly author: string | null;
  readonly origin: string;
  readonly isOfficial: boolean;
  readonly tags: readonly string[] | null;
  readonly source: string;
  readonly manifest: unknown;
  readonly promptBlock: string;
  readonly providesTools: unknown;
  readonly requiredEnvironmentKeys: readonly string[] | null;
  readonly optionalEnvironmentKeys: readonly string[] | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ProjectSkillRow {
  readonly id: string;
  readonly projectId: string;
  readonly skillId: string;
  readonly enabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface EnvironmentSkillRow {
  readonly id: string;
  readonly environmentId: string;
  readonly projectSkillId: string;
  readonly enabled: boolean;
  readonly config: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function refuse(code: string, message: string): never {
  throw new UnreadableSkillsRowError(code, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A `TEXT[]` column, with SQL NULL read as the empty list the DEFAULT names.
 *
 * The `undefined` arm is not decoration: a projection that omitted the column
 * would otherwise reach the caller as an empty list rather than as a mistake,
 * and this reader is the only place that could tell the difference.
 */
export function readTextList(field: string, value: unknown): readonly string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    refuse(UNREADABLE_TEXT_LIST, `${field} is neither NULL nor a list`);
  }
  for (const element of value) {
    if (typeof element !== "string") refuse(UNREADABLE_TEXT_LIST, `${field} holds a non-text element`);
  }
  return value as readonly string[];
}

/** `Skill.origin`, validated against the closed set rather than cast to it. */
export function readSkillOrigin(value: string): SkillOrigin {
  if (!isSkillOrigin(value)) {
    refuse(UNKNOWN_SKILL_ORIGIN, `Skill.origin holds "${value}", which is not a skill origin`);
  }
  return value;
}

function optionalText(field: string, source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") refuse(UNREADABLE_MANIFEST, `${field}.${key} is present and is not text`);
  return value;
}

function requiredText(field: string, source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string") refuse(UNREADABLE_MANIFEST, `${field}.${key} is missing or is not text`);
  return value;
}

function textListIn(field: string, source: Record<string, unknown>, key: string): readonly string[] {
  const value = source[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) refuse(UNREADABLE_MANIFEST, `${field}.${key} is present and is not a list`);
  for (const element of value) {
    if (typeof element !== "string") refuse(UNREADABLE_MANIFEST, `${field}.${key} holds a non-text element`);
  }
  return value as readonly string[];
}

function optionalOrigin(field: string, source: Record<string, unknown>): SkillOrigin | null {
  const value = source["origin"];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !isSkillOrigin(value)) {
    refuse(UNREADABLE_MANIFEST, `${field}.origin is present and is not a skill origin`);
  }
  return value;
}

/**
 * One element of `Skill.providesTools`, or of `manifest.provides_tools`.
 *
 * `inputSchema` and `outputSchema` are JSON the skill author supplied and this
 * context does not interpret (`domain/manifest.ts` says so), so they are checked
 * for OBJECT-OR-NULL and no further. Checking their contents here would be this
 * package deciding a JSON Schema dialect on the executor's behalf.
 */
function readProvidedTool(field: string, value: unknown): SkillProvidedTool {
  if (!isPlainObject(value)) refuse(UNREADABLE_PROVIDED_TOOLS, `${field} holds a non-object element`);
  const name = value["name"];
  if (typeof name !== "string") refuse(UNREADABLE_PROVIDED_TOOLS, `${field} element has no tool name`);
  const description = value["description"];
  if (description !== undefined && typeof description !== "string") {
    refuse(UNREADABLE_PROVIDED_TOOLS, `${field} element description is present and is not text`);
  }
  const handler = value["handler"];
  if (handler !== undefined && handler !== null && typeof handler !== "string") {
    refuse(UNREADABLE_PROVIDED_TOOLS, `${field} element handler is present and is not text`);
  }
  return {
    ...value,
    name: asIdentifier<ToolName>(name),
    description: description ?? "",
    inputSchema: readSchema(field, value["inputSchema"]),
    outputSchema: readSchema(field, value["outputSchema"]),
    handler: handler ?? null,
  } as SkillProvidedTool;
}

function readSchema(field: string, value: unknown): Readonly<Record<string, JsonValue>> | null {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) refuse(UNREADABLE_PROVIDED_TOOLS, `${field} element schema is not an object`);
  return value as Readonly<Record<string, JsonValue>>;
}

/** `Skill.providesTools`, the column the runtime reads. */
export function readProvidedTools(value: unknown): readonly SkillProvidedTool[] {
  if (!Array.isArray(value)) {
    refuse(UNREADABLE_PROVIDED_TOOLS, "Skill.providesTools is not an array");
  }
  return value.map((element) => readProvidedTool("Skill.providesTools", element));
}

/** `Skill.manifest`, validated field by field and with unknown keys preserved. */
export function readManifest(value: unknown): SkillManifest {
  if (!isPlainObject(value)) refuse(UNREADABLE_MANIFEST, "Skill.manifest is not an object");
  const field = "Skill.manifest";
  const providesTools = value["provides_tools"];
  if (providesTools !== undefined && providesTools !== null && !Array.isArray(providesTools)) {
    refuse(UNREADABLE_MANIFEST, `${field}.provides_tools is present and is not a list`);
  }
  return {
    ...value,
    id: asIdentifier<SkillSlug>(requiredText(field, value, "id")),
    name: requiredText(field, value, "name"),
    description: requiredText(field, value, "description"),
    version: asIdentifier<SkillVersion>(requiredText(field, value, "version")),
    author: optionalText(field, value, "author"),
    origin: optionalOrigin(field, value),
    spec_version: optionalText(field, value, "spec_version"),
    required_env: textListIn(field, value, "required_env").map((key) => asIdentifier<EnvironmentKey>(key)),
    optional_env: textListIn(field, value, "optional_env").map((key) => asIdentifier<EnvironmentKey>(key)),
    provides_tools: (Array.isArray(providesTools) ? providesTools : []).map((element) =>
      readProvidedTool(`${field}.provides_tools`, element),
    ),
    tags: textListIn(field, value, "tags"),
    importedFrom: optionalText(field, value, "importedFrom"),
    category: optionalText(field, value, "category"),
  } as SkillManifest;
}

/** `EnvironmentSkill.config`, validated against the `_json_root` CHECK's shape. */
export function readInstallConfig(value: unknown): Readonly<Record<string, JsonValue>> {
  if (value === null || value === undefined) return {};
  if (!isPlainObject(value)) refuse(UNREADABLE_INSTALL_CONFIG, "EnvironmentSkill.config is not an object");
  return value as Readonly<Record<string, JsonValue>>;
}

/** The `(organizationId, slug, version)` triple, as the domain's value. */
export function readIdentity(row: SkillRow): SkillIdentity {
  return skillIdentity(
    { level: "organization", organizationId: asIdentifier(row.organizationId) },
    asIdentifier<SkillSlug>(row.slug),
    asIdentifier<SkillVersion>(row.version),
  );
}

export function readSkill(row: SkillRow): CatalogueEntry {
  return {
    skillId: asIdentifier<SkillId>(row.id),
    identity: readIdentity(row),
    name: row.name,
    description: row.description,
    author: row.author,
    origin: readSkillOrigin(row.origin),
    isOfficial: row.isOfficial,
    tags: readTextList("Skill.tags", row.tags),
    source: row.source,
    manifest: readManifest(row.manifest),
    promptBlock: row.promptBlock,
    providesTools: readProvidedTools(row.providesTools),
    requiredEnvironmentKeys: readTextList("Skill.requiredEnvironmentKeys", row.requiredEnvironmentKeys).map(
      (key) => asIdentifier<EnvironmentKey>(key),
    ),
    optionalEnvironmentKeys: readTextList("Skill.optionalEnvironmentKeys", row.optionalEnvironmentKeys).map(
      (key) => asIdentifier<EnvironmentKey>(key),
    ),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * `ProjectSkill`, with its organization supplied by the READING SCOPE.
 *
 * The table carries `projectId` and nothing above it, so the organization half
 * of `ProjectInstallation.scope` is not stored anywhere on the row. The
 * in-memory double fills it from the scope for the same reason, and every read
 * of this table in this store is confined to a scope whose project the row's own
 * `projectId` is matched against — so the value is the reader's own claim, not a
 * guess, and a row from another project cannot reach this function at all.
 */
export function readProjectInstallation(
  row: ProjectSkillRow,
  scope: EnvironmentScope,
): ProjectInstallation {
  return {
    projectSkillId: asIdentifier<ProjectSkillId>(row.id),
    scope: {
      level: "project",
      organizationId: scope.organizationId,
      projectId: asIdentifier(row.projectId),
    },
    skillId: asIdentifier<SkillId>(row.skillId),
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function readEnvironmentInstallation(
  row: EnvironmentSkillRow,
  scope: EnvironmentScope,
): EnvironmentInstallation {
  return {
    environmentSkillId: asIdentifier<EnvironmentSkillId>(row.id),
    scope,
    projectSkillId: asIdentifier<ProjectSkillId>(row.projectSkillId),
    enabled: row.enabled,
    config: readInstallConfig(row.config),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
