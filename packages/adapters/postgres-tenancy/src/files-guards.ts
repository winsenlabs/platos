// Every shape the canonical schema will not hold, refused BEFORE a statement is
// sent — `files`' half of the pattern `identity-guards.ts` established.
//
// WHY A GUARD AND NOT THE DATABASE'S OWN ERROR. On PostgreSQL a violated
// constraint aborts the WHOLE transaction, not just the statement. A caller that
// binds three attachments to a turn, meets a refusal on the second and then
// appends an outbox row in the same unit of work would meet 25P02 rather than
// its own refusal, and the second failure would be the one it reported. Refusing
// before the statement leaves the caller's transaction intact and usable, which
// is what makes the refusal a value rather than an incident.
//
// EVERY CODE HERE IS DISTINCT, AND THAT IS THE ACCEPTANCE CONDITION RATHER THAN
// A PREFERENCE. Two guards sharing one code cannot be told apart in a log, and
// `files/domain/errors.ts` collapses every store failure into ONE caller-facing
// code, `FILES_REPOSITORY_UNAVAILABLE` — right for a caller, useless for an
// operator. So the discrimination lives here and travels out of band, inside
// `details.reason`, led by the code.
//
// *** WHAT THE MIGRATIONS HOLD AND `schema.prisma` DOES NOT ***
//
// Reading the two model definitions alone would have produced the uuid guard and
// missed every other rule this store has to live under.
// `internal-packages/tenancy-database/prisma/migrations/` carries, for these two
// tables:
//
//   Artifact_metadata_json_root         CHECK metadata IS NULL OR
//                                       jsonb_typeof("metadata") = 'object'
//   Artifact_ancestry                   RULE: the thread must be IN the row's
//                                       environment, and `producedByTurnId` must
//                                       be a turn OF THAT THREAD — ON INSERT AND
//                                       ON UPDATE
//   MessageAttachment_ancestry          RULE: the end user must belong to the
//                                       environment's ORGANIZATION, the agent to
//                                       its PROJECT, and the thread must carry
//                                       the same environment, end user AND agent
//                                       — on both
//   MessageAttachment_owner_immutable   RULE rejecting any change to
//                                       environmentId, endUserId, agentId or
//                                       threadId
//   MessageAttachment_binding_one_way   RULE rejecting any change to a turn
//                                       binding once one is set — INCLUDING
//                                       clearing it back to NULL
//
// Not one of the five appears in `schema.prisma`, and the in-memory double
// enforces none of them.
//
// AND FIVE COLUMNS ARE `INTEGER` WHERE THE DOMAIN SAYS `number`. `bytes`,
// `width`, `height`, `durationSec` and `revision` are 32-bit signed on
// PostgreSQL; `Attachment.bytes` and `ArtifactRevision.revision` are plain
// TypeScript numbers, which are 64-bit floats. A 3 GB upload, a fractional byte
// count and a negative revision are all values the double stores and the column
// refuses.

import type { EnvironmentScope, TenantScope } from "@platos/context-files/application/ports/index.js";

/** An identifier bound for a `@db.Uuid` column is not a uuid. */
export const FILES_IDENTIFIER_NOT_UUID = "files.write.identifier_not_uuid";

/** A `Date` bound for a `timestamp(3)` column cannot be stored. */
export const FILES_INSTANT_NOT_REPRESENTABLE = "files.write.instant_not_representable";

/** A value bound for an `INTEGER` column is not a 32-bit signed integer. */
export const INTEGER_OUT_OF_RANGE = "files.write.integer_out_of_range";

/** `Artifact.metadata` is `JSONB` behind `jsonb_typeof(...) = 'object'`. */
export const METADATA_NOT_OBJECT = "files.write.metadata_not_object";

/**
 * A `TEXT` column was handed a string PostgreSQL cannot store.
 *
 * `U+0000` is the one character a `text` value may not contain: the wire format
 * is NUL-terminated, so the driver reports it as an encoding error naming no
 * column at all. Every free-form column of these two tables is exposed to it —
 * `originalName` comes off an upload, `content` and `title` off a model, and
 * `storageKey` is derived from a sanitised filename that keeps every character
 * outside its own unsafe set.
 */
export const TEXT_HOLDS_NUL = "files.write.text_holds_nul";

/**
 * A key column of the erasure selector is empty.
 *
 * `Artifact.createdBy` is a plain `TEXT` with no CHECK behind it, and it is what
 * `deleteArtifactRevisionsForSubject` matches on. An empty principal is
 * therefore not merely a bad row: it is a row that a LATER erasure of a
 * different, equally empty principal would destroy.
 */
export const PRINCIPAL_EMPTY = "files.write.principal_empty";

/**
 * The write's own scope names an ancestry the tenant tree does not agree with.
 *
 * Both tables store `environmentId` and NOTHING above it, while both aggregates
 * carry a full `EnvironmentScope` — three ids. `MessageAttachment_ancestry`
 * checks the stored chain and has nothing to say about the caller's CLAIM about
 * which project and organization that environment sits under, so a row written
 * under a forged claim would read back under the true one and be invisible to
 * every scoped read that used the forged scope.
 */
export const SCOPE_ANCESTRY_FORGED = "files.write.scope_ancestry_forged";

/** The scope names an environment that does not exist at all. */
export const SCOPE_ENVIRONMENT_UNKNOWN = "files.write.scope_environment_unknown";

/**
 * A refusal, carrying the distinct code and the detail an operator needs.
 *
 * A class rather than a `Result` because these are raised from deep inside a
 * store method and caught once, in `files-refusal.ts`, which is the only place a
 * throw becomes an outcome.
 */
export class FilesWriteRefused extends Error {
  readonly code: string;
  readonly detail: string;

  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "FilesWriteRefused";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * The uuid shape, as PostgreSQL's `uuid` input parser accepts it.
 *
 * Deliberately the CANONICAL 8-4-4-4-12 hyphenated form and nothing else, even
 * though `uuid_in` also takes the braced and unhyphenated spellings: this store
 * never mints those and the in-memory double never produces one. Version and
 * variant nibbles are NOT checked, because the database does not check them
 * either and this package's fixtures spell ids like
 * `bbbbbbbb-0011-4000-8000-000000000001`.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** PostgreSQL `integer`. */
const INT32_MAX = 2147483647;

/** The one character a `text` column may not hold. */
const NUL = "\u0000";

export function looksLikeUuid(value: string): boolean {
  return UUID.test(value);
}

/** Refuse a value bound for a `@db.Uuid` column that is not one. */
export function requireUuid(field: string, value: string): void {
  if (!looksLikeUuid(value)) {
    throw new FilesWriteRefused(FILES_IDENTIFIER_NOT_UUID, `${field} is not a uuid: ${value}`);
  }
}

/** The nullable half: an absent id is fine, a present malformed one is not. */
export function requireOptionalUuid(field: string, value: string | null): void {
  if (value !== null) requireUuid(field, value);
}

/** Refuse a `Date` a `timestamp(3)` column cannot hold. */
export function requireInstant(field: string, value: Date): Date {
  if (Number.isNaN(value.getTime())) {
    throw new FilesWriteRefused(
      FILES_INSTANT_NOT_REPRESENTABLE,
      `${field} is not a representable instant`,
    );
  }
  return value;
}

export function requireOptionalInstant(field: string, value: Date | null): Date | null {
  return value === null ? null : requireInstant(field, value);
}

/**
 * Refuse a value bound for an `INTEGER` column.
 *
 * `minimum` is a parameter because the columns do not share one floor. `bytes`
 * may not be negative — it is summed into an organization quota, and one
 * negative row would let a tenant mint headroom. `revision` may not be below 1:
 * `FIRST_ARTIFACT_REVISION` is 1 and the append-only rule counts up from it.
 * `width`, `height` and `durationSec` are measurements, floored at zero for the
 * same reason `bytes` is, one dimension over.
 */
export function requireInt32(field: string, value: number, minimum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > INT32_MAX) {
    throw new FilesWriteRefused(
      INTEGER_OUT_OF_RANGE,
      `${field} must be an integer in [${String(minimum)}, ${String(INT32_MAX)}], got ${String(value)}`,
    );
  }
  return value;
}

export function requireOptionalInt32(
  field: string,
  value: number | null,
  minimum: number,
): number | null {
  return value === null ? null : requireInt32(field, value, minimum);
}

/** Refuse a value bound for a `jsonb_typeof(...) = 'object'` column. */
export function requireJsonObject(field: string, value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FilesWriteRefused(
      METADATA_NOT_OBJECT,
      `${field} must be a JSON object, got ${describe(value)}`,
    );
  }
}

/** Refuse a `TEXT` value PostgreSQL cannot store. */
export function requireStorableText(field: string, value: string): string {
  if (value.includes(NUL)) {
    throw new FilesWriteRefused(
      TEXT_HOLDS_NUL,
      `${field} contains U+0000, which a text column cannot hold`,
    );
  }
  return value;
}

export function requireOptionalStorableText(field: string, value: string | null): string | null {
  return value === null ? null : requireStorableText(field, value);
}

/** Refuse an empty `Artifact.createdBy`. */
export function requirePrincipal(field: string, value: string): string {
  if (value.length === 0) {
    throw new FilesWriteRefused(
      PRINCIPAL_EMPTY,
      `${field} is the erasure selector's key column and is empty`,
    );
  }
  return requireStorableText(field, value);
}

/**
 * Refuse a scope whose three ids are not three uuids.
 *
 * The SHAPE half only. Whether the three are a real chain is a question about
 * stored rows, and `requireAncestry` in `files-ancestry.ts` asks the database
 * rather than guessing here.
 */
export function requireScopeShape(scope: EnvironmentScope): void {
  requireUuid("scope.organizationId", scope.organizationId);
  requireUuid("scope.projectId", scope.projectId);
  requireUuid("scope.environmentId", scope.environmentId);
}

/**
 * The shape half for an erasure selector, whose scope may sit at any of the
 * three levels.
 *
 * `FilesErasureSelector.scope` is a `TenantScope` and not an `EnvironmentScope`
 * on purpose — an erasure may be addressed at an organization — so this checks
 * exactly the ids the level carries and no more.
 */
export function requireTenantScopeShape(scope: TenantScope): void {
  requireUuid("selector.scope.organizationId", scope.organizationId);
  if (scope.level === "organization") return;
  requireUuid("selector.scope.projectId", scope.projectId);
  if (scope.level === "project") return;
  requireUuid("selector.scope.environmentId", scope.environmentId);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}
