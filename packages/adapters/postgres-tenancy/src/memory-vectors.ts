// The four statements the generated client cannot express, and the reason it
// cannot.
//
// `Memory.embedding` and `MemoryEntity.embedding` are declared
// `Unsupported("vector(1536)")` in `schema.prisma`. Prisma models an
// `Unsupported` column by NAME only: it appears in no `select`, in no `data`,
// and in no `where`, so a delegate call can neither store a vector nor read one
// nor order by one. That is not a gap this package works around — it is the
// reason ADR M0.3 §15's one ORM home also holds raw SQL, and `RAW_SQL_METHODS`
// in `scripts/arch/table-ownership.mjs` judges these four statements by the
// TABLE THEY NAME exactly as it judges a delegate call.
//
// EVERY STATEMENT HERE IS ONE STATIC TAGGED TEMPLATE, AND THAT IS FORCED. The
// sole-writer gate refuses `raw-sql-not-static` in EVERY package — a statement
// assembled at runtime cannot be attributed to an owner, so no owner can be
// checked and nobody may issue one. The extraction source
// (`apps/agent/src/memory/memory.service.ts`) builds its candidate query by
// joining a `clauses` array into `$queryRawUnsafe`, which is precisely the shape
// the gate refuses; the same query is written below as one template whose
// every filter is a PARAMETER that can turn itself off.
//
// THAT SHAPE IS ALSO WHAT MAKES THE STATEMENT COUNT A CONSTANT. A search with
// no filters and a search with all six are the same one statement, so the pin in
// `memory-statements.integration.test.ts` measures the same number for a small
// fixture and a large one, and no filter can become an extra round trip.
//
// LISTS TRAVEL AS DELIMITED TEXT RATHER THAN AS ARRAYS. `agentIds` and
// `visibilities` are bound as one `text` parameter and re-split in SQL with
// `string_to_array`. A JavaScript array bound straight into a tagged template
// depends on the driver's array serialisation for a column type the client has
// no mapping for; a single `text` parameter depends on nothing. Both lists are
// uuids and closed-vocabulary words respectively — neither can contain the
// delimiter — and `memory-guards.ts` has already refused anything that is not a
// uuid before a search is ever issued.

import type { TenancyReader, TenancyTransactionClient } from "./client.js";
import type { MemoryEntityRow, MemoryRow } from "./memory-rows.js";

/** The `WHERE` a vector search narrows by, flattened into bindable scalars. */
export interface MemorySearchBindings {
  readonly environmentId: string;
  readonly endUserId: string;
  /** Comma-joined agent uuids. Never empty: the store answers `[]` without a statement. */
  readonly agentCsv: string;
  readonly kind: string | null;
  readonly source: string | null;
  /** Comma-joined visibilities, or `""` when the caller named none. */
  readonly visibilityCsv: string;
  readonly activeOnly: boolean;
  readonly archivedOnly: boolean;
  readonly excludeRag: boolean;
  readonly excludeQuarantined: boolean;
  readonly vector: string;
  readonly candidateLimit: number;
}

/** One candidate row, plus the similarity the store computed. */
export type MemoryCandidateRow = MemoryRow & { readonly score: number };

export type EntityCandidateRow = MemoryEntityRow & { readonly score: number };

/**
 * The candidate query.
 *
 * `1 - (embedding <=> v)` is cosine similarity in [0, 1], computed by the store
 * exactly as `MemoryMatch.score` documents. The order is by DISTANCE ascending
 * rather than by the similarity descending so the HNSW cosine index on
 * `("embedding" vector_cosine_ops) WHERE "embedding" IS NOT NULL` can serve it;
 * the two orders are the same order. The tie-break on `"id"` makes it TOTAL, so
 * a page is stable across two identical calls.
 */
export async function selectMemoryCandidates(
  reader: TenancyReader,
  bindings: MemorySearchBindings,
): Promise<readonly MemoryCandidateRow[]> {
  return reader.$queryRaw<MemoryCandidateRow[]>`
    SELECT "id", "endUserId", "agentId", "clusterId", "kind", "profileKey", "content",
           "metadata", "visibility", "source", "sourceThreadId", "sourceTurnIds",
           "extractorVersion", "originalSource", "originalSourceThreadId",
           "originalSourceTurnIds", "contentHash", "confidence",
           "feedbackBaselineConfidence", "lastAccessedAt", "quarantinedAt", "archivedAt",
           "createdAt", "updatedAt",
           1 - ("embedding" <=> ${bindings.vector}::vector) AS "score"
      FROM "Memory"
     WHERE "environmentId" = ${bindings.environmentId}::uuid
       AND "endUserId" = ${bindings.endUserId}::uuid
       AND "agentId" = ANY(string_to_array(${bindings.agentCsv}, ',')::uuid[])
       AND "embedding" IS NOT NULL
       AND (${bindings.kind}::text IS NULL OR "kind" = ${bindings.kind}::text)
       AND (${bindings.source}::text IS NULL OR "source" = ${bindings.source}::text)
       AND (${bindings.visibilityCsv}::text = ''
            OR "visibility" = ANY(string_to_array(${bindings.visibilityCsv}, ',')))
       AND (${bindings.activeOnly}::boolean IS NOT TRUE OR "archivedAt" IS NULL)
       AND (${bindings.archivedOnly}::boolean IS NOT TRUE OR "archivedAt" IS NOT NULL)
       AND (${bindings.excludeRag}::boolean IS NOT TRUE OR "source" <> 'rag')
       AND (${bindings.excludeQuarantined}::boolean IS NOT TRUE OR "quarantinedAt" IS NULL)
     ORDER BY "embedding" <=> ${bindings.vector}::vector ASC, "id" ASC
     LIMIT ${bindings.candidateLimit}`;
}

/** The `WHERE` an entity search narrows by. Entities carry no lifecycle columns. */
export interface EntitySearchBindings {
  readonly environmentId: string;
  readonly endUserId: string;
  readonly agentCsv: string;
  readonly vector: string;
  readonly limit: number;
}

export async function selectEntityCandidates(
  reader: TenancyReader,
  bindings: EntitySearchBindings,
): Promise<readonly EntityCandidateRow[]> {
  return reader.$queryRaw<EntityCandidateRow[]>`
    SELECT "id", "endUserId", "agentId", "clusterId", "entityKey", "entityType", "label",
           "aliases", "metadata", "createdAt", "updatedAt",
           1 - ("embedding" <=> ${bindings.vector}::vector) AS "score"
      FROM "MemoryEntity"
     WHERE "environmentId" = ${bindings.environmentId}::uuid
       AND "endUserId" = ${bindings.endUserId}::uuid
       AND "agentId" = ANY(string_to_array(${bindings.agentCsv}, ',')::uuid[])
       AND "embedding" IS NOT NULL
     ORDER BY "embedding" <=> ${bindings.vector}::vector ASC, "id" ASC
     LIMIT ${bindings.limit}`;
}

/**
 * Store, keep or clear one row's vector.
 *
 * ONE statement serves `set` and `clear` because a bound `null` and a bound
 * literal reach the same `::vector` cast; `keep` never calls this at all, which
 * is the whole reason `EmbeddingDirective` is a three-case union rather than a
 * nullable vector. The `WHERE` carries `environmentId` as well as the primary
 * key, for the reason `cost-budgets.ts` gives for keying its update on the pair:
 * a bare id is installation-wide, and a store whose statements are scoped only
 * where the caller remembered to scope them is a store with a tenant leak one
 * refactor away.
 *
 * It is a WRITE and is counted as one: `MUTATING_SQL_STATEMENT` matches
 * `update "Memory"` and attributes it to `memory`, whose canonical-store adapter
 * is this directory.
 */
export async function writeMemoryEmbedding(
  writer: TenancyTransactionClient,
  environmentId: string,
  memoryId: string,
  vector: string | null,
): Promise<number> {
  return writer.$executeRaw`
    UPDATE "Memory"
       SET "embedding" = ${vector}::vector
     WHERE "id" = ${memoryId}::uuid AND "environmentId" = ${environmentId}::uuid`;
}

export async function writeEntityEmbedding(
  writer: TenancyTransactionClient,
  environmentId: string,
  entityId: string,
  vector: string | null,
): Promise<number> {
  return writer.$executeRaw`
    UPDATE "MemoryEntity"
       SET "embedding" = ${vector}::vector
     WHERE "id" = ${entityId}::uuid AND "environmentId" = ${environmentId}::uuid`;
}

/** Is a row's vector present? The one question a suite can ask about a column no read returns. */
export async function countRowsWithEmbedding(
  reader: TenancyReader,
  memoryId: string,
): Promise<number> {
  const rows = await reader.$queryRaw<{ readonly present: bigint }[]>`
    SELECT count(*) AS "present" FROM "Memory"
     WHERE "id" = ${memoryId}::uuid AND "embedding" IS NOT NULL`;
  return Number(rows[0]?.present ?? 0n);
}
