// What the real database refuses, checked BEFORE the statement is sent.
//
// WHY BEFORE. On PostgreSQL a statement that violates a constraint ABORTS the
// enclosing transaction: every later statement fails with 25P02 until the block
// ends. Every mutation on both of this context's ports takes the CALLER's
// `TransactionScope`, and `remember.ts` writes a memory inside the same unit of
// work that appends its extraction entities — so a store that let
// `Memory_extraction_provenance_check` raise would have reported the refusal
// correctly and left the caller unable to write anything else. `cost-guards.ts`
// and `governance-guards.ts` found the same thing on the same database; the
// answer is the same. Refuse in TypeScript, send nothing, keep the transaction.
//
// EVERY GUARD BELOW IS A CONSTRAINT THAT EXISTS ONLY IN THE MIGRATIONS, ONLY IN
// THE COLUMN TYPE, OR ONLY IN A ROW RULE — AND THAT NO IN-MEMORY DOUBLE IN THIS
// CONTEXT HOLDS.
//
//   `@db.Uuid` on three primary keys and on the six foreign keys they carry.
//   `packages/contexts/memory/application/testing/fixtures.ts` mints `mem-1`,
//   `agent-1`, `ent-1` and `thread-1`. Every one is accepted by both doubles and
//   refused by PostgreSQL, and every use-case suite in the context passes with
//   them.
//
//   `Memory_extraction_provenance_check`, which is the one this context's own
//   domain can VIOLATE while returning `ok`. `admitProvenance` in
//   `domain/memory.ts` refuses turns without a thread and nothing else — so a
//   draft naming a thread and an extractor but NO turns is admitted by the
//   domain, stored by the double, and refused by the database, whose extracted
//   branch demands `cardinality("sourceTurnIds") > 0` alongside the extractor.
//
//   `contentHash ~ '^[0-9a-f]{64}$'` — in BOTH branches of that same check. An
//   upper-case digest is a different string to PostgreSQL and is refused; the
//   `ContentDigest` port promises only that the value is deterministic.
//
//   `Memory_confidence_check` and `Memory_feedback_baseline_confidence_check`.
//   `boundedConfidence` clamps to [0, 1] on the paths that call it, and
//   `Memory.confidence` is a plain nullable number that nothing clamps on the
//   way into `insertMemory`.
//
//   `Memory_source_check` and `Memory_visibility_check`. The second is a PAIR
//   constraint over `visibility` and the derived `agentVisible` column, which is
//   why nothing in this package accepts an `agentVisible` from a caller:
//   `memory-rows.ts` derives it with the domain's own `agentVisibleFor`, so the
//   pair agrees by construction rather than by review.
//
//   `vector(1536)`. The column is `Unsupported` in the schema, so the generated
//   client cannot type it at all; a three-component fixture vector reaches
//   pgvector as a literal and is refused there, inside the transaction, with the
//   row already written. `InMemoryEmbeddingModel` produces exactly such vectors.
//
//   pgvector REFUSES `NaN` AND `Infinity`, and `Float` — which is what `weight`
//   and both confidences are — is double precision, which stores them happily.
//   A `NaN` weight would make every mean taken over that column afterwards
//   `NaN` with no error anywhere.
//
//   `Memory_metadata_json_root`, `MemoryEntity_metadata_json_root` and
//   `MemoryRelationship_metadata_json_root`, each `IS NULL OR jsonb_typeof =
//   'object'`. `MemoryMetadata` is typed as an object-or-null in the domain, so
//   the guard exists for the value that arrives through a transport boundary as
//   an array or a scalar with the type assertion already spent.
//
// EVERY REFUSAL HAS ITS OWN CODE. Two guards sharing one code cannot be told
// apart in a log, which is how two defects hid behind one code in `privacy` and
// in `identity-access`.

import type {
  Memory,
  MemoryEntity,
  MemoryMetadata,
  MemoryRelationship,
  MemorySubject,
} from "@platos/context-memory/application/ports/index.js";
import {
  EMBEDDING_DIMENSIONS,
  isMemoryKind,
  isMemorySource,
  isMemoryVisibility,
  MAX_ENTITY_KEY_LENGTH,
  normalizeProfileKey,
} from "@platos/context-memory/application/ports/index.js";

/** An identifier bound for a `@db.Uuid` column that is not a uuid. */
export const MEMORY_IDENTIFIER_NOT_UUID = "memory.write.identifier_not_uuid";

/** `Memory_extraction_provenance_check`: the extracted branch is half-stated. */
export const MEMORY_PROVENANCE_CONTRACT = "memory.write.provenance_contract";

/** `contentHash` is not 64 lower-case hexadecimal digits. */
export const MEMORY_CONTENT_HASH_MALFORMED = "memory.write.content_hash_malformed";

/** `Memory_confidence_check`: outside [0, 1], or not a finite number. */
export const MEMORY_CONFIDENCE_OUT_OF_RANGE = "memory.write.confidence_out_of_range";

/** `Memory_feedback_baseline_confidence_check`, which is a SEPARATE constraint. */
export const MEMORY_BASELINE_OUT_OF_RANGE = "memory.write.baseline_out_of_range";

/** A `kind` no CHECK admits. */
export const MEMORY_KIND_NOT_CANONICAL = "memory.write.kind_not_canonical";

/** A `source` outside `Memory_source_check`'s four values. */
export const MEMORY_SOURCE_NOT_CANONICAL = "memory.write.source_not_canonical";

/** A `visibility` outside `Memory_visibility_check`'s three values. */
export const MEMORY_VISIBILITY_NOT_CANONICAL = "memory.write.visibility_not_canonical";

/** A `*_metadata_json_root` CHECK: the root is not a JSON object. */
export const MEMORY_METADATA_NOT_OBJECT = "memory.write.metadata_not_object";

/** `vector(1536)`: pgvector counts the dimensions and refuses any other count. */
export const MEMORY_EMBEDDING_DIMENSION = "memory.write.embedding_dimension";

/** pgvector refuses `NaN` and `Infinity`; `double precision` does not. */
export const MEMORY_EMBEDDING_NOT_FINITE = "memory.write.embedding_not_finite";

/** `MemoryRelationship.weight` is `Float`, so it would store a `NaN`. */
export const MEMORY_WEIGHT_NOT_FINITE = "memory.write.weight_not_finite";

/** `MAX_ENTITY_KEY_LENGTH`, which the two partial unique indexes are over. */
export const MEMORY_ENTITY_KEY_TOO_LONG = "memory.write.entity_key_too_long";

/** A `profileKey` in a spelling `normalizeProfileKey` would never produce. */
export const MEMORY_PROFILE_KEY_NOT_NORMALISED = "memory.write.profile_key_not_normalised";

export class MemoryWriteRefused extends Error {
  readonly code: string;
  readonly detail: string;

  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "MemoryWriteRefused";
    this.code = code;
    this.detail = detail;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;

/**
 * The dimension the column declares, RE-EXPORTED rather than restated.
 *
 * `embedding-model.ts` in the context already publishes `EMBEDDING_DIMENSIONS`
 * and `isStorableEmbedding` over it, and the number is in the DDL as
 * `vector(1536)`. A second `= 1536` in this file would be a third place the
 * width is written down and the first one to drift; the guard below reads the
 * port's value, so a column widened in the schema and the port is widened here
 * by the same edit.
 */
export { EMBEDDING_DIMENSIONS };

export function requireUuid(label: string, value: string): string {
  if (!UUID.test(value)) {
    throw new MemoryWriteRefused(
      MEMORY_IDENTIFIER_NOT_UUID,
      `${label} must be a uuid for a @db.Uuid column; received ${JSON.stringify(value)}`,
    );
  }
  return value;
}

export function requireOptionalUuid(label: string, value: string | null): string | null {
  return value === null ? null : requireUuid(label, value);
}

export function requireUuidList(label: string, values: readonly string[]): readonly string[] {
  values.forEach((value, index) => requireUuid(`${label}[${String(index)}]`, value));
  return values;
}

/** Every `@db.Uuid` column a subject occupies, checked together. */
export function requireSubjectUuids(subject: MemorySubject): void {
  requireUuid("environmentId", subject.environment.environmentId);
  requireUuid("endUserId", subject.endUserId);
}

function requireBoundedFraction(code: string, label: string, value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new MemoryWriteRefused(
      code,
      `${label} must be a finite number in [0, 1]; received ${String(value)}`,
    );
  }
  return value;
}

export function requireStorableConfidence(value: number | null): number | null {
  return requireBoundedFraction(MEMORY_CONFIDENCE_OUT_OF_RANGE, "confidence", value);
}

export function requireStorableBaseline(value: number | null): number | null {
  return requireBoundedFraction(MEMORY_BASELINE_OUT_OF_RANGE, "feedbackBaselineConfidence", value);
}

export function requireStorableWeight(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value)) {
    throw new MemoryWriteRefused(
      MEMORY_WEIGHT_NOT_FINITE,
      `weight must be a finite number for a double precision column; received ${String(value)}`,
    );
  }
  return value;
}

export function requireStorableMetadata(label: string, metadata: MemoryMetadata): MemoryMetadata {
  if (metadata === null) return null;
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    const shape = Array.isArray(metadata) ? "an array" : typeof metadata;
    throw new MemoryWriteRefused(
      MEMORY_METADATA_NOT_OBJECT,
      `${label} must have a JSON OBJECT root; ${shape} was given`,
    );
  }
  return metadata;
}

/**
 * `Memory_extraction_provenance_check`, transcribed as its two branches.
 *
 * The domain admits a shape this refuses, which is the whole reason the guard is
 * here rather than assumed: `admitProvenance` returns `ok` for a thread and an
 * extractor with no turns, and the database's extracted branch requires
 * `cardinality("sourceTurnIds") > 0` in the same conjunction as the extractor.
 * The direct branch requires the converse — no extractor AND no turns — so the
 * shape falls between the two and satisfies neither.
 */
export function requireStorableProvenance(memory: Memory): void {
  const { sourceThreadId, sourceTurnIds, extractorVersion } = memory.provenance;
  const extractor = extractorVersion === null ? "" : extractorVersion.trim();
  const hash = memory.contentHash;
  if (hash !== null && !SHA256_HEX.test(hash)) {
    throw new MemoryWriteRefused(
      MEMORY_CONTENT_HASH_MALFORMED,
      `contentHash must be 64 lower-case hexadecimal digits; received ${JSON.stringify(hash)}`,
    );
  }
  if (extractor !== "") {
    if (sourceThreadId === null || sourceTurnIds.length === 0 || hash === null) {
      throw new MemoryWriteRefused(
        MEMORY_PROVENANCE_CONTRACT,
        "an extracted memory must carry a source thread, at least one source turn and a content hash",
      );
    }
    return;
  }
  if (sourceTurnIds.length > 0) {
    throw new MemoryWriteRefused(
      MEMORY_PROVENANCE_CONTRACT,
      "a memory with no extractor version may not claim source turns",
    );
  }
}

/** The three closed vocabularies the CHECKs hold, plus the stored key spelling. */
export function requireStorableTaxonomy(memory: Memory): void {
  if (!isMemoryKind(memory.kind)) {
    throw new MemoryWriteRefused(
      MEMORY_KIND_NOT_CANONICAL,
      `kind ${JSON.stringify(memory.kind)} is not a memory kind`,
    );
  }
  if (!isMemorySource(memory.source)) {
    throw new MemoryWriteRefused(
      MEMORY_SOURCE_NOT_CANONICAL,
      `Memory_source_check admits manual, extracted, imported and rag; received ${JSON.stringify(memory.source)}`,
    );
  }
  if (!isMemoryVisibility(memory.visibility)) {
    throw new MemoryWriteRefused(
      MEMORY_VISIBILITY_NOT_CANONICAL,
      `Memory_visibility_check admits agent_visible, hidden and private; received ${JSON.stringify(memory.visibility)}`,
    );
  }
  if (memory.profileKey !== null && normalizeProfileKey(memory.profileKey) !== memory.profileKey) {
    throw new MemoryWriteRefused(
      MEMORY_PROFILE_KEY_NOT_NORMALISED,
      `profileKey ${JSON.stringify(memory.profileKey)} is not the value normalizeProfileKey would store`,
    );
  }
}

/** Everything a `Memory` row write is refused for, in one call. */
export function requireStorableMemory(memory: Memory): void {
  requireUuid("memoryId", memory.memoryId);
  requireSubjectUuids(memory.subject);
  requireUuid("agentId", memory.ownership.agentId);
  requireOptionalUuid("clusterId", memory.ownership.clusterId);
  requireOptionalUuid("sourceThreadId", memory.provenance.sourceThreadId);
  requireUuidList("sourceTurnIds", memory.provenance.sourceTurnIds);
  requireStorableTaxonomy(memory);
  requireStorableProvenance(memory);
  requireStorableConfidence(memory.confidence.confidence);
  requireStorableBaseline(memory.confidence.feedbackBaselineConfidence);
  requireStorableMetadata("Memory.metadata", memory.metadata);
}

export function requireStorableEntity(entity: MemoryEntity): void {
  requireUuid("entityId", entity.entityId);
  requireSubjectUuids(entity.subject);
  requireUuid("agentId", entity.ownership.agentId);
  requireOptionalUuid("clusterId", entity.ownership.clusterId);
  if (entity.entityKey.length > MAX_ENTITY_KEY_LENGTH) {
    throw new MemoryWriteRefused(
      MEMORY_ENTITY_KEY_TOO_LONG,
      `entityKey is ${String(entity.entityKey.length)} characters; the partial unique indexes carry at most ${String(MAX_ENTITY_KEY_LENGTH)}`,
    );
  }
  requireStorableMetadata("MemoryEntity.metadata", entity.metadata);
}

export function requireStorableRelationship(relationship: MemoryRelationship): void {
  requireUuid("relationshipId", relationship.relationshipId);
  requireSubjectUuids(relationship.subject);
  requireUuid("agentId", relationship.ownership.agentId);
  requireOptionalUuid("clusterId", relationship.ownership.clusterId);
  requireUuid("fromEntityId", relationship.fromEntityId);
  requireUuid("toEntityId", relationship.toEntityId);
  requireOptionalUuid("sourceMemoryId", relationship.sourceMemoryId);
  requireStorableWeight(relationship.weight);
  requireStorableMetadata("MemoryRelationship.metadata", relationship.metadata);
}

/**
 * The `vector(1536)` literal pgvector parses, or a refusal.
 *
 * The dimension is counted HERE rather than left to the column, because the
 * column is `Unsupported` in the schema: the generated client carries no type
 * for it, so nothing between a caller's array and pgvector's parser knows how
 * long the column is. `InMemoryEmbeddingModel` produces short vectors and every
 * use-case suite in the context passes with them.
 */
export function toVectorLiteral(label: string, vector: readonly number[]): string {
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new MemoryWriteRefused(
      MEMORY_EMBEDDING_DIMENSION,
      `${label} holds ${String(vector.length)} components; the column is vector(${String(EMBEDDING_DIMENSIONS)})`,
    );
  }
  for (const component of vector) {
    if (!Number.isFinite(component)) {
      throw new MemoryWriteRefused(
        MEMORY_EMBEDDING_NOT_FINITE,
        `${label} holds ${String(component)}, which pgvector refuses`,
      );
    }
  }
  return `[${vector.join(",")}]`;
}
