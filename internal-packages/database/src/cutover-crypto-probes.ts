import { isDeepStrictEqual } from "node:util";
import {
  assertSecretFreeCutoverEvidence,
  assertTargetMessageEncryptionConfig,
  decodeLegacyJsonMessage,
  decodeVersionedLegacyMessage,
  encryptTargetJsonMessage,
  type CutoverJsonValue,
  type DecodedCutoverValue,
} from "./cutover-crypto";
import { normalizeJsonField, type JsonField, type JsonValue } from "./json";
import type { CutoverDatabase } from "./cutover-types";
import { CutoverFailure } from "./cutover-types";

const DEFAULT_CHUNK_SIZE = 250;

export const retainedCryptoProbeFields = [
  "Turn.outputText",
  "Turn.thinkingContent",
  "ToolCallAudit.arguments",
  "ToolCallAudit.result",
  "SafetyEvent.detail",
  "SafetyEvent.metadata",
  "Memory.content",
  "Memory.metadata",
  "MemoryEntity.label",
  "MemoryEntity.metadata",
  "MemoryRelationship.metadata",
] as const;

export type RetainedCryptoProbeField = (typeof retainedCryptoProbeFields)[number];

type SourceEncoding = "VERSIONED_TEXT" | "MARKER_TEXT" | "MARKER_JSONB";
type TargetStorage = "TEXT" | "JSONB";

interface FieldContract {
  readonly sourceEncoding: SourceEncoding;
  readonly targetStorage: TargetStorage;
  readonly nullable: boolean;
  readonly jsonField?: JsonField;
}

const fieldContracts: Readonly<Record<RetainedCryptoProbeField, FieldContract>> = Object.freeze({
  "Turn.outputText": Object.freeze({
    sourceEncoding: "VERSIONED_TEXT",
    targetStorage: "TEXT",
    nullable: true,
  }),
  "Turn.thinkingContent": Object.freeze({
    sourceEncoding: "VERSIONED_TEXT",
    targetStorage: "TEXT",
    nullable: true,
  }),
  "ToolCallAudit.arguments": Object.freeze({
    sourceEncoding: "MARKER_JSONB",
    targetStorage: "JSONB",
    nullable: false,
    jsonField: "ToolCallAudit.arguments",
  }),
  "ToolCallAudit.result": Object.freeze({
    sourceEncoding: "MARKER_JSONB",
    targetStorage: "JSONB",
    nullable: true,
    jsonField: "ToolCallAudit.result",
  }),
  "SafetyEvent.detail": Object.freeze({
    sourceEncoding: "MARKER_TEXT",
    targetStorage: "TEXT",
    nullable: true,
  }),
  "SafetyEvent.metadata": Object.freeze({
    sourceEncoding: "MARKER_JSONB",
    targetStorage: "JSONB",
    nullable: true,
    jsonField: "SafetyEvent.metadata",
  }),
  "Memory.content": Object.freeze({
    sourceEncoding: "MARKER_TEXT",
    targetStorage: "TEXT",
    nullable: false,
  }),
  "Memory.metadata": Object.freeze({
    sourceEncoding: "MARKER_JSONB",
    targetStorage: "JSONB",
    nullable: true,
    jsonField: "Memory.metadata",
  }),
  "MemoryEntity.label": Object.freeze({
    sourceEncoding: "MARKER_TEXT",
    targetStorage: "TEXT",
    nullable: false,
  }),
  "MemoryEntity.metadata": Object.freeze({
    sourceEncoding: "MARKER_JSONB",
    targetStorage: "JSONB",
    nullable: true,
    jsonField: "MemoryEntity.metadata",
  }),
  "MemoryRelationship.metadata": Object.freeze({
    sourceEncoding: "MARKER_JSONB",
    targetStorage: "JSONB",
    nullable: true,
    jsonField: "MemoryRelationship.metadata",
  }),
});

export interface CutoverCryptoProbeOptions {
  readonly sourceMessageEncryptionKeys: Readonly<Record<string, string>>;
  readonly targetMessageEncryptionKey: string;
  readonly targetMessageEncryptionKeyVersion: number;
}

export interface RetainedCryptoFieldInput {
  readonly field: RetainedCryptoProbeField;
  readonly sourceValue: unknown;
  /** Required only by the Turn fields, whose inherited envelope version is row-level. */
  readonly sourceKeyVersion?: unknown;
}

export interface RetainedCryptoFieldTransform {
  readonly field: RetainedCryptoProbeField;
  readonly storageValue: JsonValue | string | null;
  readonly sourceEncoding: "PLAINTEXT" | "ENVELOPE" | "NULL";
  readonly sourceKeyVersion: number | null;
  readonly targetKeyVersion: number | null;
}

export interface RetainedCryptoFieldProbeEvidence {
  readonly fieldCount: 1;
  readonly sourceUnversionedCount: number;
  readonly sourceVersionCounts: Readonly<Record<string, number>>;
  readonly targetVersionCounts: Readonly<Record<string, number>>;
}

export interface RetainedCryptoCutoverEvidence {
  readonly rowCounts: Readonly<{
    turns: number;
    toolCallAudits: number;
    safetyEvents: number;
    memories: number;
    memoryEntities: number;
    memoryRelationships: number;
  }>;
  readonly fieldCounts: Readonly<Record<RetainedCryptoProbeField, number>>;
  readonly sourceUnversionedCount: number;
  readonly sourceVersionCounts: Readonly<Record<string, number>>;
  readonly targetVersionCounts: Readonly<Record<string, number>>;
}

interface PreparedFieldTransform extends RetainedCryptoFieldTransform {
  readonly expectedSemantics: JsonValue | string | null;
}

function cryptoFailure(code: string, summary: string): CutoverFailure {
  return new CutoverFailure(code, summary);
}

function normalizeExpectedJson(field: JsonField, value: unknown): JsonValue {
  try {
    return normalizeJsonField(field, value) as unknown as JsonValue;
  } catch {
    throw cryptoFailure(
      "CUTOVER_CRYPTO_SOURCE_SHAPE_INVALID",
      `${field} source semantics do not match the target reader contract`
    );
  }
}

function decodeSource(
  input: RetainedCryptoFieldInput,
  options: CutoverCryptoProbeOptions
): DecodedCutoverValue<CutoverJsonValue | string | null> {
  const contract = fieldContracts[input.field];
  if (input.sourceValue === null) {
    if (!contract.nullable) {
      throw cryptoFailure(
        "CUTOVER_CRYPTO_REQUIRED_SOURCE_MISSING",
        `${input.field} source material is required`
      );
    }
    return Object.freeze({ encoding: "PLAINTEXT", keyVersion: null, value: null });
  }
  if (input.sourceValue === undefined) {
    throw cryptoFailure(
      "CUTOVER_CRYPTO_SOURCE_INVALID",
      `${input.field} source material is malformed`
    );
  }

  try {
    if (contract.sourceEncoding === "VERSIONED_TEXT") {
      return decodeVersionedLegacyMessage(
        input.sourceValue,
        input.sourceKeyVersion,
        options.sourceMessageEncryptionKeys
      );
    }
    return decodeLegacyJsonMessage(
      input.sourceValue,
      contract.sourceEncoding === "MARKER_TEXT" ? "TEXT" : "JSONB",
      options.sourceMessageEncryptionKeys
    );
  } catch {
    throw cryptoFailure(
      "CUTOVER_CRYPTO_SOURCE_ENVELOPE_INVALID",
      `${input.field} source envelope is unreadable`
    );
  }
}

function expectedSemantics(
  input: RetainedCryptoFieldInput,
  decoded: DecodedCutoverValue<CutoverJsonValue | string | null>
): JsonValue | string | null {
  if (decoded.value === null) return null;
  const contract = fieldContracts[input.field];
  if (contract.jsonField) return normalizeExpectedJson(contract.jsonField, decoded.value);
  if (typeof decoded.value !== "string") {
    throw cryptoFailure(
      "CUTOVER_CRYPTO_SOURCE_SHAPE_INVALID",
      `${input.field} source semantics do not match the target reader contract`
    );
  }
  return decoded.value;
}

function prepareRetainedCryptoField(
  input: RetainedCryptoFieldInput,
  options: CutoverCryptoProbeOptions
): PreparedFieldTransform {
  assertTargetConfig(options);
  const decoded = decodeSource(input, options);
  const expected = expectedSemantics(input, decoded);
  if (expected === null) {
    return Object.freeze({
      field: input.field,
      storageValue: null,
      sourceEncoding: "NULL",
      sourceKeyVersion: null,
      targetKeyVersion: null,
      expectedSemantics: null,
    });
  }

  const envelope = encryptTargetJsonMessage(
    expected,
    options.targetMessageEncryptionKeyVersion,
    options.targetMessageEncryptionKey
  );
  const storageEnvelope: JsonValue = {
    __platos_enc: envelope.__platos_enc,
    v: envelope.v,
    ct: envelope.ct,
  };
  return Object.freeze({
    field: input.field,
    storageValue:
      fieldContracts[input.field].targetStorage === "TEXT"
        ? JSON.stringify(storageEnvelope)
        : storageEnvelope,
    sourceEncoding: decoded.encoding,
    sourceKeyVersion: decoded.keyVersion,
    targetKeyVersion: options.targetMessageEncryptionKeyVersion,
    expectedSemantics: expected,
  });
}

function assertTargetConfig(options: CutoverCryptoProbeOptions): void {
  try {
    assertTargetMessageEncryptionConfig(
      options.targetMessageEncryptionKeyVersion,
      options.targetMessageEncryptionKey
    );
  } catch {
    throw cryptoFailure(
      "CUTOVER_CRYPTO_TARGET_CONFIG_INVALID",
      "active target message encryption configuration is invalid"
    );
  }
}

/** Decode, validate, and re-encrypt one retained field under the active target key. */
export function reencryptRetainedCryptoField(
  input: RetainedCryptoFieldInput,
  options: CutoverCryptoProbeOptions
): RetainedCryptoFieldTransform {
  const prepared = prepareRetainedCryptoField(input, options);
  return Object.freeze({
    field: prepared.field,
    storageValue: prepared.storageValue,
    sourceEncoding: prepared.sourceEncoding,
    sourceKeyVersion: prepared.sourceKeyVersion,
    targetKeyVersion: prepared.targetKeyVersion,
  });
}

function decodeTarget(
  field: RetainedCryptoProbeField,
  storageValue: unknown,
  options: CutoverCryptoProbeOptions
): JsonValue | string | null {
  if (storageValue === null) return null;
  const contract = fieldContracts[field];
  let decoded: DecodedCutoverValue<CutoverJsonValue | string>;
  try {
    decoded = decodeLegacyJsonMessage(
      storageValue,
      contract.targetStorage === "TEXT" ? "TEXT" : "JSONB",
      { [String(options.targetMessageEncryptionKeyVersion)]: options.targetMessageEncryptionKey }
    );
  } catch {
    throw cryptoFailure(
      "CUTOVER_CRYPTO_TARGET_READER_FAILED",
      `${field} target reader rejected persisted material`
    );
  }
  if (
    decoded.encoding !== "ENVELOPE" ||
    decoded.keyVersion !== options.targetMessageEncryptionKeyVersion
  ) {
    throw cryptoFailure(
      "CUTOVER_CRYPTO_TARGET_READER_FAILED",
      `${field} target reader did not observe the active envelope version`
    );
  }
  if (contract.jsonField) return normalizeExpectedJson(contract.jsonField, decoded.value);
  if (typeof decoded.value !== "string") {
    throw cryptoFailure(
      "CUTOVER_CRYPTO_TARGET_READER_FAILED",
      `${field} target reader returned an invalid semantic shape`
    );
  }
  return decoded.value;
}

function probePreparedField(
  prepared: PreparedFieldTransform,
  persistedValue: unknown,
  options: CutoverCryptoProbeOptions
): RetainedCryptoFieldProbeEvidence {
  const observed = decodeTarget(prepared.field, persistedValue, options);
  if (!isDeepStrictEqual(observed, prepared.expectedSemantics)) {
    throw cryptoFailure(
      "CUTOVER_CRYPTO_TARGET_SEMANTICS_MISMATCH",
      `${prepared.field} target reader semantics differ from the decoded source`
    );
  }
  const evidence = Object.freeze({
    fieldCount: 1 as const,
    sourceUnversionedCount: prepared.sourceEncoding === "PLAINTEXT" ? 1 : 0,
    sourceVersionCounts: Object.freeze(
      prepared.sourceKeyVersion === null ? {} : { [String(prepared.sourceKeyVersion)]: 1 }
    ),
    targetVersionCounts: Object.freeze(
      prepared.targetKeyVersion === null ? {} : { [String(prepared.targetKeyVersion)]: 1 }
    ),
  });
  assertSecretFreeCutoverEvidence(evidence, [
    options.targetMessageEncryptionKey,
    ...Object.values(options.sourceMessageEncryptionKeys),
  ]);
  return evidence;
}

/** Run the strict target-reader semantic-equivalence probe for one transform. */
export function probeRetainedCryptoField(
  input: RetainedCryptoFieldInput,
  persistedValue: unknown,
  options: CutoverCryptoProbeOptions
): RetainedCryptoFieldProbeEvidence {
  return probePreparedField(prepareRetainedCryptoField(input, options), persistedValue, options);
}

type RowCountKey = keyof RetainedCryptoCutoverEvidence["rowCounts"];

interface DatabaseField {
  readonly field: RetainedCryptoProbeField;
  readonly sourceProperty: string;
  readonly sourceKeyVersionProperty?: string;
  readonly targetColumn: string;
  readonly jsonb: boolean;
}

interface DatabasePlan {
  readonly rowCountKey: RowCountKey;
  readonly targetTable: string;
  readonly selectSql: string;
  readonly fields: readonly DatabaseField[];
}

const databasePlans: readonly DatabasePlan[] = Object.freeze([
  Object.freeze({
    rowCountKey: "turns",
    targetTable: "Turn",
    selectSql: `SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
                       source.content AS output_text, source."thinkingContent" AS thinking_content,
                       source."encKeyVersion" AS enc_key_version
                  FROM cutover_legacy."PlatosAgentMessage" source
                  JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version=1
                   AND target_map.source_model='PlatosAgentMessage' AND target_map.source_id=source.id
                   AND target_map.target_model='Turn' AND target_map.stable_suffix=''
                 WHERE source.role='assistant' AND source.id>$1 ORDER BY source.id LIMIT $2`,
    fields: Object.freeze([
      Object.freeze({
        field: "Turn.outputText",
        sourceProperty: "output_text",
        sourceKeyVersionProperty: "enc_key_version",
        targetColumn: "outputText",
        jsonb: false,
      }),
      Object.freeze({
        field: "Turn.thinkingContent",
        sourceProperty: "thinking_content",
        sourceKeyVersionProperty: "enc_key_version",
        targetColumn: "thinkingContent",
        jsonb: false,
      }),
    ]),
  }),
  Object.freeze({
    rowCountKey: "toolCallAudits",
    targetTable: "ToolCallAudit",
    selectSql: `SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
                       source.args AS arguments, source.result
                  FROM cutover_legacy."PlatosToolCallAudit" source
                  JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version=1
                   AND target_map.source_model='PlatosToolCallAudit' AND target_map.source_id=source.id
                   AND target_map.target_model='ToolCallAudit' AND target_map.stable_suffix=''
                 WHERE source.id>$1 ORDER BY source.id LIMIT $2`,
    fields: Object.freeze([
      Object.freeze({
        field: "ToolCallAudit.arguments",
        sourceProperty: "arguments",
        targetColumn: "arguments",
        jsonb: true,
      }),
      Object.freeze({
        field: "ToolCallAudit.result",
        sourceProperty: "result",
        targetColumn: "result",
        jsonb: true,
      }),
    ]),
  }),
  Object.freeze({
    rowCountKey: "safetyEvents",
    targetTable: "SafetyEvent",
    selectSql: `SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
                       source.detail, source.meta AS metadata
                  FROM cutover_legacy."PlatosSafetyEvent" source
                  JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version=1
                   AND target_map.source_model='PlatosSafetyEvent' AND target_map.source_id=source.id
                   AND target_map.target_model='SafetyEvent' AND target_map.stable_suffix=''
                 WHERE source.id>$1 ORDER BY source.id LIMIT $2`,
    fields: Object.freeze([
      Object.freeze({
        field: "SafetyEvent.detail",
        sourceProperty: "detail",
        targetColumn: "detail",
        jsonb: false,
      }),
      Object.freeze({
        field: "SafetyEvent.metadata",
        sourceProperty: "metadata",
        targetColumn: "metadata",
        jsonb: true,
      }),
    ]),
  }),
  Object.freeze({
    rowCountKey: "memories",
    targetTable: "Memory",
    selectSql: `SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
                       source.content, source.metadata
                  FROM cutover_legacy."PlatosMemory" source
                  JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version=1
                   AND target_map.source_model='PlatosMemory' AND target_map.source_id=source.id
                   AND target_map.target_model='Memory' AND target_map.stable_suffix=''
                 WHERE source.id>$1 ORDER BY source.id LIMIT $2`,
    fields: Object.freeze([
      Object.freeze({
        field: "Memory.content",
        sourceProperty: "content",
        targetColumn: "content",
        jsonb: false,
      }),
      Object.freeze({
        field: "Memory.metadata",
        sourceProperty: "metadata",
        targetColumn: "metadata",
        jsonb: true,
      }),
    ]),
  }),
  Object.freeze({
    rowCountKey: "memoryEntities",
    targetTable: "MemoryEntity",
    selectSql: `SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
                       source.label, source.metadata
                  FROM cutover_legacy."PlatosMemoryEntity" source
                  JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version=1
                   AND target_map.source_model='PlatosMemoryEntity' AND target_map.source_id=source.id
                   AND target_map.target_model='MemoryEntity' AND target_map.stable_suffix=''
                 WHERE source.id>$1 ORDER BY source.id LIMIT $2`,
    fields: Object.freeze([
      Object.freeze({
        field: "MemoryEntity.label",
        sourceProperty: "label",
        targetColumn: "label",
        jsonb: false,
      }),
      Object.freeze({
        field: "MemoryEntity.metadata",
        sourceProperty: "metadata",
        targetColumn: "metadata",
        jsonb: true,
      }),
    ]),
  }),
  Object.freeze({
    rowCountKey: "memoryRelationships",
    targetTable: "MemoryRelationship",
    selectSql: `SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
                       source.metadata
                  FROM cutover_legacy."PlatosMemoryRelationship" source
                  JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version=1
                   AND target_map.source_model='PlatosMemoryRelationship' AND target_map.source_id=source.id
                   AND target_map.target_model='MemoryRelationship' AND target_map.stable_suffix=''
                 WHERE source.id>$1 ORDER BY source.id LIMIT $2`,
    fields: Object.freeze([
      Object.freeze({
        field: "MemoryRelationship.metadata",
        sourceProperty: "metadata",
        targetColumn: "metadata",
        jsonb: true,
      }),
    ]),
  }),
]);

function increment(counts: Record<string, number>, version: number | null): void {
  if (version === null) return;
  const key = String(version);
  counts[key] = (counts[key] ?? 0) + 1;
}

function positiveChunkSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw cryptoFailure("CUTOVER_CRYPTO_CHUNK_INVALID", "crypto probe chunk size must be positive");
  }
  return value;
}

async function persistPreparedRow(
  database: CutoverDatabase,
  plan: DatabasePlan,
  targetId: string,
  prepared: readonly PreparedFieldTransform[],
  options: CutoverCryptoProbeOptions
): Promise<void> {
  const assignments = plan.fields.map(
    (field, index) => `"${field.targetColumn}"=$${index + 2}${field.jsonb ? "::jsonb" : ""}`
  );
  const returning = plan.fields.map(
    (field, index) => `"${field.targetColumn}" AS "persisted_${index}"`
  );
  const values = prepared.map((entry, index) => {
    if (entry.storageValue === null) return null;
    return plan.fields[index]!.jsonb ? JSON.stringify(entry.storageValue) : entry.storageValue;
  });
  const result = await database.query(
    `UPDATE public."${plan.targetTable}" SET ${assignments.join(", ")}
      WHERE id=$1 RETURNING ${returning.join(", ")}`,
    [targetId, ...values]
  );
  if (result.rowCount !== 1 || result.rows.length !== 1) {
    throw cryptoFailure(
      "CUTOVER_CRYPTO_TARGET_ROW_MISSING",
      `${plan.targetTable} mapped target row is missing`
    );
  }
  for (let index = 0; index < prepared.length; index += 1) {
    probePreparedField(prepared[index]!, result.rows[0]![`persisted_${index}`], options);
  }
}

/**
 * Standalone post-batch cutover gate. It deliberately is not wired into the
 * engine or phase ledger: callers must run it inside the existing cutover
 * transaction after retained rows exist and before immutable triggers land.
 */
export async function reencryptAndProbeRetainedCryptoTargets(
  database: CutoverDatabase,
  options: CutoverCryptoProbeOptions,
  chunkSize = DEFAULT_CHUNK_SIZE
): Promise<RetainedCryptoCutoverEvidence> {
  assertTargetConfig(options);
  const limit = positiveChunkSize(chunkSize);
  const rowCounts: Record<RowCountKey, number> = {
    turns: 0,
    toolCallAudits: 0,
    safetyEvents: 0,
    memories: 0,
    memoryEntities: 0,
    memoryRelationships: 0,
  };
  const fieldCounts = Object.fromEntries(
    retainedCryptoProbeFields.map((field) => [field, 0])
  ) as Record<RetainedCryptoProbeField, number>;
  const sourceVersionCounts: Record<string, number> = {};
  const targetVersionCounts: Record<string, number> = {};
  let sourceUnversionedCount = 0;

  for (const plan of databasePlans) {
    let cursor = "";
    while (true) {
      const result = await database.query(plan.selectSql, [cursor, limit]);
      if (result.rows.length === 0) break;
      for (const row of result.rows) {
        const sourceId = row.source_id;
        const targetId = row.target_id;
        if (typeof sourceId !== "string" || typeof targetId !== "string") {
          throw cryptoFailure(
            "CUTOVER_CRYPTO_MAPPING_INVALID",
            `${plan.targetTable} source mapping is malformed`
          );
        }
        const prepared = plan.fields.map((field) =>
          prepareRetainedCryptoField(
            {
              field: field.field,
              sourceValue: row[field.sourceProperty],
              sourceKeyVersion: field.sourceKeyVersionProperty
                ? row[field.sourceKeyVersionProperty]
                : undefined,
            },
            options
          )
        );
        await persistPreparedRow(database, plan, targetId, prepared, options);
        rowCounts[plan.rowCountKey] += 1;
        for (const entry of prepared) {
          if (entry.sourceEncoding === "NULL") continue;
          fieldCounts[entry.field] += 1;
          if (entry.sourceEncoding === "PLAINTEXT") sourceUnversionedCount += 1;
          increment(sourceVersionCounts, entry.sourceKeyVersion);
          increment(targetVersionCounts, entry.targetKeyVersion);
        }
        cursor = sourceId;
      }
      if (result.rows.length < limit) break;
    }
  }

  const evidence = Object.freeze({
    rowCounts: Object.freeze({ ...rowCounts }),
    fieldCounts: Object.freeze({ ...fieldCounts }),
    sourceUnversionedCount,
    sourceVersionCounts: Object.freeze({ ...sourceVersionCounts }),
    targetVersionCounts: Object.freeze({ ...targetVersionCounts }),
  });
  assertSecretFreeCutoverEvidence(evidence, [
    options.targetMessageEncryptionKey,
    ...Object.values(options.sourceMessageEncryptionKeys),
  ]);
  return evidence;
}
