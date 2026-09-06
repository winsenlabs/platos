// Every shape the canonical schema will not hold, refused BEFORE a statement is
// sent — `skills`' half of the pattern `identity-guards.ts` established.
//
// WHY A GUARD AND NOT THE DATABASE'S OWN ERROR. On PostgreSQL a violated
// constraint aborts the WHOLE transaction, not just the statement. A caller that
// installs a skill, gets a refusal and then writes an outbox row in the same
// unit of work would meet 25P02 rather than its own refusal, and the second
// failure would be the one it reported. Refusing before the statement leaves the
// caller's transaction intact and usable, which is what makes the refusal a
// value rather than an incident.
//
// EVERY CODE HERE IS DISTINCT, AND THAT IS THE ACCEPTANCE CONDITION RATHER THAN
// A PREFERENCE. Two guards sharing one code cannot be told apart in a log, and
// `skills/domain/errors.ts` deliberately collapses every store failure into ONE
// caller-facing code, `SKILLS_REPOSITORY_UNAVAILABLE` — right for a caller,
// useless for an operator. So the discrimination lives here and travels out of
// band, inside `details.reason`, led by the code.
//
// *** WHAT THE MIGRATIONS HOLD AND `schema.prisma` DOES NOT ***
//
// Reading the model definitions alone would have produced four of these guards
// and missed the rest. `internal-packages/tenancy-database/prisma/migrations/`
// carries, for this context's three tables:
//
//   Skill_manifest_json_root            CHECK jsonb_typeof("manifest") = 'object'
//   Skill_providesTools_json_root       CHECK jsonb_typeof("providesTools") = 'array'
//   EnvironmentSkill_config_json_root   CHECK jsonb_typeof("config") = 'object'
//   Skill_owner_immutable               RULE rejecting an organizationId change
//   ProjectSkill_owner_immutable        RULE rejecting a projectId change
//   EnvironmentSkill_owner_immutable    RULE rejecting an environmentId change
//   ProjectSkill_ancestry               RULE: the project and the skill must
//                                       share an organization — ON INSERT *AND*
//                                       ON UPDATE
//   EnvironmentSkill_ancestry           RULE: the environment and the project
//                                       adoption must share a project — likewise
//                                       on both
//
// Not one of the eight appears in `schema.prisma`, and the in-memory double
// enforces none of them.
//
// AND THE THREE `TEXT[]` COLUMNS ARE NULLABLE IN THE DDL. `tags`,
// `requiredEnvironmentKeys` and `optionalEnvironmentKeys` are declared
// `TEXT[] DEFAULT ARRAY[]::TEXT[]` with NO `NOT NULL`, while `schema.prisma`
// presents all three as non-optional `String[]`. A row holding SQL NULL in any
// of them is therefore REPRESENTABLE and the generated types say it is not —
// which is a READ problem, handled in `skills-rows.ts`, and a WRITE obligation,
// handled here: this store never writes one.

/** An identifier bound for a `@db.Uuid` column is not a uuid. */
export const IDENTIFIER_NOT_UUID = "skills.write.identifier_not_uuid";

/** `Skill.manifest` is `JSONB` behind `jsonb_typeof(...) = 'object'`. */
export const MANIFEST_NOT_OBJECT = "skills.write.manifest_not_object";

/** `Skill.providesTools` is `JSONB` behind `jsonb_typeof(...) = 'array'`. */
export const PROVIDED_TOOLS_NOT_ARRAY = "skills.write.provided_tools_not_array";

/** `EnvironmentSkill.config` is `JSONB` behind `jsonb_typeof(...) = 'object'`. */
export const CONFIG_NOT_OBJECT = "skills.write.config_not_object";

/**
 * A `TEXT[]` column was handed something that is not a list of strings.
 *
 * Distinct from the two JSON codes because the column is an ARRAY OF TEXT, not
 * JSON: the driver refuses a nested object with a message about the array type,
 * and an operator who read `manifest_not_object` there would look at the wrong
 * column.
 */
export const TEXT_LIST_INVALID = "skills.write.text_list_invalid";

/**
 * A `slug` or a `version` is empty.
 *
 * Neither column carries a CHECK, and that is exactly why this guard exists
 * rather than being left to the database. The pair is two thirds of
 * `@@unique([organizationId, slug, version])`, so an empty one does not fail —
 * it SUCCEEDS, and every version-less registration in the organization converges
 * onto that single row. `domain/manifest.ts` defaults an absent version to
 * `DEFAULT_SKILL_VERSION` for the same reason; an empty string arrives past that
 * default, from a manifest that supplied `version: ""`.
 */
export const IDENTITY_SEGMENT_EMPTY = "skills.write.identity_segment_empty";

/**
 * A `Date` bound for a `timestamp(3)` column cannot be stored.
 *
 * An `Invalid Date` reaches the driver as `NaN` and is reported as a parameter
 * error with no column named. Refusing here names the column.
 */
export const INSTANT_NOT_REPRESENTABLE = "skills.write.instant_not_representable";

/**
 * The write's own scope disagrees with the row it is writing.
 *
 * `upsertProjectInstallation` takes a `CatalogueScope` and a `SkillId` and has to
 * write `ProjectSkill.projectId` from the scope; `ProjectSkill_ancestry` will
 * then check the project against the SKILL's organization. This guard catches the
 * case the rule cannot see, because the rule reads the stored rows and not
 * the caller's claim: a scope whose `organizationId` and `projectId` are
 * inconsistent with each other is a forged scope, and it must not reach a
 * statement that would resolve the project alone and quietly write into whatever
 * organization actually owns it.
 */
export const SCOPE_ANCESTRY_INCOHERENT = "skills.write.scope_ancestry_incoherent";

/**
 * A refusal, carrying the distinct code and the detail an operator needs.
 *
 * A class rather than a `Result` because these are raised from deep inside a
 * store method and caught once, in `skills-refusal.ts`, which is the only place
 * a throw becomes an outcome.
 */
export class SkillsWriteRefused extends Error {
  readonly code: string;
  readonly detail: string;

  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "SkillsWriteRefused";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * The uuid shape, as PostgreSQL's `uuid` input parser accepts it.
 *
 * Deliberately the CANONICAL 8-4-4-4-12 hyphenated form and nothing else, even
 * though `uuid_in` also takes the braced and unhyphenated spellings. This store
 * never mints those and the in-memory double never produces one, so admitting
 * them would widen the guard past anything either side can generate — and a
 * guard admitting shapes no caller uses is a guard nothing can falsify.
 *
 * Version and variant nibbles are NOT checked, and that is a decision. The
 * database does not check them either, `AT`-stamped fixtures across this package
 * spell ids like `bbbbbbbb-0011-4000-8000-000000000001`, and a guard stricter
 * than the column would refuse rows PostgreSQL accepts.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function looksLikeUuid(value: string): boolean {
  return UUID.test(value);
}

/** Refuse a value bound for a `@db.Uuid` column that is not one. */
export function requireUuid(field: string, value: string): void {
  if (!looksLikeUuid(value)) {
    throw new SkillsWriteRefused(IDENTIFIER_NOT_UUID, `${field} is not a uuid: ${value}`);
  }
}

/**
 * Refuse a scope whose levels do not agree.
 *
 * `CatalogueScope` wraps an `EnvironmentScope`, which the kernel's union
 * guarantees carries all three ids — so the shape is never missing. What it does
 * NOT guarantee is that the three ids are a real chain, and every one of them is
 * bound to a different column of a different table here.
 */
export function requireCoherentScope(
  organizationId: string,
  projectId: string,
  environmentId: string,
): void {
  requireUuid("scope.organizationId", organizationId);
  requireUuid("scope.projectId", projectId);
  requireUuid("scope.environmentId", environmentId);
  if (organizationId === projectId || projectId === environmentId || organizationId === environmentId) {
    throw new SkillsWriteRefused(
      SCOPE_ANCESTRY_INCOHERENT,
      `scope names one identifier at two levels: org=${organizationId} project=${projectId} environment=${environmentId}`,
    );
  }
}

/** Refuse a value bound for a `jsonb_typeof(...) = 'object'` column. */
export function requireJsonObject(code: string, field: string, value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SkillsWriteRefused(code, `${field} must be a JSON object, got ${describe(value)}`);
  }
}

/** Refuse a value bound for a `jsonb_typeof(...) = 'array'` column. */
export function requireJsonArray(code: string, field: string, value: unknown): void {
  if (!Array.isArray(value)) {
    throw new SkillsWriteRefused(code, `${field} must be a JSON array, got ${describe(value)}`);
  }
}

/**
 * Refuse a value bound for a `TEXT[]` column that is not a list of strings.
 *
 * The NULL half of this guard is the one that matters. `tags`,
 * `requiredEnvironmentKeys` and `optionalEnvironmentKeys` are nullable in the
 * DDL and non-nullable in `schema.prisma`, so a `null` reaching the client is
 * accepted by the type system, refused by the client's validator, and the
 * refusal names a Prisma input path rather than a column.
 */
export function requireTextList(field: string, value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new SkillsWriteRefused(TEXT_LIST_INVALID, `${field} must be a list, got ${describe(value)}`);
  }
  for (const element of value) {
    if (typeof element !== "string") {
      throw new SkillsWriteRefused(
        TEXT_LIST_INVALID,
        `${field} must hold only text, got ${describe(element)}`,
      );
    }
  }
  return value as readonly string[];
}

/** Refuse an empty segment of the `(organizationId, slug, version)` key. */
export function requireIdentitySegment(field: string, value: string): void {
  if (value.length === 0) {
    throw new SkillsWriteRefused(IDENTITY_SEGMENT_EMPTY, `${field} is part of the uniqueness key and is empty`);
  }
}

/** Refuse a `Date` a `timestamp(3)` column cannot hold. */
export function requireInstant(field: string, value: Date): Date {
  if (Number.isNaN(value.getTime())) {
    throw new SkillsWriteRefused(INSTANT_NOT_REPRESENTABLE, `${field} is not a representable instant`);
  }
  return value;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}
