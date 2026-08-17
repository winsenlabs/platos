import { createCipheriv } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  backfillBatch8Memories,
  backfillBatch8MemoryRelationships,
  backfillRetainedMemoryBatch8,
  classifyBatch8NullableJsonMessage,
  classifyBatch8TextMessage,
  retainedMemoryBatch8DeferredTargetChecks,
  retainedMemoryBatch8GraphEquations,
  retainedMemoryBatch8MappingTargets,
  retainedMemoryBatch8ParentOrder,
  retainedMemoryBatch8SourceModels,
  validateRetainedMemoryBatch8,
  validateRetainedMemoryBatch8Source,
} from "./cutover-memory-batch8";
import type { CutoverDatabase, QueryResultLike } from "./cutover-types";

const MESSAGE_KEY = "11".repeat(32);
const MESSAGE_KEYS = { 1: MESSAGE_KEY };

function messageEnvelope(value: unknown, fill = 0x61): Record<string, unknown> {
  const iv = Buffer.alloc(16, fill);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(MESSAGE_KEY, "hex"), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    __platos_enc: 1,
    v: 1,
    ct: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64"),
  };
}

interface CapturedQuery {
  readonly sql: string;
  readonly values?: readonly unknown[];
}

function chunkDatabase(
  sourceTable: string,
  rows: readonly Record<string, unknown>[]
): { database: CutoverDatabase; queries: CapturedQuery[] } {
  const queries: CapturedQuery[] = [];
  const database: CutoverDatabase = {
    async query<Row extends Record<string, unknown>>(
      sql: string,
      values?: readonly unknown[]
    ): Promise<QueryResultLike<Row>> {
      queries.push({ sql, values });
      if (sql.includes(`FROM cutover_legacy."${sourceTable}" source`)) {
        const selected = values?.[0] === "" ? rows : [];
        return { rows: selected as unknown as Row[], rowCount: selected.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { database, queries };
}

const createdAt = new Date("2025-01-01T00:00:00Z");
const updatedAt = new Date("2025-01-02T00:00:00Z");

describe("retained memory/knowledge-graph cutover Batch 8", () => {
  test("pins isolated sources, deterministic mappings, bounded parent order, and deferred work", () => {
    expect(retainedMemoryBatch8SourceModels).toEqual([
      "PlatosMemory",
      "PlatosMemoryEntity",
      "PlatosMemoryRelationship",
    ]);
    expect(retainedMemoryBatch8MappingTargets).toEqual([
      { sourceModel: "PlatosMemory", targetModel: "Memory", stableSuffix: "" },
      { sourceModel: "PlatosMemoryEntity", targetModel: "MemoryEntity", stableSuffix: "" },
      {
        sourceModel: "PlatosMemoryRelationship",
        targetModel: "MemoryRelationship",
        stableSuffix: "",
      },
    ]);
    expect(retainedMemoryBatch8ParentOrder).toEqual([
      "Memory",
      "MemoryEntity",
      "MemoryRelationship",
    ]);
    expect(retainedMemoryBatch8DeferredTargetChecks).toEqual([
      {
        fields: "Memory.content,Memory.metadata",
        reEncryption: "UNIMPLEMENTED",
        readProbe: "MEMORY_DECRYPT_READ_UNIMPLEMENTED",
      },
      {
        fields: "MemoryEntity.label,MemoryEntity.metadata",
        reEncryption: "UNIMPLEMENTED",
        readProbe: "MEMORY_DECRYPT_READ_UNIMPLEMENTED",
      },
      {
        fields: "MemoryRelationship.metadata",
        reEncryption: "UNIMPLEMENTED",
        readProbe: "MEMORY_DECRYPT_READ_UNIMPLEMENTED",
      },
    ]);
    expect(retainedMemoryBatch8GraphEquations).toHaveLength(6);
  });

  test("strictly classifies mixed text and JSON fields while retaining exact storage", () => {
    const contentEnvelope = messageEnvelope("encrypted content", 0x62);
    const contentStorage = JSON.stringify(contentEnvelope);
    expect(classifyBatch8TextMessage("Memory.content", contentStorage, MESSAGE_KEYS)).toEqual({
      encoding: "ENVELOPE",
      keyVersion: 1,
      storageValue: contentStorage,
      decodedValue: "encrypted content",
    });
    expect(classifyBatch8TextMessage("MemoryEntity.label", "Plain label", MESSAGE_KEYS)).toEqual({
      encoding: "PLAINTEXT",
      keyVersion: null,
      storageValue: "Plain label",
      decodedValue: "Plain label",
    });

    const metadataEnvelope = messageEnvelope({ nested: { retained: true } }, 0x63);
    expect(
      classifyBatch8NullableJsonMessage("Memory.metadata", metadataEnvelope, MESSAGE_KEYS)
    ).toEqual({
      encoding: "ENVELOPE",
      keyVersion: 1,
      storageValue: metadataEnvelope,
      decodedValue: { nested: { retained: true } },
    });
    expect(
      classifyBatch8NullableJsonMessage(
        "MemoryRelationship.metadata",
        { confidence: 0.9 },
        MESSAGE_KEYS
      )
    ).toEqual({
      encoding: "PLAINTEXT",
      keyVersion: null,
      storageValue: { confidence: 0.9 },
      decodedValue: { confidence: 0.9 },
    });
  });

  test("recognized invalid encrypted values block with no sentinel or plaintext fallback", () => {
    const envelope = messageEnvelope("content");
    expect(() =>
      classifyBatch8TextMessage(
        "Memory.content",
        JSON.stringify({ ...envelope, ct: "plaintext-looking-sentinel" }),
        MESSAGE_KEYS
      )
    ).toThrow("message envelope is unreadable");
    expect(() =>
      classifyBatch8TextMessage(
        "Memory.content",
        JSON.stringify({ ...envelope, __platos_enc: 2 }),
        MESSAGE_KEYS
      )
    ).toThrow("message envelope is unreadable");
    expect(() =>
      classifyBatch8TextMessage("Memory.content", JSON.stringify(envelope), {
        2: MESSAGE_KEY,
      })
    ).toThrow("message envelope is unreadable");
    expect(() =>
      classifyBatch8TextMessage(
        "MemoryEntity.label",
        JSON.stringify(messageEnvelope({ not: "text" })),
        MESSAGE_KEYS
      )
    ).toThrow("must decode to a string");
    expect(() =>
      classifyBatch8NullableJsonMessage(
        "MemoryEntity.metadata",
        messageEnvelope(["not-an-object"]),
        MESSAGE_KEYS
      )
    ).toThrow("expected object root");
  });

  test("backfills memory in stable bounded chunks with canonical parents and full retained semantics", async () => {
    const envelope = JSON.stringify(messageEnvelope("encrypted content"));
    const { database, queries } = chunkDatabase("PlatosMemory", [
      {
        source_id: "memory-a",
        target_id: "00000000-0000-5000-8000-000000000001",
        environment_id: "00000000-0000-5000-8000-000000000002",
        end_user_id: "00000000-0000-5000-8000-000000000003",
        agent_id: "00000000-0000-5000-8000-000000000004",
        kind: "fact",
        content: envelope,
        metadata: { nested: { retained: true } },
        embedding: "[0.1,0.2]",
        agent_visible: false,
        visibility: "private",
        source: "extracted",
        source_thread_id: "00000000-0000-5000-8000-000000000005",
        source_turn_ids: ["00000000-0000-5000-8000-000000000006"],
        extractor_version: "fixture-v1",
        content_hash: "ab".repeat(32),
        confidence: 0.75,
        last_accessed_at: updatedAt,
        archived_at: updatedAt,
        created_at: createdAt,
        updated_at: updatedAt,
      },
    ]);

    await expect(
      backfillBatch8Memories(database, { messageEncryptionKeys: MESSAGE_KEYS }, 1)
    ).resolves.toBe(1);
    const selects = queries.filter((query) =>
      query.sql.includes('FROM cutover_legacy."PlatosMemory" source')
    );
    expect(selects.map((query) => query.values)).toEqual([
      ["", 1],
      ["memory-a", 1],
    ]);
    expect(selects[0]?.sql).toContain("WITH ORDINALITY");
    expect(selects[0]?.sql).toContain("source_model='PlatosAgentMessage'");
    expect(selects[0]?.sql).toContain("source_model='PlatosEndUser'");
    expect(selects[0]?.sql).toContain("source_model='PlatosAgent'");

    const insert = queries.find((query) => query.sql.includes('INSERT INTO public."Memory"'))!;
    expect(insert.sql).not.toMatch(/\bUPDATE\b|\bDELETE\b|\bON CONFLICT\b/);
    expect(insert.values).toContain(envelope);
    expect(insert.values).toContain("[0.1,0.2]");
    expect(insert.values).toContain("ab".repeat(32));
    expect(insert.values).toContain(updatedAt);
    expect(insert.values?.[4]).toBeNull();
    expect(insert.values?.[13]).toEqual(["00000000-0000-5000-8000-000000000006"]);
  });

  test("backfills relationships only through mapped endpoints and source memory", async () => {
    const { database, queries } = chunkDatabase("PlatosMemoryRelationship", [
      {
        source_id: "relationship-a",
        target_id: "00000000-0000-5000-8000-000000000001",
        environment_id: "00000000-0000-5000-8000-000000000002",
        end_user_id: "00000000-0000-5000-8000-000000000003",
        agent_id: "00000000-0000-5000-8000-000000000004",
        from_entity_id: "00000000-0000-5000-8000-000000000005",
        to_entity_id: "00000000-0000-5000-8000-000000000006",
        relationship_type: "works_at",
        weight: 0.9,
        metadata: { retained: true },
        source_memory_id: "00000000-0000-5000-8000-000000000007",
        created_at: createdAt,
      },
    ]);

    await expect(
      backfillBatch8MemoryRelationships(database, { messageEncryptionKeys: MESSAGE_KEYS }, 1)
    ).resolves.toBe(1);
    const select = queries.find((query) =>
      query.sql.includes('FROM cutover_legacy."PlatosMemoryRelationship" source')
    )!;
    expect(select.sql).toContain("source_model='PlatosMemoryEntity'");
    expect(select.sql).toContain("source_model='PlatosMemory'");
    const insert = queries.find((query) =>
      query.sql.includes('INSERT INTO public."MemoryRelationship"')
    )!;
    expect(insert.values?.slice(4, 8)).toEqual([
      null,
      "00000000-0000-5000-8000-000000000005",
      "00000000-0000-5000-8000-000000000006",
      "works_at",
    ]);
  });

  test("fails source validation before decoding when canonical ancestry is invalid", async () => {
    let calls = 0;
    const database: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(): Promise<QueryResultLike<Row>> {
        calls += 1;
        return {
          rows: [{ issue: "relationship-canonical-scope" }] as unknown as Row[],
          rowCount: 1,
        };
      },
    };
    await expect(
      validateRetainedMemoryBatch8Source(database, { messageEncryptionKeys: MESSAGE_KEYS })
    ).rejects.toMatchObject({ code: "BATCH8_SOURCE_OR_MAPPING_INVALID" });
    expect(calls).toBe(1);
  });

  test("keeps conservation, ancestry, and semantic graph gates separate", async () => {
    let call = 0;
    const database: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(): Promise<QueryResultLike<Row>> {
        call += 1;
        return call === 2
          ? { rows: [{ issue: "relationship-canonical-scope" }] as unknown as Row[], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      },
    };
    await expect(validateRetainedMemoryBatch8(database)).rejects.toMatchObject({
      code: "BATCH8_ANCESTRY_FAILED",
    });
    expect(call).toBe(2);
  });

  test("returns count-only evidence without completion, execute, or runtime-read claims", async () => {
    const database: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(): Promise<QueryResultLike<Row>> {
        return { rows: [], rowCount: 0 };
      },
    };
    const evidence = await backfillRetainedMemoryBatch8(
      database,
      { messageEncryptionKeys: { 1: "message-key-sentinel" } },
      2
    );
    expect(evidence).toEqual({
      batch: "retained-memory-batch8",
      sourceRows: { memories: 0, entities: 0, relationships: 0 },
      targetRows: { memories: 0, entities: 0, relationships: 0 },
      graphCounts: {
        directedEdges: 0,
        fromEndpoints: 0,
        toEndpoints: 0,
        sourcedEdges: 0,
      },
    });
    expect(JSON.stringify(evidence)).not.toContain("message-key-sentinel");
    expect(JSON.stringify(evidence)).not.toMatch(/complete|execute|probe|reencrypt/i);
  });
});
