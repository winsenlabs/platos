import { CUTOVER_CHUNK_SIZE } from "./cutover-backfill";
import {
  decodeVersionedLegacyMessage,
  type CutoverJsonValue,
} from "./cutover-crypto";
import { mapCutoverId } from "./cutover-id";
import { normalizeJsonField, type JsonValue } from "./json";
import type { CutoverDatabase } from "./cutover-types";
import { CutoverFailure } from "./cutover-types";

export const retainedConversationBatch2SourceModels = [
  "PlatosEndUser",
  "PlatosEndUserIdentity",
  "PlatosAgentThread",
  "PlatosAgentMessage",
  "PlatosAgentArtifact",
  "PlatosMessageAttachment",
  "PlatosPostmanTemplate",
] as const;

/**
 * Message children are data-dependent. Ordinals are zero-based in mapping
 * suffixes even though the clean sequence columns are one-based.
 */
export const retainedConversationBatch2MappingTargets = [
  { sourceModel: "PlatosEndUser", targetModel: "EndUser", stableSuffix: "" },
  { sourceModel: "PlatosEndUserIdentity", targetModel: "EndUserIdentity", stableSuffix: "" },
  { sourceModel: "PlatosAgentThread", targetModel: "Thread", stableSuffix: "" },
  { sourceModel: "PlatosAgentMessage", targetModel: "Turn", stableSuffix: "" },
  { sourceModel: "PlatosAgentMessage", targetModel: "Step", stableSuffix: "step:<ordinal>" },
  { sourceModel: "PlatosAgentMessage", targetModel: "ToolCall", stableSuffix: "tool-call:<ordinal>" },
  { sourceModel: "PlatosAgentArtifact", targetModel: "Artifact", stableSuffix: "" },
  { sourceModel: "PlatosMessageAttachment", targetModel: "MessageAttachment", stableSuffix: "" },
  { sourceModel: "PlatosPostmanTemplate", targetModel: "PostmanTemplate", stableSuffix: "" },
] as const;

export function batch2StepSuffix(ordinal: number): string {
  return ordinalSuffix("step", ordinal);
}

export function batch2ToolCallSuffix(ordinal: number): string {
  return ordinalSuffix("tool-call", ordinal);
}

function ordinalSuffix(prefix: "step" | "tool-call", ordinal: number): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new TypeError("conversation child ordinal must be a non-negative safe integer");
  }
  return `${prefix}:${ordinal}`;
}

interface NormalizedToolCall {
  readonly ordinal: number;
  readonly toolName: string;
  readonly arguments: JsonValue;
  /// Null for a call that never produced a result; ToolCall.result is nullable
  /// and the target row carries status PENDING.
  readonly result: JsonValue | null;
  readonly status: "SUCCEEDED" | "PENDING";
}

interface PendingCall {
  readonly ordinal: number;
  readonly toolName: string;
  readonly callId: string | null;
  readonly arguments: JsonValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw batch2Failure("BATCH2_MALFORMED_CONVERSATION_EVIDENCE", `${label} must be a non-empty string`);
  }
  return value;
}

function optionalCallId(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  return nonEmptyString(value, label);
}

/**
 * Models sometimes emit tool input as a JSON string rather than an object. The
 * runtime repairs that in flight (`repairStringifiedToolInput`), but a call
 * persisted before the repair kept the raw string, and ToolCall.arguments
 * requires an object root. Decode the same shape the runtime would have.
 */
function decodeStringifiedArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

function normalizedArguments(value: unknown): JsonValue {
  const decoded = decodeStringifiedArguments(value);
  // A non-object that will not decode is preserved under a `value` key rather
  // than failing the cutover, matching how results are handled.
  const candidate = isRecord(decoded) ? decoded : { value: decoded };
  try {
    return normalizeJsonField("ToolCall.arguments", candidate) as unknown as JsonValue;
  } catch (error) {
    throw batch2Failure(
      "BATCH2_MALFORMED_TOOL_CALLS",
      error instanceof Error ? error.message : "tool arguments are malformed"
    );
  }
}

function normalizedResult(value: unknown): JsonValue {
  const candidate = isRecord(value) || Array.isArray(value) ? value : { value };
  try {
    return normalizeJsonField("ToolCall.result", candidate) as unknown as JsonValue;
  } catch (error) {
    throw batch2Failure(
      "BATCH2_MALFORMED_TOOL_CALLS",
      error instanceof Error ? error.message : "tool result is malformed"
    );
  }
}

/**
 * Accepts the two historical shapes written by Platos: a call/result event log,
 * or one combined row per call. Mixed shapes, unmatched results, duplicate
 * unresolved names, and conflicting argument aliases block the cutover.
 */
export function normalizeBatch2ToolCalls(input: unknown): readonly NormalizedToolCall[] {
  if (input === null || input === undefined) return [];
  if (!Array.isArray(input)) {
    throw batch2Failure("BATCH2_MALFORMED_TOOL_CALLS", "toolCalls must have an array root");
  }
  if (input.length === 0) return [];
  if (!input.every(isRecord)) {
    throw batch2Failure("BATCH2_MALFORMED_TOOL_CALLS", "every toolCalls entry must be an object");
  }

  const eventEntries = input.filter((entry) => hasOwn(entry, "type"));
  if (eventEntries.length !== 0 && eventEntries.length !== input.length) {
    throw batch2Failure("BATCH2_AMBIGUOUS_TOOL_CALLS", "toolCalls cannot mix event and combined shapes");
  }

  if (eventEntries.length === 0) {
    return Object.freeze(input.map((entry, ordinal) => {
      const hasParams = hasOwn(entry, "params");
      const hasArguments = hasOwn(entry, "arguments");
      if (hasParams === hasArguments || !hasOwn(entry, "result")) {
        throw batch2Failure(
          "BATCH2_AMBIGUOUS_TOOL_CALLS",
          "combined tool call must contain exactly one argument field and one result"
        );
      }
      return Object.freeze({
        ordinal,
        toolName: nonEmptyString(entry.name, `toolCalls[${ordinal}].name`),
        arguments: normalizedArguments(hasParams ? entry.params : entry.arguments),
        result: normalizedResult(entry.result),
        status: "SUCCEEDED" as const,
      });
    }));
  }

  const pending: PendingCall[] = [];
  const completed: NormalizedToolCall[] = [];
  for (let eventOrdinal = 0; eventOrdinal < input.length; eventOrdinal += 1) {
    const entry = input[eventOrdinal]!;
    const type = entry.type;
    const toolName = nonEmptyString(entry.name, `toolCalls[${eventOrdinal}].name`);
    const callId = optionalCallId(entry.callId, `toolCalls[${eventOrdinal}].callId`);
    if (type === "call") {
      if (!hasOwn(entry, "params") || hasOwn(entry, "result")) {
        throw batch2Failure("BATCH2_AMBIGUOUS_TOOL_CALLS", "call event has conflicting fields");
      }
      pending.push({
        ordinal: pending.length + completed.length,
        toolName,
        callId,
        arguments: normalizedArguments(entry.params),
      });
      continue;
    }
    if (type !== "result" || !hasOwn(entry, "result") || hasOwn(entry, "params")) {
      throw batch2Failure("BATCH2_AMBIGUOUS_TOOL_CALLS", "unrecognized tool call event shape");
    }

    const candidates = pending.filter((call) =>
      callId === null
        ? call.callId === null && call.toolName === toolName
        : call.callId === callId && call.toolName === toolName
    );
    if (candidates.length === 0) {
      throw batch2Failure(
        "BATCH2_AMBIGUOUS_TOOL_CALLS",
        "tool result must identify exactly one unresolved call"
      );
    }
    // A correlated result naming several unresolved calls is genuinely
    // ambiguous. An uncorrelated one is not: legacy `toolCalls` never recorded
    // a callId, so a tool invoked twice in a turn leaves two identical pending
    // entries. Results come back in call order, so resolve the earliest —
    // `pending` is append-ordered, making candidates[0] that call.
    if (candidates.length > 1 && callId !== null) {
      throw batch2Failure(
        "BATCH2_AMBIGUOUS_TOOL_CALLS",
        "tool result must identify exactly one unresolved call"
      );
    }
    const call = candidates[0]!;
    pending.splice(pending.indexOf(call), 1);
    completed.push(Object.freeze({
      ordinal: call.ordinal,
      toolName: call.toolName,
      arguments: call.arguments,
      result: normalizedResult(entry.result),
      status: "SUCCEEDED" as const,
    }));
  }
  // A call with no result is a real terminal state, not corruption: an
  // approval request that was never answered leaves exactly this shape. The
  // target models it directly — ToolCall.result is nullable and WorkStatus has
  // PENDING — so carry it across rather than failing the whole cutover.
  for (const unresolved of pending) {
    completed.push(Object.freeze({
      ordinal: unresolved.ordinal,
      toolName: unresolved.toolName,
      arguments: unresolved.arguments,
      result: null,
      status: "PENDING" as const,
    }));
  }
  return Object.freeze(completed.sort((left, right) => left.ordinal - right.ordinal));
}

interface NormalizedResponseEvidence {
  readonly model: string;
  readonly versionSourceId: string;
  readonly versionBucket: "CURRENT" | "CANARY" | "LOCKED" | "FALLBACK";
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheCreationInputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly costCents: number | null;
  readonly latencyMs: number | null;
}

function optionalNonNegativeInteger(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw batch2Failure("BATCH2_MALFORMED_RESPONSE_JSON", `${label} must be a non-negative integer`);
  }
  return value as number;
}

function optionalNonNegativeNumber(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw batch2Failure("BATCH2_MALFORMED_RESPONSE_JSON", `${label} must be a non-negative number`);
  }
  return value;
}

/** Normalize only response evidence represented by clean Turn/Step columns. */
export function normalizeBatch2ResponseJson(input: unknown): NormalizedResponseEvidence {
  if (!isRecord(input)) {
    throw batch2Failure("BATCH2_MALFORMED_RESPONSE_JSON", "assistant responseJson must have an object root");
  }
  if (hasOwn(input, "versionId") || hasOwn(input, "versionBucket") || hasOwn(input, "latency")) {
    throw batch2Failure("BATCH2_AMBIGUOUS_RESPONSE_JSON", "responseJson contains an unsupported mapped-field alias");
  }
  // The four outcomes agent version resolution can record for a turn.
  const bucket = input.version_bucket;
  if (bucket !== "current" && bucket !== "canary" && bucket !== "locked" && bucket !== "fallback") {
    throw batch2Failure(
      "BATCH2_MALFORMED_RESPONSE_JSON",
      "responseJson.version_bucket must be current, canary, locked, or fallback"
    );
  }
  const usage = input.usage === undefined || input.usage === null ? {} : input.usage;
  if (!isRecord(usage)) {
    throw batch2Failure("BATCH2_MALFORMED_RESPONSE_JSON", "responseJson.usage must be an object");
  }
  const cost = input.cost_with_cache_cents ?? input.cost_cents;
  return Object.freeze({
    model: nonEmptyString(input.model, "responseJson.model"),
    versionSourceId: nonEmptyString(input.version_id, "responseJson.version_id"),
    versionBucket: bucket.toUpperCase() as "CURRENT" | "CANARY" | "LOCKED" | "FALLBACK",
    inputTokens: optionalNonNegativeInteger(usage.inputTokens, "responseJson.usage.inputTokens"),
    outputTokens: optionalNonNegativeInteger(usage.outputTokens, "responseJson.usage.outputTokens"),
    cacheCreationInputTokens: optionalNonNegativeInteger(
      usage.cacheCreationInputTokens,
      "responseJson.usage.cacheCreationInputTokens"
    ),
    cacheReadInputTokens: optionalNonNegativeInteger(
      usage.cacheReadInputTokens,
      "responseJson.usage.cacheReadInputTokens"
    ),
    reasoningTokens: optionalNonNegativeInteger(
      usage.reasoningTokens,
      "responseJson.usage.reasoningTokens"
    ),
    costCents: optionalNonNegativeNumber(cost, "responseJson cost"),
    latencyMs: optionalNonNegativeInteger(input.latency_ms, "responseJson.latency_ms"),
  });
}

export function mergeBatch2IdentityProfiles(
  endUserMetadata: unknown,
  identityMetadata: unknown
): JsonValue | null {
  const normalize = (value: unknown): Record<string, JsonValue> | null => {
    if (value === null || value === undefined) return null;
    try {
      return normalizeJsonField("EndUserIdentity.profile", value) as unknown as Record<string, JsonValue>;
    } catch (error) {
      throw batch2Failure(
        "BATCH2_MALFORMED_IDENTITY_PROFILE",
        error instanceof Error ? error.message : "identity profile is malformed"
      );
    }
  };
  const inherited = normalize(endUserMetadata);
  const identity = normalize(identityMetadata);
  if (inherited === null) return identity;
  if (identity === null) return inherited;
  const merged: Record<string, JsonValue> = { ...inherited };
  for (const [key, value] of Object.entries(identity)) {
    if (hasOwn(merged, key) && JSON.stringify(merged[key]) !== JSON.stringify(value)) {
      throw batch2Failure(
        "BATCH2_AMBIGUOUS_IDENTITY_PROFILE",
        "end-user and identity metadata contain a conflicting profile key"
      );
    }
    merged[key] = value;
  }
  return merged;
}

export interface Batch2MessageSourceEvidence {
  readonly sourceId: string;
  readonly role: unknown;
  readonly content: unknown;
  readonly thinkingContent: unknown;
  readonly encKeyVersion: unknown;
  readonly responseJson: unknown;
  readonly toolCalls: unknown;
}

export interface NormalizedBatch2MessageEvidence {
  readonly role: "user" | "assistant";
  readonly inputText: string | null;
  readonly outputText: string | null;
  readonly thinkingContent: string | null;
  readonly response: NormalizedResponseEvidence | null;
  readonly toolCalls: readonly NormalizedToolCall[];
}

/**
 * Classification-only crypto boundary for this batch. Recognized envelopes are
 * strictly decoded under the supplied key ring. This deliberately does not add
 * target re-encryption or a target read probe; those remain an execute blocker.
 */
export function normalizeBatch2MessageEvidence(
  input: Batch2MessageSourceEvidence,
  messageKeys: Readonly<Record<string, string>>
): NormalizedBatch2MessageEvidence {
  // encKeyVersion is row-level while each encrypted column remains nullable.
  // Null means absent material, not a malformed or plaintext envelope.
  const content = input.content === null
    ? null
    : decodeVersionedLegacyMessage(input.content, input.encKeyVersion, messageKeys).value;
  const thinking = input.thinkingContent === null
    ? null
    : decodeVersionedLegacyMessage(input.thinkingContent, input.encKeyVersion, messageKeys).value;
  if (input.role === "user") {
    if (input.responseJson !== null && input.responseJson !== undefined) {
      throw batch2Failure("BATCH2_AMBIGUOUS_RESPONSE_JSON", "user message cannot carry assistant responseJson");
    }
    if (input.toolCalls !== null && input.toolCalls !== undefined) {
      throw batch2Failure("BATCH2_AMBIGUOUS_TOOL_CALLS", "user message cannot carry tool calls");
    }
    if (thinking !== null) {
      throw batch2Failure("BATCH2_MALFORMED_CONVERSATION_EVIDENCE", "user message cannot carry thinking content");
    }
    return Object.freeze({
      role: "user",
      inputText: content,
      outputText: null,
      thinkingContent: null,
      response: null,
      toolCalls: [],
    });
  }
  if (input.role !== "assistant") {
    throw batch2Failure(
      "BATCH2_UNREPRESENTABLE_MESSAGE_ROLE",
      "legacy tool-role rows cannot be represented without ambiguous Turn ownership"
    );
  }
  return Object.freeze({
    role: "assistant",
    inputText: null,
    outputText: content,
    thinkingContent: thinking,
    response: normalizeBatch2ResponseJson(input.responseJson),
    toolCalls: normalizeBatch2ToolCalls(input.toolCalls),
  });
}

function normalizeThreadStatus(value: unknown): "ACTIVE" | "SUCCEEDED" | "CANCELLED" {
  if (value === "active") return "ACTIVE";
  if (value === "completed") return "SUCCEEDED";
  if (value === "archived") return "CANCELLED";
  throw batch2Failure("BATCH2_INVALID_STATUS", "thread status is not representable");
}

function normalizeMessageStatus(value: unknown): "SUCCEEDED" | "CANCELLED" {
  if (value === "active") return "SUCCEEDED";
  if (value === "edited_out") return "CANCELLED";
  throw batch2Failure("BATCH2_INVALID_STATUS", "message status is not representable");
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 1) {
    throw batch2Failure("BATCH2_MALFORMED_CONVERSATION_EVIDENCE", `${label} must be a positive integer`);
  }
  return parsed as number;
}

function normalizedOptionalJson(field: "PostmanTemplate.sessionContext" | "Thread.sessionContext" | "Artifact.metadata", value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(normalizeJsonField(field, value));
  } catch (error) {
    throw batch2Failure(
      "BATCH2_JSON_NORMALIZATION_FAILED",
      error instanceof Error ? error.message : `${field} normalization failed`
    );
  }
}

function parameterTuples(rowCount: number, width: number): string {
  return Array.from({ length: rowCount }, (_, rowIndex) => {
    const offset = rowIndex * width;
    return `(${Array.from({ length: width }, (__, columnIndex) => `$${offset + columnIndex + 1}`).join(", ")})`;
  }).join(", ");
}

async function forEachIdChunk<Row extends Record<string, unknown>>(
  database: CutoverDatabase,
  selectSql: string,
  consume: (rows: readonly Row[]) => Promise<void>,
  chunkSize: number,
  code = "BATCH2_CHUNK_ORDER_INVALID"
): Promise<void> {
  assertChunkSize(chunkSize);
  let cursor = "";
  while (true) {
    const result = await database.query<Row>(selectSql, [cursor, chunkSize]);
    if (result.rows.length === 0) return;
    await consume(result.rows);
    const next = result.rows.at(-1)?.source_id;
    if (typeof next !== "string" || next <= cursor) {
      throw batch2Failure(code, "Batch 2 source chunk order is not stable");
    }
    cursor = next;
  }
}

function assertChunkSize(chunkSize: number): void {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new TypeError("cutover chunk size must be a positive integer");
  }
}

interface MappingMessageRow extends Record<string, unknown> {
  source_id: string;
  role: unknown;
  tool_calls: unknown;
}

/** Replace generic split placeholders with exact data-dependent ordinal maps. */
export async function materializeBatch2MessageOrdinalMappings(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  await database.query(`DELETE FROM cutover_legacy.cutover_id_map
    WHERE mapping_version = 1 AND source_model = 'PlatosAgentMessage'
      AND target_model IN ('Step', 'ToolCall')`);
  let inserted = 0;
  await forEachIdChunk<MappingMessageRow>(
    database,
    `SELECT source.id::text AS source_id, source.role, source."toolCalls" AS tool_calls
       FROM cutover_legacy."PlatosAgentMessage" source
      WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      const mappings: Array<readonly [string, string, string, string]> = [];
      for (const row of rows) {
        if (row.role === "assistant") {
          const suffix = batch2StepSuffix(0);
          mappings.push([
            row.source_id,
            "Step",
            suffix,
            mapCutoverId({ sourceModel: "PlatosAgentMessage", sourceId: row.source_id, suffix }),
          ]);
          for (const call of normalizeBatch2ToolCalls(row.tool_calls)) {
            const callSuffix = batch2ToolCallSuffix(call.ordinal);
            mappings.push([
              row.source_id,
              "ToolCall",
              callSuffix,
              mapCutoverId({ sourceModel: "PlatosAgentMessage", sourceId: row.source_id, suffix: callSuffix }),
            ]);
          }
        } else if (row.role !== "user") {
          throw batch2Failure("BATCH2_UNREPRESENTABLE_MESSAGE_ROLE", "message role is not representable");
        }
      }
      if (mappings.length === 0) return;
      await database.query(
        `INSERT INTO cutover_legacy.cutover_id_map
          (mapping_version, source_model, source_id, target_model, stable_suffix, target_id)
         VALUES ${parameterTuples(mappings.length, 5).replaceAll("(", "(1, ")}`,
        mappings.flatMap(([sourceId, targetModel, suffix, targetId]) => [
          "PlatosAgentMessage", sourceId, targetModel, suffix, targetId,
        ])
      );
      inserted += mappings.length;
    },
    chunkSize
  );
  return inserted;
}

const sourceValidationSql = `
  WITH issues AS (
    SELECT 'missing-static-map' AS issue WHERE EXISTS (
      SELECT 1 FROM (VALUES
        ('PlatosEndUser','EndUser'), ('PlatosEndUserIdentity','EndUserIdentity'),
        ('PlatosAgentThread','Thread'), ('PlatosAgentMessage','Turn'),
        ('PlatosAgentArtifact','Artifact'), ('PlatosMessageAttachment','MessageAttachment'),
        ('PlatosPostmanTemplate','PostmanTemplate')) expected(source_model,target_model)
      JOIN LATERAL (SELECT id FROM cutover_legacy."PlatosEndUser" WHERE expected.source_model='PlatosEndUser'
                    UNION ALL SELECT id FROM cutover_legacy."PlatosEndUserIdentity" WHERE expected.source_model='PlatosEndUserIdentity'
                    UNION ALL SELECT id FROM cutover_legacy."PlatosAgentThread" WHERE expected.source_model='PlatosAgentThread'
                    UNION ALL SELECT id FROM cutover_legacy."PlatosAgentMessage" WHERE expected.source_model='PlatosAgentMessage'
                    UNION ALL SELECT id FROM cutover_legacy."PlatosAgentArtifact" WHERE expected.source_model='PlatosAgentArtifact'
                    UNION ALL SELECT id FROM cutover_legacy."PlatosMessageAttachment" WHERE expected.source_model='PlatosMessageAttachment'
                    UNION ALL SELECT id FROM cutover_legacy."PlatosPostmanTemplate" WHERE expected.source_model='PlatosPostmanTemplate') source ON true
      WHERE (SELECT count(*) FROM cutover_legacy.cutover_id_map map
              WHERE map.mapping_version=1 AND map.source_model=expected.source_model
                AND map.source_id=source.id AND map.target_model=expected.target_model
                AND map.stable_suffix='') <> 1)
    UNION ALL
    SELECT 'message-child-map' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosAgentMessage" source
      WHERE (source.role='assistant' AND (SELECT count(*) FROM cutover_legacy.cutover_id_map map
             WHERE map.mapping_version=1 AND map.source_model='PlatosAgentMessage'
               AND map.source_id=source.id AND map.target_model='Step'
               AND map.stable_suffix='step:0') <> 1)
         OR (source.role='user' AND EXISTS (SELECT 1 FROM cutover_legacy.cutover_id_map map
             WHERE map.mapping_version=1 AND map.source_model='PlatosAgentMessage'
               AND map.source_id=source.id AND map.target_model IN ('Step','ToolCall'))))
    UNION ALL
    SELECT 'end-user-ancestry' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosEndUser" source
      LEFT JOIN cutover_legacy."RuntimeEnvironment" environment ON environment.id=source."environmentId"
      LEFT JOIN cutover_legacy."Project" project ON project.id=source."projectId"
      WHERE environment.id IS NULL OR project.id IS NULL
         OR environment."projectId"<>source."projectId" OR environment."organizationId"<>source."organizationId"
         OR project."organizationId"<>source."organizationId")
    UNION ALL
    SELECT 'identity-ancestry-or-collision' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosEndUserIdentity" identity
      LEFT JOIN cutover_legacy."PlatosEndUser" end_user ON end_user.id=identity."platosEndUserId"
      WHERE end_user.id IS NULL OR end_user."organizationId"<>identity."organizationId"
         OR end_user."projectId"<>identity."projectId" OR end_user."environmentId"<>identity."environmentId")
      OR EXISTS (SELECT 1 FROM cutover_legacy."PlatosEndUserIdentity"
                 GROUP BY "organizationId", channel, handle HAVING count(*)>1)
    UNION ALL
    SELECT 'end-user-profile-without-identity' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosEndUser" end_user
      WHERE end_user.metadata IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM cutover_legacy."PlatosEndUserIdentity" identity
        WHERE identity."platosEndUserId"=end_user.id))
    UNION ALL
    SELECT 'thread-ancestry' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosAgentThread" source
      LEFT JOIN cutover_legacy."RuntimeEnvironment" environment ON environment.id=source."environmentId"
      LEFT JOIN cutover_legacy."PlatosAgent" agent ON agent.id=source."agentId"
      LEFT JOIN cutover_legacy."PlatosEndUser" end_user ON end_user.id=source."platosEndUserId"
      LEFT JOIN cutover_legacy."PlatosAgentThread" parent ON parent.id=source."parentThreadId"
      WHERE environment.id IS NULL OR agent.id IS NULL OR end_user.id IS NULL
         OR environment."projectId"<>source."projectId" OR environment."organizationId"<>source."organizationId"
         OR agent."projectId"<>source."projectId" OR agent."environmentId"<>source."environmentId"
         OR end_user."organizationId"<>source."organizationId" OR end_user."environmentId"<>source."environmentId"
         OR (source."parentThreadId" IS NOT NULL AND (parent.id IS NULL OR parent."environmentId"<>source."environmentId")))
    UNION ALL
    SELECT 'thread-parent-cycle' WHERE EXISTS (
      WITH RECURSIVE walk(id, parent_id, path, cycle) AS (
        SELECT id, "parentThreadId", ARRAY[id], false FROM cutover_legacy."PlatosAgentThread"
        UNION ALL
        SELECT parent.id, parent."parentThreadId", walk.path || parent.id, parent.id=ANY(walk.path)
        FROM walk JOIN cutover_legacy."PlatosAgentThread" parent ON parent.id=walk.parent_id
        WHERE NOT walk.cycle)
      SELECT 1 FROM walk WHERE cycle)
    UNION ALL
    SELECT 'message-parent-or-version' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosAgentMessage" message
      LEFT JOIN cutover_legacy."PlatosAgentThread" thread ON thread.id=message."threadId"
      LEFT JOIN cutover_legacy."PlatosAgentVersion" locked ON locked.id=thread."lockedVersionId" AND locked."agentId"=thread."agentId"
      LEFT JOIN cutover_legacy."PlatosAgentVersion" response_version
        ON response_version.id=CASE WHEN jsonb_typeof(message."responseJson")='object' THEN message."responseJson"->>'version_id' END
       AND response_version."agentId"=thread."agentId"
      WHERE thread.id IS NULL OR message.role NOT IN ('user','assistant')
         OR (message.role='user' AND locked.id IS NULL)
         OR (message.role='assistant' AND response_version.id IS NULL))
    UNION ALL
    SELECT 'artifact-ancestry' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosAgentArtifact" source
      LEFT JOIN cutover_legacy."PlatosAgentThread" thread ON thread.id=source."threadId"
      WHERE thread.id IS NULL OR thread."environmentId"<>source."environmentId"
         OR thread."projectId"<>source."projectId" OR thread."organizationId"<>source."organizationId")
    UNION ALL
    SELECT 'attachment-ancestry-or-uploader' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosMessageAttachment" source
      LEFT JOIN cutover_legacy."RuntimeEnvironment" environment ON environment.id=source."environmentId"
      WHERE environment.id IS NULL OR environment."projectId"<>source."projectId"
         OR environment."organizationId"<>source."organizationId"
         OR (SELECT count(*) FROM cutover_legacy."PlatosEndUser" end_user
             WHERE end_user."organizationId"=source."organizationId"
               AND end_user."environmentId"=source."environmentId"
               AND source."uploadedBy" IN (end_user.id, end_user."externalUserId", end_user."linkedExternalId")) <> 1)
    UNION ALL
    SELECT 'postman-ancestry' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosPostmanTemplate" source
      LEFT JOIN cutover_legacy."RuntimeEnvironment" environment ON environment.id=source."environmentId"
      LEFT JOIN cutover_legacy."PlatosAgent" agent ON agent.id=source."agentId"
      WHERE environment.id IS NULL OR agent.id IS NULL OR environment."projectId"<>source."projectId"
         OR environment."organizationId"<>source."organizationId"
         OR agent."projectId"<>source."projectId" OR agent."environmentId"<>source."environmentId")
  ) SELECT DISTINCT issue FROM issues ORDER BY issue`;

interface MessageValidationRow extends Record<string, unknown> {
  source_id: string;
  role: unknown;
  content: unknown;
  thinking_content: unknown;
  enc_key_version: unknown;
  response_json: unknown;
  tool_calls: unknown;
}

export async function validateRetainedConversationBatch2Source(
  database: CutoverDatabase,
  messageKeys: Readonly<Record<string, string>>,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<void> {
  const issues = await database.query<{ issue: string }>(sourceValidationSql);
  if (issues.rows.length > 0) {
    throw batch2Failure(
      "BATCH2_SOURCE_OR_MAPPING_INVALID",
      `retained conversation Batch 2 source validation failed: ${issues.rows.map((row) => row.issue).join(", ")}`
    );
  }
  await forEachIdChunk<MessageValidationRow>(
    database,
    `SELECT source.id::text AS source_id, source.role, source.content,
            source."thinkingContent" AS thinking_content, source."encKeyVersion" AS enc_key_version,
            source."responseJson" AS response_json, source."toolCalls" AS tool_calls
       FROM cutover_legacy."PlatosAgentMessage" source
      WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      for (const row of rows) {
        const evidence = normalizeBatch2MessageEvidence({
          sourceId: row.source_id,
          role: row.role,
          content: row.content,
          thinkingContent: row.thinking_content,
          encKeyVersion: row.enc_key_version,
          responseJson: row.response_json,
          toolCalls: row.tool_calls,
        }, messageKeys);
        const expected = evidence.role === "assistant"
          ? [batch2StepSuffix(0), ...evidence.toolCalls.map((call) => batch2ToolCallSuffix(call.ordinal))]
          : [];
        const mappings = await database.query<{ stable_suffix: string }>(`
          SELECT stable_suffix FROM cutover_legacy.cutover_id_map
           WHERE mapping_version=1 AND source_model='PlatosAgentMessage' AND source_id=$1
             AND target_model IN ('Step','ToolCall')
           ORDER BY stable_suffix`, [row.source_id]);
        const actual = mappings.rows.map((mapping) => mapping.stable_suffix).sort();
        const sortedExpected = [...expected].sort();
        if (actual.length !== sortedExpected.length || actual.some((suffix, index) => suffix !== sortedExpected[index])) {
          throw batch2Failure(
            "BATCH2_SOURCE_OR_MAPPING_INVALID",
            "message child ordinal mappings do not match normalized evidence"
          );
        }
      }
    },
    chunkSize
  );
}

interface EndUserRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  organization_id: string;
  display_name: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function backfillBatch2EndUsers(database: CutoverDatabase, chunkSize = CUTOVER_CHUNK_SIZE): Promise<void> {
  await forEachIdChunk<EndUserRow>(database, `
    SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
           organization_map.target_id::text AS organization_id, source."displayName" AS display_name,
           source."createdAt" AS created_at, source."updatedAt" AS updated_at
      FROM cutover_legacy."PlatosEndUser" source
      JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version=1
       AND target_map.source_model='PlatosEndUser' AND target_map.source_id=source.id
       AND target_map.target_model='EndUser' AND target_map.stable_suffix=''
      JOIN cutover_legacy.cutover_id_map organization_map ON organization_map.mapping_version=1
       AND organization_map.source_model='Organization' AND organization_map.source_id=source."organizationId"
       AND organization_map.target_model='Organization' AND organization_map.stable_suffix=''
     WHERE source.id > $1 ORDER BY source.id LIMIT $2`, async (rows) => {
    await database.query(`INSERT INTO public."EndUser"
      (id, "organizationId", "displayName", "createdAt", "updatedAt")
      VALUES ${parameterTuples(rows.length, 5)}`, rows.flatMap((row) => [
      row.target_id, row.organization_id, row.display_name, row.created_at, row.updated_at,
    ]));
  }, chunkSize);
}

interface IdentityRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  end_user_id: string;
  organization_id: string;
  channel: string;
  handle: string;
  end_user_metadata: unknown;
  identity_metadata: unknown;
  created_at: Date;
  updated_at: Date;
}

export async function backfillBatch2EndUserIdentities(database: CutoverDatabase, chunkSize = CUTOVER_CHUNK_SIZE): Promise<void> {
  await forEachIdChunk<IdentityRow>(database, `
    SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
           end_user_map.target_id::text AS end_user_id, organization_map.target_id::text AS organization_id,
           source.channel, source.handle, end_user.metadata AS end_user_metadata,
           source.metadata AS identity_metadata, source."createdAt" AS created_at, source."updatedAt" AS updated_at
      FROM cutover_legacy."PlatosEndUserIdentity" source
      JOIN cutover_legacy."PlatosEndUser" end_user ON end_user.id=source."platosEndUserId"
      JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version=1
       AND target_map.source_model='PlatosEndUserIdentity' AND target_map.source_id=source.id
       AND target_map.target_model='EndUserIdentity' AND target_map.stable_suffix=''
      JOIN cutover_legacy.cutover_id_map end_user_map ON end_user_map.mapping_version=1
       AND end_user_map.source_model='PlatosEndUser' AND end_user_map.source_id=source."platosEndUserId"
       AND end_user_map.target_model='EndUser' AND end_user_map.stable_suffix=''
      JOIN cutover_legacy.cutover_id_map organization_map ON organization_map.mapping_version=1
       AND organization_map.source_model='Organization' AND organization_map.source_id=source."organizationId"
       AND organization_map.target_model='Organization' AND organization_map.stable_suffix=''
     WHERE source.id > $1 ORDER BY source.id LIMIT $2`, async (rows) => {
    await database.query(`INSERT INTO public."EndUserIdentity"
      (id, "endUserId", "organizationId", issuer, channel, subject, profile, "createdAt", "updatedAt")
      VALUES ${parameterTuples(rows.length, 9)}`, rows.flatMap((row) => {
      const profile = mergeBatch2IdentityProfiles(row.end_user_metadata, row.identity_metadata);
      return [row.target_id, row.end_user_id, row.organization_id, row.channel, row.channel, row.handle,
        profile === null ? null : JSON.stringify(profile), row.created_at, row.updated_at];
    }));
  }, chunkSize);
}

interface ThreadRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  parent_depth: number | string;
  environment_id: string;
  agent_id: string;
  end_user_id: string;
  parent_thread_id: string | null;
  title: string | null;
  status: unknown;
  compacted_at: Date | null;
  session_context: unknown;
  tags: string[];
  pinned_at: Date | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Parent depth + source id form the stable keyset, so children never precede parents. */
export async function backfillBatch2Threads(database: CutoverDatabase, chunkSize = CUTOVER_CHUNK_SIZE): Promise<void> {
  assertChunkSize(chunkSize);
  let depthCursor = -1;
  let idCursor = "";
  while (true) {
    const result = await database.query<ThreadRow>(`
      WITH RECURSIVE ranked AS (
        SELECT source.*, 0 AS parent_depth FROM cutover_legacy."PlatosAgentThread" source WHERE source."parentThreadId" IS NULL
        UNION ALL
        SELECT child.*, ranked.parent_depth + 1 FROM cutover_legacy."PlatosAgentThread" child
        JOIN ranked ON ranked.id=child."parentThreadId")
      SELECT source.id::text AS source_id, target_map.target_id::text AS target_id, source.parent_depth,
             environment_map.target_id::text AS environment_id, agent_map.target_id::text AS agent_id,
             end_user_map.target_id::text AS end_user_id, parent_map.target_id::text AS parent_thread_id,
             source.title, source.status, source."compactedAt" AS compacted_at,
             source."sessionContext" AS session_context, source.tags, source."pinnedAt" AS pinned_at,
             source."archivedAt" AS archived_at, source."createdAt" AS created_at, source."updatedAt" AS updated_at
        FROM ranked source
        JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version=1
         AND target_map.source_model='PlatosAgentThread' AND target_map.source_id=source.id AND target_map.target_model='Thread'
        JOIN cutover_legacy.cutover_id_map environment_map ON environment_map.mapping_version=1
         AND environment_map.source_model='RuntimeEnvironment' AND environment_map.source_id=source."environmentId"
         AND environment_map.target_model='Environment'
        JOIN cutover_legacy.cutover_id_map agent_map ON agent_map.mapping_version=1
         AND agent_map.source_model='PlatosAgent' AND agent_map.source_id=source."agentId" AND agent_map.target_model='Agent'
        JOIN cutover_legacy.cutover_id_map end_user_map ON end_user_map.mapping_version=1
         AND end_user_map.source_model='PlatosEndUser' AND end_user_map.source_id=source."platosEndUserId"
         AND end_user_map.target_model='EndUser'
        LEFT JOIN cutover_legacy.cutover_id_map parent_map ON parent_map.mapping_version=1
         AND parent_map.source_model='PlatosAgentThread' AND parent_map.source_id=source."parentThreadId"
         AND parent_map.target_model='Thread'
       WHERE (source.parent_depth, source.id) > ($1::integer, $2::text)
       ORDER BY source.parent_depth, source.id LIMIT $3`, [depthCursor, idCursor, chunkSize]);
    if (result.rows.length === 0) return;
    await database.query(`INSERT INTO public."Thread"
      (id, "environmentId", "agentId", "endUserId", "parentThreadId", title, status,
       "compactedAt", "sessionContext", tags, "pinnedAt", "archivedAt", "createdAt", "updatedAt")
      VALUES ${parameterTuples(result.rows.length, 14)}`, result.rows.flatMap((row) => [
      row.target_id, row.environment_id, row.agent_id, row.end_user_id, row.parent_thread_id,
      row.title, normalizeThreadStatus(row.status), row.compacted_at,
      normalizedOptionalJson("Thread.sessionContext", row.session_context), row.tags,
      row.pinned_at, row.archived_at, row.created_at, row.updated_at,
    ]));
    const last = result.rows.at(-1)!;
    const nextDepth = Number(last.parent_depth);
    if (!Number.isSafeInteger(nextDepth) || nextDepth < depthCursor ||
        (nextDepth === depthCursor && last.source_id <= idCursor)) {
      throw batch2Failure("BATCH2_THREAD_ORDER_INVALID", "thread parent-first keyset is not stable");
    }
    depthCursor = nextDepth;
    idCursor = last.source_id;
  }
}

interface MessageRow extends MessageValidationRow {
  target_id: string;
  thread_id: string;
  locked_agent_version_id: string | null;
  response_agent_version_id: string | null;
  sequence: number | string;
  status: unknown;
  created_at: Date;
  step_id: string | null;
}

export async function backfillBatch2Messages(
  database: CutoverDatabase,
  messageKeys: Readonly<Record<string, string>>,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<void> {
  await forEachIdChunk<MessageRow>(database, `
    WITH ranked AS (
      SELECT message.*,
             row_number() OVER (
               PARTITION BY message."threadId" ORDER BY message."createdAt", message.id
             )::text AS cutover_sequence
        FROM cutover_legacy."PlatosAgentMessage" message
    )
    SELECT source.id::text AS source_id, turn_map.target_id::text AS target_id,
           thread_map.target_id::text AS thread_id, source.role, source.content,
           source."thinkingContent" AS thinking_content, source."encKeyVersion" AS enc_key_version,
           source."responseJson" AS response_json, source."toolCalls" AS tool_calls,
           locked_version_map.target_id::text AS locked_agent_version_id,
           response_version_map.target_id::text AS response_agent_version_id,
           source.cutover_sequence AS sequence,
           source.status, source."createdAt" AS created_at, step_map.target_id::text AS step_id
      FROM ranked source
      JOIN cutover_legacy."PlatosAgentThread" thread ON thread.id=source."threadId"
      JOIN cutover_legacy.cutover_id_map turn_map ON turn_map.mapping_version=1
       AND turn_map.source_model='PlatosAgentMessage' AND turn_map.source_id=source.id AND turn_map.target_model='Turn'
      JOIN cutover_legacy.cutover_id_map thread_map ON thread_map.mapping_version=1
       AND thread_map.source_model='PlatosAgentThread' AND thread_map.source_id=source."threadId" AND thread_map.target_model='Thread'
      LEFT JOIN cutover_legacy.cutover_id_map locked_version_map ON locked_version_map.mapping_version=1
       AND locked_version_map.source_model='PlatosAgentVersion' AND locked_version_map.source_id=thread."lockedVersionId"
       AND locked_version_map.target_model='AgentVersion'
      LEFT JOIN cutover_legacy.cutover_id_map response_version_map ON response_version_map.mapping_version=1
       AND response_version_map.source_model='PlatosAgentVersion'
       AND response_version_map.source_id=CASE WHEN jsonb_typeof(source."responseJson")='object' THEN source."responseJson"->>'version_id' END
       AND response_version_map.target_model='AgentVersion'
      LEFT JOIN cutover_legacy.cutover_id_map step_map ON step_map.mapping_version=1
       AND step_map.source_model='PlatosAgentMessage' AND step_map.source_id=source.id
       AND step_map.target_model='Step' AND step_map.stable_suffix='step:0'
     WHERE source.id > $1 ORDER BY source.id LIMIT $2`, async (rows) => {
    const normalized = rows.map((row) => ({
      row,
      evidence: normalizeBatch2MessageEvidence({
        sourceId: row.source_id,
        role: row.role,
        content: row.content,
        thinkingContent: row.thinking_content,
        encKeyVersion: row.enc_key_version,
        responseJson: row.response_json,
        toolCalls: row.tool_calls,
      }, messageKeys),
    }));
    await database.query(`INSERT INTO public."Turn"
      (id, "threadId", "agentVersionId", "versionBucket", sequence, "inputText", "outputText",
       "thinkingContent", status, "costCents", "latencyMs", "createdAt")
      VALUES ${parameterTuples(rows.length, 12)}`, normalized.flatMap(({ row, evidence }) => {
      const response = evidence.response;
      if (response && row.response_agent_version_id === null) {
        throw batch2Failure("BATCH2_SOURCE_OR_MAPPING_INVALID", "assistant AgentVersion mapping is missing");
      }
      if (!response && row.locked_agent_version_id === null) {
        throw batch2Failure("BATCH2_SOURCE_OR_MAPPING_INVALID", "user AgentVersion mapping is missing");
      }
      return [row.target_id, row.thread_id,
        response ? row.response_agent_version_id : row.locked_agent_version_id,
        response?.versionBucket ?? "CURRENT", positiveInteger(row.sequence, "Turn.sequence"),
        evidence.inputText, evidence.outputText, evidence.thinkingContent,
        normalizeMessageStatus(row.status), response?.costCents ?? null, response?.latencyMs ?? null,
        row.created_at];
    }));

    const assistantRows = normalized.filter(({ evidence }) => evidence.role === "assistant");
    if (assistantRows.length > 0) {
      await database.query(`INSERT INTO public."Step"
        (id, "turnId", sequence, model, status, "inputTokens", "outputTokens",
         "cacheCreationInputTokens", "cacheReadInputTokens", "reasoningTokens",
         "costCents", "latencyMs", "createdAt")
        VALUES ${parameterTuples(assistantRows.length, 13)}`, assistantRows.flatMap(({ row, evidence }) => {
        if (row.step_id === null || evidence.response === null) {
          throw batch2Failure("BATCH2_SOURCE_OR_MAPPING_INVALID", "assistant Step mapping is missing");
        }
        const response = evidence.response;
        return [row.step_id, row.target_id, 1, response.model, normalizeMessageStatus(row.status),
          response.inputTokens, response.outputTokens, response.cacheCreationInputTokens,
          response.cacheReadInputTokens, response.reasoningTokens, response.costCents,
          response.latencyMs, row.created_at];
      }));
    }

    const calls = assistantRows.flatMap(({ row, evidence }) => evidence.toolCalls.map((call) => ({ row, call })));
    if (calls.length > 0) {
      const mapRows = await database.query<{ source_id: string; stable_suffix: string; target_id: string }>(`
        SELECT source_id, stable_suffix, target_id::text AS target_id
          FROM cutover_legacy.cutover_id_map
         WHERE mapping_version=1 AND source_model='PlatosAgentMessage' AND target_model='ToolCall'
           AND source_id = ANY($1::text[])`, [Array.from(new Set(calls.map(({ row }) => row.source_id)))]);
      const callIds = new Map(mapRows.rows.map((map) => [`${map.source_id}:${map.stable_suffix}`, map.target_id]));
      await database.query(`INSERT INTO public."ToolCall"
        (id, "stepId", sequence, "toolName", arguments, result, status, "createdAt")
        VALUES ${parameterTuples(calls.length, 8)}`, calls.flatMap(({ row, call }) => {
        const id = callIds.get(`${row.source_id}:${batch2ToolCallSuffix(call.ordinal)}`);
        if (!id || row.step_id === null) {
          throw batch2Failure("BATCH2_SOURCE_OR_MAPPING_INVALID", "tool-call ordinal mapping is missing");
        }
        // SQL NULL, not JSON null: the post-cutover shape check requires
        // result to be an object or array when present, and jsonb 'null'
        // would fail it.
        return [id, row.step_id, call.ordinal + 1, call.toolName, JSON.stringify(call.arguments),
          call.result === null ? null : JSON.stringify(call.result), call.status, row.created_at];
      }));
    }
  }, chunkSize);
}

interface ArtifactRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  environment_id: string;
  thread_id: string;
  artifact_key: string;
  revision: number;
  kind: string;
  title: string | null;
  content: string;
  metadata: unknown;
  created_by: string;
  created_at: Date;
}

export async function backfillBatch2Artifacts(database: CutoverDatabase, chunkSize = CUTOVER_CHUNK_SIZE): Promise<void> {
  await forEachIdChunk<ArtifactRow>(database, `
    SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
           environment_map.target_id::text AS environment_id, thread_map.target_id::text AS thread_id,
           source."artifactKey" AS artifact_key, source.revision, source.kind, source.title,
           source.content, source.metadata, source."createdBy" AS created_by, source."createdAt" AS created_at
      FROM cutover_legacy."PlatosAgentArtifact" source
      JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version=1
       AND target_map.source_model='PlatosAgentArtifact' AND target_map.source_id=source.id AND target_map.target_model='Artifact'
      JOIN cutover_legacy.cutover_id_map environment_map ON environment_map.mapping_version=1
       AND environment_map.source_model='RuntimeEnvironment' AND environment_map.source_id=source."environmentId"
       AND environment_map.target_model='Environment'
      JOIN cutover_legacy.cutover_id_map thread_map ON thread_map.mapping_version=1
       AND thread_map.source_model='PlatosAgentThread' AND thread_map.source_id=source."threadId" AND thread_map.target_model='Thread'
     WHERE source.id > $1 ORDER BY source.id LIMIT $2`, async (rows) => {
    await database.query(`INSERT INTO public."Artifact"
      (id, "environmentId", "threadId", "artifactKey", revision, kind, title, content, metadata, "createdBy", "createdAt")
      VALUES ${parameterTuples(rows.length, 11)}`, rows.flatMap((row) => [
      row.target_id, row.environment_id, row.thread_id, row.artifact_key, row.revision, row.kind,
      row.title, row.content, normalizedOptionalJson("Artifact.metadata", row.metadata), row.created_by, row.created_at,
    ]));
  }, chunkSize);
}

interface AttachmentRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  environment_id: string;
  end_user_id: string;
  kind: string;
  mime_type: string;
  bytes: number;
  width: number | null;
  height: number | null;
  duration_sec: number | null;
  storage_key: string;
  original_name: string | null;
  content_hash: string | null;
  created_at: Date;
  expires_at: Date | null;
}

export async function backfillBatch2MessageAttachments(database: CutoverDatabase, chunkSize = CUTOVER_CHUNK_SIZE): Promise<void> {
  await forEachIdChunk<AttachmentRow>(database, `
    SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
           environment_map.target_id::text AS environment_id, end_user_map.target_id::text AS end_user_id,
           source.kind, source."mimeType" AS mime_type, source.bytes, source.width, source.height,
           source."durationSec" AS duration_sec, source."storageKey" AS storage_key,
           source."originalName" AS original_name, source."contentHash" AS content_hash,
           source."createdAt" AS created_at, source."expiresAt" AS expires_at
      FROM cutover_legacy."PlatosMessageAttachment" source
      JOIN cutover_legacy."PlatosEndUser" end_user ON end_user."organizationId"=source."organizationId"
       AND end_user."environmentId"=source."environmentId"
       AND source."uploadedBy" IN (end_user.id, end_user."externalUserId", end_user."linkedExternalId")
      JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version=1
       AND target_map.source_model='PlatosMessageAttachment' AND target_map.source_id=source.id
       AND target_map.target_model='MessageAttachment'
      JOIN cutover_legacy.cutover_id_map environment_map ON environment_map.mapping_version=1
       AND environment_map.source_model='RuntimeEnvironment' AND environment_map.source_id=source."environmentId"
       AND environment_map.target_model='Environment'
      JOIN cutover_legacy.cutover_id_map end_user_map ON end_user_map.mapping_version=1
       AND end_user_map.source_model='PlatosEndUser' AND end_user_map.source_id=end_user.id
       AND end_user_map.target_model='EndUser'
     WHERE source.id > $1 ORDER BY source.id LIMIT $2`, async (rows) => {
    await database.query(`INSERT INTO public."MessageAttachment"
      (id, "environmentId", "endUserId", kind, "mimeType", bytes, width, height, "durationSec",
       "storageKey", "originalName", "contentHash", "createdAt", "expiresAt")
      VALUES ${parameterTuples(rows.length, 14)}`, rows.flatMap((row) => [
      row.target_id, row.environment_id, row.end_user_id, row.kind, row.mime_type, row.bytes,
      row.width, row.height, row.duration_sec,
      // Object-store keys are opaque identifiers. Never decode, normalize, or rebuild them.
      row.storage_key,
      row.original_name, row.content_hash, row.created_at, row.expires_at,
    ]));
  }, chunkSize);
}

interface PostmanRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  environment_id: string;
  agent_id: string;
  name: string;
  simulate_user_id: string;
  session_context: unknown;
  created_by: string;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
}

export async function backfillBatch2PostmanTemplates(database: CutoverDatabase, chunkSize = CUTOVER_CHUNK_SIZE): Promise<void> {
  await forEachIdChunk<PostmanRow>(database, `
    SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
           environment_map.target_id::text AS environment_id, agent_map.target_id::text AS agent_id,
           source.name, source."simulateUserId" AS simulate_user_id,
           source."sessionContext" AS session_context, source."createdBy" AS created_by,
           source."isDefault" AS is_default, source."createdAt" AS created_at, source."updatedAt" AS updated_at
      FROM cutover_legacy."PlatosPostmanTemplate" source
      JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version=1
       AND target_map.source_model='PlatosPostmanTemplate' AND target_map.source_id=source.id
       AND target_map.target_model='PostmanTemplate'
      JOIN cutover_legacy.cutover_id_map environment_map ON environment_map.mapping_version=1
       AND environment_map.source_model='RuntimeEnvironment' AND environment_map.source_id=source."environmentId"
       AND environment_map.target_model='Environment'
      JOIN cutover_legacy.cutover_id_map agent_map ON agent_map.mapping_version=1
       AND agent_map.source_model='PlatosAgent' AND agent_map.source_id=source."agentId" AND agent_map.target_model='Agent'
     WHERE source.id > $1 ORDER BY source.id LIMIT $2`, async (rows) => {
    await database.query(`INSERT INTO public."PostmanTemplate"
      (id, "environmentId", "agentId", name, "simulateUserId", "sessionContext", "createdBy",
       "isDefault", "createdAt", "updatedAt") VALUES ${parameterTuples(rows.length, 10)}`,
      rows.flatMap((row) => [row.target_id, row.environment_id, row.agent_id, row.name,
        row.simulate_user_id, normalizedOptionalJson("PostmanTemplate.sessionContext", row.session_context),
        row.created_by, row.is_default, row.created_at, row.updated_at]));
  }, chunkSize);
}

export async function backfillRetainedConversationBatch2(
  database: CutoverDatabase,
  messageKeys: Readonly<Record<string, string>>,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<void> {
  await materializeBatch2MessageOrdinalMappings(database, chunkSize);
  await validateRetainedConversationBatch2Source(database, messageKeys, chunkSize);
  await backfillBatch2EndUsers(database, chunkSize);
  await backfillBatch2EndUserIdentities(database, chunkSize);
  await backfillBatch2PostmanTemplates(database, chunkSize);
  await backfillBatch2Threads(database, chunkSize);
  await backfillBatch2Messages(database, messageKeys, chunkSize);
  await backfillBatch2Artifacts(database, chunkSize);
  await backfillBatch2MessageAttachments(database, chunkSize);
}

const conservationValidationSql = `
  WITH equations(id, source_count, target_count) AS (
    VALUES
      ('end-users', (SELECT count(*) FROM cutover_legacy."PlatosEndUser"),
       (SELECT count(*) FROM public."EndUser" target JOIN cutover_legacy.cutover_id_map map
         ON map.source_model='PlatosEndUser' AND map.target_model='EndUser' AND map.target_id=target.id)),
      ('identities', (SELECT count(*) FROM cutover_legacy."PlatosEndUserIdentity"),
       (SELECT count(*) FROM public."EndUserIdentity" target JOIN cutover_legacy.cutover_id_map map
         ON map.source_model='PlatosEndUserIdentity' AND map.target_model='EndUserIdentity' AND map.target_id=target.id)),
      ('threads', (SELECT count(*) FROM cutover_legacy."PlatosAgentThread"),
       (SELECT count(*) FROM public."Thread" target JOIN cutover_legacy.cutover_id_map map
         ON map.source_model='PlatosAgentThread' AND map.target_model='Thread' AND map.target_id=target.id)),
      ('turns', (SELECT count(*) FROM cutover_legacy."PlatosAgentMessage"),
       (SELECT count(*) FROM public."Turn" target JOIN cutover_legacy.cutover_id_map map
         ON map.source_model='PlatosAgentMessage' AND map.target_model='Turn' AND map.target_id=target.id)),
      ('steps', (SELECT count(*) FROM cutover_legacy."PlatosAgentMessage" WHERE role='assistant'),
       (SELECT count(*) FROM public."Step" target JOIN cutover_legacy.cutover_id_map map
         ON map.source_model='PlatosAgentMessage' AND map.target_model='Step' AND map.target_id=target.id)),
      ('tool-calls', (SELECT count(*) FROM cutover_legacy.cutover_id_map WHERE mapping_version=1
         AND source_model='PlatosAgentMessage' AND target_model='ToolCall'),
       (SELECT count(*) FROM public."ToolCall" target JOIN cutover_legacy.cutover_id_map map
         ON map.source_model='PlatosAgentMessage' AND map.target_model='ToolCall' AND map.target_id=target.id)),
      ('artifacts', (SELECT count(*) FROM cutover_legacy."PlatosAgentArtifact"),
       (SELECT count(*) FROM public."Artifact" target JOIN cutover_legacy.cutover_id_map map
         ON map.source_model='PlatosAgentArtifact' AND map.target_model='Artifact' AND map.target_id=target.id)),
      ('attachments', (SELECT count(*) FROM cutover_legacy."PlatosMessageAttachment"),
       (SELECT count(*) FROM public."MessageAttachment" target JOIN cutover_legacy.cutover_id_map map
         ON map.source_model='PlatosMessageAttachment' AND map.target_model='MessageAttachment' AND map.target_id=target.id)),
      ('postman-templates', (SELECT count(*) FROM cutover_legacy."PlatosPostmanTemplate"),
       (SELECT count(*) FROM public."PostmanTemplate" target JOIN cutover_legacy.cutover_id_map map
         ON map.source_model='PlatosPostmanTemplate' AND map.target_model='PostmanTemplate' AND map.target_id=target.id))
  ) SELECT id FROM equations WHERE source_count<>target_count ORDER BY id`;

const ancestryValidationSql = `
  WITH issues AS (
    SELECT 'identity' AS issue FROM public."EndUserIdentity" identity
      JOIN public."EndUser" end_user ON end_user.id=identity."endUserId"
      WHERE identity."organizationId"<>end_user."organizationId"
    UNION ALL
    SELECT 'thread' FROM public."Thread" thread
      JOIN public."Environment" environment ON environment.id=thread."environmentId"
      JOIN public."Agent" agent ON agent.id=thread."agentId"
      JOIN public."EndUser" end_user ON end_user.id=thread."endUserId"
      JOIN public."Project" project ON project.id=environment."projectId"
      WHERE agent."projectId"<>project.id OR end_user."organizationId"<>project."organizationId"
    UNION ALL
    SELECT 'thread-parent' FROM public."Thread" child JOIN public."Thread" parent ON parent.id=child."parentThreadId"
      WHERE child."environmentId"<>parent."environmentId"
    UNION ALL
    SELECT 'turn' FROM public."Turn" turn JOIN public."Thread" thread ON thread.id=turn."threadId"
      JOIN public."AgentVersion" version ON version.id=turn."agentVersionId"
      WHERE version."agentId"<>thread."agentId"
    UNION ALL
    SELECT 'step' FROM public."Step" step LEFT JOIN public."Turn" turn ON turn.id=step."turnId" WHERE turn.id IS NULL
    UNION ALL
    SELECT 'tool-call' FROM public."ToolCall" call LEFT JOIN public."Step" step ON step.id=call."stepId" WHERE step.id IS NULL
    UNION ALL
    SELECT 'artifact' FROM public."Artifact" artifact JOIN public."Thread" thread ON thread.id=artifact."threadId"
      WHERE artifact."environmentId"<>thread."environmentId"
  ) SELECT DISTINCT issue FROM issues ORDER BY issue`;

const jsonValidationSql = `
  WITH issues AS (
    SELECT 'identity-profile' AS issue FROM public."EndUserIdentity" target
      JOIN cutover_legacy.cutover_id_map map ON map.target_model='EndUserIdentity' AND map.target_id=target.id
      WHERE target.profile IS NOT NULL AND jsonb_typeof(target.profile)<>'object'
    UNION ALL
    SELECT 'thread-session-context' FROM public."Thread" target
      JOIN cutover_legacy.cutover_id_map map ON map.target_model='Thread' AND map.target_id=target.id
      WHERE target."sessionContext" IS NOT NULL AND jsonb_typeof(target."sessionContext")<>'object'
    UNION ALL
    SELECT 'tool-call-json' FROM public."ToolCall" target
      JOIN cutover_legacy.cutover_id_map map ON map.target_model='ToolCall' AND map.target_id=target.id
      WHERE jsonb_typeof(target.arguments)<>'object' OR jsonb_typeof(target.result) NOT IN ('object','array')
    UNION ALL
    SELECT 'artifact-metadata' FROM public."Artifact" target
      JOIN cutover_legacy.cutover_id_map map ON map.target_model='Artifact' AND map.target_id=target.id
      WHERE target.metadata IS NOT NULL AND jsonb_typeof(target.metadata)<>'object'
    UNION ALL
    SELECT 'postman-session-context' FROM public."PostmanTemplate" target
      JOIN cutover_legacy.cutover_id_map map ON map.target_model='PostmanTemplate' AND map.target_id=target.id
      WHERE target."sessionContext" IS NOT NULL AND jsonb_typeof(target."sessionContext")<>'object'
  ) SELECT DISTINCT issue FROM issues ORDER BY issue`;

async function assertValidationQuery(database: CutoverDatabase, sql: string, code: string, summary: string): Promise<void> {
  const result = await database.query<{ id?: string; issue?: string }>(sql);
  if (result.rows.length > 0) {
    throw batch2Failure(code, `${summary}: ${result.rows.map((row) => row.id ?? row.issue ?? "unknown").join(", ")}`);
  }
}

export async function validateRetainedConversationBatch2(database: CutoverDatabase): Promise<void> {
  await assertValidationQuery(database, conservationValidationSql, "BATCH2_CONSERVATION_FAILED", "conversation Batch 2 conservation failed");
  await assertValidationQuery(database, ancestryValidationSql, "BATCH2_ANCESTRY_FAILED", "conversation Batch 2 ancestry failed");
  await assertValidationQuery(database, jsonValidationSql, "BATCH2_JSON_VALIDATION_FAILED", "conversation Batch 2 JSON validation failed");
}

function batch2Failure(code: string, message: string): CutoverFailure {
  return new CutoverFailure(code, message);
}
