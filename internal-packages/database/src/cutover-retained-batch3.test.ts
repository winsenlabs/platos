import { describe, expect, test } from "vitest";
import {
  backfillBatch3Checkpoint1Entities,
  backfillBatch3Checkpoint1EntityPolicies,
  backfillBatch3Checkpoint1EnvironmentTools,
  backfillBatch3Checkpoint1McpClients,
  backfillBatch3Checkpoint1McpConfigs,
  backfillRetainedBatch3Checkpoint1,
  batch3PolicyEffect,
  materializeRetainedBatch3Checkpoint1SharedMappings,
  normalizeBatch3McpClientHeaders,
  normalizeBatch3McpConfigJson,
  retainedBatch3Checkpoint1MappingTargets,
  retainedBatch3Checkpoint1SourceModels,
  validateRetainedBatch3Checkpoint1,
  validateRetainedBatch3Checkpoint1Source,
} from "./cutover-retained-batch3";
import type { CutoverDatabase, QueryResultLike } from "./cutover-types";

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

describe("retained-domain Batch 3 checkpoint 1", () => {
  test("pins the five checkpoint-1 sources and canonical mapping ownership", () => {
    expect(retainedBatch3Checkpoint1SourceModels).toEqual([
      "PlatosConnectedEntity",
      "PlatosEntityMcpConfig",
      "PlatosEntityMcpClient",
      "PlatosEntityToolMapping",
      "PlatosEntityMcpToolAcl",
    ]);
    expect(retainedBatch3Checkpoint1MappingTargets).toEqual([
      { sourceModel: "PlatosConnectedEntity", targetModel: "Entity", stableSuffix: "" },
      {
        sourceModel: "PlatosEntityMcpConfig",
        targetModel: "EntityMcpConfig",
        stableSuffix: "",
        mappingSourceModel: "PlatosConnectedEntity",
      },
      {
        sourceModel: "PlatosEntityMcpClient",
        targetModel: "EntityMcpClient",
        stableSuffix: "",
        mappingSourceModel: "PlatosConnectedEntity",
      },
      {
        sourceModel: "PlatosEntityToolMapping",
        targetModel: "EnvironmentEntityTool",
        stableSuffix: "",
      },
      {
        sourceModel: "PlatosEntityMcpToolAcl",
        targetModel: "EntityToolPolicy",
        stableSuffix: "",
      },
    ]);
  });

  test("strictly normalizes MCP JSON roots and preserves nested values", () => {
    expect(
      normalizeBatch3McpConfigJson({
        identityProviders: [{ id: "oidc", nested: { enabled: true } }],
        branding: { name: "Fixture", theme: { accent: "blue" } },
      })
    ).toEqual({
      identityProviders: [{ id: "oidc", nested: { enabled: true } }],
      branding: { name: "Fixture", theme: { accent: "blue" } },
    });
    expect(normalizeBatch3McpConfigJson({ identityProviders: null, branding: null })).toEqual({
      identityProviders: [],
      branding: {},
    });
    expect(normalizeBatch3McpClientHeaders({ Authorization: "Bearer {{secret}}" })).toEqual({
      Authorization: "Bearer {{secret}}",
    });
    expect(() =>
      normalizeBatch3McpConfigJson({ identityProviders: {}, branding: {} })
    ).toThrow("invalid root");
    expect(() => normalizeBatch3McpClientHeaders([])).toThrow("invalid root");
  });

  test("maps exposed ACL state to the target policy enum without inversion", () => {
    expect(batch3PolicyEffect(true)).toBe("ALLOW");
    expect(batch3PolicyEffect(false)).toBe("DENY");
  });

  test("reuses the Entity UUID for both shared-primary-key MCP targets", async () => {
    const queries: CapturedQuery[] = [];
    const database: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(
        sql: string,
        values?: readonly unknown[]
      ): Promise<QueryResultLike<Row>> {
        queries.push({ sql, values });
        return { rows: [], rowCount: 0 };
      },
    };

    await materializeRetainedBatch3Checkpoint1SharedMappings(database);
    expect(queries).toHaveLength(2);
    expect(queries[0]?.sql).toContain('cutover_legacy."PlatosEntityMcpConfig"');
    expect(queries[0]?.sql).toContain("SET target_id = entity_map.target_id");
    expect(queries[0]?.sql).toContain("source_model = 'PlatosConnectedEntity'");
    expect(queries[1]?.sql).toContain('cutover_legacy."PlatosEntityMcpClient"');
    expect(queries[1]?.sql).toContain("target_model = 'EntityMcpClient'");
  });

  test("backfills entities in stable bounded chunks without selecting secret material", async () => {
    const { database, queries } = chunkDatabase("PlatosConnectedEntity", [
      {
        source_id: "entity-a",
        target_id: "00000000-0000-5000-8000-000000000001",
        project_id: "00000000-0000-5000-8000-000000000002",
        external_id: "fixture-entity",
        display_name: "Fixture Entity",
        connection_status: "connected",
        connection_kind: "mcp",
        mcp_urls: ["https://mcp.example.invalid"],
        allowed_origins: ["https://app.example.invalid"],
        capabilities: ["tools"],
        last_connected_at: updatedAt,
        created_at: createdAt,
        updated_at: updatedAt,
      },
    ]);

    await expect(backfillBatch3Checkpoint1Entities(database, 1)).resolves.toBe(1);
    const selects = queries.filter((query) =>
      query.sql.includes('FROM cutover_legacy."PlatosConnectedEntity" source')
    );
    expect(selects.map((query) => query.values)).toEqual([
      ["", 1],
      ["entity-a", 1],
    ]);
    expect(selects[0]?.sql).not.toContain('source."serviceSecret"');
    expect(selects[0]?.sql).not.toContain('source."testCredentials"');
    const insert = queries.find((query) => query.sql.includes('INSERT INTO public."Entity"'))!;
    expect(insert.values).toEqual([
      "00000000-0000-5000-8000-000000000001",
      "00000000-0000-5000-8000-000000000002",
      "fixture-entity",
      "Fixture Entity",
      "connected",
      "mcp",
      ["https://mcp.example.invalid"],
      ["https://app.example.invalid"],
      ["tools"],
      updatedAt,
      createdAt,
      updatedAt,
    ]);
  });

  test("backfills MCP server config with normalized JSON", async () => {
    const { database, queries } = chunkDatabase("PlatosEntityMcpConfig", [
      {
        source_id: "entity-a",
        entity_id: "00000000-0000-5000-8000-000000000001",
        enabled: true,
        identity_mode: "oidc",
        identity_providers: [{ id: "fixture" }],
        branding: { name: "Fixture" },
        tool_allowlist: ["search_docs"],
        redirect_uri_allowlist: ["https://app.example.invalid/callback"],
        rate_limit_per_minute: 45,
        inject_mcp_context: true,
        created_at: createdAt,
        updated_at: updatedAt,
      },
    ]);

    await expect(backfillBatch3Checkpoint1McpConfigs(database, 1)).resolves.toBe(1);
    const insert = queries.find((query) =>
      query.sql.includes('INSERT INTO public."EntityMcpConfig"')
    )!;
    expect(insert.values?.[3]).toBe('[{"id":"fixture"}]');
    expect(insert.values?.[4]).toBe('{"name":"Fixture"}');
    expect(insert.values?.[8]).toBe(true);
  });

  test("backfills MCP client metadata while leaving credential linkage for checkpoint 2", async () => {
    const { database, queries } = chunkDatabase("PlatosEntityMcpClient", [
      {
        source_id: "entity-a",
        entity_id: "00000000-0000-5000-8000-000000000001",
        transport: "remote-http",
        url: "https://mcp.example.invalid",
        headers_template: { "X-User": "{{endUserId}}" },
        last_discovery_at: updatedAt,
        discovery_error: null,
        created_at: createdAt,
        updated_at: updatedAt,
      },
    ]);

    await expect(backfillBatch3Checkpoint1McpClients(database, 1)).resolves.toBe(1);
    const select = queries.find((query) =>
      query.sql.includes('FROM cutover_legacy."PlatosEntityMcpClient" source')
    )!;
    expect(select.sql).not.toContain('source."credsSecretKey"');
    const insert = queries.find((query) =>
      query.sql.includes('INSERT INTO public."EntityMcpClient"')
    )!;
    expect(insert.values?.[3]).toBeNull();
    expect(insert.values?.[4]).toBe('{"X-User":"{{endUserId}}"}');
  });

  test("backfills the environment/entity/tool matrix through canonical parent mappings", async () => {
    const { database, queries } = chunkDatabase("PlatosEntityToolMapping", [
      {
        source_id: "mapping-a",
        target_id: "00000000-0000-5000-8000-000000000001",
        environment_id: "00000000-0000-5000-8000-000000000002",
        entity_id: "00000000-0000-5000-8000-000000000003",
        tool_id: "00000000-0000-5000-8000-000000000004",
        enabled: true,
        callback_url: null,
        created_at: createdAt,
        updated_at: updatedAt,
      },
    ]);

    await expect(backfillBatch3Checkpoint1EnvironmentTools(database, 1)).resolves.toBe(1);
    const select = queries.find((query) =>
      query.sql.includes('FROM cutover_legacy."PlatosEntityToolMapping" source')
    )!;
    expect(select.sql).toContain("source_model = 'RuntimeEnvironment'");
    expect(select.sql).toContain("source_model = 'PlatosConnectedEntity'");
    expect(select.sql).toContain("source_model = 'PlatosToolDefinition'");
    const insert = queries.find((query) =>
      query.sql.includes('INSERT INTO public."EnvironmentEntityTool"')
    )!;
    expect(insert.values?.slice(0, 5)).toEqual([
      "00000000-0000-5000-8000-000000000001",
      "00000000-0000-5000-8000-000000000002",
      "00000000-0000-5000-8000-000000000003",
      "00000000-0000-5000-8000-000000000004",
      true,
    ]);
  });

  test("backfills entity tool policy and intentionally omits allowedPatIds", async () => {
    const { database, queries } = chunkDatabase("PlatosEntityMcpToolAcl", [
      {
        source_id: "policy-a",
        target_id: "00000000-0000-5000-8000-000000000001",
        entity_id: "00000000-0000-5000-8000-000000000002",
        tool_id: "00000000-0000-5000-8000-000000000003",
        exposed: false,
        min_identity_mode: "bearer",
        scope_labels: ["mcp:tools"],
        added_by: "legacy-user",
        added_at: createdAt,
        last_reviewed_at: updatedAt,
      },
    ]);

    await expect(backfillBatch3Checkpoint1EntityPolicies(database, 1)).resolves.toBe(1);
    const select = queries.find((query) =>
      query.sql.includes('FROM cutover_legacy."PlatosEntityMcpToolAcl" source')
    )!;
    expect(select.sql).not.toContain('source."allowedPatIds"');
    const insert = queries.find((query) =>
      query.sql.includes('INSERT INTO public."EntityToolPolicy"')
    )!;
    expect(insert.values?.[3]).toBe("DENY");
    expect(insert.values?.[5]).toEqual(["mcp:tools"]);
  });

  test("fails closed on source and mapping validation issues", async () => {
    let call = 0;
    const sourceInvalid: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(): Promise<QueryResultLike<Row>> {
        call += 1;
        return {
          rows: (call === 1 ? [{ issue: "entity-secret-or-identity" }] : []) as unknown as Row[],
          rowCount: call === 1 ? 1 : 0,
        };
      },
    };
    await expect(validateRetainedBatch3Checkpoint1Source(sourceInvalid)).rejects.toMatchObject({
      code: "BATCH3_SOURCE_INVALID",
    });
    expect(call).toBe(1);

    call = 0;
    const mappingInvalid: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(): Promise<QueryResultLike<Row>> {
        call += 1;
        return {
          rows: (call === 2 ? [{ issue: "PlatosEntityMcpClient" }] : []) as unknown as Row[],
          rowCount: call === 2 ? 1 : 0,
        };
      },
    };
    await expect(validateRetainedBatch3Checkpoint1Source(mappingInvalid)).rejects.toMatchObject({
      code: "BATCH3_MAPPING_INVALID",
    });
  });

  test("runs separate conservation, ancestry, and shape equations", async () => {
    let call = 0;
    const database: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(): Promise<QueryResultLike<Row>> {
        call += 1;
        return {
          rows: (call === 2 ? [{ issue: "environment-tool" }] : []) as unknown as Row[],
          rowCount: call === 2 ? 1 : 0,
        };
      },
    };

    await expect(validateRetainedBatch3Checkpoint1(database)).rejects.toMatchObject({
      code: "BATCH3_ANCESTRY_FAILED",
    });
    expect(call).toBe(2);
  });

  test("returns only secret-free row-count evidence", async () => {
    const database: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(): Promise<QueryResultLike<Row>> {
        return { rows: [], rowCount: 0 };
      },
    };
    await expect(backfillRetainedBatch3Checkpoint1(database, 2)).resolves.toEqual({
      entityRows: 0,
      mcpConfigRows: 0,
      mcpClientRows: 0,
      environmentToolRows: 0,
      entityPolicyRows: 0,
    });
  });
});
