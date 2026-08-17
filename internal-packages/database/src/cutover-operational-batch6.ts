import { CUTOVER_CHUNK_SIZE } from "./cutover-backfill";
import {
  assertSecretFreeCutoverEvidence,
  decodeLegacyJsonMessage,
  type CutoverJsonValue,
  type DecodedCutoverValue,
} from "./cutover-crypto";
import { normalizeJsonField, type JsonField, type JsonValue } from "./json";
import type { CutoverDatabase } from "./cutover-types";
import { CutoverFailure } from "./cutover-types";

export const retainedOperationalBatch6SourceModels = [
  "PlatosToolHealth",
  "PlatosToolCallAudit",
  "PlatosAdminAudit",
  "PlatosCredentialAudit",
  "PlatosAgentApproval",
  "PlatosBudgetCap",
  "PlatosSafetyEvent",
  "PlatosEvent",
  "PlatosNotificationRule",
  "PlatosErasureOperation",
] as const;

export const retainedOperationalBatch6MappingTargets = [
  { sourceModel: "PlatosToolHealth", targetModel: "ToolHealth", stableSuffix: "" },
  { sourceModel: "PlatosToolCallAudit", targetModel: "ToolCallAudit", stableSuffix: "" },
  { sourceModel: "PlatosAdminAudit", targetModel: "AdminAudit", stableSuffix: "" },
  { sourceModel: "PlatosCredentialAudit", targetModel: "AdminAudit", stableSuffix: "" },
  { sourceModel: "PlatosAgentApproval", targetModel: "AgentApproval", stableSuffix: "" },
  { sourceModel: "PlatosBudgetCap", targetModel: "Budget", stableSuffix: "" },
  { sourceModel: "PlatosSafetyEvent", targetModel: "SafetyEvent", stableSuffix: "" },
  { sourceModel: "PlatosEvent", targetModel: "Event", stableSuffix: "" },
  { sourceModel: "PlatosNotificationRule", targetModel: "NotificationRule", stableSuffix: "" },
  { sourceModel: "PlatosErasureOperation", targetModel: "ErasureOperation", stableSuffix: "" },
] as const;

/**
 * Batch 6 validates inherited envelopes and retains their existing at-rest
 * representation. Re-encryption under the final target writer and its runtime
 * read probes remain a later gate; this module does not claim either one.
 */
export const retainedOperationalBatch6DeferredTargetChecks = Object.freeze([
  Object.freeze({
    fields: "ToolCallAudit.arguments,ToolCallAudit.result",
    reEncryption: "DEFERRED",
    readProbe: "AUDIT_DECRYPT_READ",
  }),
  Object.freeze({
    fields: "SafetyEvent.detail,SafetyEvent.metadata",
    reEncryption: "DEFERRED",
    readProbe: "AUDIT_DECRYPT_READ",
  }),
] as const);

/** These targets are inserted only. Immutable triggers are installed later. */
export const retainedOperationalBatch6AppendOnlyTargets = Object.freeze([
  "ToolCallAudit",
  "AdminAudit",
  "SafetyEvent",
  "Event",
] as const);

export interface RetainedOperationalBatch6Options {
  readonly messageEncryptionKeys: Readonly<Record<string, string>>;
}

export interface RetainedOperationalBatch6Evidence {
  readonly batch: "retained-operational-batch6";
  readonly sourceRows: Readonly<Record<string, number>>;
  readonly targetRows: Readonly<Record<string, number>>;
  readonly mergeCounts: Readonly<{
    adminAuditSources: number;
    credentialAuditSources: number;
    adminAuditTargets: number;
  }>;
}

export interface ClassifiedBatch6MessageValue {
  readonly encoding: "PLAINTEXT" | "ENVELOPE";
  readonly keyVersion: number | null;
  readonly storageValue: JsonValue | string;
  readonly decodedValue: JsonValue | string;
}

function batch6Failure(code: string, summary: string): CutoverFailure {
  return new CutoverFailure(code, summary);
}

function normalizationFailure(label: string, error: unknown): never {
  throw batch6Failure(
    "BATCH6_SOURCE_VALUE_INVALID",
    `${label} is malformed${
      error instanceof Error && error.message.includes("expected") ? `: ${error.message}` : ""
    }`
  );
}

function normalizeBatch6Json(field: JsonField, value: unknown): JsonValue {
  try {
    return normalizeJsonField(field, value) as unknown as JsonValue;
  } catch (error) {
    return normalizationFailure(field, error);
  }
}

function normalizeNullableBatch6Json(field: JsonField, value: unknown): JsonValue | null {
  if (value === null || value === undefined) return null;
  return normalizeBatch6Json(field, value);
}

/**
 * Classifies only the exact inherited JSON message marker. Recognized invalid
 * material blocks. The original envelope is retained after successful decode
 * and root validation; no plaintext fallback is attempted.
 */
export function classifyBatch6JsonMessage(
  field: JsonField,
  sourceValue: unknown,
  messageEncryptionKeys: Readonly<Record<string, string>>
): ClassifiedBatch6MessageValue {
  let decoded: DecodedCutoverValue<CutoverJsonValue | string>;
  try {
    decoded = decodeLegacyJsonMessage(sourceValue, "JSONB", messageEncryptionKeys);
  } catch {
    throw batch6Failure(
      "BATCH6_MESSAGE_ENVELOPE_INVALID",
      `${field} message envelope is unreadable`
    );
  }
  const normalized = normalizeBatch6Json(field, decoded.value);
  return Object.freeze({
    encoding: decoded.encoding,
    keyVersion: decoded.keyVersion,
    storageValue: decoded.encoding === "ENVELOPE" ? (sourceValue as JsonValue) : normalized,
    decodedValue: normalized,
  });
}

export function classifyNullableBatch6JsonMessage(
  field: JsonField,
  sourceValue: unknown,
  messageEncryptionKeys: Readonly<Record<string, string>>
): ClassifiedBatch6MessageValue | null {
  if (sourceValue === null || sourceValue === undefined) return null;
  return classifyBatch6JsonMessage(field, sourceValue, messageEncryptionKeys);
}

export function classifyNullableBatch6TextMessage(
  label: "SafetyEvent.detail",
  sourceValue: unknown,
  messageEncryptionKeys: Readonly<Record<string, string>>
): ClassifiedBatch6MessageValue | null {
  if (sourceValue === null || sourceValue === undefined) return null;
  let decoded: DecodedCutoverValue<CutoverJsonValue | string>;
  try {
    decoded = decodeLegacyJsonMessage(sourceValue, "TEXT", messageEncryptionKeys);
  } catch {
    throw batch6Failure(
      "BATCH6_MESSAGE_ENVELOPE_INVALID",
      `${label} message envelope is unreadable`
    );
  }
  if (typeof decoded.value !== "string") {
    throw batch6Failure("BATCH6_SOURCE_VALUE_INVALID", `${label} must decode to a string`);
  }
  return Object.freeze({
    encoding: decoded.encoding,
    keyVersion: decoded.keyVersion,
    storageValue: decoded.encoding === "ENVELOPE" ? (sourceValue as string) : decoded.value,
    decodedValue: decoded.value,
  });
}

export type Batch6WorkStatus = "PENDING" | "ACTIVE" | "SUCCEEDED" | "FAILED" | "CANCELLED";
export type Batch6ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";

export function normalizeBatch6ToolCallStatus(value: unknown): Batch6WorkStatus {
  if (value === "success") return "SUCCEEDED";
  if (value === "failed" || value === "timeout") return "FAILED";
  throw batch6Failure("BATCH6_STATUS_INVALID", "tool-call audit status is not representable");
}

export function normalizeBatch6ApprovalStatus(value: unknown): Batch6ApprovalStatus {
  if (value === "pending") return "PENDING";
  if (value === "approved") return "APPROVED";
  if (value === "rejected") return "REJECTED";
  if (value === "timed_out") return "EXPIRED";
  throw batch6Failure("BATCH6_STATUS_INVALID", "agent approval status is not representable");
}

export function normalizeBatch6ErasureStatus(value: unknown): Batch6WorkStatus {
  if (value === "pending") return "PENDING";
  if (value === "running") return "ACTIVE";
  if (value === "completed") return "SUCCEEDED";
  if (
    value === "blocked_legal_hold" ||
    value === "partial_failure" ||
    value === "verification_failed"
  )
    return "FAILED";
  throw batch6Failure("BATCH6_STATUS_INVALID", "erasure status is not representable");
}

/** Canonical decimal(18,6) text; rejects negative, non-finite, or overflowing costs. */
export function normalizeBatch6CostCents(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value >= 1_000_000_000_000
  ) {
    throw batch6Failure(
      "BATCH6_COST_INVALID",
      "tool-call cost is not representable as decimal(18,6)"
    );
  }
  const fixed = value.toFixed(6);
  if (Number(fixed) !== value) {
    throw batch6Failure(
      "BATCH6_COST_INVALID",
      "tool-call cost exceeds canonical decimal(18,6) precision"
    );
  }
  return fixed;
}

export function normalizeBatch6BudgetScope(value: unknown): "scope" | "agent" | "user" {
  if (value === "scope" || value === "agent" || value === "user") return value;
  throw batch6Failure("BATCH6_BUDGET_SCOPE_INVALID", "budget scope is not representable");
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw batch6Failure("BATCH6_SOURCE_VALUE_INVALID", `${label} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.includes("\0")) {
    throw batch6Failure("BATCH6_SOURCE_VALUE_INVALID", `${label} must be a string when present`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw batch6Failure("BATCH6_SOURCE_VALUE_INVALID", `${label} must be a non-negative integer`);
  }
  return value as number;
}

function nullableNonNegativeInteger(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  return nonNegativeInteger(value, label);
}

function positiveInteger(value: unknown, label: string): number {
  const normalized = nonNegativeInteger(value, label);
  if (normalized === 0) {
    throw batch6Failure("BATCH6_SOURCE_VALUE_INVALID", `${label} must be a positive integer`);
  }
  return normalized;
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

async function forEachBatch6SourceChunk<Row extends Record<string, unknown>>(
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
      throw batch6Failure("BATCH6_CHUNK_ORDER_INVALID", "Batch 6 source chunk order is not stable");
    }
    cursor = nextCursor;
    count += result.rows.length;
  }
}

const sourceAndMappingValidationSql = `
  WITH scoped(source_model, source_id, organization_id, project_id, environment_id) AS (
    SELECT 'PlatosToolCallAudit', id, "organizationId", "projectId", "environmentId" FROM cutover_legacy."PlatosToolCallAudit"
    UNION ALL SELECT 'PlatosAdminAudit', id, "organizationId", "projectId", "environmentId" FROM cutover_legacy."PlatosAdminAudit"
    UNION ALL SELECT 'PlatosAgentApproval', id, "organizationId", "projectId", "environmentId" FROM cutover_legacy."PlatosAgentApproval"
    UNION ALL SELECT 'PlatosBudgetCap', id, "organizationId", "projectId", "environmentId" FROM cutover_legacy."PlatosBudgetCap"
    UNION ALL SELECT 'PlatosSafetyEvent', id, "organizationId", "projectId", "environmentId" FROM cutover_legacy."PlatosSafetyEvent"
    UNION ALL SELECT 'PlatosEvent', id, "organizationId", "projectId", "environmentId" FROM cutover_legacy."PlatosEvent"
    UNION ALL SELECT 'PlatosNotificationRule', id, "organizationId", "projectId", "environmentId" FROM cutover_legacy."PlatosNotificationRule"
    UNION ALL SELECT 'PlatosCredentialAudit', id, "organizationId", "projectId", "environmentId" FROM cutover_legacy."PlatosCredentialAudit"
  ), expected(source_model, target_model) AS (VALUES
    ('PlatosToolHealth', 'ToolHealth'),
    ('PlatosToolCallAudit', 'ToolCallAudit'),
    ('PlatosAdminAudit', 'AdminAudit'),
    ('PlatosCredentialAudit', 'AdminAudit'),
    ('PlatosAgentApproval', 'AgentApproval'),
    ('PlatosBudgetCap', 'Budget'),
    ('PlatosSafetyEvent', 'SafetyEvent'),
    ('PlatosEvent', 'Event'),
    ('PlatosNotificationRule', 'NotificationRule'),
    ('PlatosErasureOperation', 'ErasureOperation')
  ), source_ids(source_model, source_id) AS (
    SELECT 'PlatosToolHealth', id FROM cutover_legacy."PlatosToolHealth"
    UNION ALL SELECT 'PlatosToolCallAudit', id FROM cutover_legacy."PlatosToolCallAudit"
    UNION ALL SELECT 'PlatosAdminAudit', id FROM cutover_legacy."PlatosAdminAudit"
    UNION ALL SELECT 'PlatosCredentialAudit', id FROM cutover_legacy."PlatosCredentialAudit"
    UNION ALL SELECT 'PlatosAgentApproval', id FROM cutover_legacy."PlatosAgentApproval"
    UNION ALL SELECT 'PlatosBudgetCap', id FROM cutover_legacy."PlatosBudgetCap"
    UNION ALL SELECT 'PlatosSafetyEvent', id FROM cutover_legacy."PlatosSafetyEvent"
    UNION ALL SELECT 'PlatosEvent', id FROM cutover_legacy."PlatosEvent"
    UNION ALL SELECT 'PlatosNotificationRule', id FROM cutover_legacy."PlatosNotificationRule"
    UNION ALL SELECT 'PlatosErasureOperation', id FROM cutover_legacy."PlatosErasureOperation"
  ), issues AS (
    SELECT 'missing-or-duplicate-id-map' AS issue WHERE EXISTS (
      SELECT 1 FROM source_ids source JOIN expected USING (source_model)
       WHERE (SELECT count(*) FROM cutover_legacy.cutover_id_map map
               WHERE map.mapping_version = 1 AND map.source_model = source.source_model
                 AND map.source_id = source.source_id AND map.target_model = expected.target_model
                 AND map.stable_suffix = '') <> 1)
    UNION ALL SELECT 'scope-ancestry' WHERE EXISTS (
      SELECT 1 FROM scoped source
      LEFT JOIN cutover_legacy."RuntimeEnvironment" environment ON environment.id = source.environment_id
      LEFT JOIN cutover_legacy."Project" project ON project.id = source.project_id
      WHERE source.environment_id IS NULL OR source.project_id IS NULL OR source.organization_id IS NULL
         OR environment.id IS NULL OR project.id IS NULL
         OR environment."projectId" <> source.project_id
         OR environment."organizationId" <> source.organization_id
         OR project."organizationId" <> source.organization_id)
    UNION ALL SELECT 'tool-health-environment' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosToolHealth" source
      LEFT JOIN cutover_legacy."RuntimeEnvironment" environment ON environment.id = source."environmentId"
      WHERE environment.id IS NULL)
    UNION ALL SELECT 'erasure-organization' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosErasureOperation" source
      LEFT JOIN cutover_legacy."Organization" organization ON organization.id = source."organizationId"
      WHERE organization.id IS NULL)
    UNION ALL SELECT 'tool-reference' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosToolHealth" source
      LEFT JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
       AND map.source_model = 'PlatosToolDefinition' AND map.source_id = source."toolId"
       AND map.target_model = 'Tool' AND map.stable_suffix = ''
      WHERE map.target_id IS NULL
      UNION ALL
      SELECT 1 FROM cutover_legacy."PlatosToolCallAudit" source
      LEFT JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
       AND map.source_model = 'PlatosToolDefinition' AND map.source_id = source."toolId"
       AND map.target_model = 'Tool' AND map.stable_suffix = ''
      WHERE source."toolId" IS NOT NULL AND map.target_id IS NULL)
    UNION ALL SELECT 'notification-name-collision' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosNotificationRule"
       GROUP BY "environmentId", name HAVING count(*) > 1)
    UNION ALL SELECT 'tool-health-collision' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosToolHealth"
       GROUP BY "environmentId", "toolId", "entityId" HAVING count(*) > 1)
    UNION ALL SELECT 'erasure-idempotency-collision' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosErasureOperation"
       GROUP BY "organizationId", "idempotencyKey" HAVING count(*) > 1)
  )
  SELECT issue FROM issues ORDER BY issue`;

export async function validateRetainedOperationalBatch6Source(
  database: CutoverDatabase
): Promise<void> {
  const issues = await database.query<{ issue: string }>(sourceAndMappingValidationSql);
  if (issues.rows.length > 0) {
    throw batch6Failure(
      "BATCH6_SOURCE_OR_MAPPING_INVALID",
      `retained operational Batch 6 source validation failed: ${issues.rows
        .map((row) => row.issue)
        .join(", ")}`
    );
  }
}

interface ToolHealthRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  environment_id: string;
  tool_id: string;
  entity_external_id: string;
  last_called_at: Date | null;
  last_status: string | null;
  fail_count: number;
  total_calls: number;
  total_failures: number;
  p95_latency_ms: number | null;
  avg_latency_ms: number | null;
  updated_at: Date;
}

export async function backfillBatch6ToolHealth(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch6SourceChunk<ToolHealthRow>(
    database,
    `
    SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
           environment_map.target_id::text AS environment_id, tool_map.target_id::text AS tool_id,
           source."entityId" AS entity_external_id, source."lastCalledAt" AS last_called_at,
           source."lastStatus" AS last_status, source."failCount" AS fail_count,
           source."totalCalls" AS total_calls, source."totalFailures" AS total_failures,
           source."p95LatencyMs" AS p95_latency_ms, source."avgLatencyMs" AS avg_latency_ms,
           source."updatedAt" AS updated_at
      FROM cutover_legacy."PlatosToolHealth" source
      JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version = 1
       AND target_map.source_model = 'PlatosToolHealth' AND target_map.source_id = source.id
       AND target_map.target_model = 'ToolHealth' AND target_map.stable_suffix = ''
      JOIN cutover_legacy.cutover_id_map environment_map ON environment_map.mapping_version = 1
       AND environment_map.source_model = 'RuntimeEnvironment' AND environment_map.source_id = source."environmentId"
       AND environment_map.target_model = 'Environment' AND environment_map.stable_suffix = ''
      JOIN cutover_legacy.cutover_id_map tool_map ON tool_map.mapping_version = 1
       AND tool_map.source_model = 'PlatosToolDefinition' AND tool_map.source_id = source."toolId"
       AND tool_map.target_model = 'Tool' AND tool_map.stable_suffix = ''
     WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."ToolHealth"
      (id, "environmentId", "toolId", "entityExternalId", "lastCalledAt", "lastStatus",
       "failCount", "totalCalls", "totalFailures", "p95LatencyMs", "avgLatencyMs", "updatedAt")
      VALUES ${parameterTuples(rows.length, 12)}`,
        rows.flatMap((row) => [
          row.target_id,
          row.environment_id,
          row.tool_id,
          nonEmptyString(row.entity_external_id, "PlatosToolHealth.entityId"),
          row.last_called_at,
          nullableString(row.last_status, "PlatosToolHealth.lastStatus"),
          nonNegativeInteger(row.fail_count, "PlatosToolHealth.failCount"),
          nonNegativeInteger(row.total_calls, "PlatosToolHealth.totalCalls"),
          nonNegativeInteger(row.total_failures, "PlatosToolHealth.totalFailures"),
          nullableNonNegativeInteger(row.p95_latency_ms, "PlatosToolHealth.p95LatencyMs"),
          nullableNonNegativeInteger(row.avg_latency_ms, "PlatosToolHealth.avgLatencyMs"),
          row.updated_at,
        ])
      );
    },
    chunkSize
  );
}

interface ToolCallAuditRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  environment_id: string;
  tool_id: string | null;
  end_user_id: string | null;
  agent_id: string | null;
  thread_id: string | null;
  tool_name: string;
  arguments: unknown;
  result: unknown;
  error: string | null;
  status: string;
  latency_ms: number;
  cost_cents: number | null;
  trace_id: string | null;
  created_at: Date;
}

export async function backfillBatch6ToolCallAudits(
  database: CutoverDatabase,
  options: RetainedOperationalBatch6Options,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch6SourceChunk<ToolCallAuditRow>(
    database,
    `
    SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
           environment_map.target_id::text AS environment_id, tool_map.target_id::text AS tool_id,
           end_user_map.target_id::text AS end_user_id, agent_map.target_id::text AS agent_id,
           thread_map.target_id::text AS thread_id, source."toolName" AS tool_name,
           source.args AS arguments, source.result, source.error, source.status,
           source."latencyMs" AS latency_ms, source."costCents" AS cost_cents,
           source."traceId" AS trace_id, source."createdAt" AS created_at
      FROM cutover_legacy."PlatosToolCallAudit" source
      JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version = 1
       AND target_map.source_model = 'PlatosToolCallAudit' AND target_map.source_id = source.id
       AND target_map.target_model = 'ToolCallAudit' AND target_map.stable_suffix = ''
      JOIN cutover_legacy.cutover_id_map environment_map ON environment_map.mapping_version = 1
       AND environment_map.source_model = 'RuntimeEnvironment' AND environment_map.source_id = source."environmentId"
       AND environment_map.target_model = 'Environment' AND environment_map.stable_suffix = ''
      LEFT JOIN cutover_legacy.cutover_id_map tool_map ON tool_map.mapping_version = 1
       AND tool_map.source_model = 'PlatosToolDefinition' AND tool_map.source_id = source."toolId"
       AND tool_map.target_model = 'Tool' AND tool_map.stable_suffix = ''
      LEFT JOIN cutover_legacy."PlatosEndUser" source_end_user
        ON source_end_user."environmentId" = source."environmentId"
       AND source_end_user."externalUserId" = source."endUserId"
      LEFT JOIN cutover_legacy.cutover_id_map end_user_map ON end_user_map.mapping_version = 1
       AND end_user_map.source_model = 'PlatosEndUser' AND end_user_map.source_id = source_end_user.id
       AND end_user_map.target_model = 'EndUser' AND end_user_map.stable_suffix = ''
      LEFT JOIN cutover_legacy.cutover_id_map agent_map ON agent_map.mapping_version = 1
       AND agent_map.source_model = 'PlatosAgent' AND agent_map.source_id = source."agentId"
       AND agent_map.target_model = 'Agent' AND agent_map.stable_suffix = ''
      LEFT JOIN cutover_legacy.cutover_id_map thread_map ON thread_map.mapping_version = 1
       AND thread_map.source_model = 'PlatosAgentThread' AND thread_map.source_id = source."threadId"
       AND thread_map.target_model = 'Thread' AND thread_map.stable_suffix = ''
     WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."ToolCallAudit"
      (id, "environmentId", "toolId", "endUserId", "agentId", "threadId", "toolName",
       arguments, result, error, status, "latencyMs", "costCents", "traceId", "createdAt")
      VALUES ${parameterTuples(rows.length, 15)}`,
        rows.flatMap((row) => [
          row.target_id,
          row.environment_id,
          row.tool_id,
          row.end_user_id,
          row.agent_id,
          row.thread_id,
          nonEmptyString(row.tool_name, "PlatosToolCallAudit.toolName"),
          JSON.stringify(
            classifyBatch6JsonMessage(
              "ToolCallAudit.arguments",
              row.arguments,
              options.messageEncryptionKeys
            ).storageValue
          ),
          row.result == null
            ? null
            : JSON.stringify(
                classifyBatch6JsonMessage(
                  "ToolCallAudit.result",
                  row.result,
                  options.messageEncryptionKeys
                ).storageValue
              ),
          row.error,
          normalizeBatch6ToolCallStatus(row.status),
          nonNegativeInteger(row.latency_ms, "PlatosToolCallAudit.latencyMs"),
          normalizeBatch6CostCents(row.cost_cents),
          row.trace_id,
          row.created_at,
        ])
      );
    },
    chunkSize
  );
}

interface AdminAuditRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  environment_id: string;
  actor_user_id: string | null;
  action: string;
  subject_type: string;
  subject_id: string | null;
  before_json: unknown;
  after_json: unknown;
  reason: string | null;
  source: string | null;
  created_at: Date;
}

export async function backfillBatch6AdminAudits(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch6SourceChunk<AdminAuditRow>(
    database,
    `
    SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
           environment_map.target_id::text AS environment_id,
           coalesce(actor_map.target_id::text, source."actorUserId") AS actor_user_id,
           source.action, source."subjectType" AS subject_type, source."subjectId" AS subject_id,
           source."beforeJson" AS before_json, source."afterJson" AS after_json,
           source.reason, source.source, source."createdAt" AS created_at
      FROM cutover_legacy."PlatosAdminAudit" source
      JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version = 1
       AND target_map.source_model = 'PlatosAdminAudit' AND target_map.source_id = source.id
       AND target_map.target_model = 'AdminAudit' AND target_map.stable_suffix = ''
      JOIN cutover_legacy.cutover_id_map environment_map ON environment_map.mapping_version = 1
       AND environment_map.source_model = 'RuntimeEnvironment' AND environment_map.source_id = source."environmentId"
       AND environment_map.target_model = 'Environment' AND environment_map.stable_suffix = ''
      LEFT JOIN cutover_legacy.cutover_id_map actor_map ON actor_map.mapping_version = 1
       AND actor_map.source_model = 'User' AND actor_map.source_id = source."actorUserId"
       AND actor_map.target_model = 'User' AND actor_map.stable_suffix = ''
     WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."AdminAudit"
      (id, "environmentId", "actorUserId", action, "subjectType", "subjectId",
       before, after, reason, source, "createdAt")
      VALUES ${parameterTuples(rows.length, 11)}`,
        rows.flatMap((row) => [
          row.target_id,
          row.environment_id,
          row.actor_user_id,
          nonEmptyString(row.action, "PlatosAdminAudit.action"),
          nonEmptyString(row.subject_type, "PlatosAdminAudit.subjectType"),
          row.subject_id,
          row.before_json == null
            ? null
            : JSON.stringify(normalizeBatch6Json("AdminAudit.before", row.before_json)),
          row.after_json == null
            ? null
            : JSON.stringify(normalizeBatch6Json("AdminAudit.after", row.after_json)),
          row.reason,
          row.source,
          row.created_at,
        ])
      );
    },
    chunkSize
  );
}

interface CredentialAuditRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  environment_id: string;
  actor_user_id: string | null;
  action: string;
  family: string;
  credential_id: string;
  created_at: Date;
}

export async function backfillBatch6CredentialAudits(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch6SourceChunk<CredentialAuditRow>(
    database,
    `
    SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
           environment_map.target_id::text AS environment_id,
           coalesce(actor_map.target_id::text, source."actorUserId") AS actor_user_id,
           source.action, source.family, source."credentialId" AS credential_id,
           source."createdAt" AS created_at
      FROM cutover_legacy."PlatosCredentialAudit" source
      JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version = 1
       AND target_map.source_model = 'PlatosCredentialAudit' AND target_map.source_id = source.id
       AND target_map.target_model = 'AdminAudit' AND target_map.stable_suffix = ''
      JOIN cutover_legacy.cutover_id_map environment_map ON environment_map.mapping_version = 1
       AND environment_map.source_model = 'RuntimeEnvironment' AND environment_map.source_id = source."environmentId"
       AND environment_map.target_model = 'Environment' AND environment_map.stable_suffix = ''
      LEFT JOIN cutover_legacy.cutover_id_map actor_map ON actor_map.mapping_version = 1
       AND actor_map.source_model = 'User' AND actor_map.source_id = source."actorUserId"
       AND actor_map.target_model = 'User' AND actor_map.stable_suffix = ''
     WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."AdminAudit"
      (id, "environmentId", "actorUserId", action, "subjectType", "subjectId",
       before, after, reason, source, "createdAt")
      VALUES ${parameterTuples(rows.length, 11)}`,
        rows.flatMap((row) => [
          row.target_id,
          row.environment_id,
          row.actor_user_id,
          nonEmptyString(row.action, "PlatosCredentialAudit.action"),
          "PlatosCredentialAudit",
          nonEmptyString(row.credential_id, "PlatosCredentialAudit.credentialId"),
          null,
          null,
          null,
          `legacy:PlatosCredentialAudit:${nonEmptyString(
            row.family,
            "PlatosCredentialAudit.family"
          )}`,
          row.created_at,
        ])
      );
    },
    chunkSize
  );
}

interface AgentApprovalRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  environment_id: string;
  agent_id: string | null;
  thread_id: string | null;
  action: string;
  details: string | null;
  status: string;
  timeout_seconds: number;
  resolved_at: Date | null;
  responded_by: string | null;
  comment: string | null;
  tool_name: string | null;
  arguments: unknown;
  resolution: unknown;
  created_at: Date;
  updated_at: Date;
}

export async function backfillBatch6AgentApprovals(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch6SourceChunk<AgentApprovalRow>(
    database,
    `
    SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
           environment_map.target_id::text AS environment_id, agent_map.target_id::text AS agent_id,
           thread_map.target_id::text AS thread_id, source.action, source.details, source.status,
           source."timeoutSeconds" AS timeout_seconds, source."resolvedAt" AS resolved_at,
           source."respondedBy" AS responded_by, source.comment, source."toolName" AS tool_name,
           source.args AS arguments, source.resolution,
           source."createdAt" AS created_at, source."updatedAt" AS updated_at
      FROM cutover_legacy."PlatosAgentApproval" source
      JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version = 1
       AND target_map.source_model = 'PlatosAgentApproval' AND target_map.source_id = source.id
       AND target_map.target_model = 'AgentApproval' AND target_map.stable_suffix = ''
      JOIN cutover_legacy.cutover_id_map environment_map ON environment_map.mapping_version = 1
       AND environment_map.source_model = 'RuntimeEnvironment' AND environment_map.source_id = source."environmentId"
       AND environment_map.target_model = 'Environment' AND environment_map.stable_suffix = ''
      LEFT JOIN cutover_legacy.cutover_id_map agent_map ON agent_map.mapping_version = 1
       AND agent_map.source_model = 'PlatosAgent' AND agent_map.source_id = source."agentId"
       AND agent_map.target_model = 'Agent' AND agent_map.stable_suffix = ''
      LEFT JOIN cutover_legacy.cutover_id_map thread_map ON thread_map.mapping_version = 1
       AND thread_map.source_model = 'PlatosAgentThread' AND thread_map.source_id = source."threadId"
       AND thread_map.target_model = 'Thread' AND thread_map.stable_suffix = ''
     WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."AgentApproval"
      (id, "environmentId", "agentId", "threadId", "turnId", action, details, status,
       "timeoutSeconds", "resolvedAt", "respondedBy", comment, "toolName", arguments,
       resolution, "createdAt", "updatedAt") VALUES ${parameterTuples(rows.length, 17)}`,
        rows.flatMap((row) => [
          row.target_id,
          row.environment_id,
          row.agent_id,
          row.thread_id,
          null,
          nonEmptyString(row.action, "PlatosAgentApproval.action"),
          row.details,
          normalizeBatch6ApprovalStatus(row.status),
          positiveInteger(row.timeout_seconds, "PlatosAgentApproval.timeoutSeconds"),
          row.resolved_at,
          row.responded_by,
          row.comment,
          row.tool_name,
          row.arguments == null
            ? null
            : JSON.stringify(normalizeBatch6Json("AgentApproval.arguments", row.arguments)),
          row.resolution == null
            ? null
            : JSON.stringify(normalizeBatch6Json("AgentApproval.resolution", row.resolution)),
          row.created_at,
          row.updated_at,
        ])
      );
    },
    chunkSize
  );
}

interface BudgetRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  environment_id: string;
  agent_id: string | null;
  scope: string;
  period: string;
  limit_cents: number;
  alert_thresholds: unknown;
  override_until: Date | null;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export async function backfillBatch6Budgets(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch6SourceChunk<BudgetRow>(
    database,
    `
    SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
           environment_map.target_id::text AS environment_id, agent_map.target_id::text AS agent_id,
           source."scopeType" AS scope, source.period, source."limitCents" AS limit_cents,
           source."alertThresholds" AS alert_thresholds, source."overrideUntil" AS override_until,
           source.enabled, source."createdAt" AS created_at, source."updatedAt" AS updated_at
      FROM cutover_legacy."PlatosBudgetCap" source
      JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version = 1
       AND target_map.source_model = 'PlatosBudgetCap' AND target_map.source_id = source.id
       AND target_map.target_model = 'Budget' AND target_map.stable_suffix = ''
      JOIN cutover_legacy.cutover_id_map environment_map ON environment_map.mapping_version = 1
       AND environment_map.source_model = 'RuntimeEnvironment' AND environment_map.source_id = source."environmentId"
       AND environment_map.target_model = 'Environment' AND environment_map.stable_suffix = ''
      LEFT JOIN cutover_legacy.cutover_id_map agent_map ON agent_map.mapping_version = 1
       AND agent_map.source_model = 'PlatosAgent' AND agent_map.source_id = source."agentId"
       AND agent_map.target_model = 'Agent' AND agent_map.stable_suffix = ''
     WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."Budget"
      (id, "environmentId", "agentId", scope, period, "limitCents", "turnsLimit",
       "alertThresholds", enabled, "overrideUntil", "createdAt", "updatedAt")
      VALUES ${parameterTuples(rows.length, 12)}`,
        rows.flatMap((row) => [
          row.target_id,
          row.environment_id,
          row.agent_id,
          normalizeBatch6BudgetScope(row.scope),
          nonEmptyString(row.period, "PlatosBudgetCap.period"),
          nonNegativeInteger(row.limit_cents, "PlatosBudgetCap.limitCents"),
          null,
          JSON.stringify(normalizeBatch6Json("Budget.alertThresholds", row.alert_thresholds)),
          row.enabled,
          row.override_until,
          row.created_at,
          row.updated_at,
        ])
      );
    },
    chunkSize
  );
}

interface SafetyEventRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  environment_id: string;
  agent_id: string | null;
  thread_id: string | null;
  detector: string;
  action: string;
  severity: string;
  detail: unknown;
  metadata: unknown;
  tool_name: string | null;
  tool_call_id: string | null;
  created_at: Date;
}

export async function backfillBatch6SafetyEvents(
  database: CutoverDatabase,
  options: RetainedOperationalBatch6Options,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch6SourceChunk<SafetyEventRow>(
    database,
    `
    SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
           environment_map.target_id::text AS environment_id, agent_map.target_id::text AS agent_id,
           thread_map.target_id::text AS thread_id, source.detector, source.action, source.severity,
           source.detail, source.meta AS metadata, source."toolName" AS tool_name,
           tool_call_map.target_id::text AS tool_call_id, source."createdAt" AS created_at
      FROM cutover_legacy."PlatosSafetyEvent" source
      JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version = 1
       AND target_map.source_model = 'PlatosSafetyEvent' AND target_map.source_id = source.id
       AND target_map.target_model = 'SafetyEvent' AND target_map.stable_suffix = ''
      JOIN cutover_legacy.cutover_id_map environment_map ON environment_map.mapping_version = 1
       AND environment_map.source_model = 'RuntimeEnvironment' AND environment_map.source_id = source."environmentId"
       AND environment_map.target_model = 'Environment' AND environment_map.stable_suffix = ''
      LEFT JOIN cutover_legacy.cutover_id_map agent_map ON agent_map.mapping_version = 1
       AND agent_map.source_model = 'PlatosAgent' AND agent_map.source_id = source."agentId"
       AND agent_map.target_model = 'Agent' AND agent_map.stable_suffix = ''
      LEFT JOIN cutover_legacy.cutover_id_map thread_map ON thread_map.mapping_version = 1
       AND thread_map.source_model = 'PlatosAgentThread' AND thread_map.source_id = source."threadId"
       AND thread_map.target_model = 'Thread' AND thread_map.stable_suffix = ''
      LEFT JOIN cutover_legacy.cutover_id_map tool_call_map ON tool_call_map.mapping_version = 1
       AND tool_call_map.source_model = 'PlatosToolCallAudit' AND tool_call_map.source_id = source."toolCallId"
       AND tool_call_map.target_model = 'ToolCallAudit' AND tool_call_map.stable_suffix = ''
     WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."SafetyEvent"
      (id, "environmentId", "agentId", "threadId", "turnId", "endUserId", detector,
       action, severity, detail, metadata, "toolName", "toolCallId", "createdAt")
      VALUES ${parameterTuples(rows.length, 14)}`,
        rows.flatMap((row) => [
          row.target_id,
          row.environment_id,
          row.agent_id,
          row.thread_id,
          null,
          null,
          nonEmptyString(row.detector, "PlatosSafetyEvent.detector"),
          nonEmptyString(row.action, "PlatosSafetyEvent.action"),
          nonEmptyString(row.severity, "PlatosSafetyEvent.severity"),
          classifyNullableBatch6TextMessage(
            "SafetyEvent.detail",
            row.detail,
            options.messageEncryptionKeys
          )?.storageValue ?? null,
          row.metadata == null
            ? null
            : JSON.stringify(
                classifyBatch6JsonMessage(
                  "SafetyEvent.metadata",
                  row.metadata,
                  options.messageEncryptionKeys
                ).storageValue
              ),
          row.tool_name,
          row.tool_call_id,
          row.created_at,
        ])
      );
    },
    chunkSize
  );
}

interface EventRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  environment_id: string;
  event_type: string;
  subject_id: string | null;
  event_body: unknown;
  created_at: Date;
}

export async function backfillBatch6Events(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch6SourceChunk<EventRow>(
    database,
    `
    SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
           environment_map.target_id::text AS environment_id, source."eventType" AS event_type,
           source."subjectId" AS subject_id, source.payload AS event_body, source."createdAt" AS created_at
      FROM cutover_legacy."PlatosEvent" source
      JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version = 1
       AND target_map.source_model = 'PlatosEvent' AND target_map.source_id = source.id
       AND target_map.target_model = 'Event' AND target_map.stable_suffix = ''
      JOIN cutover_legacy.cutover_id_map environment_map ON environment_map.mapping_version = 1
       AND environment_map.source_model = 'RuntimeEnvironment' AND environment_map.source_id = source."environmentId"
       AND environment_map.target_model = 'Environment' AND environment_map.stable_suffix = ''
     WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."Event"
      (id, "environmentId", "eventType", "subjectId", payload, "createdAt")
      VALUES ${parameterTuples(rows.length, 6)}`,
        rows.flatMap((row) => [
          row.target_id,
          row.environment_id,
          nonEmptyString(row.event_type, "PlatosEvent.eventType"),
          row.subject_id,
          JSON.stringify(normalizeBatch6Json("Event.payload", row.event_body)),
          row.created_at,
        ])
      );
    },
    chunkSize
  );
}

interface NotificationRuleRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  environment_id: string;
  name: string;
  filters: unknown;
  delivery: unknown;
  enabled: boolean;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export async function backfillBatch6NotificationRules(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch6SourceChunk<NotificationRuleRow>(
    database,
    `
    SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
           environment_map.target_id::text AS environment_id, source.name, source.filters,
           source.delivery, source.enabled, source."createdBy" AS created_by,
           source."createdAt" AS created_at, source."updatedAt" AS updated_at
      FROM cutover_legacy."PlatosNotificationRule" source
      JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version = 1
       AND target_map.source_model = 'PlatosNotificationRule' AND target_map.source_id = source.id
       AND target_map.target_model = 'NotificationRule' AND target_map.stable_suffix = ''
      JOIN cutover_legacy.cutover_id_map environment_map ON environment_map.mapping_version = 1
       AND environment_map.source_model = 'RuntimeEnvironment' AND environment_map.source_id = source."environmentId"
       AND environment_map.target_model = 'Environment' AND environment_map.stable_suffix = ''
     WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."NotificationRule"
      (id, "environmentId", name, filters, delivery, enabled, "createdBy", "createdAt", "updatedAt")
      VALUES ${parameterTuples(rows.length, 9)}`,
        rows.flatMap((row) => [
          row.target_id,
          row.environment_id,
          nonEmptyString(row.name, "PlatosNotificationRule.name"),
          JSON.stringify(normalizeBatch6Json("NotificationRule.filters", row.filters)),
          JSON.stringify(normalizeBatch6Json("NotificationRule.delivery", row.delivery)),
          row.enabled,
          nonEmptyString(row.created_by, "PlatosNotificationRule.createdBy"),
          row.created_at,
          row.updated_at,
        ])
      );
    },
    chunkSize
  );
}

interface ErasureOperationRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  organization_id: string;
  idempotency_key: string;
  subject_key_hash: string;
  status: string;
  scopes: unknown;
  stores: unknown;
  inventory: unknown;
  policy_version: string;
  legal_hold_policy_id: string | null;
  requested_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  updated_at: Date;
}

export async function backfillBatch6ErasureOperations(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch6SourceChunk<ErasureOperationRow>(
    database,
    `
    SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
           organization_map.target_id::text AS organization_id,
           source."idempotencyKey" AS idempotency_key, source."subjectKeyHash" AS subject_key_hash,
           source.status, source.scopes, source.stores, source.inventory,
           source."policyVersion" AS policy_version, source."legalHoldPolicyId" AS legal_hold_policy_id,
           source."requestedAt" AS requested_at, source."startedAt" AS started_at,
           source."completedAt" AS completed_at, source."updatedAt" AS updated_at
      FROM cutover_legacy."PlatosErasureOperation" source
      JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version = 1
       AND target_map.source_model = 'PlatosErasureOperation' AND target_map.source_id = source.id
       AND target_map.target_model = 'ErasureOperation' AND target_map.stable_suffix = ''
      JOIN cutover_legacy.cutover_id_map organization_map ON organization_map.mapping_version = 1
       AND organization_map.source_model = 'Organization' AND organization_map.source_id = source."organizationId"
       AND organization_map.target_model = 'Organization' AND organization_map.stable_suffix = ''
     WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."ErasureOperation"
      (id, "organizationId", "idempotencyKey", "subjectKeyHash", status, scopes, stores,
       inventory, "policyVersion", "legalHoldPolicyId", "retryCount", "requestedAt",
       "startedAt", "completedAt", "updatedAt") VALUES ${parameterTuples(rows.length, 15)}`,
        rows.flatMap((row) => [
          row.target_id,
          row.organization_id,
          nonEmptyString(row.idempotency_key, "PlatosErasureOperation.idempotencyKey"),
          nonEmptyString(row.subject_key_hash, "PlatosErasureOperation.subjectKeyHash"),
          normalizeBatch6ErasureStatus(row.status),
          JSON.stringify(normalizeBatch6Json("ErasureOperation.scopes", row.scopes)),
          JSON.stringify(normalizeBatch6Json("ErasureOperation.stores", row.stores)),
          row.inventory == null
            ? null
            : JSON.stringify(normalizeBatch6Json("ErasureOperation.inventory", row.inventory)),
          nonEmptyString(row.policy_version, "PlatosErasureOperation.policyVersion"),
          row.legal_hold_policy_id,
          0,
          row.requested_at,
          row.started_at,
          row.completed_at,
          row.updated_at,
        ])
      );
    },
    chunkSize
  );
}

const conservationValidationSql = `
  WITH equations(id, source_count, target_count) AS (VALUES
    ('tool-health', (SELECT count(*) FROM cutover_legacy."PlatosToolHealth"),
      (SELECT count(*) FROM public."ToolHealth" target JOIN cutover_legacy.cutover_id_map map
        ON map.mapping_version = 1 AND map.source_model = 'PlatosToolHealth'
       AND map.target_model = 'ToolHealth' AND map.target_id = target.id)),
    ('tool-call-audit', (SELECT count(*) FROM cutover_legacy."PlatosToolCallAudit"),
      (SELECT count(*) FROM public."ToolCallAudit" target JOIN cutover_legacy.cutover_id_map map
        ON map.mapping_version = 1 AND map.source_model = 'PlatosToolCallAudit'
       AND map.target_model = 'ToolCallAudit' AND map.target_id = target.id)),
    ('admin-audit-merge',
      (SELECT count(*) FROM cutover_legacy."PlatosAdminAudit") +
      (SELECT count(*) FROM cutover_legacy."PlatosCredentialAudit"),
      (SELECT count(*) FROM public."AdminAudit" target JOIN cutover_legacy.cutover_id_map map
        ON map.mapping_version = 1 AND map.source_model IN ('PlatosAdminAudit', 'PlatosCredentialAudit')
       AND map.target_model = 'AdminAudit' AND map.target_id = target.id)),
    ('agent-approval', (SELECT count(*) FROM cutover_legacy."PlatosAgentApproval"),
      (SELECT count(*) FROM public."AgentApproval" target JOIN cutover_legacy.cutover_id_map map
        ON map.mapping_version = 1 AND map.source_model = 'PlatosAgentApproval'
       AND map.target_model = 'AgentApproval' AND map.target_id = target.id)),
    ('budget', (SELECT count(*) FROM cutover_legacy."PlatosBudgetCap"),
      (SELECT count(*) FROM public."Budget" target JOIN cutover_legacy.cutover_id_map map
        ON map.mapping_version = 1 AND map.source_model = 'PlatosBudgetCap'
       AND map.target_model = 'Budget' AND map.target_id = target.id)),
    ('safety-event', (SELECT count(*) FROM cutover_legacy."PlatosSafetyEvent"),
      (SELECT count(*) FROM public."SafetyEvent" target JOIN cutover_legacy.cutover_id_map map
        ON map.mapping_version = 1 AND map.source_model = 'PlatosSafetyEvent'
       AND map.target_model = 'SafetyEvent' AND map.target_id = target.id)),
    ('event', (SELECT count(*) FROM cutover_legacy."PlatosEvent"),
      (SELECT count(*) FROM public."Event" target JOIN cutover_legacy.cutover_id_map map
        ON map.mapping_version = 1 AND map.source_model = 'PlatosEvent'
       AND map.target_model = 'Event' AND map.target_id = target.id)),
    ('notification-rule', (SELECT count(*) FROM cutover_legacy."PlatosNotificationRule"),
      (SELECT count(*) FROM public."NotificationRule" target JOIN cutover_legacy.cutover_id_map map
        ON map.mapping_version = 1 AND map.source_model = 'PlatosNotificationRule'
       AND map.target_model = 'NotificationRule' AND map.target_id = target.id)),
    ('erasure-operation', (SELECT count(*) FROM cutover_legacy."PlatosErasureOperation"),
      (SELECT count(*) FROM public."ErasureOperation" target JOIN cutover_legacy.cutover_id_map map
        ON map.mapping_version = 1 AND map.source_model = 'PlatosErasureOperation'
       AND map.target_model = 'ErasureOperation' AND map.target_id = target.id))
  ) SELECT id FROM equations WHERE source_count <> target_count ORDER BY id`;

const ancestryValidationSql = `
  WITH environment_owned(target_model, target_id, environment_id) AS (
    SELECT 'ToolHealth', id, "environmentId" FROM public."ToolHealth"
    UNION ALL SELECT 'ToolCallAudit', id, "environmentId" FROM public."ToolCallAudit"
    UNION ALL SELECT 'AdminAudit', id, "environmentId" FROM public."AdminAudit"
    UNION ALL SELECT 'AgentApproval', id, "environmentId" FROM public."AgentApproval"
    UNION ALL SELECT 'Budget', id, "environmentId" FROM public."Budget"
    UNION ALL SELECT 'SafetyEvent', id, "environmentId" FROM public."SafetyEvent"
    UNION ALL SELECT 'Event', id, "environmentId" FROM public."Event"
    UNION ALL SELECT 'NotificationRule', id, "environmentId" FROM public."NotificationRule"
  ), batch_targets AS (
    SELECT owned.* FROM environment_owned owned JOIN cutover_legacy.cutover_id_map map
      ON map.mapping_version = 1 AND map.target_model = owned.target_model AND map.target_id = owned.target_id
     AND map.source_model = ANY(ARRAY['PlatosToolHealth','PlatosToolCallAudit','PlatosAdminAudit',
       'PlatosCredentialAudit','PlatosAgentApproval','PlatosBudgetCap','PlatosSafetyEvent',
       'PlatosEvent','PlatosNotificationRule'])
  ), issues AS (
    SELECT 'environment-owner' AS issue FROM batch_targets target
      LEFT JOIN public."Environment" environment ON environment.id = target.environment_id
     WHERE environment.id IS NULL
    UNION ALL SELECT 'tool-health-tool' FROM public."ToolHealth" target
      JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
       AND map.source_model = 'PlatosToolHealth' AND map.target_model = 'ToolHealth' AND map.target_id = target.id
      LEFT JOIN public."Tool" tool ON tool.id = target."toolId" WHERE tool.id IS NULL
    UNION ALL SELECT 'erasure-organization' FROM public."ErasureOperation" target
      JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
       AND map.source_model = 'PlatosErasureOperation' AND map.target_model = 'ErasureOperation'
       AND map.target_id = target.id
      LEFT JOIN public."Organization" organization ON organization.id = target."organizationId"
     WHERE organization.id IS NULL
  ) SELECT DISTINCT issue FROM issues ORDER BY issue`;

const semanticValidationSql = `
  WITH issues AS (
    SELECT 'admin-audit-provenance' AS issue FROM public."AdminAudit" target
      JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
       AND map.source_model = 'PlatosCredentialAudit' AND map.target_model = 'AdminAudit'
       AND map.target_id = target.id
      JOIN cutover_legacy."PlatosCredentialAudit" source ON source.id = map.source_id
     WHERE target."subjectType" <> 'PlatosCredentialAudit'
        OR target."subjectId" IS DISTINCT FROM source."credentialId"
        OR target.source IS DISTINCT FROM 'legacy:PlatosCredentialAudit:' || source.family
    UNION ALL SELECT 'tool-status-or-cost' FROM public."ToolCallAudit" target
      JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
       AND map.source_model = 'PlatosToolCallAudit' AND map.target_model = 'ToolCallAudit'
       AND map.target_id = target.id
      JOIN cutover_legacy."PlatosToolCallAudit" source ON source.id = map.source_id
     WHERE target.status <> CASE WHEN source.status = 'success' THEN 'SUCCEEDED'::"WorkStatus" ELSE 'FAILED'::"WorkStatus" END
        OR target."costCents" IS DISTINCT FROM source."costCents"::numeric(18,6)
    UNION ALL SELECT 'approval-status' FROM public."AgentApproval" target
      JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
       AND map.source_model = 'PlatosAgentApproval' AND map.target_model = 'AgentApproval'
       AND map.target_id = target.id
     WHERE target.status NOT IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')
    UNION ALL SELECT 'erasure-retry-conservation' FROM public."ErasureOperation" target
      JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
       AND map.source_model = 'PlatosErasureOperation' AND map.target_model = 'ErasureOperation'
       AND map.target_id = target.id
     WHERE target."retryCount" <> 0
  ) SELECT DISTINCT issue FROM issues ORDER BY issue`;

async function assertBatch6ValidationQuery(
  database: CutoverDatabase,
  sql: string,
  code: string,
  summary: string
): Promise<void> {
  const issues = await database.query<{ id?: string; issue?: string }>(sql);
  if (issues.rows.length > 0) {
    throw batch6Failure(
      code,
      `${summary}: ${issues.rows.map((row) => row.id ?? row.issue ?? "unknown").join(", ")}`
    );
  }
}

export async function validateRetainedOperationalBatch6(database: CutoverDatabase): Promise<void> {
  await assertBatch6ValidationQuery(
    database,
    conservationValidationSql,
    "BATCH6_CONSERVATION_FAILED",
    "retained operational Batch 6 conservation failed"
  );
  await assertBatch6ValidationQuery(
    database,
    ancestryValidationSql,
    "BATCH6_ANCESTRY_FAILED",
    "retained operational Batch 6 ancestry failed"
  );
  await assertBatch6ValidationQuery(
    database,
    semanticValidationSql,
    "BATCH6_SEMANTIC_VALIDATION_FAILED",
    "retained operational Batch 6 semantic validation failed"
  );
}

export async function backfillRetainedOperationalBatch6(
  database: CutoverDatabase,
  options: RetainedOperationalBatch6Options,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<RetainedOperationalBatch6Evidence> {
  await validateRetainedOperationalBatch6Source(database);
  const toolHealth = await backfillBatch6ToolHealth(database, chunkSize);
  const toolCallAudits = await backfillBatch6ToolCallAudits(database, options, chunkSize);
  const adminAuditSources = await backfillBatch6AdminAudits(database, chunkSize);
  const credentialAuditSources = await backfillBatch6CredentialAudits(database, chunkSize);
  const agentApprovals = await backfillBatch6AgentApprovals(database, chunkSize);
  const budgets = await backfillBatch6Budgets(database, chunkSize);
  const safetyEvents = await backfillBatch6SafetyEvents(database, options, chunkSize);
  const events = await backfillBatch6Events(database, chunkSize);
  const notificationRules = await backfillBatch6NotificationRules(database, chunkSize);
  const erasureOperations = await backfillBatch6ErasureOperations(database, chunkSize);
  await validateRetainedOperationalBatch6(database);

  const adminAuditTargets = adminAuditSources + credentialAuditSources;
  const evidence: RetainedOperationalBatch6Evidence = {
    batch: "retained-operational-batch6",
    sourceRows: Object.freeze({
      toolHealth,
      toolCallAudits,
      adminAudits: adminAuditSources,
      credentialAudits: credentialAuditSources,
      agentApprovals,
      budgets,
      safetyEvents,
      events,
      notificationRules,
      erasureOperations,
    }),
    targetRows: Object.freeze({
      toolHealth,
      toolCallAudits,
      adminAudits: adminAuditTargets,
      agentApprovals,
      budgets,
      safetyEvents,
      events,
      notificationRules,
      erasureOperations,
    }),
    mergeCounts: Object.freeze({ adminAuditSources, credentialAuditSources, adminAuditTargets }),
  };
  assertSecretFreeCutoverEvidence(evidence);
  return Object.freeze(evidence);
}
