import { describe, expect, test } from "vitest";
import {
  backfillBatch1Tools,
  normalizeBatch1AgentVersionSnapshot,
  retainedAgentToolBatch1MappingTargets,
  retainedAgentToolBatch1SourceModels,
  validateRetainedAgentToolBatch1Source,
} from "./cutover-agent-tool-batch1";
import type { CutoverDatabase, QueryResultLike } from "./cutover-types";

const validPromptBlock = {
  id: "system",
  type: "STATIC",
  name: "System",
  content: "Be concise",
  enabled: true,
  editable: true,
  order: 0,
};

const validDynamicBlock = {
  key: "customer",
  name: "Customer",
  defaultContent: "Unknown",
};

describe("retained agent/tool cutover Batch 1", () => {
  test("pins the exact source-to-target mapping materialization contract", () => {
    expect(retainedAgentToolBatch1SourceModels).toEqual([
      "PlatosToolDefinition",
      "PlatosAgent",
      "PlatosAgentVersion",
      "PlatosAgentCluster",
    ]);
    expect(retainedAgentToolBatch1MappingTargets).toEqual([
      { sourceModel: "PlatosToolDefinition", targetModel: "Tool", stableSuffix: "" },
      { sourceModel: "PlatosAgent", targetModel: "Agent", stableSuffix: "" },
      { sourceModel: "PlatosAgent", targetModel: "AgentBinding", stableSuffix: "agent-binding" },
      { sourceModel: "PlatosAgentVersion", targetModel: "AgentVersion", stableSuffix: "" },
      { sourceModel: "PlatosAgentCluster", targetModel: "AgentCluster", stableSuffix: "" },
    ]);
  });

  test("normalizes authorized snapshot JSON while excluding export-only config", () => {
    const normalized = normalizeBatch1AgentVersionSnapshot({
      model: "anthropic:claude-sonnet-4-6",
      systemPrompt: "export-only sentinel",
      maxSteps: 777,
      contextLimit: 999,
      promptBlocks: JSON.stringify([validPromptBlock]),
      dynamicBlocks: JSON.stringify([validDynamicBlock]),
      toolsBlockConfig: JSON.stringify({ mode: "direct", pinnedTools: ["search"] }),
      modelRoutes: JSON.stringify([
        { label: "primary", model: "anthropic:claude-sonnet-4-6", isDefault: true },
      ]),
      memoryConfig: { conversation: true },
      outputSchema: { type: "object" },
    });

    expect(normalized).toEqual({
      model: "anthropic:claude-sonnet-4-6",
      promptBlocks: [validPromptBlock],
      dynamicBlocks: [validDynamicBlock],
      toolsBlockConfig: { mode: "direct", pinnedTools: ["search"] },
      modelRoutes: [
        { label: "primary", model: "anthropic:claude-sonnet-4-6", isDefault: true },
      ],
      memoryConfig: { conversation: true },
      outputSchema: { type: "object" },
    });
    expect(normalized).not.toHaveProperty("systemPrompt");
    expect(normalized).not.toHaveProperty("maxSteps");
    expect(normalized).not.toHaveProperty("contextLimit");
  });

  test("fails closed on malformed snapshots and retired embedded tool lists", () => {
    expect(() => normalizeBatch1AgentVersionSnapshot([])).toThrow(
      "snapshot must have an object root"
    );
    expect(() => normalizeBatch1AgentVersionSnapshot({ model: "" })).toThrow(
      "snapshot model must be a non-empty string"
    );
    expect(() =>
      normalizeBatch1AgentVersionSnapshot({
        model: "anthropic:test",
        promptBlocks: "not-json",
      })
    ).toThrow("legacy encoded value is malformed JSON");
    expect(() =>
      normalizeBatch1AgentVersionSnapshot({
        model: "anthropic:test",
        toolsBlockConfig: { enabledTools: ["legacy-tool"] },
      })
    ).toThrow("enabledTools is retired");
  });

  test("pages tool rows in stable bounded chunks and writes no export-only fields", async () => {
    const queries: { sql: string; values?: readonly unknown[] }[] = [];
    const database: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(
        sql: string,
        values?: readonly unknown[]
      ): Promise<QueryResultLike<Row>> {
        queries.push({ sql, values });
        if (sql.includes('FROM cutover_legacy."PlatosToolDefinition"')) {
          const rows = values?.[0] === ""
            ? [
                {
                  source_id: "tool-a",
                  target_id: "03125bd3-8e2e-5500-8942-574db43e9203",
                  name: "search",
                  description: "Search",
                  param_schema: { type: "object" },
                  category: "knowledge",
                  schema_hash: "hash-a",
                  created_at: new Date("2025-01-01T00:00:00Z"),
                  updated_at: new Date("2025-01-02T00:00:00Z"),
                },
                {
                  source_id: "tool-b",
                  target_id: "4cd093ea-ff26-5c22-aefc-936b2e9491a2",
                  name: "email",
                  description: "Email",
                  param_schema: { type: "object" },
                  category: null,
                  schema_hash: "hash-b",
                  created_at: new Date("2025-01-01T00:00:00Z"),
                  updated_at: new Date("2025-01-02T00:00:00Z"),
                },
              ]
            : [];
          return { rows: rows as unknown as Row[], rowCount: rows.length };
        }
        return { rows: [], rowCount: 2 };
      },
    };

    await backfillBatch1Tools(database, 2);

    expect(queries.filter((query) => query.sql.includes("ORDER BY source.id LIMIT $2")))
      .toHaveLength(2);
    const insert = queries.find((query) => query.sql.includes('INSERT INTO public."Tool"'))!;
    expect(insert.sql).toContain("category");
    expect(insert.sql).not.toContain("organizationId");
    expect(insert.sql).not.toContain("projectId");
    expect(insert.sql).not.toContain("bm25Tokens");
    expect(insert.values).toHaveLength(16);
  });

  test("reports missing deterministic mappings as a closed source gate", async () => {
    const database: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(): Promise<QueryResultLike<Row>> {
        return {
          rows: [{ issue: "missing-agent-binding-map" }] as unknown as Row[],
          rowCount: 1,
        };
      },
    };
    await expect(validateRetainedAgentToolBatch1Source(database)).rejects.toThrow(
      "missing-agent-binding-map"
    );
  });
});
