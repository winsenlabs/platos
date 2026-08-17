import { CUTOVER_CHUNK_SIZE } from "./cutover-backfill";
import {
  assertSecretFreeCutoverEvidence,
  decodeLegacyJsonMessage,
  validateSha256Hex,
  type CutoverJsonValue,
  type DecodedCutoverValue,
} from "./cutover-crypto";
import { normalizeJsonField, type JsonField, type JsonValue } from "./json";
import type { CutoverDatabase } from "./cutover-types";
import { CutoverFailure } from "./cutover-types";

export const retainedMemoryBatch8SourceModels = [
  "PlatosMemory",
  "PlatosMemoryEntity",
  "PlatosMemoryRelationship",
] as const;

export const retainedMemoryBatch8MappingTargets = [
  { sourceModel: "PlatosMemory", targetModel: "Memory", stableSuffix: "" },
  { sourceModel: "PlatosMemoryEntity", targetModel: "MemoryEntity", stableSuffix: "" },
  {
    sourceModel: "PlatosMemoryRelationship",
    targetModel: "MemoryRelationship",
    stableSuffix: "",
  },
] as const;

/** Parents are inserted in bounded stages before graph edges. */
export const retainedMemoryBatch8ParentOrder = Object.freeze([
  "Memory",
  "MemoryEntity",
  "MemoryRelationship",
] as const);

/**
 * Batch 8 validates inherited envelopes and retains their exact at-rest form.
 * The final target writer must re-encrypt these fields and exercise the target
 * runtime reader. Neither operation is implemented or claimed by this batch.
 */
export const retainedMemoryBatch8DeferredTargetChecks = Object.freeze([
  Object.freeze({
    fields: "Memory.content,Memory.metadata",
    reEncryption: "UNIMPLEMENTED",
    readProbe: "MEMORY_DECRYPT_READ_UNIMPLEMENTED",
  }),
  Object.freeze({
    fields: "MemoryEntity.label,MemoryEntity.metadata",
    reEncryption: "UNIMPLEMENTED",
    readProbe: "MEMORY_DECRYPT_READ_UNIMPLEMENTED",
  }),
  Object.freeze({
    fields: "MemoryRelationship.metadata",
    reEncryption: "UNIMPLEMENTED",
    readProbe: "MEMORY_DECRYPT_READ_UNIMPLEMENTED",
  }),
] as const);

export interface RetainedMemoryBatch8Options {
  readonly messageEncryptionKeys: Readonly<Record<string, string>>;
}

export interface RetainedMemoryBatch8Evidence {
  readonly batch: "retained-memory-batch8";
  readonly sourceRows: Readonly<{
    memories: number;
    entities: number;
    relationships: number;
  }>;
  readonly targetRows: Readonly<{
    memories: number;
    entities: number;
    relationships: number;
  }>;
  readonly graphCounts: Readonly<{
    directedEdges: number;
    fromEndpoints: number;
    toEndpoints: number;
    sourcedEdges: number;
  }>;
}

export interface ClassifiedBatch8MessageValue<T extends JsonValue | string> {
  readonly encoding: "PLAINTEXT" | "ENVELOPE";
  readonly keyVersion: number | null;
  readonly storageValue: T;
  readonly decodedValue: T;
}

function batch8Failure(code: string, summary: string): CutoverFailure {
  return new CutoverFailure(code, summary);
}

function parameterTuples(rowCount: number, width: number): string {
  return Array.from({ length: rowCount }, (_, rowIndex) => {
    const offset = rowIndex * width;
    return `(${Array.from(
      { length: width },
      (__, columnIndex) => `$${offset + columnIndex + 1}`
    ).join(", ")})`;
  }).join(", ");
}

async function forEachBatch8SourceChunk<Row extends Record<string, unknown>>(
  database: CutoverDatabase,
  selectSql: string,
  consume: (rows: readonly Row[]) => Promise<void>,
  chunkSize: number
): Promise<number> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new TypeError("cutover chunk size must be a positive integer");
  }

  let cursor = "";
  let count = 0;
  while (true) {
    const result = await database.query<Row>(selectSql, [cursor, chunkSize]);
    if (result.rows.length === 0) return count;
    await consume(result.rows);
    const nextCursor = result.rows[result.rows.length - 1]?.source_id;
    if (typeof nextCursor !== "string" || nextCursor <= cursor) {
      throw batch8Failure(
        "BATCH8_CHUNK_ORDER_INVALID",
        "retained memory Batch 8 source chunk order is not stable"
      );
    }
    cursor = nextCursor;
    count += result.rows.length;
  }
}

function normalizeBatch8Json(field: JsonField, value: unknown): JsonValue {
  try {
    return normalizeJsonField(field, value) as unknown as JsonValue;
  } catch (error) {
    throw batch8Failure(
      "BATCH8_SOURCE_VALUE_INVALID",
      `${field} is malformed${
        error instanceof Error && error.message.includes("expected") ? `: ${error.message}` : ""
      }`
    );
  }
}

/**
 * Only the exact inherited marker is encrypted. Once recognized, malformed,
 * unsupported, wrong-key, and wrong-shape values block without plaintext fallback.
 */
export function classifyBatch8TextMessage(
  field: "Memory.content" | "MemoryEntity.label",
  sourceValue: unknown,
  messageEncryptionKeys: Readonly<Record<string, string>>
): ClassifiedBatch8MessageValue<string> {
  let decoded: DecodedCutoverValue<CutoverJsonValue | string>;
  try {
    decoded = decodeLegacyJsonMessage(sourceValue, "TEXT", messageEncryptionKeys);
  } catch {
    throw batch8Failure(
      "BATCH8_MESSAGE_ENVELOPE_INVALID",
      `${field} message envelope is unreadable`
    );
  }
  if (typeof sourceValue !== "string" || typeof decoded.value !== "string") {
    throw batch8Failure("BATCH8_SOURCE_VALUE_INVALID", `${field} must decode to a string`);
  }
  return Object.freeze({
    encoding: decoded.encoding,
    keyVersion: decoded.keyVersion,
    storageValue: sourceValue,
    decodedValue: decoded.value,
  });
}

export function classifyBatch8NullableJsonMessage(
  field: "Memory.metadata" | "MemoryEntity.metadata" | "MemoryRelationship.metadata",
  sourceValue: unknown,
  messageEncryptionKeys: Readonly<Record<string, string>>
): ClassifiedBatch8MessageValue<JsonValue> | null {
  if (sourceValue === null || sourceValue === undefined) return null;
  let decoded: DecodedCutoverValue<CutoverJsonValue | string>;
  try {
    decoded = decodeLegacyJsonMessage(sourceValue, "JSONB", messageEncryptionKeys);
  } catch {
    throw batch8Failure(
      "BATCH8_MESSAGE_ENVELOPE_INVALID",
      `${field} message envelope is unreadable`
    );
  }
  const normalized = normalizeBatch8Json(field, decoded.value);
  return Object.freeze({
    encoding: decoded.encoding,
    keyVersion: decoded.keyVersion,
    storageValue: decoded.encoding === "ENVELOPE" ? (sourceValue as JsonValue) : normalized,
    decodedValue: normalized,
  });
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw batch8Failure("BATCH8_SOURCE_VALUE_INVALID", `${label} must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.includes("\0"))
  ) {
    throw batch8Failure("BATCH8_SOURCE_VALUE_INVALID", `${label} must be a string array`);
  }
  return value;
}

function nullableConfidence(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw batch8Failure(
      "BATCH8_SOURCE_VALUE_INVALID",
      "PlatosMemory.confidence must be between zero and one"
    );
  }
  return value;
}

function validateVisibility(agentVisible: unknown, visibility: unknown): string {
  if (
    typeof agentVisible !== "boolean" ||
    !["agent_visible", "hidden", "private"].includes(String(visibility)) ||
    agentVisible !== (visibility !== "private")
  ) {
    throw batch8Failure(
      "BATCH8_VISIBILITY_INVALID",
      "PlatosMemory visibility fields are inconsistent"
    );
  }
  return visibility as string;
}

const sourceAndMappingValidationSql = `
  WITH memory_scope AS (
    SELECT 'PlatosMemory'::text AS source_model, id, "organizationId", "projectId",
           "environmentId", "agentId", "userId", "platosEndUserId"
      FROM cutover_legacy."PlatosMemory"
    UNION ALL
    SELECT 'PlatosMemoryEntity', id, "organizationId", "projectId", "environmentId",
           "agentId", "userId", NULL::text
      FROM cutover_legacy."PlatosMemoryEntity"
    UNION ALL
    SELECT 'PlatosMemoryRelationship', id, "organizationId", "projectId", "environmentId",
           "agentId", "userId", NULL::text
      FROM cutover_legacy."PlatosMemoryRelationship"
  ), issues AS (
    SELECT 'missing-static-map' AS issue WHERE EXISTS (
      SELECT 1 FROM (VALUES
        ('PlatosMemory','Memory'),
        ('PlatosMemoryEntity','MemoryEntity'),
        ('PlatosMemoryRelationship','MemoryRelationship')
      ) expected(source_model,target_model)
      JOIN LATERAL (
        SELECT id FROM cutover_legacy."PlatosMemory" WHERE expected.source_model='PlatosMemory'
        UNION ALL SELECT id FROM cutover_legacy."PlatosMemoryEntity"
          WHERE expected.source_model='PlatosMemoryEntity'
        UNION ALL SELECT id FROM cutover_legacy."PlatosMemoryRelationship"
          WHERE expected.source_model='PlatosMemoryRelationship'
      ) source ON true
      WHERE (SELECT count(*) FROM cutover_legacy.cutover_id_map map
              WHERE map.mapping_version=1 AND map.source_model=expected.source_model
                AND map.source_id=source.id AND map.target_model=expected.target_model
                AND map.stable_suffix='') <> 1)
    UNION ALL
    SELECT 'canonical-scope' WHERE EXISTS (
      SELECT 1 FROM memory_scope source
      LEFT JOIN cutover_legacy."RuntimeEnvironment" environment
        ON environment.id=source."environmentId"
      LEFT JOIN cutover_legacy."Project" project ON project.id=source."projectId"
      LEFT JOIN cutover_legacy."PlatosAgent" agent ON agent.id=source."agentId"
      WHERE environment.id IS NULL OR project.id IS NULL OR agent.id IS NULL
         OR source."agentId" IS NULL
         OR environment."projectId"<>source."projectId"
         OR environment."organizationId"<>source."organizationId"
         OR project."organizationId"<>source."organizationId"
         OR agent."projectId"<>source."projectId"
         OR agent."environmentId"<>source."environmentId")
    UNION ALL
    SELECT 'canonical-end-user' WHERE EXISTS (
      SELECT 1 FROM memory_scope source
      WHERE (SELECT count(*) FROM cutover_legacy."PlatosEndUser" end_user
              WHERE end_user."organizationId"=source."organizationId"
                AND end_user."projectId"=source."projectId"
                AND end_user."environmentId"=source."environmentId"
                AND source."userId" IN (end_user.id, end_user."externalUserId", end_user."linkedExternalId")
                AND (source."platosEndUserId" IS NULL OR end_user.id=source."platosEndUserId")) <> 1)
    UNION ALL
    SELECT 'memory-provenance' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosMemory" source
      LEFT JOIN cutover_legacy."PlatosAgentThread" thread ON thread.id=source."sourceThreadId"
      WHERE (
          source."sourceThreadId" IS NULL AND
          (cardinality(source."sourceMessageIds")<>0 OR source."extractorVersion" IS NOT NULL
           OR source."contentHash" IS NOT NULL)
        ) OR (
          source."sourceThreadId" IS NOT NULL AND
          (thread.id IS NULL OR cardinality(source."sourceMessageIds")=0
           OR NULLIF(btrim(source."extractorVersion"),'') IS NULL
           OR source."contentHash" !~ '^[0-9a-f]{64}$'
           OR thread."environmentId"<>source."environmentId"
           OR thread."agentId"<>source."agentId"
           OR NOT EXISTS (
             SELECT 1 FROM cutover_legacy."PlatosEndUser" end_user
             WHERE end_user.id=thread."platosEndUserId"
               AND end_user."environmentId"=source."environmentId"
               AND source."userId" IN (end_user.id, end_user."externalUserId", end_user."linkedExternalId"))
           OR EXISTS (
             SELECT 1 FROM unnest(source."sourceMessageIds") message_id
             LEFT JOIN cutover_legacy."PlatosAgentMessage" message
               ON message.id=message_id AND message."threadId"=source."sourceThreadId"
             WHERE message.id IS NULL
                OR (SELECT count(*) FROM cutover_legacy.cutover_id_map message_map
                    WHERE message_map.mapping_version=1
                      AND message_map.source_model='PlatosAgentMessage'
                      AND message_map.source_id=message_id
                      AND message_map.target_model='Turn'
                      AND message_map.stable_suffix='')<>1))
        ))
    UNION ALL
    SELECT 'memory-target-collision' WHERE EXISTS (
      SELECT source."environmentId", end_user.id, source."sourceThreadId", source."contentHash"
      FROM cutover_legacy."PlatosMemory" source
      JOIN cutover_legacy."PlatosEndUser" end_user
        ON end_user."organizationId"=source."organizationId"
       AND end_user."projectId"=source."projectId"
       AND end_user."environmentId"=source."environmentId"
       AND source."userId" IN (end_user.id, end_user."externalUserId", end_user."linkedExternalId")
       AND (source."platosEndUserId" IS NULL OR end_user.id=source."platosEndUserId")
      WHERE source."sourceThreadId" IS NOT NULL AND source."contentHash" IS NOT NULL
      GROUP BY source."environmentId", end_user.id, source."sourceThreadId", source."contentHash"
      HAVING count(*)>1)
    UNION ALL
    SELECT 'entity-target-collision' WHERE EXISTS (
      SELECT source."environmentId", end_user.id, source."agentId", source."entityKey"
      FROM cutover_legacy."PlatosMemoryEntity" source
      JOIN cutover_legacy."PlatosEndUser" end_user
        ON end_user."organizationId"=source."organizationId"
       AND end_user."projectId"=source."projectId"
       AND end_user."environmentId"=source."environmentId"
       AND source."userId" IN (end_user.id, end_user."externalUserId", end_user."linkedExternalId")
      GROUP BY source."environmentId", end_user.id, source."agentId", source."entityKey"
      HAVING count(*)>1)
    UNION ALL
    SELECT 'relationship-target-collision' WHERE EXISTS (
      SELECT "fromEntityId", "toEntityId", "relationshipType"
      FROM cutover_legacy."PlatosMemoryRelationship"
      GROUP BY "fromEntityId", "toEntityId", "relationshipType" HAVING count(*)>1)
    UNION ALL
    SELECT 'relationship-canonical-scope' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosMemoryRelationship" relationship
      LEFT JOIN cutover_legacy."PlatosMemoryEntity" source
        ON source.id=relationship."fromEntityId"
      LEFT JOIN cutover_legacy."PlatosMemoryEntity" target
        ON target.id=relationship."toEntityId"
      LEFT JOIN cutover_legacy."PlatosMemory" source_memory
        ON source_memory.id=relationship."sourceMemoryId"
      LEFT JOIN LATERAL (
        SELECT end_user.id FROM cutover_legacy."PlatosEndUser" end_user
        WHERE end_user."organizationId"=relationship."organizationId"
          AND end_user."projectId"=relationship."projectId"
          AND end_user."environmentId"=relationship."environmentId"
          AND relationship."userId" IN (end_user.id,end_user."externalUserId",end_user."linkedExternalId")
      ) relationship_user ON true
      LEFT JOIN LATERAL (
        SELECT end_user.id FROM cutover_legacy."PlatosEndUser" end_user
        WHERE end_user."organizationId"=source."organizationId"
          AND end_user."projectId"=source."projectId"
          AND end_user."environmentId"=source."environmentId"
          AND source."userId" IN (end_user.id,end_user."externalUserId",end_user."linkedExternalId")
      ) source_user ON true
      LEFT JOIN LATERAL (
        SELECT end_user.id FROM cutover_legacy."PlatosEndUser" end_user
        WHERE end_user."organizationId"=target."organizationId"
          AND end_user."projectId"=target."projectId"
          AND end_user."environmentId"=target."environmentId"
          AND target."userId" IN (end_user.id,end_user."externalUserId",end_user."linkedExternalId")
      ) target_user ON true
      LEFT JOIN LATERAL (
        SELECT end_user.id FROM cutover_legacy."PlatosEndUser" end_user
        WHERE end_user."organizationId"=source_memory."organizationId"
          AND end_user."projectId"=source_memory."projectId"
          AND end_user."environmentId"=source_memory."environmentId"
          AND source_memory."userId" IN (end_user.id,end_user."externalUserId",end_user."linkedExternalId")
          AND (source_memory."platosEndUserId" IS NULL OR end_user.id=source_memory."platosEndUserId")
      ) source_memory_user ON true
      WHERE source.id IS NULL OR target.id IS NULL
         OR source."organizationId"<>relationship."organizationId"
         OR source."projectId"<>relationship."projectId"
         OR source."environmentId"<>relationship."environmentId"
         OR source_user.id IS DISTINCT FROM relationship_user.id
         OR source."agentId" IS DISTINCT FROM relationship."agentId"
         OR target."organizationId"<>relationship."organizationId"
         OR target."projectId"<>relationship."projectId"
         OR target."environmentId"<>relationship."environmentId"
         OR target_user.id IS DISTINCT FROM relationship_user.id
         OR target."agentId" IS DISTINCT FROM relationship."agentId"
         OR (relationship."sourceMemoryId" IS NOT NULL AND
             (source_memory.id IS NULL
              OR source_memory."organizationId"<>relationship."organizationId"
              OR source_memory."projectId"<>relationship."projectId"
              OR source_memory."environmentId"<>relationship."environmentId"
              OR source_memory_user.id IS DISTINCT FROM relationship_user.id
              OR source_memory."agentId" IS DISTINCT FROM relationship."agentId")))
  ) SELECT issue FROM issues ORDER BY issue`;

interface MemoryValueRow extends Record<string, unknown> {
  source_id: string;
  content: unknown;
  metadata: unknown;
  agent_visible: unknown;
  visibility: unknown;
  content_hash: unknown;
  confidence: unknown;
}

interface EntityValueRow extends Record<string, unknown> {
  source_id: string;
  label: unknown;
  metadata: unknown;
  aliases: unknown;
}

interface RelationshipValueRow extends Record<string, unknown> {
  source_id: string;
  metadata: unknown;
}

export async function validateRetainedMemoryBatch8Source(
  database: CutoverDatabase,
  options: RetainedMemoryBatch8Options,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<void> {
  const issues = await database.query<{ issue: string }>(sourceAndMappingValidationSql);
  if (issues.rows.length > 0) {
    throw batch8Failure(
      "BATCH8_SOURCE_OR_MAPPING_INVALID",
      `retained memory Batch 8 source validation failed: ${issues.rows
        .map((row) => row.issue)
        .join(", ")}`
    );
  }

  await forEachBatch8SourceChunk<MemoryValueRow>(
    database,
    `SELECT source.id::text AS source_id, source.content, source.metadata,
            source."agentVisible" AS agent_visible, source.visibility,
            source."contentHash" AS content_hash, source.confidence
       FROM cutover_legacy."PlatosMemory" source
      WHERE source.id>$1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      for (const row of rows) {
        classifyBatch8TextMessage("Memory.content", row.content, options.messageEncryptionKeys);
        classifyBatch8NullableJsonMessage(
          "Memory.metadata",
          row.metadata,
          options.messageEncryptionKeys
        );
        validateVisibility(row.agent_visible, row.visibility);
        if (row.content_hash != null) validateSha256Hex(row.content_hash);
        nullableConfidence(row.confidence);
      }
    },
    chunkSize
  );

  await forEachBatch8SourceChunk<EntityValueRow>(
    database,
    `SELECT source.id::text AS source_id, source.label, source.metadata, source.aliases
       FROM cutover_legacy."PlatosMemoryEntity" source
      WHERE source.id>$1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      for (const row of rows) {
        classifyBatch8TextMessage("MemoryEntity.label", row.label, options.messageEncryptionKeys);
        classifyBatch8NullableJsonMessage(
          "MemoryEntity.metadata",
          row.metadata,
          options.messageEncryptionKeys
        );
        stringArray(row.aliases, "PlatosMemoryEntity.aliases");
      }
    },
    chunkSize
  );

  await forEachBatch8SourceChunk<RelationshipValueRow>(
    database,
    `SELECT source.id::text AS source_id, source.metadata
       FROM cutover_legacy."PlatosMemoryRelationship" source
      WHERE source.id>$1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      for (const row of rows) {
        classifyBatch8NullableJsonMessage(
          "MemoryRelationship.metadata",
          row.metadata,
          options.messageEncryptionKeys
        );
      }
    },
    chunkSize
  );
}

interface MemoryRow extends MemoryValueRow {
  target_id: string;
  environment_id: string;
  end_user_id: string;
  agent_id: string;
  kind: unknown;
  embedding: string | null;
  source: unknown;
  source_thread_id: string | null;
  source_turn_ids: string[];
  extractor_version: string | null;
  last_accessed_at: Date | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export async function backfillBatch8Memories(
  database: CutoverDatabase,
  options: RetainedMemoryBatch8Options,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch8SourceChunk<MemoryRow>(
    database,
    `SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
            environment_map.target_id::text AS environment_id,
            end_user_map.target_id::text AS end_user_id,
            agent_map.target_id::text AS agent_id, source.kind, source.content,
            source.metadata, source.embedding::text AS embedding,
            source."agentVisible" AS agent_visible, source.visibility, source.source,
            thread_map.target_id::text AS source_thread_id,
            COALESCE((SELECT array_agg(message_map.target_id::text ORDER BY message_id.ordinality)
              FROM unnest(source."sourceMessageIds") WITH ORDINALITY message_id(source_id, ordinality)
              JOIN cutover_legacy.cutover_id_map message_map ON message_map.mapping_version=1
               AND message_map.source_model='PlatosAgentMessage'
               AND message_map.source_id=message_id.source_id
               AND message_map.target_model='Turn' AND message_map.stable_suffix=''), ARRAY[]::text[])
              AS source_turn_ids,
            source."extractorVersion" AS extractor_version,
            source."contentHash" AS content_hash, source.confidence,
            source."lastAccessedAt" AS last_accessed_at,
            source."archivedAt" AS archived_at,
            source."createdAt" AS created_at, source."updatedAt" AS updated_at
       FROM cutover_legacy."PlatosMemory" source
       JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version=1
        AND target_map.source_model='PlatosMemory' AND target_map.source_id=source.id
        AND target_map.target_model='Memory' AND target_map.stable_suffix=''
       JOIN cutover_legacy.cutover_id_map environment_map ON environment_map.mapping_version=1
        AND environment_map.source_model='RuntimeEnvironment'
        AND environment_map.source_id=source."environmentId"
        AND environment_map.target_model='Environment' AND environment_map.stable_suffix=''
       JOIN LATERAL (SELECT end_user.id FROM cutover_legacy."PlatosEndUser" end_user
        WHERE end_user."organizationId"=source."organizationId"
          AND end_user."projectId"=source."projectId"
          AND end_user."environmentId"=source."environmentId"
          AND source."userId" IN (end_user.id,end_user."externalUserId",end_user."linkedExternalId")
          AND (source."platosEndUserId" IS NULL OR end_user.id=source."platosEndUserId")) source_end_user ON true
       JOIN cutover_legacy.cutover_id_map end_user_map ON end_user_map.mapping_version=1
        AND end_user_map.source_model='PlatosEndUser' AND end_user_map.source_id=source_end_user.id
        AND end_user_map.target_model='EndUser' AND end_user_map.stable_suffix=''
       JOIN cutover_legacy.cutover_id_map agent_map ON agent_map.mapping_version=1
        AND agent_map.source_model='PlatosAgent' AND agent_map.source_id=source."agentId"
        AND agent_map.target_model='Agent' AND agent_map.stable_suffix=''
       LEFT JOIN cutover_legacy.cutover_id_map thread_map ON thread_map.mapping_version=1
        AND thread_map.source_model='PlatosAgentThread' AND thread_map.source_id=source."sourceThreadId"
        AND thread_map.target_model='Thread' AND thread_map.stable_suffix=''
      WHERE source.id>$1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."Memory"
          (id,"environmentId","endUserId","agentId","clusterId",kind,content,metadata,
           embedding,"agentVisible",visibility,source,"sourceThreadId","sourceTurnIds",
           "extractorVersion","contentHash",confidence,"lastAccessedAt","archivedAt",
           "createdAt","updatedAt") VALUES ${parameterTuples(rows.length, 21)}`,
        rows.flatMap((row) => {
          const content = classifyBatch8TextMessage(
            "Memory.content",
            row.content,
            options.messageEncryptionKeys
          );
          const metadata = classifyBatch8NullableJsonMessage(
            "Memory.metadata",
            row.metadata,
            options.messageEncryptionKeys
          );
          return [
            row.target_id,
            row.environment_id,
            row.end_user_id,
            row.agent_id,
            null,
            requiredString(row.kind, "PlatosMemory.kind"),
            content.storageValue,
            metadata == null ? null : JSON.stringify(metadata.storageValue),
            row.embedding,
            row.agent_visible,
            validateVisibility(row.agent_visible, row.visibility),
            requiredString(row.source, "PlatosMemory.source"),
            row.source_thread_id,
            row.source_turn_ids,
            row.extractor_version,
            row.content_hash == null ? null : validateSha256Hex(row.content_hash),
            nullableConfidence(row.confidence),
            row.last_accessed_at,
            row.archived_at,
            row.created_at,
            row.updated_at,
          ];
        })
      );
    },
    chunkSize
  );
}

interface EntityRow extends EntityValueRow {
  target_id: string;
  environment_id: string;
  end_user_id: string;
  agent_id: string;
  entity_key: unknown;
  entity_type: unknown;
  embedding: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function backfillBatch8MemoryEntities(
  database: CutoverDatabase,
  options: RetainedMemoryBatch8Options,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch8SourceChunk<EntityRow>(
    database,
    `SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
            environment_map.target_id::text AS environment_id,
            end_user_map.target_id::text AS end_user_id,
            agent_map.target_id::text AS agent_id, source."entityKey" AS entity_key,
            source."entityType" AS entity_type, source.label, source.aliases, source.metadata,
            source.embedding::text AS embedding, source."createdAt" AS created_at,
            source."updatedAt" AS updated_at
       FROM cutover_legacy."PlatosMemoryEntity" source
       JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version=1
        AND target_map.source_model='PlatosMemoryEntity' AND target_map.source_id=source.id
        AND target_map.target_model='MemoryEntity' AND target_map.stable_suffix=''
       JOIN cutover_legacy.cutover_id_map environment_map ON environment_map.mapping_version=1
        AND environment_map.source_model='RuntimeEnvironment'
        AND environment_map.source_id=source."environmentId"
        AND environment_map.target_model='Environment' AND environment_map.stable_suffix=''
       JOIN LATERAL (SELECT end_user.id FROM cutover_legacy."PlatosEndUser" end_user
        WHERE end_user."organizationId"=source."organizationId"
          AND end_user."projectId"=source."projectId"
          AND end_user."environmentId"=source."environmentId"
          AND source."userId" IN (end_user.id,end_user."externalUserId",end_user."linkedExternalId")) source_end_user ON true
       JOIN cutover_legacy.cutover_id_map end_user_map ON end_user_map.mapping_version=1
        AND end_user_map.source_model='PlatosEndUser' AND end_user_map.source_id=source_end_user.id
        AND end_user_map.target_model='EndUser' AND end_user_map.stable_suffix=''
       JOIN cutover_legacy.cutover_id_map agent_map ON agent_map.mapping_version=1
        AND agent_map.source_model='PlatosAgent' AND agent_map.source_id=source."agentId"
        AND agent_map.target_model='Agent' AND agent_map.stable_suffix=''
      WHERE source.id>$1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."MemoryEntity"
          (id,"environmentId","endUserId","agentId","clusterId","entityKey","entityType",
           label,aliases,metadata,embedding,"createdAt","updatedAt")
         VALUES ${parameterTuples(rows.length, 13)}`,
        rows.flatMap((row) => {
          const label = classifyBatch8TextMessage(
            "MemoryEntity.label",
            row.label,
            options.messageEncryptionKeys
          );
          const metadata = classifyBatch8NullableJsonMessage(
            "MemoryEntity.metadata",
            row.metadata,
            options.messageEncryptionKeys
          );
          return [
            row.target_id,
            row.environment_id,
            row.end_user_id,
            row.agent_id,
            null,
            requiredString(row.entity_key, "PlatosMemoryEntity.entityKey"),
            requiredString(row.entity_type, "PlatosMemoryEntity.entityType"),
            label.storageValue,
            stringArray(row.aliases, "PlatosMemoryEntity.aliases"),
            metadata == null ? null : JSON.stringify(metadata.storageValue),
            row.embedding,
            row.created_at,
            row.updated_at,
          ];
        })
      );
    },
    chunkSize
  );
}

interface RelationshipRow extends RelationshipValueRow {
  target_id: string;
  environment_id: string;
  end_user_id: string;
  agent_id: string;
  from_entity_id: string;
  to_entity_id: string;
  relationship_type: unknown;
  weight: number | null;
  source_memory_id: string | null;
  created_at: Date;
}

export async function backfillBatch8MemoryRelationships(
  database: CutoverDatabase,
  options: RetainedMemoryBatch8Options,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch8SourceChunk<RelationshipRow>(
    database,
    `SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
            environment_map.target_id::text AS environment_id,
            end_user_map.target_id::text AS end_user_id,
            agent_map.target_id::text AS agent_id,
            from_map.target_id::text AS from_entity_id,
            to_map.target_id::text AS to_entity_id,
            source."relationshipType" AS relationship_type, source.weight, source.metadata,
            memory_map.target_id::text AS source_memory_id, source."createdAt" AS created_at
       FROM cutover_legacy."PlatosMemoryRelationship" source
       JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version=1
        AND target_map.source_model='PlatosMemoryRelationship' AND target_map.source_id=source.id
        AND target_map.target_model='MemoryRelationship' AND target_map.stable_suffix=''
       JOIN cutover_legacy.cutover_id_map environment_map ON environment_map.mapping_version=1
        AND environment_map.source_model='RuntimeEnvironment'
        AND environment_map.source_id=source."environmentId"
        AND environment_map.target_model='Environment' AND environment_map.stable_suffix=''
       JOIN LATERAL (SELECT end_user.id FROM cutover_legacy."PlatosEndUser" end_user
        WHERE end_user."organizationId"=source."organizationId"
          AND end_user."projectId"=source."projectId"
          AND end_user."environmentId"=source."environmentId"
          AND source."userId" IN (end_user.id,end_user."externalUserId",end_user."linkedExternalId")) source_end_user ON true
       JOIN cutover_legacy.cutover_id_map end_user_map ON end_user_map.mapping_version=1
        AND end_user_map.source_model='PlatosEndUser' AND end_user_map.source_id=source_end_user.id
        AND end_user_map.target_model='EndUser' AND end_user_map.stable_suffix=''
       JOIN cutover_legacy.cutover_id_map agent_map ON agent_map.mapping_version=1
        AND agent_map.source_model='PlatosAgent' AND agent_map.source_id=source."agentId"
        AND agent_map.target_model='Agent' AND agent_map.stable_suffix=''
       JOIN cutover_legacy.cutover_id_map from_map ON from_map.mapping_version=1
        AND from_map.source_model='PlatosMemoryEntity' AND from_map.source_id=source."fromEntityId"
        AND from_map.target_model='MemoryEntity' AND from_map.stable_suffix=''
       JOIN cutover_legacy.cutover_id_map to_map ON to_map.mapping_version=1
        AND to_map.source_model='PlatosMemoryEntity' AND to_map.source_id=source."toEntityId"
        AND to_map.target_model='MemoryEntity' AND to_map.stable_suffix=''
       LEFT JOIN cutover_legacy.cutover_id_map memory_map ON memory_map.mapping_version=1
        AND memory_map.source_model='PlatosMemory' AND memory_map.source_id=source."sourceMemoryId"
        AND memory_map.target_model='Memory' AND memory_map.stable_suffix=''
      WHERE source.id>$1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."MemoryRelationship"
          (id,"environmentId","endUserId","agentId","clusterId","fromEntityId","toEntityId",
           "relationshipType",weight,metadata,"sourceMemoryId","createdAt")
         VALUES ${parameterTuples(rows.length, 12)}`,
        rows.flatMap((row) => {
          const metadata = classifyBatch8NullableJsonMessage(
            "MemoryRelationship.metadata",
            row.metadata,
            options.messageEncryptionKeys
          );
          return [
            row.target_id,
            row.environment_id,
            row.end_user_id,
            row.agent_id,
            null,
            row.from_entity_id,
            row.to_entity_id,
            requiredString(row.relationship_type, "PlatosMemoryRelationship.relationshipType"),
            row.weight,
            metadata == null ? null : JSON.stringify(metadata.storageValue),
            row.source_memory_id,
            row.created_at,
          ];
        })
      );
    },
    chunkSize
  );
}

/** Linear graph equations: nodes, edges, endpoint incidence, and source links conserve. */
export const retainedMemoryBatch8GraphEquations = Object.freeze([
  "memory_rows = mapped_memory_rows",
  "entity_rows = mapped_entity_rows",
  "relationship_rows = mapped_relationship_rows",
  "relationship_rows = mapped_from_endpoint_rows",
  "relationship_rows = mapped_to_endpoint_rows",
  "sourced_relationship_rows = mapped_source_memory_rows",
] as const);

const conservationValidationSql = `
  WITH equations(id,source_count,target_count) AS (VALUES
    ('memory-rows',
      (SELECT count(*) FROM cutover_legacy."PlatosMemory"),
      (SELECT count(*) FROM public."Memory" target JOIN cutover_legacy.cutover_id_map map
        ON map.mapping_version=1 AND map.source_model='PlatosMemory'
       AND map.target_model='Memory' AND map.target_id=target.id)),
    ('entity-rows',
      (SELECT count(*) FROM cutover_legacy."PlatosMemoryEntity"),
      (SELECT count(*) FROM public."MemoryEntity" target JOIN cutover_legacy.cutover_id_map map
        ON map.mapping_version=1 AND map.source_model='PlatosMemoryEntity'
       AND map.target_model='MemoryEntity' AND map.target_id=target.id)),
    ('relationship-rows',
      (SELECT count(*) FROM cutover_legacy."PlatosMemoryRelationship"),
      (SELECT count(*) FROM public."MemoryRelationship" target JOIN cutover_legacy.cutover_id_map map
        ON map.mapping_version=1 AND map.source_model='PlatosMemoryRelationship'
       AND map.target_model='MemoryRelationship' AND map.target_id=target.id)),
    ('from-endpoint-incidence',
      (SELECT count(*) FROM cutover_legacy."PlatosMemoryRelationship"),
      (SELECT count(*) FROM public."MemoryRelationship" relationship
        JOIN cutover_legacy.cutover_id_map relationship_map ON relationship_map.mapping_version=1
         AND relationship_map.source_model='PlatosMemoryRelationship'
         AND relationship_map.target_model='MemoryRelationship' AND relationship_map.target_id=relationship.id
        JOIN cutover_legacy.cutover_id_map entity_map ON entity_map.mapping_version=1
         AND entity_map.source_model='PlatosMemoryEntity' AND entity_map.target_model='MemoryEntity'
         AND entity_map.target_id=relationship."fromEntityId")),
    ('to-endpoint-incidence',
      (SELECT count(*) FROM cutover_legacy."PlatosMemoryRelationship"),
      (SELECT count(*) FROM public."MemoryRelationship" relationship
        JOIN cutover_legacy.cutover_id_map relationship_map ON relationship_map.mapping_version=1
         AND relationship_map.source_model='PlatosMemoryRelationship'
         AND relationship_map.target_model='MemoryRelationship' AND relationship_map.target_id=relationship.id
        JOIN cutover_legacy.cutover_id_map entity_map ON entity_map.mapping_version=1
         AND entity_map.source_model='PlatosMemoryEntity' AND entity_map.target_model='MemoryEntity'
         AND entity_map.target_id=relationship."toEntityId")),
    ('source-memory-incidence',
      (SELECT count(*) FROM cutover_legacy."PlatosMemoryRelationship" WHERE "sourceMemoryId" IS NOT NULL),
      (SELECT count(*) FROM public."MemoryRelationship" relationship
        JOIN cutover_legacy.cutover_id_map relationship_map ON relationship_map.mapping_version=1
         AND relationship_map.source_model='PlatosMemoryRelationship'
         AND relationship_map.target_model='MemoryRelationship' AND relationship_map.target_id=relationship.id
       WHERE relationship."sourceMemoryId" IS NOT NULL))
  ) SELECT id FROM equations WHERE source_count<>target_count ORDER BY id`;

const ancestryValidationSql = `
  WITH issues AS (
    SELECT 'memory-canonical-ancestry' AS issue FROM public."Memory" target
    JOIN cutover_legacy.cutover_id_map map ON map.mapping_version=1
     AND map.source_model='PlatosMemory' AND map.target_model='Memory' AND map.target_id=target.id
    LEFT JOIN public."Environment" environment ON environment.id=target."environmentId"
    LEFT JOIN public."Project" project ON project.id=environment."projectId"
    LEFT JOIN public."Agent" agent ON agent.id=target."agentId" AND agent."projectId"=project.id
    LEFT JOIN public."EndUser" end_user ON end_user.id=target."endUserId"
     AND end_user."organizationId"=project."organizationId"
    LEFT JOIN public."Thread" thread ON thread.id=target."sourceThreadId"
     AND thread."environmentId"=target."environmentId" AND thread."agentId"=target."agentId"
     AND thread."endUserId"=target."endUserId"
    WHERE environment.id IS NULL OR agent.id IS NULL OR end_user.id IS NULL
       OR target."clusterId" IS NOT NULL
       OR (target."sourceThreadId" IS NOT NULL AND thread.id IS NULL)
       OR EXISTS (SELECT 1 FROM unnest(target."sourceTurnIds") turn_id
                  LEFT JOIN public."Turn" turn ON turn.id=turn_id AND turn."threadId"=target."sourceThreadId"
                  WHERE turn.id IS NULL)
    UNION ALL
    SELECT 'entity-canonical-ancestry' FROM public."MemoryEntity" target
    JOIN cutover_legacy.cutover_id_map map ON map.mapping_version=1
     AND map.source_model='PlatosMemoryEntity' AND map.target_model='MemoryEntity' AND map.target_id=target.id
    LEFT JOIN public."Environment" environment ON environment.id=target."environmentId"
    LEFT JOIN public."Project" project ON project.id=environment."projectId"
    LEFT JOIN public."Agent" agent ON agent.id=target."agentId" AND agent."projectId"=project.id
    LEFT JOIN public."EndUser" end_user ON end_user.id=target."endUserId"
     AND end_user."organizationId"=project."organizationId"
    WHERE environment.id IS NULL OR agent.id IS NULL OR end_user.id IS NULL OR target."clusterId" IS NOT NULL
    UNION ALL
    SELECT 'relationship-canonical-scope' FROM public."MemoryRelationship" relationship
    JOIN cutover_legacy.cutover_id_map map ON map.mapping_version=1
     AND map.source_model='PlatosMemoryRelationship' AND map.target_model='MemoryRelationship'
     AND map.target_id=relationship.id
    LEFT JOIN public."MemoryEntity" source ON source.id=relationship."fromEntityId"
    LEFT JOIN public."MemoryEntity" target ON target.id=relationship."toEntityId"
    LEFT JOIN public."Memory" source_memory ON source_memory.id=relationship."sourceMemoryId"
    WHERE relationship."clusterId" IS NOT NULL OR source.id IS NULL OR target.id IS NULL
       OR (source."environmentId",source."endUserId",source."agentId") IS DISTINCT FROM
          (relationship."environmentId",relationship."endUserId",relationship."agentId")
       OR (target."environmentId",target."endUserId",target."agentId") IS DISTINCT FROM
          (relationship."environmentId",relationship."endUserId",relationship."agentId")
       OR (relationship."sourceMemoryId" IS NOT NULL AND
           ((source_memory."environmentId",source_memory."endUserId",source_memory."agentId") IS DISTINCT FROM
            (relationship."environmentId",relationship."endUserId",relationship."agentId")))
  ) SELECT DISTINCT issue FROM issues ORDER BY issue`;

const semanticValidationSql = `
  WITH issues AS (
    SELECT 'memory-preservation' AS issue FROM public."Memory" target
    JOIN cutover_legacy.cutover_id_map map ON map.mapping_version=1
     AND map.source_model='PlatosMemory' AND map.target_model='Memory' AND map.target_id=target.id
    JOIN cutover_legacy."PlatosMemory" source ON source.id=map.source_id
    WHERE target.kind IS DISTINCT FROM source.kind
       OR target.content IS DISTINCT FROM source.content
       OR target.metadata IS DISTINCT FROM source.metadata
       OR target.embedding IS DISTINCT FROM source.embedding
       OR target."agentVisible" IS DISTINCT FROM source."agentVisible"
       OR target.visibility IS DISTINCT FROM source.visibility
       OR target.source IS DISTINCT FROM source.source
       OR target."extractorVersion" IS DISTINCT FROM source."extractorVersion"
       OR target."contentHash" IS DISTINCT FROM source."contentHash"
       OR target.confidence IS DISTINCT FROM source.confidence
       OR target."lastAccessedAt" IS DISTINCT FROM source."lastAccessedAt"
       OR target."archivedAt" IS DISTINCT FROM source."archivedAt"
       OR target."createdAt" IS DISTINCT FROM source."createdAt"
       OR target."updatedAt" IS DISTINCT FROM source."updatedAt"
    UNION ALL
    SELECT 'entity-preservation' FROM public."MemoryEntity" target
    JOIN cutover_legacy.cutover_id_map map ON map.mapping_version=1
     AND map.source_model='PlatosMemoryEntity' AND map.target_model='MemoryEntity' AND map.target_id=target.id
    JOIN cutover_legacy."PlatosMemoryEntity" source ON source.id=map.source_id
    WHERE target."entityKey" IS DISTINCT FROM source."entityKey"
       OR target."entityType" IS DISTINCT FROM source."entityType"
       OR target.label IS DISTINCT FROM source.label
       OR target.aliases IS DISTINCT FROM source.aliases
       OR target.metadata IS DISTINCT FROM source.metadata
       OR target.embedding IS DISTINCT FROM source.embedding
       OR target."createdAt" IS DISTINCT FROM source."createdAt"
       OR target."updatedAt" IS DISTINCT FROM source."updatedAt"
    UNION ALL
    SELECT 'relationship-preservation' FROM public."MemoryRelationship" target
    JOIN cutover_legacy.cutover_id_map map ON map.mapping_version=1
     AND map.source_model='PlatosMemoryRelationship' AND map.target_model='MemoryRelationship'
     AND map.target_id=target.id
    JOIN cutover_legacy."PlatosMemoryRelationship" source ON source.id=map.source_id
    JOIN cutover_legacy.cutover_id_map from_map ON from_map.mapping_version=1
     AND from_map.source_model='PlatosMemoryEntity' AND from_map.source_id=source."fromEntityId"
     AND from_map.target_model='MemoryEntity' AND from_map.stable_suffix=''
    JOIN cutover_legacy.cutover_id_map to_map ON to_map.mapping_version=1
     AND to_map.source_model='PlatosMemoryEntity' AND to_map.source_id=source."toEntityId"
     AND to_map.target_model='MemoryEntity' AND to_map.stable_suffix=''
    LEFT JOIN cutover_legacy.cutover_id_map memory_map ON memory_map.mapping_version=1
     AND memory_map.source_model='PlatosMemory' AND memory_map.source_id=source."sourceMemoryId"
     AND memory_map.target_model='Memory' AND memory_map.stable_suffix=''
    WHERE target."fromEntityId" IS DISTINCT FROM from_map.target_id
       OR target."toEntityId" IS DISTINCT FROM to_map.target_id
       OR target."relationshipType" IS DISTINCT FROM source."relationshipType"
       OR target.weight IS DISTINCT FROM source.weight
       OR target.metadata IS DISTINCT FROM source.metadata
       OR target."sourceMemoryId" IS DISTINCT FROM memory_map.target_id
       OR target."createdAt" IS DISTINCT FROM source."createdAt"
  ) SELECT DISTINCT issue FROM issues ORDER BY issue`;

async function assertBatch8ValidationQuery(
  database: CutoverDatabase,
  sql: string,
  code: string,
  summary: string
): Promise<void> {
  const issues = await database.query<{ id?: string; issue?: string }>(sql);
  if (issues.rows.length > 0) {
    throw batch8Failure(
      code,
      `${summary}: ${issues.rows.map((row) => row.id ?? row.issue ?? "unknown").join(", ")}`
    );
  }
}

export async function validateRetainedMemoryBatch8(database: CutoverDatabase): Promise<void> {
  await assertBatch8ValidationQuery(
    database,
    conservationValidationSql,
    "BATCH8_CONSERVATION_FAILED",
    "retained memory Batch 8 conservation failed"
  );
  await assertBatch8ValidationQuery(
    database,
    ancestryValidationSql,
    "BATCH8_ANCESTRY_FAILED",
    "retained memory Batch 8 ancestry failed"
  );
  await assertBatch8ValidationQuery(
    database,
    semanticValidationSql,
    "BATCH8_SEMANTIC_VALIDATION_FAILED",
    "retained memory Batch 8 semantic validation failed"
  );
}

export async function backfillRetainedMemoryBatch8(
  database: CutoverDatabase,
  options: RetainedMemoryBatch8Options,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<RetainedMemoryBatch8Evidence> {
  await validateRetainedMemoryBatch8Source(database, options, chunkSize);
  const memories = await backfillBatch8Memories(database, options, chunkSize);
  const entities = await backfillBatch8MemoryEntities(database, options, chunkSize);
  const relationships = await backfillBatch8MemoryRelationships(database, options, chunkSize);
  await validateRetainedMemoryBatch8(database);

  const sourcedEdges = await database.query<{ count: number | string }>(
    `SELECT count(*)::text AS count FROM cutover_legacy."PlatosMemoryRelationship"
      WHERE "sourceMemoryId" IS NOT NULL`
  );
  const sourcedEdgeCount = Number(sourcedEdges.rows[0]?.count ?? 0);
  if (!Number.isSafeInteger(sourcedEdgeCount) || sourcedEdgeCount < 0) {
    throw batch8Failure("BATCH8_COUNT_INVALID", "retained memory Batch 8 count is invalid");
  }

  const evidence: RetainedMemoryBatch8Evidence = {
    batch: "retained-memory-batch8",
    sourceRows: Object.freeze({ memories, entities, relationships }),
    targetRows: Object.freeze({ memories, entities, relationships }),
    graphCounts: Object.freeze({
      directedEdges: relationships,
      fromEndpoints: relationships,
      toEndpoints: relationships,
      sourcedEdges: sourcedEdgeCount,
    }),
  };
  assertSecretFreeCutoverEvidence(evidence);
  return Object.freeze(evidence);
}
