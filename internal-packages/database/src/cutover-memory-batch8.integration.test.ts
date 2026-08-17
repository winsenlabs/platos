import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  backfillRetainedAgentToolBatch1,
  validateRetainedAgentToolBatch1,
} from "./cutover-agent-tool-batch1";
import {
  backfillCoreTenancy,
  createCleanCatalog,
  createCutoverJournal,
  materializeCutoverIdMap,
  moveLegacyCatalogToTemporarySchema,
  validateCoreTenancyBackfill,
} from "./cutover-backfill";
import {
  backfillRetainedConversationBatch2,
  materializeBatch2MessageOrdinalMappings,
  validateRetainedConversationBatch2,
} from "./cutover-conversation-batch2";
import { backfillRetainedMemoryBatch8 } from "./cutover-memory-batch8";

const runHarness = process.env.RUN_DATABASE_CUTOVER_MEMORY_BATCH8_HARNESS === "1";
const describeHarness = runHarness ? describe : describe.skip;
const packageRoot = resolve(__dirname, "..");
const messageEncryptionKeys = Object.freeze({ "1": "11".repeat(32) });

describeHarness("retained memory Batch 8 isolated PostgreSQL replay", () => {
  let container: StartedPostgreSqlContainer;
  let database: pg.Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    const databaseUrl = container.getConnectionUri();
    execFileSync(
      resolve(packageRoot, "node_modules/.bin/prisma"),
      ["migrate", "deploy", "--schema", resolve(packageRoot, "legacy-prisma/schema.prisma")],
      {
        cwd: packageRoot,
        env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl },
        stdio: "pipe",
      }
    );
    database = new pg.Client({ connectionString: databaseUrl });
    await database.connect();
  }, 120_000);

  afterAll(async () => {
    await database?.end();
    await container?.stop();
  });

  test("conserves memory semantics and a same-scope directed graph with count-only evidence", async () => {
    for (const fixture of [
      "legacy-core-seed.sql",
      "legacy-agent-tool-batch1-seed.sql",
      "legacy-conversation-batch2-seed.sql",
      "legacy-memory-batch8-seed.sql",
    ]) {
      await database.query(readFileSync(resolve(packageRoot, "test-fixtures", fixture), "utf8"));
    }

    await database.query("BEGIN");
    try {
      await moveLegacyCatalogToTemporarySchema(database);
      await createCleanCatalog(database, packageRoot);
      await createCutoverJournal(database, "f69928a1-cba3-5840-b3b0-dc60ae1dcbb2");
      await materializeCutoverIdMap(database);
      await materializeBatch2MessageOrdinalMappings(database);
      await backfillCoreTenancy(database);
      await validateCoreTenancyBackfill(database);
      await backfillRetainedAgentToolBatch1(database);
      await validateRetainedAgentToolBatch1(database);
      await backfillRetainedConversationBatch2(database, messageEncryptionKeys);
      await validateRetainedConversationBatch2(database);

      const evidence = await backfillRetainedMemoryBatch8(database, { messageEncryptionKeys }, 1);
      expect(evidence).toEqual({
        batch: "retained-memory-batch8",
        sourceRows: { memories: 2, entities: 2, relationships: 1 },
        targetRows: { memories: 2, entities: 2, relationships: 1 },
        graphCounts: {
          directedEdges: 1,
          fromEndpoints: 1,
          toEndpoints: 1,
          sourcedEdges: 1,
        },
      });
      expect(JSON.stringify(evidence)).not.toContain("Alice works at Acme");
      expect(JSON.stringify(evidence)).not.toContain("UVFRUVFRUVFRUVFRUVFR");

      const memories = await database.query<{
        sourceId: string;
        sourceTurnCount: number;
        hasSourceThread: boolean;
        embeddingPreserved: boolean;
        contentHash: string | null;
        agentVisible: boolean;
        visibility: string;
        lastAccessedAt: Date | null;
        archivedAt: Date | null;
      }>(`SELECT source.id AS "sourceId",
                 cardinality(target."sourceTurnIds") AS "sourceTurnCount",
                 target."sourceThreadId" IS NOT NULL AS "hasSourceThread",
                 target.embedding = source.embedding AS "embeddingPreserved",
                 target."contentHash", target."agentVisible", target.visibility,
                 target."lastAccessedAt", target."archivedAt"
            FROM cutover_legacy."PlatosMemory" source
            JOIN cutover_legacy.cutover_id_map map ON map.mapping_version=1
             AND map.source_model='PlatosMemory' AND map.source_id=source.id
             AND map.target_model='Memory' AND map.stable_suffix=''
            JOIN public."Memory" target ON target.id=map.target_id
           ORDER BY source.id`);
      expect(memories.rows).toHaveLength(2);
      expect(memories.rows[0]).toMatchObject({
        sourceId: "cllegacymemory0001",
        sourceTurnCount: 2,
        hasSourceThread: true,
        embeddingPreserved: true,
        contentHash: "030549a81f2b45ad55d6ba63c629501d52f6b4a646810e4ea8b32c6d23376f79",
        agentVisible: true,
        visibility: "agent_visible",
        archivedAt: null,
      });
      expect(memories.rows[0]?.lastAccessedAt?.toISOString()).toBe("2025-01-04T00:00:00.000Z");
      expect(memories.rows[1]).toMatchObject({
        sourceId: "cllegacymemory0002",
        sourceTurnCount: 0,
        hasSourceThread: false,
        embeddingPreserved: true,
        contentHash: null,
        agentVisible: false,
        visibility: "private",
      });
      expect(memories.rows[1]?.archivedAt?.toISOString()).toBe("2025-01-06T00:00:00.000Z");

      const graph = await database.query<{
        relationshipEnvironmentId: string;
        relationshipEndUserId: string;
        relationshipAgentId: string;
        fromEnvironmentId: string;
        fromEndUserId: string;
        fromAgentId: string;
        toEnvironmentId: string;
        toEndUserId: string;
        toAgentId: string;
        sourceEnvironmentId: string;
        sourceEndUserId: string;
        sourceAgentId: string;
        fromEmbeddingPreserved: boolean;
        toEmbeddingPreserved: boolean;
      }>(`SELECT relationship."environmentId"::text AS "relationshipEnvironmentId",
                 relationship."endUserId"::text AS "relationshipEndUserId",
                 relationship."agentId"::text AS "relationshipAgentId",
                 source."environmentId"::text AS "fromEnvironmentId",
                 source."endUserId"::text AS "fromEndUserId",
                 source."agentId"::text AS "fromAgentId",
                 target."environmentId"::text AS "toEnvironmentId",
                 target."endUserId"::text AS "toEndUserId",
                 target."agentId"::text AS "toAgentId",
                 memory."environmentId"::text AS "sourceEnvironmentId",
                 memory."endUserId"::text AS "sourceEndUserId",
                 memory."agentId"::text AS "sourceAgentId",
                 source.embedding = legacy_source.embedding AS "fromEmbeddingPreserved",
                 target.embedding = legacy_target.embedding AS "toEmbeddingPreserved"
            FROM public."MemoryRelationship" relationship
            JOIN public."MemoryEntity" source ON source.id=relationship."fromEntityId"
            JOIN public."MemoryEntity" target ON target.id=relationship."toEntityId"
            JOIN public."Memory" memory ON memory.id=relationship."sourceMemoryId"
            JOIN cutover_legacy.cutover_id_map relationship_map ON relationship_map.mapping_version=1
             AND relationship_map.source_model='PlatosMemoryRelationship'
             AND relationship_map.target_model='MemoryRelationship'
             AND relationship_map.target_id=relationship.id
            JOIN cutover_legacy."PlatosMemoryRelationship" legacy_relationship
              ON legacy_relationship.id=relationship_map.source_id
            JOIN cutover_legacy."PlatosMemoryEntity" legacy_source
              ON legacy_source.id=legacy_relationship."fromEntityId"
            JOIN cutover_legacy."PlatosMemoryEntity" legacy_target
              ON legacy_target.id=legacy_relationship."toEntityId"`);
      expect(graph.rows).toHaveLength(1);
      const edge = graph.rows[0]!;
      expect([
        edge.relationshipEnvironmentId,
        edge.relationshipEndUserId,
        edge.relationshipAgentId,
      ]).toEqual([edge.fromEnvironmentId, edge.fromEndUserId, edge.fromAgentId]);
      expect([
        edge.relationshipEnvironmentId,
        edge.relationshipEndUserId,
        edge.relationshipAgentId,
      ]).toEqual([edge.toEnvironmentId, edge.toEndUserId, edge.toAgentId]);
      expect([
        edge.relationshipEnvironmentId,
        edge.relationshipEndUserId,
        edge.relationshipAgentId,
      ]).toEqual([edge.sourceEnvironmentId, edge.sourceEndUserId, edge.sourceAgentId]);
      expect(edge.fromEmbeddingPreserved).toBe(true);
      expect(edge.toEmbeddingPreserved).toBe(true);
    } finally {
      await database.query("ROLLBACK");
    }
  }, 240_000);
});
