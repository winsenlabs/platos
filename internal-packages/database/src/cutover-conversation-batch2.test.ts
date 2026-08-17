import { createCipheriv } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  backfillBatch2MessageAttachments,
  backfillBatch2Threads,
  batch2StepSuffix,
  batch2ToolCallSuffix,
  materializeBatch2MessageOrdinalMappings,
  mergeBatch2IdentityProfiles,
  normalizeBatch2MessageEvidence,
  normalizeBatch2ResponseJson,
  normalizeBatch2ToolCalls,
  retainedConversationBatch2MappingTargets,
  retainedConversationBatch2SourceModels,
  validateRetainedConversationBatch2,
} from "./cutover-conversation-batch2";
import type { CutoverDatabase, QueryResultLike } from "./cutover-types";

const TEST_MESSAGE_KEY = "11".repeat(32);

function encryptLegacyMessage(value: string, ivByte = 0x22): string {
  const iv = Buffer.alloc(16, ivByte);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(TEST_MESSAGE_KEY, "hex"), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

describe("retained conversation cutover Batch 2", () => {
  test("pins the exact source mappings and zero-based ordinal suffix grammar", () => {
    expect(retainedConversationBatch2SourceModels).toEqual([
      "PlatosEndUser",
      "PlatosEndUserIdentity",
      "PlatosAgentThread",
      "PlatosAgentMessage",
      "PlatosAgentArtifact",
      "PlatosMessageAttachment",
      "PlatosPostmanTemplate",
    ]);
    expect(retainedConversationBatch2MappingTargets).toEqual([
      { sourceModel: "PlatosEndUser", targetModel: "EndUser", stableSuffix: "" },
      { sourceModel: "PlatosEndUserIdentity", targetModel: "EndUserIdentity", stableSuffix: "" },
      { sourceModel: "PlatosAgentThread", targetModel: "Thread", stableSuffix: "" },
      { sourceModel: "PlatosAgentMessage", targetModel: "Turn", stableSuffix: "" },
      { sourceModel: "PlatosAgentMessage", targetModel: "Step", stableSuffix: "step:<ordinal>" },
      { sourceModel: "PlatosAgentMessage", targetModel: "ToolCall", stableSuffix: "tool-call:<ordinal>" },
      { sourceModel: "PlatosAgentArtifact", targetModel: "Artifact", stableSuffix: "" },
      { sourceModel: "PlatosMessageAttachment", targetModel: "MessageAttachment", stableSuffix: "" },
      { sourceModel: "PlatosPostmanTemplate", targetModel: "PostmanTemplate", stableSuffix: "" },
    ]);
    expect(batch2StepSuffix(0)).toBe("step:0");
    expect(batch2ToolCallSuffix(27)).toBe("tool-call:27");
    expect(() => batch2StepSuffix(-1)).toThrow("non-negative safe integer");
  });

  test("normalizes call/result event logs without discarding arguments or results", () => {
    expect(normalizeBatch2ToolCalls([
      { type: "call", name: "lookup", params: { id: 1 }, callId: "call-a" },
      { type: "result", name: "lookup", result: "found", callId: "call-a" },
      { type: "call", name: "save", params: { value: true } },
      { type: "result", name: "save", result: [{ id: 2 }] },
    ])).toEqual([
      {
        ordinal: 0,
        toolName: "lookup",
        arguments: { id: 1 },
        result: { value: "found" },
        status: "SUCCEEDED",
      },
      {
        ordinal: 1,
        toolName: "save",
        arguments: { value: true },
        result: [{ id: 2 }],
        status: "SUCCEEDED",
      },
    ]);
  });

  test("accepts the older combined tool-call shape and blocks ambiguous variants", () => {
    expect(normalizeBatch2ToolCalls([
      { name: "lookup", params: { id: 1 }, result: { found: true }, actionId: "exported" },
    ])).toEqual([
      {
        ordinal: 0,
        toolName: "lookup",
        arguments: { id: 1 },
        result: { found: true },
        status: "SUCCEEDED",
      },
    ]);
    expect(() => normalizeBatch2ToolCalls([
      { type: "call", name: "lookup", params: {} },
      { name: "lookup", params: {}, result: {} },
    ])).toThrow("cannot mix event and combined shapes");
    expect(() => normalizeBatch2ToolCalls([
      { type: "call", name: "lookup", params: {} },
      { type: "call", name: "lookup", params: {} },
      { type: "result", name: "lookup", result: {} },
    ])).toThrow("exactly one unresolved call");
    expect(() => normalizeBatch2ToolCalls([
      { type: "call", name: "lookup", params: {} },
    ])).toThrow("no matching result");
  });

  test("normalizes mapped response evidence and rejects aliases that could disagree", () => {
    expect(normalizeBatch2ResponseJson({
      model: "anthropic:test",
      version_id: "version-1",
      version_bucket: "canary",
      usage: { inputTokens: 10, outputTokens: 4, reasoningTokens: 2 },
      cost_cents: 2,
      cost_with_cache_cents: 1.5,
      latency_ms: 321,
      trace_id: "export-only",
    })).toEqual({
      model: "anthropic:test",
      versionSourceId: "version-1",
      versionBucket: "CANARY",
      inputTokens: 10,
      outputTokens: 4,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      reasoningTokens: 2,
      costCents: 1.5,
      latencyMs: 321,
    });
    expect(() => normalizeBatch2ResponseJson({
      model: "anthropic:test",
      version_id: "version-1",
      versionId: "version-2",
      version_bucket: "current",
    })).toThrow("unsupported mapped-field alias");
    expect(() => normalizeBatch2ResponseJson({
      model: "anthropic:test",
      version_id: "version-1",
      version_bucket: "current",
      usage: { inputTokens: -1 },
    })).toThrow("non-negative integer");
  });

  test("strictly decodes recognized encrypted messages under the supplied key ring", () => {
    const normalized = normalizeBatch2MessageEvidence({
      sourceId: "message-1",
      role: "assistant",
      content: encryptLegacyMessage("answer", 0x22),
      thinkingContent: encryptLegacyMessage("reasoning", 0x33),
      encKeyVersion: 1,
      responseJson: {
        model: "anthropic:test",
        version_id: "version-1",
        version_bucket: "current",
      },
      toolCalls: [],
    }, { "1": TEST_MESSAGE_KEY });
    expect(normalized).toMatchObject({
      role: "assistant",
      outputText: "answer",
      thinkingContent: "reasoning",
      response: { model: "anthropic:test", versionSourceId: "version-1" },
    });
    expect(normalizeBatch2MessageEvidence({
      sourceId: "message-2",
      role: "assistant",
      content: encryptLegacyMessage("answer", 0x44),
      thinkingContent: null,
      encKeyVersion: 1,
      responseJson: {
        model: "anthropic:test",
        version_id: "version-1",
        version_bucket: "current",
      },
      toolCalls: [],
    }, { "1": TEST_MESSAGE_KEY }).thinkingContent).toBeNull();
  });

  test("never falls back to ciphertext or a sentinel after envelope recognition", () => {
    const encrypted = encryptLegacyMessage("answer");
    const source = {
      sourceId: "message-1",
      role: "assistant",
      content: encrypted,
      thinkingContent: null,
      encKeyVersion: 1,
      responseJson: {
        model: "anthropic:test",
        version_id: "version-1",
        version_bucket: "current",
      },
      toolCalls: [],
    };
    expect(() => normalizeBatch2MessageEvidence(source, {})).toThrow("invalid_key");
    expect(() => normalizeBatch2MessageEvidence(source, { "1": "22".repeat(32) })).toThrow(
      "decryption_failed"
    );
    expect(() => normalizeBatch2MessageEvidence({ ...source, content: "plaintext-sentinel" }, {
      "1": TEST_MESSAGE_KEY,
    })).toThrow("malformed_envelope");
  });

  test("fails closed for unrepresentable message roles and user-side assistant evidence", () => {
    expect(() => normalizeBatch2MessageEvidence({
      sourceId: "message-tool",
      role: "tool",
      content: "result",
      thinkingContent: null,
      encKeyVersion: null,
      responseJson: null,
      toolCalls: null,
    }, {})).toThrow("tool-role rows cannot be represented");
    expect(() => normalizeBatch2MessageEvidence({
      sourceId: "message-user",
      role: "user",
      content: "input",
      thinkingContent: null,
      encKeyVersion: null,
      responseJson: { model: "ambiguous" },
      toolCalls: null,
    }, {})).toThrow("user message cannot carry assistant responseJson");
  });

  test("merges normalized profile evidence only when overlapping keys agree", () => {
    expect(mergeBatch2IdentityProfiles(
      { locale: "en", shared: { verified: true } },
      { timezone: "UTC", shared: { verified: true } }
    )).toEqual({ locale: "en", timezone: "UTC", shared: { verified: true } });
    expect(() => mergeBatch2IdentityProfiles(
      { locale: "en" },
      { locale: "fr" }
    )).toThrow("conflicting profile key");
    expect(() => mergeBatch2IdentityProfiles([], null)).toThrow("expected object root");
  });

  test("materializes only assistant step and tool-call ordinal mappings in bounded chunks", async () => {
    const queries: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const database: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<QueryResultLike<Row>> {
        queries.push({ sql, values });
        if (sql.includes('FROM cutover_legacy."PlatosAgentMessage"')) {
          const rows = values?.[0] === "" ? [
            {
              source_id: "message-a",
              role: "assistant",
              tool_calls: [
                { type: "call", name: "lookup", params: {} },
                { type: "result", name: "lookup", result: {} },
              ],
            },
            { source_id: "message-b", role: "user", tool_calls: null },
          ] : [];
          return { rows: rows as unknown as Row[], rowCount: rows.length };
        }
        return { rows: [], rowCount: 0 };
      },
    };

    await expect(materializeBatch2MessageOrdinalMappings(database, 2)).resolves.toBe(2);
    expect(queries[0]?.sql).toContain("DELETE FROM cutover_legacy.cutover_id_map");
    const insert = queries.find((query) => query.sql.includes("INSERT INTO cutover_legacy.cutover_id_map"))!;
    expect(insert.values).toEqual([
      "PlatosAgentMessage",
      "message-a",
      "Step",
      "step:0",
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      "PlatosAgentMessage",
      "message-a",
      "ToolCall",
      "tool-call:0",
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    ]);
    expect(queries.filter((query) => query.sql.includes("ORDER BY source.id LIMIT $2"))).toHaveLength(2);
  });

  test("backfills threads by ancestry depth rather than source-id order", async () => {
    const inserts: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const database: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<QueryResultLike<Row>> {
        if (sql.includes("WITH RECURSIVE ranked")) {
          const rows = values?.[0] === -1 ? [
            {
              source_id: "thread-z-parent", target_id: "00000000-0000-5000-8000-000000000001",
              parent_depth: 0, environment_id: "00000000-0000-5000-8000-000000000002",
              agent_id: "00000000-0000-5000-8000-000000000003",
              end_user_id: "00000000-0000-5000-8000-000000000004", parent_thread_id: null,
              title: "parent", status: "active", compacted_at: null, session_context: {}, tags: [],
              pinned_at: null, archived_at: null, created_at: new Date(0), updated_at: new Date(0),
            },
            {
              source_id: "thread-a-child", target_id: "00000000-0000-5000-8000-000000000005",
              parent_depth: 1, environment_id: "00000000-0000-5000-8000-000000000002",
              agent_id: "00000000-0000-5000-8000-000000000003",
              end_user_id: "00000000-0000-5000-8000-000000000004",
              parent_thread_id: "00000000-0000-5000-8000-000000000001",
              title: "child", status: "archived", compacted_at: null, session_context: null, tags: ["fork"],
              pinned_at: null, archived_at: new Date(1), created_at: new Date(1), updated_at: new Date(1),
            },
          ] : [];
          return { rows: rows as unknown as Row[], rowCount: rows.length };
        }
        if (sql.includes('INSERT INTO public."Thread"')) inserts.push({ sql, values });
        return { rows: [], rowCount: 2 };
      },
    };

    await backfillBatch2Threads(database, 2);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.values?.[0]).toBe("00000000-0000-5000-8000-000000000001");
    expect(inserts[0]?.values?.[14]).toBe("00000000-0000-5000-8000-000000000005");
    expect(inserts[0]?.values?.[18]).toBe("00000000-0000-5000-8000-000000000001");
  });

  test("copies opaque object storage keys byte-for-byte", async () => {
    const opaqueKey = "org//opaque/%2Fkey+must=remain?exact#fragment";
    let insertValues: readonly unknown[] | undefined;
    const database: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<QueryResultLike<Row>> {
        if (sql.includes('FROM cutover_legacy."PlatosMessageAttachment"')) {
          const rows = values?.[0] === "" ? [{
            source_id: "attachment-a", target_id: "00000000-0000-5000-8000-000000000001",
            environment_id: "00000000-0000-5000-8000-000000000002",
            end_user_id: "00000000-0000-5000-8000-000000000003", kind: "document",
            mime_type: "application/json", bytes: 10, width: null, height: null, duration_sec: null,
            storage_key: opaqueKey, original_name: "fixture.json", content_hash: null,
            created_at: new Date(0), expires_at: null,
          }] : [];
          return { rows: rows as unknown as Row[], rowCount: rows.length };
        }
        if (sql.includes('INSERT INTO public."MessageAttachment"')) insertValues = values;
        return { rows: [], rowCount: 1 };
      },
    };

    await backfillBatch2MessageAttachments(database, 1);
    expect(insertValues?.[9]).toBe(opaqueKey);
  });

  test("runs separate conservation, ancestry, and JSON validation gates", async () => {
    let call = 0;
    const database: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(): Promise<QueryResultLike<Row>> {
        call += 1;
        return call === 2
          ? { rows: [{ issue: "turn" }] as unknown as Row[], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      },
    };
    await expect(validateRetainedConversationBatch2(database)).rejects.toMatchObject({
      code: "BATCH2_ANCESTRY_FAILED",
    });
    expect(call).toBe(2);
  });
});
