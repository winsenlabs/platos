import { createCipheriv } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  backfillBatch6CredentialAudits,
  backfillBatch6ToolCallAudits,
  backfillRetainedOperationalBatch6,
  classifyBatch6JsonMessage,
  classifyNullableBatch6TextMessage,
  normalizeBatch6ApprovalStatus,
  normalizeBatch6CostCents,
  normalizeBatch6ErasureStatus,
  normalizeBatch6ToolCallStatus,
  retainedOperationalBatch6AppendOnlyTargets,
  retainedOperationalBatch6DeferredTargetChecks,
  retainedOperationalBatch6MappingTargets,
  retainedOperationalBatch6SourceModels,
  validateRetainedOperationalBatch6,
  validateRetainedOperationalBatch6Source,
} from "./cutover-operational-batch6";
import type { CutoverDatabase, QueryResultLike } from "./cutover-types";

const MESSAGE_KEY = "11".repeat(32);
const MESSAGE_KEYS = { 1: MESSAGE_KEY };

function messageEnvelope(value: unknown, fill = 0x22): Record<string, unknown> {
  const iv = Buffer.alloc(16, fill);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(MESSAGE_KEY, "hex"), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    __platos_enc: 1,
    v: 1,
    ct: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64"),
  };
}

describe("retained operational/audit/governance cutover Batch 6", () => {
  test("pins isolated sources, deterministic targets, deferred probes, and append-only targets", () => {
    expect(retainedOperationalBatch6SourceModels).toEqual([
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
    ]);
    expect(retainedOperationalBatch6MappingTargets).toContainEqual({
      sourceModel: "PlatosCredentialAudit",
      targetModel: "AdminAudit",
      stableSuffix: "",
    });
    expect(retainedOperationalBatch6DeferredTargetChecks).toEqual([
      {
        fields: "ToolCallAudit.arguments,ToolCallAudit.result",
        reEncryption: "DEFERRED",
        readProbe: "AUDIT_DECRYPT_READ",
      },
      {
        fields: "SafetyEvent.detail,SafetyEvent.metadata",
        reEncryption: "DEFERRED",
        readProbe: "AUDIT_DECRYPT_READ",
      },
    ]);
    expect(retainedOperationalBatch6AppendOnlyTargets).toEqual([
      "ToolCallAudit",
      "AdminAudit",
      "SafetyEvent",
      "Event",
    ]);
  });

  test("strictly classifies JSON and text message envelopes without changing retained storage", () => {
    const jsonEnvelope = messageEnvelope({ query: "fixture" });
    const encrypted = classifyBatch6JsonMessage(
      "ToolCallAudit.arguments",
      jsonEnvelope,
      MESSAGE_KEYS
    );
    expect(encrypted).toMatchObject({
      encoding: "ENVELOPE",
      keyVersion: 1,
      storageValue: jsonEnvelope,
      decodedValue: { query: "fixture" },
    });

    const plaintext = classifyBatch6JsonMessage(
      "ToolCallAudit.result",
      [{ ok: true }],
      MESSAGE_KEYS
    );
    expect(plaintext).toEqual({
      encoding: "PLAINTEXT",
      keyVersion: null,
      storageValue: [{ ok: true }],
      decodedValue: [{ ok: true }],
    });

    const textEnvelope = JSON.stringify(messageEnvelope("redacted detail", 0x33));
    expect(
      classifyNullableBatch6TextMessage("SafetyEvent.detail", textEnvelope, MESSAGE_KEYS)
    ).toEqual({
      encoding: "ENVELOPE",
      keyVersion: 1,
      storageValue: textEnvelope,
      decodedValue: "redacted detail",
    });
  });

  test("recognized invalid encrypted material blocks with no sentinel or plaintext fallback", () => {
    expect(() =>
      classifyBatch6JsonMessage(
        "ToolCallAudit.arguments",
        { ...messageEnvelope({ query: "fixture" }), ct: "not-canonical-ciphertext" },
        MESSAGE_KEYS
      )
    ).toThrow("message envelope is unreadable");
    expect(() =>
      classifyBatch6JsonMessage(
        "ToolCallAudit.arguments",
        { ...messageEnvelope({ query: "fixture" }), __platos_enc: 2 },
        MESSAGE_KEYS
      )
    ).toThrow("message envelope is unreadable");
    expect(() =>
      classifyBatch6JsonMessage("ToolCallAudit.arguments", messageEnvelope({ query: "fixture" }), {
        2: MESSAGE_KEY,
      })
    ).toThrow("message envelope is unreadable");
    expect(() =>
      classifyNullableBatch6TextMessage(
        "SafetyEvent.detail",
        JSON.stringify(messageEnvelope({ not: "text" })),
        MESSAGE_KEYS
      )
    ).toThrow("must decode to a string");
  });

  test("blocks wrong JSON roots after decrypting recognized envelopes", () => {
    expect(() =>
      classifyBatch6JsonMessage(
        "ToolCallAudit.arguments",
        messageEnvelope(["wrong-root"]),
        MESSAGE_KEYS
      )
    ).toThrow("expected object root");
    expect(() =>
      classifyBatch6JsonMessage("SafetyEvent.metadata", "encoded-looking-plaintext", MESSAGE_KEYS)
    ).toThrow("expected object root");
  });

  test("normalizes canonical statuses and decimal costs fail-closed", () => {
    expect(normalizeBatch6ToolCallStatus("success")).toBe("SUCCEEDED");
    expect(normalizeBatch6ToolCallStatus("timeout")).toBe("FAILED");
    expect(normalizeBatch6ApprovalStatus("timed_out")).toBe("EXPIRED");
    expect(normalizeBatch6ErasureStatus("running")).toBe("ACTIVE");
    expect(normalizeBatch6ErasureStatus("blocked_legal_hold")).toBe("FAILED");
    expect(normalizeBatch6CostCents(0.25)).toBe("0.250000");
    expect(normalizeBatch6CostCents(null)).toBeNull();
    expect(() => normalizeBatch6ToolCallStatus("ok")).toThrow("not representable");
    expect(() => normalizeBatch6ApprovalStatus("cancelled")).toThrow("not representable");
    expect(() => normalizeBatch6ErasureStatus("unknown")).toThrow("not representable");
    expect(() => normalizeBatch6CostCents(-1)).toThrow("not representable");
    expect(() => normalizeBatch6CostCents(0.1234567)).toThrow("precision");
  });

  test("pages tool-call audits in bounded chunks and preserves a validated envelope", async () => {
    const envelope = messageEnvelope({ query: "encrypted-fixture" });
    const queries: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const database: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(
        sql: string,
        values?: readonly unknown[]
      ): Promise<QueryResultLike<Row>> {
        queries.push({ sql, values });
        if (sql.includes('FROM cutover_legacy."PlatosToolCallAudit" source')) {
          const rows =
            values?.[0] === ""
              ? [
                  {
                    source_id: "audit-a",
                    target_id: "00000000-0000-5000-8000-000000000001",
                    environment_id: "00000000-0000-5000-8000-000000000002",
                    tool_id: "00000000-0000-5000-8000-000000000003",
                    end_user_id: null,
                    agent_id: null,
                    thread_id: null,
                    tool_name: "search_docs",
                    arguments: envelope,
                    result: [{ ok: true }],
                    error: null,
                    status: "success",
                    latency_ms: 12,
                    cost_cents: 0.25,
                    trace_id: "trace-fixture",
                    created_at: new Date(0),
                  },
                ]
              : [];
          return { rows: rows as unknown as Row[], rowCount: rows.length };
        }
        return { rows: [], rowCount: 1 };
      },
    };

    await expect(
      backfillBatch6ToolCallAudits(database, { messageEncryptionKeys: MESSAGE_KEYS }, 1)
    ).resolves.toBe(1);
    expect(
      queries.filter((query) => query.sql.includes("ORDER BY source.id LIMIT $2"))
    ).toHaveLength(2);
    const insert = queries.find((query) =>
      query.sql.includes('INSERT INTO public."ToolCallAudit"')
    );
    expect(insert?.sql).not.toMatch(/\bUPDATE\b|\bDELETE\b|\bON CONFLICT\b/);
    expect(JSON.parse(String(insert?.values?.[7]))).toEqual(envelope);
    expect(insert?.values).toContain("SUCCEEDED");
    expect(insert?.values).toContain("0.250000");
  });

  test("merges credential audits with deterministic source provenance using insert-only semantics", async () => {
    const queries: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const database: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(
        sql: string,
        values?: readonly unknown[]
      ): Promise<QueryResultLike<Row>> {
        queries.push({ sql, values });
        if (sql.includes('FROM cutover_legacy."PlatosCredentialAudit" source')) {
          const rows =
            values?.[0] === ""
              ? [
                  {
                    source_id: "credential-audit-a",
                    target_id: "00000000-0000-5000-8000-000000000001",
                    environment_id: "00000000-0000-5000-8000-000000000002",
                    actor_user_id: null,
                    action: "use",
                    family: "control_plane",
                    credential_id: "credential-fixture",
                    created_at: new Date(0),
                  },
                ]
              : [];
          return { rows: rows as unknown as Row[], rowCount: rows.length };
        }
        return { rows: [], rowCount: 1 };
      },
    };

    await expect(backfillBatch6CredentialAudits(database, 1)).resolves.toBe(1);
    const insert = queries.find((query) => query.sql.includes('INSERT INTO public."AdminAudit"'));
    expect(insert?.sql).not.toMatch(/\bUPDATE\b|\bDELETE\b|\bON CONFLICT\b/);
    expect(insert?.values).toContain("PlatosCredentialAudit");
    expect(insert?.values).toContain("credential-fixture");
    expect(insert?.values).toContain("legacy:PlatosCredentialAudit:control_plane");
  });

  test("returns count-only merge evidence and makes no completion claim", async () => {
    const database: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(): Promise<QueryResultLike<Row>> {
        return { rows: [], rowCount: 0 };
      },
    };
    const evidence = await backfillRetainedOperationalBatch6(
      database,
      { messageEncryptionKeys: { 1: "message-key-sentinel" } },
      2
    );
    expect(evidence.mergeCounts).toEqual({
      adminAuditSources: 0,
      credentialAuditSources: 0,
      adminAuditTargets: 0,
    });
    expect(JSON.stringify(evidence)).not.toContain("message-key-sentinel");
    expect(JSON.stringify(evidence)).not.toMatch(/complete|probe|reencrypt/i);
  });

  test("keeps source, conservation, ancestry, and semantic gates separate", async () => {
    const sourceDatabase: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(): Promise<QueryResultLike<Row>> {
        return { rows: [{ issue: "scope-ancestry" }] as unknown as Row[], rowCount: 1 };
      },
    };
    await expect(validateRetainedOperationalBatch6Source(sourceDatabase)).rejects.toMatchObject({
      code: "BATCH6_SOURCE_OR_MAPPING_INVALID",
    });

    let call = 0;
    const targetDatabase: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(): Promise<QueryResultLike<Row>> {
        call += 1;
        return call === 3
          ? { rows: [{ issue: "admin-audit-provenance" }] as unknown as Row[], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      },
    };
    await expect(validateRetainedOperationalBatch6(targetDatabase)).rejects.toMatchObject({
      code: "BATCH6_SEMANTIC_VALIDATION_FAILED",
    });
    expect(call).toBe(3);
  });
});
