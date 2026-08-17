import { createHash } from "node:crypto";
import { CUTOVER_CHUNK_SIZE } from "./cutover-backfill";
import {
  assertSecretFreeCutoverEvidence,
  decodeLegacyJsonMessage,
  decodeLegacyPlatosSecret,
  decodeLegacySecretStoreJson,
  serializeAggregateCredentialPayload,
  validateSha256Hex,
  type CutoverJsonValue,
} from "./cutover-crypto";
import { mapCutoverId } from "./cutover-id";
import { aggregateCredentialPayloadContracts } from "./cutover-ledger";
import { normalizeJsonField, type JsonValue } from "./json";
import {
  CredentialRootKeyRing,
  decryptCredentialSecret,
  encryptCredentialSecret,
} from "./secrets";
import type { CutoverDatabase } from "./cutover-types";
import { CutoverFailure } from "./cutover-types";

/** Checkpoint 1 deliberately excludes MCP sessions, bearer tokens, and credentials. */
export const retainedBatch3Checkpoint1SourceModels = [
  "PlatosConnectedEntity",
  "PlatosEntityMcpConfig",
  "PlatosEntityMcpClient",
  "PlatosEntityToolMapping",
  "PlatosEntityMcpToolAcl",
] as const;

export const retainedBatch3Checkpoint1MappingTargets = [
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
] as const;

export interface RetainedBatch3Checkpoint1Evidence {
  readonly entityRows: number;
  readonly mcpConfigRows: number;
  readonly mcpClientRows: number;
  readonly environmentToolRows: number;
  readonly entityPolicyRows: number;
}

function batch3Failure(code: string, message: string): CutoverFailure {
  return new CutoverFailure(code, message);
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

async function forEachSourceChunk<Row extends Record<string, unknown>>(
  database: CutoverDatabase,
  selectSql: string,
  consume: (rows: readonly Row[]) => Promise<void>,
  chunkSize: number
): Promise<number> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new TypeError("cutover chunk size must be a positive integer");
  }

  let cursor = "";
  let consumed = 0;
  while (true) {
    const result = await database.query<Row>(selectSql, [cursor, chunkSize]);
    if (result.rows.length === 0) return consumed;
    await consume(result.rows);
    consumed += result.rows.length;
    const nextCursor = result.rows[result.rows.length - 1]?.source_id;
    if (typeof nextCursor !== "string" || nextCursor <= cursor) {
      throw batch3Failure(
        "BATCH3_CHUNK_ORDER_INVALID",
        "retained Batch 3 checkpoint 1 source chunk order is not stable"
      );
    }
    cursor = nextCursor;
  }
}

function normalizeBatch3Json(
  field: "EntityMcpConfig.identityProviders" | "EntityMcpConfig.branding" | "EntityMcpClient.headersTemplate",
  value: unknown,
  fallback: JsonValue
): JsonValue {
  try {
    return normalizeJsonField(field, value ?? fallback) as unknown as JsonValue;
  } catch {
    throw batch3Failure(
      "BATCH3_MALFORMED_JSON",
      "retained Batch 3 checkpoint 1 JSON has an invalid root"
    );
  }
}

export function normalizeBatch3McpConfigJson(input: {
  readonly identityProviders: unknown;
  readonly branding: unknown;
}): Readonly<{ identityProviders: JsonValue; branding: JsonValue }> {
  return Object.freeze({
    identityProviders: normalizeBatch3Json(
      "EntityMcpConfig.identityProviders",
      input.identityProviders,
      []
    ),
    branding: normalizeBatch3Json("EntityMcpConfig.branding", input.branding, {}),
  });
}

export function normalizeBatch3McpClientHeaders(value: unknown): JsonValue {
  return normalizeBatch3Json("EntityMcpClient.headersTemplate", value, {});
}

/**
 * Both MCP configuration targets share Entity's primary key. The generic map
 * materializer cannot infer this reference identity, so checkpoint 1 replaces
 * only those two generated target UUIDs with the canonical Entity UUID.
 */
export async function materializeRetainedBatch3Checkpoint1SharedMappings(
  database: CutoverDatabase
): Promise<void> {
  for (const sourceModel of ["PlatosEntityMcpConfig", "PlatosEntityMcpClient"] as const) {
    await database.query(
      `UPDATE cutover_legacy.cutover_id_map child
          SET target_id = entity_map.target_id
         FROM cutover_legacy."${sourceModel}" source
         JOIN cutover_legacy.cutover_id_map entity_map
           ON entity_map.mapping_version = 1
          AND entity_map.source_model = 'PlatosConnectedEntity'
          AND entity_map.source_id = source."entityPk"
          AND entity_map.target_model = 'Entity'
          AND entity_map.stable_suffix = ''
        WHERE child.mapping_version = 1
          AND child.source_model = '${sourceModel}'
          AND child.source_id = source."entityPk"
          AND child.target_model = '${sourceModel === "PlatosEntityMcpConfig" ? "EntityMcpConfig" : "EntityMcpClient"}'
          AND child.stable_suffix = ''`
    );
  }
}

const checkpoint1SourceValidationSql = `
  WITH issues AS (
    SELECT 'entity-secret-or-identity' AS issue
      WHERE EXISTS (
        SELECT 1 FROM cutover_legacy."PlatosConnectedEntity" entity
         WHERE entity."serviceSecret" IS NULL OR entity."serviceSecret" = ''
            OR btrim(entity."entityId") = '' OR btrim(entity."displayName") = '')
    UNION ALL
    SELECT 'entity-source-ancestry'
      WHERE EXISTS (
        SELECT 1 FROM cutover_legacy."PlatosConnectedEntity" entity
        LEFT JOIN cutover_legacy."Project" project ON project.id = entity."projectId"
        WHERE project.id IS NULL OR project."organizationId" <> entity."organizationId")
    UNION ALL
    SELECT 'entity-required-environment-fanout'
      WHERE EXISTS (
        SELECT 1 FROM cutover_legacy."PlatosConnectedEntity" entity
        WHERE NOT EXISTS (
          SELECT 1 FROM cutover_legacy."RuntimeEnvironment" environment
           WHERE environment."projectId" = entity."projectId"
             AND environment."organizationId" = entity."organizationId"))
    UNION ALL
    SELECT 'entity-target-key-collision'
      WHERE EXISTS (
        SELECT entity."projectId", entity."entityId"
          FROM cutover_legacy."PlatosConnectedEntity" entity
         GROUP BY entity."projectId", entity."entityId" HAVING count(*) > 1)
    UNION ALL
    SELECT 'mcp-child-parent'
      WHERE EXISTS (
        SELECT config."entityPk"
          FROM cutover_legacy."PlatosEntityMcpConfig" config
          LEFT JOIN cutover_legacy."PlatosConnectedEntity" entity ON entity.id = config."entityPk"
         WHERE entity.id IS NULL
        UNION ALL
        SELECT client."entityPk"
          FROM cutover_legacy."PlatosEntityMcpClient" client
          LEFT JOIN cutover_legacy."PlatosConnectedEntity" entity ON entity.id = client."entityPk"
         WHERE entity.id IS NULL OR client."credsSecretKey" = '')
    UNION ALL
    SELECT 'tool-mapping-ancestry'
      WHERE EXISTS (
        SELECT 1 FROM cutover_legacy."PlatosEntityToolMapping" mapping
        LEFT JOIN cutover_legacy."PlatosConnectedEntity" entity ON entity.id = mapping."entityId"
        LEFT JOIN cutover_legacy."PlatosToolDefinition" tool ON tool.id = mapping."toolId"
        LEFT JOIN cutover_legacy."RuntimeEnvironment" environment
          ON environment.id = mapping."environmentId"
        WHERE entity.id IS NULL OR tool.id IS NULL OR environment.id IS NULL
           OR environment."projectId" <> entity."projectId"
           OR environment."organizationId" <> entity."organizationId"
           OR (tool."projectId" IS NOT NULL AND tool."projectId" <> entity."projectId")
           OR (tool."organizationId" IS NOT NULL
               AND tool."organizationId" <> entity."organizationId"))
    UNION ALL
    SELECT 'tool-policy-ancestry'
      WHERE EXISTS (
        SELECT 1 FROM cutover_legacy."PlatosEntityMcpToolAcl" policy
        LEFT JOIN cutover_legacy."PlatosConnectedEntity" entity ON entity.id = policy."entityPk"
        LEFT JOIN cutover_legacy."PlatosToolDefinition" tool ON tool.id = policy."toolId"
        WHERE entity.id IS NULL OR tool.id IS NULL OR policy."toolName" <> tool.name
           OR (tool."projectId" IS NOT NULL AND tool."projectId" <> entity."projectId")
           OR (tool."organizationId" IS NOT NULL
               AND tool."organizationId" <> entity."organizationId"))
  )
  SELECT issue FROM issues ORDER BY issue`;

const checkpoint1MappingValidationSql = `
  WITH expected(source_model, source_id, target_model, expected_target_id) AS (
    SELECT 'PlatosConnectedEntity', entity.id::text, 'Entity', entity_map.target_id
      FROM cutover_legacy."PlatosConnectedEntity" entity
      LEFT JOIN cutover_legacy.cutover_id_map entity_map
        ON entity_map.mapping_version = 1
       AND entity_map.source_model = 'PlatosConnectedEntity'
       AND entity_map.source_id = entity.id
       AND entity_map.target_model = 'Entity'
       AND entity_map.stable_suffix = ''
    UNION ALL
    SELECT 'PlatosEntityMcpConfig', config."entityPk", 'EntityMcpConfig', entity_map.target_id
      FROM cutover_legacy."PlatosEntityMcpConfig" config
      LEFT JOIN cutover_legacy.cutover_id_map entity_map
        ON entity_map.mapping_version = 1
       AND entity_map.source_model = 'PlatosConnectedEntity'
       AND entity_map.source_id = config."entityPk"
       AND entity_map.target_model = 'Entity'
       AND entity_map.stable_suffix = ''
    UNION ALL
    SELECT 'PlatosEntityMcpClient', client."entityPk", 'EntityMcpClient', entity_map.target_id
      FROM cutover_legacy."PlatosEntityMcpClient" client
      LEFT JOIN cutover_legacy.cutover_id_map entity_map
        ON entity_map.mapping_version = 1
       AND entity_map.source_model = 'PlatosConnectedEntity'
       AND entity_map.source_id = client."entityPk"
       AND entity_map.target_model = 'Entity'
       AND entity_map.stable_suffix = ''
    UNION ALL
    SELECT 'PlatosEntityToolMapping', mapping.id::text, 'EnvironmentEntityTool', NULL::uuid
      FROM cutover_legacy."PlatosEntityToolMapping" mapping
    UNION ALL
    SELECT 'PlatosEntityMcpToolAcl', policy.id::text, 'EntityToolPolicy', NULL::uuid
      FROM cutover_legacy."PlatosEntityMcpToolAcl" policy
  )
  SELECT expected.source_model AS issue
    FROM expected
   WHERE (SELECT count(*) FROM cutover_legacy.cutover_id_map map
           WHERE map.mapping_version = 1
             AND map.source_model = expected.source_model
             AND map.source_id = expected.source_id
             AND map.target_model = expected.target_model
             AND map.stable_suffix = ''
             AND (expected.expected_target_id IS NULL
                  OR map.target_id = expected.expected_target_id)) <> 1
   ORDER BY expected.source_model LIMIT 20`;

export async function validateRetainedBatch3Checkpoint1Source(
  database: CutoverDatabase
): Promise<void> {
  const sourceIssues = await database.query<{ issue: string }>(checkpoint1SourceValidationSql);
  if (sourceIssues.rows.length > 0) {
    throw batch3Failure(
      "BATCH3_SOURCE_INVALID",
      `retained Batch 3 checkpoint 1 source validation failed: ${sourceIssues.rows
        .map((row) => row.issue)
        .join(", ")}`
    );
  }

  const mappingIssues = await database.query<{ issue: string }>(checkpoint1MappingValidationSql);
  if (mappingIssues.rows.length > 0) {
    throw batch3Failure(
      "BATCH3_MAPPING_INVALID",
      "retained Batch 3 checkpoint 1 deterministic mappings are incomplete or non-canonical"
    );
  }
}

interface EntitySourceRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  project_id: string;
  external_id: string;
  display_name: string;
  connection_status: string;
  connection_kind: string;
  mcp_urls: string[];
  allowed_origins: string[];
  capabilities: string[];
  last_connected_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export async function backfillBatch3Checkpoint1Entities(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachSourceChunk<EntitySourceRow>(
    database,
    `SELECT source.id::text AS source_id, entity_map.target_id::text AS target_id,
            project_map.target_id::text AS project_id, source."entityId" AS external_id,
            source."displayName" AS display_name,
            source."connectionStatus" AS connection_status,
            source."connectionKind" AS connection_kind, source."mcpUrls" AS mcp_urls,
            source."allowedOrigins" AS allowed_origins, source.capabilities,
            source."lastConnectedAt" AS last_connected_at,
            source."createdAt" AS created_at, source."updatedAt" AS updated_at
       FROM cutover_legacy."PlatosConnectedEntity" source
       JOIN cutover_legacy.cutover_id_map entity_map
         ON entity_map.mapping_version = 1
        AND entity_map.source_model = 'PlatosConnectedEntity'
        AND entity_map.source_id = source.id AND entity_map.target_model = 'Entity'
        AND entity_map.stable_suffix = ''
       JOIN cutover_legacy.cutover_id_map project_map
         ON project_map.mapping_version = 1 AND project_map.source_model = 'Project'
        AND project_map.source_id = source."projectId" AND project_map.target_model = 'Project'
        AND project_map.stable_suffix = ''
      WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."Entity"
          (id, "projectId", "externalId", "displayName", "connectionStatus",
           "connectionKind", "mcpUrls", "allowedOrigins", capabilities,
           "lastConnectedAt", "createdAt", "updatedAt")
         VALUES ${parameterTuples(rows.length, 12)}`,
        rows.flatMap((row) => [
          row.target_id,
          row.project_id,
          row.external_id,
          row.display_name,
          row.connection_status,
          row.connection_kind,
          row.mcp_urls,
          row.allowed_origins,
          row.capabilities,
          row.last_connected_at,
          row.created_at,
          row.updated_at,
        ])
      );
    },
    chunkSize
  );
}

interface McpConfigSourceRow extends Record<string, unknown> {
  source_id: string;
  entity_id: string;
  enabled: boolean;
  identity_mode: string;
  identity_providers: unknown;
  branding: unknown;
  tool_allowlist: string[];
  redirect_uri_allowlist: string[];
  rate_limit_per_minute: number;
  inject_mcp_context: boolean;
  created_at: Date;
  updated_at: Date;
}

export async function backfillBatch3Checkpoint1McpConfigs(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachSourceChunk<McpConfigSourceRow>(
    database,
    `SELECT source."entityPk"::text AS source_id, entity_map.target_id::text AS entity_id,
            source.enabled, source."identityMode" AS identity_mode,
            source."identityProviders" AS identity_providers, source.branding,
            source."toolAllowlist" AS tool_allowlist,
            source."redirectUriAllowlist" AS redirect_uri_allowlist,
            source."rateLimitPerMinute" AS rate_limit_per_minute,
            source."injectMcpContext" AS inject_mcp_context,
            source."createdAt" AS created_at, source."updatedAt" AS updated_at
       FROM cutover_legacy."PlatosEntityMcpConfig" source
       JOIN cutover_legacy.cutover_id_map entity_map
         ON entity_map.mapping_version = 1
        AND entity_map.source_model = 'PlatosConnectedEntity'
        AND entity_map.source_id = source."entityPk" AND entity_map.target_model = 'Entity'
        AND entity_map.stable_suffix = ''
      WHERE source."entityPk" > $1 ORDER BY source."entityPk" LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."EntityMcpConfig"
          ("entityId", enabled, "identityMode", "identityProviders", branding,
           "toolAllowlist", "redirectUriAllowlist", "rateLimitPerMinute",
           "injectMcpContext", "createdAt", "updatedAt")
         VALUES ${parameterTuples(rows.length, 11)}`,
        rows.flatMap((row) => {
          const json = normalizeBatch3McpConfigJson({
            identityProviders: row.identity_providers,
            branding: row.branding,
          });
          return [
            row.entity_id,
            row.enabled,
            row.identity_mode,
            JSON.stringify(json.identityProviders),
            JSON.stringify(json.branding),
            row.tool_allowlist,
            row.redirect_uri_allowlist,
            row.rate_limit_per_minute,
            row.inject_mcp_context,
            row.created_at,
            row.updated_at,
          ];
        })
      );
    },
    chunkSize
  );
}

interface McpClientSourceRow extends Record<string, unknown> {
  source_id: string;
  entity_id: string;
  transport: string;
  url: string | null;
  headers_template: unknown;
  last_discovery_at: Date | null;
  discovery_error: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Credential linkage is intentionally left nullable until checkpoint 2. */
export async function backfillBatch3Checkpoint1McpClients(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachSourceChunk<McpClientSourceRow>(
    database,
    `SELECT source."entityPk"::text AS source_id, entity_map.target_id::text AS entity_id,
            source.transport, source.url, source."headersTemplate" AS headers_template,
            source."lastDiscoveryAt" AS last_discovery_at,
            source."discoveryError" AS discovery_error,
            source."createdAt" AS created_at, source."updatedAt" AS updated_at
       FROM cutover_legacy."PlatosEntityMcpClient" source
       JOIN cutover_legacy.cutover_id_map entity_map
         ON entity_map.mapping_version = 1
        AND entity_map.source_model = 'PlatosConnectedEntity'
        AND entity_map.source_id = source."entityPk" AND entity_map.target_model = 'Entity'
        AND entity_map.stable_suffix = ''
      WHERE source."entityPk" > $1 ORDER BY source."entityPk" LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."EntityMcpClient"
          ("entityId", transport, url, "credentialId", "headersTemplate",
           "lastDiscoveryAt", "discoveryError", "createdAt", "updatedAt")
         VALUES ${parameterTuples(rows.length, 9)}`,
        rows.flatMap((row) => [
          row.entity_id,
          row.transport,
          row.url,
          null,
          JSON.stringify(normalizeBatch3McpClientHeaders(row.headers_template)),
          row.last_discovery_at,
          row.discovery_error,
          row.created_at,
          row.updated_at,
        ])
      );
    },
    chunkSize
  );
}

interface EnvironmentEntityToolSourceRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  environment_id: string;
  entity_id: string;
  tool_id: string;
  enabled: boolean;
  callback_url: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function backfillBatch3Checkpoint1EnvironmentTools(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachSourceChunk<EnvironmentEntityToolSourceRow>(
    database,
    `SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
            environment_map.target_id::text AS environment_id,
            entity_map.target_id::text AS entity_id, tool_map.target_id::text AS tool_id,
            source.enabled, source."callbackUrl" AS callback_url,
            source."createdAt" AS created_at, source."updatedAt" AS updated_at
       FROM cutover_legacy."PlatosEntityToolMapping" source
       JOIN cutover_legacy.cutover_id_map target_map
         ON target_map.mapping_version = 1
        AND target_map.source_model = 'PlatosEntityToolMapping'
        AND target_map.source_id = source.id
        AND target_map.target_model = 'EnvironmentEntityTool'
        AND target_map.stable_suffix = ''
       JOIN cutover_legacy.cutover_id_map environment_map
         ON environment_map.mapping_version = 1
        AND environment_map.source_model = 'RuntimeEnvironment'
        AND environment_map.source_id = source."environmentId"
        AND environment_map.target_model = 'Environment'
        AND environment_map.stable_suffix = ''
       JOIN cutover_legacy.cutover_id_map entity_map
         ON entity_map.mapping_version = 1
        AND entity_map.source_model = 'PlatosConnectedEntity'
        AND entity_map.source_id = source."entityId" AND entity_map.target_model = 'Entity'
        AND entity_map.stable_suffix = ''
       JOIN cutover_legacy.cutover_id_map tool_map
         ON tool_map.mapping_version = 1 AND tool_map.source_model = 'PlatosToolDefinition'
        AND tool_map.source_id = source."toolId" AND tool_map.target_model = 'Tool'
        AND tool_map.stable_suffix = ''
      WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."EnvironmentEntityTool"
          (id, "environmentId", "entityId", "toolId", enabled, "callbackUrl",
           "createdAt", "updatedAt")
         VALUES ${parameterTuples(rows.length, 8)}`,
        rows.flatMap((row) => [
          row.target_id,
          row.environment_id,
          row.entity_id,
          row.tool_id,
          row.enabled,
          row.callback_url,
          row.created_at,
          row.updated_at,
        ])
      );
    },
    chunkSize
  );
}

interface EntityToolPolicySourceRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  entity_id: string;
  tool_id: string;
  exposed: boolean;
  min_identity_mode: string;
  scope_labels: string[];
  added_by: string;
  added_at: Date;
  last_reviewed_at: Date | null;
}

export function batch3PolicyEffect(exposed: boolean): "ALLOW" | "DENY" {
  return exposed ? "ALLOW" : "DENY";
}

export async function backfillBatch3Checkpoint1EntityPolicies(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachSourceChunk<EntityToolPolicySourceRow>(
    database,
    `SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
            entity_map.target_id::text AS entity_id, tool_map.target_id::text AS tool_id,
            source.exposed, source."minIdentityMode" AS min_identity_mode,
            source."scopeLabels" AS scope_labels, source."addedBy" AS added_by,
            source."addedAt" AS added_at, source."lastReviewedAt" AS last_reviewed_at
       FROM cutover_legacy."PlatosEntityMcpToolAcl" source
       JOIN cutover_legacy.cutover_id_map target_map
         ON target_map.mapping_version = 1
        AND target_map.source_model = 'PlatosEntityMcpToolAcl'
        AND target_map.source_id = source.id AND target_map.target_model = 'EntityToolPolicy'
        AND target_map.stable_suffix = ''
       JOIN cutover_legacy.cutover_id_map entity_map
         ON entity_map.mapping_version = 1
        AND entity_map.source_model = 'PlatosConnectedEntity'
        AND entity_map.source_id = source."entityPk" AND entity_map.target_model = 'Entity'
        AND entity_map.stable_suffix = ''
       JOIN cutover_legacy.cutover_id_map tool_map
         ON tool_map.mapping_version = 1 AND tool_map.source_model = 'PlatosToolDefinition'
        AND tool_map.source_id = source."toolId" AND tool_map.target_model = 'Tool'
        AND tool_map.stable_suffix = ''
      WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."EntityToolPolicy"
          (id, "entityId", "toolId", effect, "minIdentityMode", "scopeLabels",
           "addedBy", "addedAt", "lastReviewedAt")
         VALUES ${parameterTuples(rows.length, 9)}`,
        rows.flatMap((row) => [
          row.target_id,
          row.entity_id,
          row.tool_id,
          batch3PolicyEffect(row.exposed),
          row.min_identity_mode,
          row.scope_labels,
          row.added_by,
          row.added_at,
          row.last_reviewed_at,
        ])
      );
    },
    chunkSize
  );
}

export async function backfillRetainedBatch3Checkpoint1(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<RetainedBatch3Checkpoint1Evidence> {
  await materializeRetainedBatch3Checkpoint1SharedMappings(database);
  await validateRetainedBatch3Checkpoint1Source(database);
  const evidence = Object.freeze({
    entityRows: await backfillBatch3Checkpoint1Entities(database, chunkSize),
    mcpConfigRows: await backfillBatch3Checkpoint1McpConfigs(database, chunkSize),
    mcpClientRows: await backfillBatch3Checkpoint1McpClients(database, chunkSize),
    environmentToolRows: await backfillBatch3Checkpoint1EnvironmentTools(database, chunkSize),
    entityPolicyRows: await backfillBatch3Checkpoint1EntityPolicies(database, chunkSize),
  });
  assertSecretFreeCutoverEvidence(evidence);
  return evidence;
}

const checkpoint1ConservationSql = `
  WITH equations(id, source_count, target_count) AS (
    VALUES
      ('entities',
       (SELECT count(*) FROM cutover_legacy."PlatosConnectedEntity"),
       (SELECT count(*) FROM public."Entity" target
         JOIN cutover_legacy.cutover_id_map map
           ON map.mapping_version = 1 AND map.source_model = 'PlatosConnectedEntity'
          AND map.target_model = 'Entity' AND map.target_id = target.id)),
      ('mcp-configs',
       (SELECT count(*) FROM cutover_legacy."PlatosEntityMcpConfig"),
       (SELECT count(*) FROM public."EntityMcpConfig" target
         JOIN cutover_legacy.cutover_id_map map
           ON map.mapping_version = 1 AND map.source_model = 'PlatosEntityMcpConfig'
          AND map.target_model = 'EntityMcpConfig' AND map.target_id = target."entityId")),
      ('mcp-clients',
       (SELECT count(*) FROM cutover_legacy."PlatosEntityMcpClient"),
       (SELECT count(*) FROM public."EntityMcpClient" target
         JOIN cutover_legacy.cutover_id_map map
           ON map.mapping_version = 1 AND map.source_model = 'PlatosEntityMcpClient'
          AND map.target_model = 'EntityMcpClient' AND map.target_id = target."entityId")),
      ('environment-tools',
       (SELECT count(*) FROM cutover_legacy."PlatosEntityToolMapping"),
       (SELECT count(*) FROM public."EnvironmentEntityTool" target
         JOIN cutover_legacy.cutover_id_map map
           ON map.mapping_version = 1 AND map.source_model = 'PlatosEntityToolMapping'
          AND map.target_model = 'EnvironmentEntityTool' AND map.target_id = target.id)),
      ('entity-policies',
       (SELECT count(*) FROM cutover_legacy."PlatosEntityMcpToolAcl"),
       (SELECT count(*) FROM public."EntityToolPolicy" target
         JOIN cutover_legacy.cutover_id_map map
           ON map.mapping_version = 1 AND map.source_model = 'PlatosEntityMcpToolAcl'
          AND map.target_model = 'EntityToolPolicy' AND map.target_id = target.id))
  )
  SELECT id FROM equations WHERE source_count <> target_count ORDER BY id`;

const checkpoint1AncestrySql = `
  WITH issues AS (
    SELECT 'entity' AS issue FROM public."Entity" target
    JOIN cutover_legacy.cutover_id_map map
      ON map.mapping_version = 1 AND map.source_model = 'PlatosConnectedEntity'
     AND map.target_model = 'Entity' AND map.target_id = target.id
    LEFT JOIN public."Project" project ON project.id = target."projectId"
    WHERE project.id IS NULL
    UNION ALL
    SELECT 'mcp-config' FROM public."EntityMcpConfig" target
    JOIN cutover_legacy.cutover_id_map map
      ON map.mapping_version = 1 AND map.source_model = 'PlatosEntityMcpConfig'
     AND map.target_model = 'EntityMcpConfig' AND map.target_id = target."entityId"
    LEFT JOIN public."Entity" entity ON entity.id = target."entityId"
    WHERE entity.id IS NULL
    UNION ALL
    SELECT 'mcp-client' FROM public."EntityMcpClient" target
    JOIN cutover_legacy.cutover_id_map map
      ON map.mapping_version = 1 AND map.source_model = 'PlatosEntityMcpClient'
     AND map.target_model = 'EntityMcpClient' AND map.target_id = target."entityId"
    LEFT JOIN public."Entity" entity ON entity.id = target."entityId"
    LEFT JOIN public."Credential" credential ON credential.id = target."credentialId"
    LEFT JOIN public."Environment" credential_environment
      ON credential_environment.id = credential."environmentId"
     AND credential_environment."projectId" = entity."projectId"
    WHERE entity.id IS NULL
       OR (target."credentialId" IS NOT NULL AND credential_environment.id IS NULL)
    UNION ALL
    SELECT 'environment-tool' FROM public."EnvironmentEntityTool" target
    JOIN cutover_legacy.cutover_id_map map
      ON map.mapping_version = 1 AND map.source_model = 'PlatosEntityToolMapping'
     AND map.target_model = 'EnvironmentEntityTool' AND map.target_id = target.id
    LEFT JOIN public."Environment" environment ON environment.id = target."environmentId"
    LEFT JOIN public."Entity" entity
      ON entity.id = target."entityId" AND entity."projectId" = environment."projectId"
    LEFT JOIN public."Tool" tool ON tool.id = target."toolId"
    WHERE environment.id IS NULL OR entity.id IS NULL OR tool.id IS NULL
    UNION ALL
    SELECT 'entity-policy' FROM public."EntityToolPolicy" target
    JOIN cutover_legacy.cutover_id_map map
      ON map.mapping_version = 1 AND map.source_model = 'PlatosEntityMcpToolAcl'
     AND map.target_model = 'EntityToolPolicy' AND map.target_id = target.id
    LEFT JOIN public."Entity" entity ON entity.id = target."entityId"
    LEFT JOIN public."Tool" tool ON tool.id = target."toolId"
    WHERE entity.id IS NULL OR tool.id IS NULL
  )
  SELECT DISTINCT issue FROM issues ORDER BY issue`;

const checkpoint1ShapeSql = `
  WITH issues AS (
    SELECT 'mcp-config-json' AS issue FROM public."EntityMcpConfig" target
    JOIN cutover_legacy.cutover_id_map map
      ON map.mapping_version = 1 AND map.source_model = 'PlatosEntityMcpConfig'
     AND map.target_model = 'EntityMcpConfig' AND map.target_id = target."entityId"
    WHERE jsonb_typeof(target."identityProviders") <> 'array'
       OR jsonb_typeof(target.branding) <> 'object'
    UNION ALL
    SELECT 'mcp-client-json' FROM public."EntityMcpClient" target
    JOIN cutover_legacy.cutover_id_map map
      ON map.mapping_version = 1 AND map.source_model = 'PlatosEntityMcpClient'
     AND map.target_model = 'EntityMcpClient' AND map.target_id = target."entityId"
    WHERE jsonb_typeof(target."headersTemplate") <> 'object'
    UNION ALL
    SELECT 'policy-effect' FROM public."EntityToolPolicy" target
    JOIN cutover_legacy.cutover_id_map map
      ON map.mapping_version = 1 AND map.source_model = 'PlatosEntityMcpToolAcl'
     AND map.target_model = 'EntityToolPolicy' AND map.target_id = target.id
    JOIN cutover_legacy."PlatosEntityMcpToolAcl" source
      ON source.id = map.source_id
    WHERE target.effect::text <> CASE WHEN source.exposed THEN 'ALLOW' ELSE 'DENY' END
  )
  SELECT DISTINCT issue FROM issues ORDER BY issue`;

async function assertCheckpoint1Validation(
  database: CutoverDatabase,
  sql: string,
  code: string,
  summary: string
): Promise<void> {
  const issues = await database.query<{ id?: string; issue?: string }>(sql);
  if (issues.rows.length > 0) {
    throw batch3Failure(
      code,
      `${summary}: ${issues.rows.map((row) => row.id ?? row.issue ?? "unknown").join(", ")}`
    );
  }
}

export async function validateRetainedBatch3Checkpoint1(
  database: CutoverDatabase
): Promise<void> {
  await assertCheckpoint1Validation(
    database,
    checkpoint1ConservationSql,
    "BATCH3_CONSERVATION_FAILED",
    "retained Batch 3 checkpoint 1 conservation failed"
  );
  await assertCheckpoint1Validation(
    database,
    checkpoint1AncestrySql,
    "BATCH3_ANCESTRY_FAILED",
    "retained Batch 3 checkpoint 1 ancestry failed"
  );
  await assertCheckpoint1Validation(
    database,
    checkpoint1ShapeSql,
    "BATCH3_SHAPE_FAILED",
    "retained Batch 3 checkpoint 1 JSON or policy transform validation failed"
  );
}

export const retainedBatch3SourceModels = [
  ...retainedBatch3Checkpoint1SourceModels,
  "PlatosMcpAnonSession",
  "PlatosMcpOidcSession",
  "PlatosMcpBearerToken",
] as const;

export const retainedBatch3MappingTargets = [
  ...retainedBatch3Checkpoint1MappingTargets,
  { sourceModel: "PlatosMcpAnonSession", targetModel: "McpAnonymousSession", stableSuffix: "" },
  { sourceModel: "PlatosMcpOidcSession", targetModel: "McpOidcSession", stableSuffix: "" },
  { sourceModel: "PlatosMcpBearerToken", targetModel: "McpBearerToken", stableSuffix: "" },
] as const;

const entityAggregate = aggregateCredentialPayloadContracts.find(
  (contract) => contract.id === "entity-service-and-test"
)!;
const oidcAggregate = aggregateCredentialPayloadContracts.find(
  (contract) => contract.id === "mcp-oidc-tokens"
)!;

export interface RetainedBatch3Options {
  readonly legacyEncryptionKey: string;
  readonly platosEncryptionKey: string;
  readonly messageEncryptionKeys: Readonly<Record<string, string>>;
  readonly credentialRootKeyRing: CredentialRootKeyRing;
}

export interface RetainedBatch3Evidence extends RetainedBatch3Checkpoint1Evidence {
  readonly entityAuthRows: number;
  readonly mcpClientAuthRows: number;
  readonly anonymousSessionRows: number;
  readonly oidcSessionRows: number;
  readonly oidcAuthRows: number;
  readonly bearerTokenRows: number;
}

interface GeneratedBatch3Credential {
  readonly id: string;
  readonly versionId: string;
  readonly environmentId: string;
  readonly kind: "ENTITY_SECRET" | "SERVICE_CREDENTIAL";
  readonly name: string;
  readonly prefix: string | null;
  readonly secretHash: string | null;
  readonly permissions: readonly string[];
  readonly plaintext: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function canonicalizeBatch3Json(value: CutoverJsonValue): CutoverJsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalizeBatch3Json);
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, canonicalizeBatch3Json(child)])
  );
}

function nonEmptyBatch3Utf8(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw batch3Failure(code, "retained Batch 3 secret material is unavailable");
  }
  const encoded = Buffer.from(value, "utf8");
  try {
    if (new TextDecoder("utf-8", { fatal: true }).decode(encoded) !== value) throw new Error();
  } catch {
    throw batch3Failure(code, "retained Batch 3 secret material is unavailable");
  }
  return value;
}

/** Strictly decodes the JSON-field envelope used by entity test credentials. */
export function decodeBatch3EntityTestCredentials(
  sourceValue: unknown,
  messageEncryptionKeys: Readonly<Record<string, string>>
): string | null {
  if (sourceValue === null || sourceValue === undefined) return null;
  try {
    const decoded = decodeLegacyJsonMessage(sourceValue, "TEXT", messageEncryptionKeys).value;
    const parsed = typeof decoded === "string" ? (JSON.parse(decoded) as unknown) : decoded;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return JSON.stringify(canonicalizeBatch3Json(parsed as CutoverJsonValue));
  } catch {
    throw batch3Failure(
      "BATCH3_ENTITY_TEST_CREDENTIALS_UNREADABLE",
      "retained Batch 3 entity test credential envelope is unreadable"
    );
  }
}

function isPackedBatch3CiphertextCandidate(value: string): boolean {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return false;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.length > 32 && decoded.toString("base64") === value;
}

/**
 * OIDC token history is unversioned. Packed-ciphertext-shaped values must
 * decrypt under exactly one configured legacy key and never fall back to text.
 */
export function decodeBatch3OidcToken(
  sourceValue: unknown,
  options: Pick<RetainedBatch3Options, "platosEncryptionKey" | "messageEncryptionKeys">
): string | null {
  if (sourceValue === null || sourceValue === undefined) return null;
  const value = nonEmptyBatch3Utf8(sourceValue, "BATCH3_OIDC_TOKEN_UNREADABLE");
  if (!isPackedBatch3CiphertextCandidate(value)) return value;

  const keys = [...new Set([options.platosEncryptionKey, ...Object.values(options.messageEncryptionKeys)])];
  const successful: string[] = [];
  for (const key of keys) {
    try {
      successful.push(
        nonEmptyBatch3Utf8(
          decodeLegacyPlatosSecret(value, key),
          "BATCH3_OIDC_TOKEN_UNREADABLE"
        )
      );
    } catch {
      // Zero or multiple successful key-domain matches fail below.
    }
  }
  if (successful.length !== 1) {
    throw batch3Failure(
      "BATCH3_OIDC_TOKEN_UNREADABLE",
      "retained Batch 3 OIDC token is unreadable or ambiguous"
    );
  }
  return successful[0]!;
}

export function validateBatch3TokenHash(value: unknown): string {
  try {
    return validateSha256Hex(value);
  } catch {
    throw batch3Failure(
      "BATCH3_INVALID_TOKEN_HASH",
      "retained Batch 3 bearer token hash is malformed"
    );
  }
}

function exactBatch3SecretStorePayload(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw batch3Failure(
      "BATCH3_MCP_CLIENT_SECRET_UNREADABLE",
      "retained Batch 3 outbound MCP credential is unreadable"
    );
  }
  const names = Object.getOwnPropertyNames(value);
  const descriptor = Object.getOwnPropertyDescriptor(value, "secret");
  if (
    names.length !== 1 ||
    names[0] !== "secret" ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    !descriptor?.enumerable ||
    !("value" in descriptor)
  ) {
    throw batch3Failure(
      "BATCH3_MCP_CLIENT_SECRET_UNREADABLE",
      "retained Batch 3 outbound MCP credential is unreadable"
    );
  }
  return nonEmptyBatch3Utf8(descriptor.value, "BATCH3_MCP_CLIENT_SECRET_UNREADABLE");
}

export function decodeBatch3McpClientSecret(
  row: { readonly version: unknown; readonly value: unknown },
  legacyEncryptionKey: string
): string {
  try {
    return exactBatch3SecretStorePayload(decodeLegacySecretStoreJson(row, legacyEncryptionKey));
  } catch (error) {
    if (error instanceof CutoverFailure) throw error;
    throw batch3Failure(
      "BATCH3_MCP_CLIENT_SECRET_UNREADABLE",
      "retained Batch 3 outbound MCP credential is unreadable"
    );
  }
}

export function buildBatch3EntityCredentialPayload(
  serviceSecret: unknown,
  testCredentials: unknown,
  messageEncryptionKeys: Readonly<Record<string, string>>
): string {
  const service = nonEmptyBatch3Utf8(serviceSecret, "BATCH3_ENTITY_SECRET_UNREADABLE");
  const test = decodeBatch3EntityTestCredentials(testCredentials, messageEncryptionKeys);
  try {
    return serializeAggregateCredentialPayload(entityAggregate, {
      "PlatosConnectedEntity.serviceSecret": service,
      "PlatosConnectedEntity.testCredentials": test,
    });
  } catch {
    throw batch3Failure(
      "BATCH3_ENTITY_SECRET_UNREADABLE",
      "retained Batch 3 entity credential aggregate is invalid"
    );
  }
}

export function buildBatch3OidcCredentialPayload(
  accessToken: unknown,
  refreshToken: unknown,
  options: Pick<RetainedBatch3Options, "platosEncryptionKey" | "messageEncryptionKeys">
): string | null {
  const access = decodeBatch3OidcToken(accessToken, options);
  const refresh = decodeBatch3OidcToken(refreshToken, options);
  if (access === null && refresh === null) return null;
  try {
    return serializeAggregateCredentialPayload(oidcAggregate, {
      "PlatosMcpOidcSession.entityAccessToken": access,
      "PlatosMcpOidcSession.entityRefreshToken": refresh,
    });
  } catch {
    throw batch3Failure(
      "BATCH3_OIDC_TOKEN_UNREADABLE",
      "retained Batch 3 OIDC credential aggregate is invalid"
    );
  }
}

export function batch3EntityCredentialName(
  entitySourceId: string,
  targetEnvironmentId: string
): string {
  return `PlatosConnectedEntity:${entitySourceId}:${targetEnvironmentId}:entity-auth`;
}

export function batch3OidcCredentialName(sourceId: string): string {
  return `PlatosMcpOidcSession:${sourceId}:mcp-oidc-tokens`;
}

function entityCredentialSuffix(environmentId: string): string {
  return `entity-auth:${environmentId}`;
}

function entityCredentialVersionSuffix(environmentId: string): string {
  return `${entityCredentialSuffix(environmentId)}:secret-version:1`;
}

export function batch3EntityCredentialIds(
  sourceId: string,
  targetEnvironmentId: string
): Readonly<{ credentialId: string; versionId: string }> {
  return Object.freeze({
    credentialId: mapCutoverId({
      sourceModel: "PlatosConnectedEntity",
      sourceId,
      suffix: entityCredentialSuffix(targetEnvironmentId),
    }),
    versionId: mapCutoverId({
      sourceModel: "PlatosConnectedEntity",
      sourceId,
      suffix: entityCredentialVersionSuffix(targetEnvironmentId),
    }),
  });
}

export function batch3McpClientCredentialIds(
  sourceId: string
): Readonly<{ credentialId: string; versionId: string }> {
  return Object.freeze({
    credentialId: mapCutoverId({
      sourceModel: "PlatosEntityMcpClient",
      sourceId,
      suffix: "credential",
    }),
    versionId: mapCutoverId({
      sourceModel: "PlatosEntityMcpClient",
      sourceId,
      suffix: "credential-secret-version:1",
    }),
  });
}

export function batch3OidcCredentialIds(
  sourceId: string
): Readonly<{ credentialId: string; versionId: string }> {
  return Object.freeze({
    credentialId: mapCutoverId({
      sourceModel: "PlatosMcpOidcSession",
      sourceId,
      suffix: "credential",
    }),
    versionId: mapCutoverId({
      sourceModel: "PlatosMcpOidcSession",
      sourceId,
      suffix: "credential-secret-version:1",
    }),
  });
}

interface DynamicBatch3MappingRow extends Record<string, unknown> {
  source_model: string;
  source_id: string;
  target_model: string;
  stable_suffix: string;
}

/** Adds only the data-dependent credential mappings owned by Batch 3. */
export async function materializeRetainedBatch3Checkpoint2Mappings(
  database: CutoverDatabase
): Promise<number> {
  await materializeRetainedBatch3Checkpoint1SharedMappings(database);
  await database.query(`DELETE FROM cutover_legacy.cutover_id_map
    WHERE mapping_version = 1 AND (
      (source_model = 'PlatosConnectedEntity'
       AND target_model IN ('Credential', 'CredentialSecretVersion')) OR
      (source_model = 'PlatosEntityMcpClient'
       AND target_model IN ('Credential', 'CredentialSecretVersion')) OR
      (source_model = 'PlatosMcpOidcSession'
       AND target_model IN ('Credential', 'CredentialSecretVersion')))`);

  const mappings = await database.query<DynamicBatch3MappingRow>(`
    SELECT 'PlatosConnectedEntity'::text AS source_model, entity.id::text AS source_id,
           target.target_model,
           CASE target.target_model
             WHEN 'Credential' THEN 'entity-auth:' || environment_map.target_id::text
             ELSE 'entity-auth:' || environment_map.target_id::text || ':secret-version:1'
           END AS stable_suffix
      FROM cutover_legacy."PlatosConnectedEntity" entity
      JOIN cutover_legacy."RuntimeEnvironment" environment
        ON environment."projectId" = entity."projectId"
       AND environment."organizationId" = entity."organizationId"
      JOIN cutover_legacy.cutover_id_map environment_map
        ON environment_map.mapping_version = 1
       AND environment_map.source_model = 'RuntimeEnvironment'
       AND environment_map.source_id = environment.id
       AND environment_map.target_model = 'Environment'
       AND environment_map.stable_suffix = ''
      CROSS JOIN (VALUES ('Credential'::text), ('CredentialSecretVersion'::text)) target(target_model)
    UNION ALL
    SELECT 'PlatosEntityMcpClient', source."entityPk", target.target_model,
           CASE target.target_model WHEN 'Credential' THEN 'credential'
             ELSE 'credential-secret-version:1' END
      FROM cutover_legacy."PlatosEntityMcpClient" source
      CROSS JOIN (VALUES ('Credential'::text), ('CredentialSecretVersion'::text)) target(target_model)
     WHERE source."credsSecretKey" IS NOT NULL
    UNION ALL
    SELECT 'PlatosMcpOidcSession', source.id, target.target_model,
           CASE target.target_model WHEN 'Credential' THEN 'credential'
             ELSE 'credential-secret-version:1' END
      FROM cutover_legacy."PlatosMcpOidcSession" source
      CROSS JOIN (VALUES ('Credential'::text), ('CredentialSecretVersion'::text)) target(target_model)
     WHERE source."entityAccessToken" IS NOT NULL OR source."entityRefreshToken" IS NOT NULL
     ORDER BY source_model, source_id, target_model, stable_suffix`);

  for (let offset = 0; offset < mappings.rows.length; offset += CUTOVER_CHUNK_SIZE) {
    const chunk = mappings.rows.slice(offset, offset + CUTOVER_CHUNK_SIZE);
    await database.query(
      `INSERT INTO cutover_legacy.cutover_id_map
        (mapping_version, source_model, source_id, target_model, stable_suffix, target_id)
       VALUES ${chunk
         .map((_, index) => {
           const base = index * 5;
           return `(1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::uuid)`;
         })
         .join(", ")}`,
      chunk.flatMap((row) => [
        row.source_model,
        row.source_id,
        row.target_model,
        row.stable_suffix,
        mapCutoverId({
          sourceModel: row.source_model,
          sourceId: row.source_id,
          suffix: row.stable_suffix,
        }),
      ])
    );
  }
  return mappings.rows.length;
}

const checkpoint2SourceValidationSql = `
  WITH issues AS (
    SELECT 'mcp-client-owner-or-secret-store' AS issue WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosEntityMcpClient" client
      JOIN cutover_legacy."PlatosConnectedEntity" entity ON entity.id = client."entityPk"
      WHERE client."credsSecretKey" IS NOT NULL AND (
        btrim(client."credsSecretKey") = '' OR
        (SELECT count(*) FROM cutover_legacy."RuntimeEnvironment" environment
         JOIN cutover_legacy."SecretStore" store
           ON store.key = 'environmentvariable:' || entity."projectId" || ':' || environment.id || ':' || client."credsSecretKey"
         WHERE environment."projectId" = entity."projectId"
           AND environment."organizationId" = entity."organizationId") <> 1))
    UNION ALL
    SELECT 'mcp-client-target-collision' WHERE EXISTS (
      SELECT entity."projectId", environment.id, client."credsSecretKey"
        FROM cutover_legacy."PlatosEntityMcpClient" client
        JOIN cutover_legacy."PlatosConnectedEntity" entity ON entity.id = client."entityPk"
        JOIN cutover_legacy."RuntimeEnvironment" environment
          ON environment."projectId" = entity."projectId"
         AND environment."organizationId" = entity."organizationId"
        JOIN cutover_legacy."SecretStore" store
          ON store.key = 'environmentvariable:' || entity."projectId" || ':' || environment.id || ':' || client."credsSecretKey"
       WHERE client."credsSecretKey" IS NOT NULL
       GROUP BY entity."projectId", environment.id, client."credsSecretKey" HAVING count(*) > 1)
    UNION ALL
    SELECT 'mcp-session-parent-or-owner' WHERE EXISTS (
      SELECT session."entityPk" FROM cutover_legacy."PlatosMcpAnonSession" session
      LEFT JOIN cutover_legacy."PlatosConnectedEntity" entity ON entity.id = session."entityPk"
      WHERE entity.id IS NULL OR btrim(session."mcpUserId") = '' OR
        (SELECT count(*) FROM cutover_legacy."RuntimeEnvironment" environment
         WHERE environment."projectId" = entity."projectId"
           AND environment."organizationId" = entity."organizationId") <> 1
      UNION ALL
      SELECT session."entityPk" FROM cutover_legacy."PlatosMcpOidcSession" session
      LEFT JOIN cutover_legacy."PlatosConnectedEntity" entity ON entity.id = session."entityPk"
      WHERE entity.id IS NULL OR btrim(session."mcpUserId") = '' OR btrim(session.provider) = ''
         OR btrim(session."externalSub") = '' OR
        (SELECT count(*) FROM cutover_legacy."RuntimeEnvironment" environment
         WHERE environment."projectId" = entity."projectId"
           AND environment."organizationId" = entity."organizationId") <> 1)
    UNION ALL
    SELECT 'mcp-session-target-collision' WHERE EXISTS (
      SELECT session."entityPk", session."mcpUserId"
        FROM cutover_legacy."PlatosMcpAnonSession" session
       GROUP BY session."entityPk", session."mcpUserId" HAVING count(*) > 1
      UNION ALL
      SELECT session."entityPk", session.provider
        FROM cutover_legacy."PlatosMcpOidcSession" session
       GROUP BY session."entityPk", session.provider, session."externalSub" HAVING count(*) > 1)
    UNION ALL
    SELECT 'bearer-owner-or-fields' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosMcpBearerToken" token
      LEFT JOIN cutover_legacy."PlatosConnectedEntity" entity ON entity.id = token."entityPk"
      LEFT JOIN cutover_legacy."OrgMember" member
        ON member."organizationId" = entity."organizationId" AND member."userId" = token."createdBy"
      WHERE entity.id IS NULL OR member.id IS NULL OR btrim(token.label) = ''
         OR btrim(token."mcpUserId") = '' OR token."tokenHash" !~ '^[0-9a-f]{64}$')
    UNION ALL
    SELECT 'missing-static-mapping' WHERE EXISTS (
      SELECT 1 FROM (
        SELECT 'PlatosMcpAnonSession'::text source_model, id::text source_id,
               'McpAnonymousSession'::text target_model FROM cutover_legacy."PlatosMcpAnonSession"
        UNION ALL SELECT 'PlatosMcpOidcSession', id::text, 'McpOidcSession'
          FROM cutover_legacy."PlatosMcpOidcSession"
        UNION ALL SELECT 'PlatosMcpBearerToken', id::text, 'McpBearerToken'
          FROM cutover_legacy."PlatosMcpBearerToken") source
      WHERE (SELECT count(*) FROM cutover_legacy.cutover_id_map map
              WHERE map.mapping_version = 1 AND map.source_model = source.source_model
                AND map.source_id = source.source_id AND map.target_model = source.target_model
                AND map.stable_suffix = '') <> 1)
  ) SELECT issue FROM issues ORDER BY issue`;

export async function validateRetainedBatch3Checkpoint2Source(
  database: CutoverDatabase,
  options: RetainedBatch3Options,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<void> {
  const issues = await database.query<{ issue: string }>(checkpoint2SourceValidationSql);
  if (issues.rows.length > 0) {
    throw batch3Failure(
      "BATCH3_CHECKPOINT2_SOURCE_INVALID",
      `retained Batch 3 checkpoint 2 source validation failed: ${issues.rows
        .map((row) => row.issue)
        .join(", ")}`
    );
  }

  const dynamicMappings = await database.query<DynamicBatch3MappingRow & { target_id: string }>(`
    SELECT source_model, source_id, target_model, stable_suffix, target_id::text
      FROM cutover_legacy.cutover_id_map
     WHERE mapping_version = 1
       AND source_model IN ('PlatosConnectedEntity', 'PlatosEntityMcpClient', 'PlatosMcpOidcSession')
       AND target_model IN ('Credential', 'CredentialSecretVersion')
     ORDER BY source_model, source_id, target_model, stable_suffix`);
  if (
    dynamicMappings.rows.some(
      (mapping) =>
        mapping.target_id !==
        mapCutoverId({
          sourceModel: mapping.source_model,
          sourceId: mapping.source_id,
          suffix: mapping.stable_suffix,
        })
    )
  ) {
    throw batch3Failure(
      "BATCH3_CHECKPOINT2_SOURCE_INVALID",
      "retained Batch 3 checkpoint 2 deterministic mapping validation failed"
    );
  }

  await forEachSourceChunk<{
    source_id: string;
    service_secret: unknown;
    test_credentials: unknown;
  }>(
    database,
    `SELECT source.id::text AS source_id, source."serviceSecret" AS service_secret,
            source."testCredentials" AS test_credentials
       FROM cutover_legacy."PlatosConnectedEntity" source
      WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      for (const row of rows) {
        buildBatch3EntityCredentialPayload(
          row.service_secret,
          row.test_credentials,
          options.messageEncryptionKeys
        );
      }
    },
    chunkSize
  );
  await forEachSourceChunk<{
    source_id: string;
    store_version: unknown;
    store_value: unknown;
  }>(
    database,
    `SELECT source."entityPk"::text AS source_id, store.version AS store_version,
            store.value AS store_value
       FROM cutover_legacy."PlatosEntityMcpClient" source
       JOIN cutover_legacy."PlatosConnectedEntity" entity ON entity.id = source."entityPk"
       JOIN cutover_legacy."RuntimeEnvironment" environment
         ON environment."projectId" = entity."projectId"
        AND environment."organizationId" = entity."organizationId"
       JOIN cutover_legacy."SecretStore" store
         ON store.key = 'environmentvariable:' || entity."projectId" || ':' || environment.id || ':' || source."credsSecretKey"
      WHERE source."credsSecretKey" IS NOT NULL AND source."entityPk" > $1
      ORDER BY source."entityPk" LIMIT $2`,
    async (rows) => {
      for (const row of rows) {
        decodeBatch3McpClientSecret(
          { version: row.store_version, value: row.store_value },
          options.legacyEncryptionKey
        );
      }
    },
    chunkSize
  );
  await forEachSourceChunk<{
    source_id: string;
    access_token: unknown;
    refresh_token: unknown;
  }>(
    database,
    `SELECT source.id::text AS source_id, source."entityAccessToken" AS access_token,
            source."entityRefreshToken" AS refresh_token
       FROM cutover_legacy."PlatosMcpOidcSession" source
      WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      for (const row of rows) {
        buildBatch3OidcCredentialPayload(row.access_token, row.refresh_token, options);
      }
    },
    chunkSize
  );
  await forEachSourceChunk<{ source_id: string; token_hash: unknown }>(
    database,
    `SELECT source.id::text AS source_id, source."tokenHash" AS token_hash
       FROM cutover_legacy."PlatosMcpBearerToken" source
      WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      for (const row of rows) validateBatch3TokenHash(row.token_hash);
    },
    chunkSize
  );
}

async function insertGeneratedBatch3Credentials(
  database: CutoverDatabase,
  credentials: readonly GeneratedBatch3Credential[],
  keyRing: CredentialRootKeyRing
): Promise<void> {
  if (credentials.length === 0) return;
  await database.query(
    `INSERT INTO public."Credential"
      (id, "environmentId", kind, name, prefix, "secretHash", permissions,
       "createdAt", "updatedAt") VALUES ${parameterTuples(credentials.length, 9)}`,
    credentials.flatMap((row) => [
      row.id,
      row.environmentId,
      row.kind,
      row.name,
      row.prefix,
      row.secretHash,
      row.permissions,
      row.createdAt,
      row.updatedAt,
    ])
  );

  const versions = credentials.map((row) => {
    const context = {
      credentialId: row.id,
      environmentId: row.environmentId,
      secretRevision: 1,
      formatVersion: 1,
      rootKeyVersion: keyRing.activeVersion,
    };
    const envelope = encryptCredentialSecret(
      keyRing.key(keyRing.activeVersion),
      context,
      row.plaintext
    );
    decryptCredentialSecret(keyRing.key(keyRing.activeVersion), context, envelope);
    return { row, envelope };
  });
  await database.query(
    `INSERT INTO public."CredentialSecretVersion"
      (id, "credentialId", "secretRevision", "formatVersion", "rootKeyVersion",
       salt, nonce, ciphertext, "authTag", "createdAt")
     VALUES ${parameterTuples(versions.length, 10)}`,
    versions.flatMap(({ row, envelope }) => [
      row.versionId,
      row.id,
      1,
      1,
      keyRing.activeVersion,
      Buffer.from(envelope.salt),
      Buffer.from(envelope.nonce),
      Buffer.from(envelope.ciphertext),
      Buffer.from(envelope.authTag),
      row.createdAt,
    ])
  );
  await database.query(
    `UPDATE public."Credential" credential
        SET "activeSecretVersionId" = supplied.version_id::uuid
       FROM (VALUES ${parameterTuples(credentials.length, 2)})
         AS supplied(credential_id, version_id)
      WHERE credential.id = supplied.credential_id::uuid`,
    credentials.flatMap((row) => [row.id, row.versionId])
  );
}

interface EntityCredentialRow extends Record<string, unknown> {
  source_id: string;
  entity_source_id: string;
  environment_id: string;
  credential_id: string;
  version_id: string;
  service_secret: unknown;
  test_credentials: unknown;
  created_at: Date;
  updated_at: Date;
}

export async function backfillBatch3EntityCredentials(
  database: CutoverDatabase,
  options: RetainedBatch3Options,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachSourceChunk<EntityCredentialRow>(
    database,
    `SELECT source.id || ':' || environment_map.target_id::text AS source_id,
            source.id::text AS entity_source_id,
            environment_map.target_id::text AS environment_id,
            credential_map.target_id::text AS credential_id,
            version_map.target_id::text AS version_id,
            source."serviceSecret" AS service_secret,
            source."testCredentials" AS test_credentials,
            source."createdAt" AS created_at, source."updatedAt" AS updated_at
       FROM cutover_legacy."PlatosConnectedEntity" source
       JOIN cutover_legacy."RuntimeEnvironment" environment
         ON environment."projectId" = source."projectId"
        AND environment."organizationId" = source."organizationId"
       JOIN cutover_legacy.cutover_id_map environment_map
         ON environment_map.mapping_version = 1
        AND environment_map.source_model = 'RuntimeEnvironment'
        AND environment_map.source_id = environment.id
        AND environment_map.target_model = 'Environment'
        AND environment_map.stable_suffix = ''
       JOIN cutover_legacy.cutover_id_map credential_map
         ON credential_map.mapping_version = 1
        AND credential_map.source_model = 'PlatosConnectedEntity'
        AND credential_map.source_id = source.id
        AND credential_map.target_model = 'Credential'
        AND credential_map.stable_suffix = 'entity-auth:' || environment_map.target_id::text
       JOIN cutover_legacy.cutover_id_map version_map
         ON version_map.mapping_version = 1
        AND version_map.source_model = 'PlatosConnectedEntity'
        AND version_map.source_id = source.id
        AND version_map.target_model = 'CredentialSecretVersion'
        AND version_map.stable_suffix = 'entity-auth:' || environment_map.target_id::text || ':secret-version:1'
      WHERE source.id || ':' || environment_map.target_id::text > $1
      ORDER BY source.id || ':' || environment_map.target_id::text LIMIT $2`,
    async (rows) => {
      const credentials = rows.map((row): GeneratedBatch3Credential => {
        const serviceSecret = nonEmptyBatch3Utf8(
          row.service_secret,
          "BATCH3_ENTITY_SECRET_UNREADABLE"
        );
        return {
          id: row.credential_id,
          versionId: row.version_id,
          environmentId: row.environment_id,
          kind: "ENTITY_SECRET",
          name: batch3EntityCredentialName(row.entity_source_id, row.environment_id),
          prefix: serviceSecret.slice(0, 8),
          secretHash: createHash("sha256").update(serviceSecret).digest("hex"),
          permissions: ["entity:wire"],
          plaintext: buildBatch3EntityCredentialPayload(
            serviceSecret,
            row.test_credentials,
            options.messageEncryptionKeys
          ),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      });
      await insertGeneratedBatch3Credentials(
        database,
        credentials,
        options.credentialRootKeyRing
      );
    },
    chunkSize
  );
}

interface McpClientCredentialRow extends Record<string, unknown> {
  source_id: string;
  entity_id: string;
  environment_id: string;
  credential_id: string;
  version_id: string;
  credential_name: string;
  store_version: unknown;
  store_value: unknown;
  store_created_at: Date;
  source_updated_at: Date;
}

export async function backfillBatch3McpClientCredentials(
  database: CutoverDatabase,
  options: RetainedBatch3Options,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachSourceChunk<McpClientCredentialRow>(
    database,
    `SELECT source."entityPk"::text AS source_id, entity_map.target_id::text AS entity_id,
            environment_map.target_id::text AS environment_id,
            credential_map.target_id::text AS credential_id,
            version_map.target_id::text AS version_id,
            source."credsSecretKey" AS credential_name,
            store.version AS store_version, store.value AS store_value,
            store."createdAt" AS store_created_at, source."updatedAt" AS source_updated_at
       FROM cutover_legacy."PlatosEntityMcpClient" source
       JOIN cutover_legacy."PlatosConnectedEntity" entity ON entity.id = source."entityPk"
       JOIN cutover_legacy."RuntimeEnvironment" environment
         ON environment."projectId" = entity."projectId"
        AND environment."organizationId" = entity."organizationId"
       JOIN cutover_legacy."SecretStore" store
         ON store.key = 'environmentvariable:' || entity."projectId" || ':' || environment.id || ':' || source."credsSecretKey"
       JOIN cutover_legacy.cutover_id_map environment_map
         ON environment_map.mapping_version = 1
        AND environment_map.source_model = 'RuntimeEnvironment'
        AND environment_map.source_id = environment.id
        AND environment_map.target_model = 'Environment'
        AND environment_map.stable_suffix = ''
       JOIN cutover_legacy.cutover_id_map entity_map
         ON entity_map.mapping_version = 1
        AND entity_map.source_model = 'PlatosConnectedEntity'
        AND entity_map.source_id = source."entityPk" AND entity_map.target_model = 'Entity'
        AND entity_map.stable_suffix = ''
       JOIN cutover_legacy.cutover_id_map credential_map
         ON credential_map.mapping_version = 1
        AND credential_map.source_model = 'PlatosEntityMcpClient'
        AND credential_map.source_id = source."entityPk"
        AND credential_map.target_model = 'Credential'
        AND credential_map.stable_suffix = 'credential'
       JOIN cutover_legacy.cutover_id_map version_map
         ON version_map.mapping_version = 1
        AND version_map.source_model = 'PlatosEntityMcpClient'
        AND version_map.source_id = source."entityPk"
        AND version_map.target_model = 'CredentialSecretVersion'
        AND version_map.stable_suffix = 'credential-secret-version:1'
      WHERE source."credsSecretKey" IS NOT NULL AND source."entityPk" > $1
      ORDER BY source."entityPk" LIMIT $2`,
    async (rows) => {
      const credentials = rows.map((row): GeneratedBatch3Credential => ({
        id: row.credential_id,
        versionId: row.version_id,
        environmentId: row.environment_id,
        kind: "SERVICE_CREDENTIAL",
        name: row.credential_name,
        prefix: null,
        secretHash: null,
        permissions: [],
        plaintext: decodeBatch3McpClientSecret(
          { version: row.store_version, value: row.store_value },
          options.legacyEncryptionKey
        ),
        createdAt: row.store_created_at,
        updatedAt: row.source_updated_at,
      }));
      await insertGeneratedBatch3Credentials(
        database,
        credentials,
        options.credentialRootKeyRing
      );
      await database.query(
        `UPDATE public."EntityMcpClient" client SET "credentialId" = supplied.credential_id
           FROM (VALUES ${parameterTuples(rows.length, 2)})
             AS supplied(entity_id, credential_id)
          WHERE client."entityId" = supplied.entity_id::uuid`,
        rows.flatMap((row) => [row.entity_id, row.credential_id])
      );
    },
    chunkSize
  );
}

interface AnonymousSessionRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  environment_id: string;
  entity_id: string;
  mcp_user_id: string;
  first_seen_ip: string | null;
  user_agent: string | null;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

export async function backfillBatch3AnonymousSessions(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachSourceChunk<AnonymousSessionRow>(
    database,
    `SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
            environment_map.target_id::text AS environment_id,
            entity_map.target_id::text AS entity_id, source."mcpUserId" AS mcp_user_id,
            source."firstSeenIp" AS first_seen_ip, source."userAgent" AS user_agent,
            source."createdAt" AS created_at, source."lastUsedAt" AS last_used_at,
            source."revokedAt" AS revoked_at
       FROM cutover_legacy."PlatosMcpAnonSession" source
       JOIN cutover_legacy."PlatosConnectedEntity" entity ON entity.id = source."entityPk"
       JOIN cutover_legacy."RuntimeEnvironment" environment
         ON environment."projectId" = entity."projectId"
        AND environment."organizationId" = entity."organizationId"
       JOIN cutover_legacy.cutover_id_map target_map
         ON target_map.mapping_version = 1
        AND target_map.source_model = 'PlatosMcpAnonSession'
        AND target_map.source_id = source.id
        AND target_map.target_model = 'McpAnonymousSession'
        AND target_map.stable_suffix = ''
       JOIN cutover_legacy.cutover_id_map environment_map
         ON environment_map.mapping_version = 1
        AND environment_map.source_model = 'RuntimeEnvironment'
        AND environment_map.source_id = environment.id
        AND environment_map.target_model = 'Environment'
        AND environment_map.stable_suffix = ''
       JOIN cutover_legacy.cutover_id_map entity_map
         ON entity_map.mapping_version = 1
        AND entity_map.source_model = 'PlatosConnectedEntity'
        AND entity_map.source_id = source."entityPk"
        AND entity_map.target_model = 'Entity' AND entity_map.stable_suffix = ''
      WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."McpAnonymousSession"
          (id, "environmentId", "entityId", "mcpUserId", "firstSeenIp", "userAgent",
           "createdAt", "lastUsedAt", "revokedAt")
         VALUES ${parameterTuples(rows.length, 9)}`,
        rows.flatMap((row) => [
          row.target_id,
          row.environment_id,
          row.entity_id,
          row.mcp_user_id,
          row.first_seen_ip,
          row.user_agent,
          row.created_at,
          row.last_used_at,
          row.revoked_at,
        ])
      );
    },
    chunkSize
  );
}

interface OidcSessionRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  environment_id: string;
  entity_id: string;
  credential_id: string | null;
  version_id: string | null;
  mcp_user_id: string;
  provider: string;
  email: string | null;
  email_verified: boolean;
  external_subject: string;
  avatar_url: string | null;
  access_token: unknown;
  refresh_token: unknown;
  first_login_at: Date;
  last_login_at: Date | null;
  revoked_at: Date | null;
}

export async function backfillBatch3OidcSessions(
  database: CutoverDatabase,
  options: RetainedBatch3Options,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<Readonly<{ sessionRows: number; authRows: number }>> {
  let authRows = 0;
  const sessionRows = await forEachSourceChunk<OidcSessionRow>(
    database,
    `SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
            environment_map.target_id::text AS environment_id,
            entity_map.target_id::text AS entity_id,
            credential_map.target_id::text AS credential_id,
            version_map.target_id::text AS version_id,
            source."mcpUserId" AS mcp_user_id, source.provider, source.email,
            source."emailVerified" AS email_verified,
            source."externalSub" AS external_subject, source."avatarUrl" AS avatar_url,
            source."entityAccessToken" AS access_token,
            source."entityRefreshToken" AS refresh_token,
            source."firstLoginAt" AS first_login_at,
            source."lastLoginAt" AS last_login_at, source."revokedAt" AS revoked_at
       FROM cutover_legacy."PlatosMcpOidcSession" source
       JOIN cutover_legacy."PlatosConnectedEntity" entity ON entity.id = source."entityPk"
       JOIN cutover_legacy."RuntimeEnvironment" environment
         ON environment."projectId" = entity."projectId"
        AND environment."organizationId" = entity."organizationId"
       JOIN cutover_legacy.cutover_id_map target_map
         ON target_map.mapping_version = 1
        AND target_map.source_model = 'PlatosMcpOidcSession'
        AND target_map.source_id = source.id
        AND target_map.target_model = 'McpOidcSession' AND target_map.stable_suffix = ''
       JOIN cutover_legacy.cutover_id_map environment_map
         ON environment_map.mapping_version = 1
        AND environment_map.source_model = 'RuntimeEnvironment'
        AND environment_map.source_id = environment.id
        AND environment_map.target_model = 'Environment' AND environment_map.stable_suffix = ''
       JOIN cutover_legacy.cutover_id_map entity_map
         ON entity_map.mapping_version = 1
        AND entity_map.source_model = 'PlatosConnectedEntity'
        AND entity_map.source_id = source."entityPk"
        AND entity_map.target_model = 'Entity' AND entity_map.stable_suffix = ''
       LEFT JOIN cutover_legacy.cutover_id_map credential_map
         ON credential_map.mapping_version = 1
        AND credential_map.source_model = 'PlatosMcpOidcSession'
        AND credential_map.source_id = source.id
        AND credential_map.target_model = 'Credential'
        AND credential_map.stable_suffix = 'credential'
       LEFT JOIN cutover_legacy.cutover_id_map version_map
         ON version_map.mapping_version = 1
        AND version_map.source_model = 'PlatosMcpOidcSession'
        AND version_map.source_id = source.id
        AND version_map.target_model = 'CredentialSecretVersion'
        AND version_map.stable_suffix = 'credential-secret-version:1'
      WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      const normalized = rows.map((row) => ({
        row,
        plaintext: buildBatch3OidcCredentialPayload(row.access_token, row.refresh_token, options),
      }));
      const credentials = normalized.flatMap(({ row, plaintext }): GeneratedBatch3Credential[] => {
        if (plaintext === null) {
          if (row.credential_id !== null || row.version_id !== null) {
            throw batch3Failure(
              "BATCH3_MAPPING_INVALID",
              "retained Batch 3 empty OIDC session has credential mappings"
            );
          }
          return [];
        }
        if (row.credential_id === null || row.version_id === null) {
          throw batch3Failure(
            "BATCH3_MAPPING_INVALID",
            "retained Batch 3 OIDC credential mapping is incomplete"
          );
        }
        return [
          {
            id: row.credential_id,
            versionId: row.version_id,
            environmentId: row.environment_id,
            kind: "SERVICE_CREDENTIAL",
            name: batch3OidcCredentialName(row.source_id),
            prefix: null,
            secretHash: null,
            permissions: [],
            plaintext,
            createdAt: row.first_login_at,
            updatedAt: row.last_login_at ?? row.first_login_at,
          },
        ];
      });
      await insertGeneratedBatch3Credentials(
        database,
        credentials,
        options.credentialRootKeyRing
      );
      authRows += credentials.length;
      await database.query(
        `INSERT INTO public."McpOidcSession"
          (id, "environmentId", "entityId", "mcpUserId", provider, email,
           "emailVerified", "externalSubject", "displayName", "avatarUrl",
           "credentialId", "firstLoginAt", "lastLoginAt", "revokedAt")
         VALUES ${parameterTuples(rows.length, 14)}`,
        normalized.flatMap(({ row, plaintext }) => [
          row.target_id,
          row.environment_id,
          row.entity_id,
          row.mcp_user_id,
          row.provider,
          row.email,
          row.email_verified,
          row.external_subject,
          null,
          row.avatar_url,
          plaintext === null ? null : row.credential_id,
          row.first_login_at,
          row.last_login_at,
          row.revoked_at,
        ])
      );
    },
    chunkSize
  );
  return Object.freeze({ sessionRows, authRows });
}

interface BearerTokenRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  entity_id: string;
  created_by_user_id: string;
  token_hash: unknown;
  label: string;
  mcp_user_id: string;
  scopes: string[];
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
}

export async function backfillBatch3BearerTokens(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachSourceChunk<BearerTokenRow>(
    database,
    `SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
            entity_map.target_id::text AS entity_id,
            user_map.target_id::text AS created_by_user_id,
            source."tokenHash" AS token_hash, source.label,
            source."mcpUserId" AS mcp_user_id, source.scopes,
            source."createdAt" AS created_at, source."lastUsedAt" AS last_used_at,
            source."expiresAt" AS expires_at, source."revokedAt" AS revoked_at
       FROM cutover_legacy."PlatosMcpBearerToken" source
       JOIN cutover_legacy.cutover_id_map target_map
         ON target_map.mapping_version = 1
        AND target_map.source_model = 'PlatosMcpBearerToken'
        AND target_map.source_id = source.id
        AND target_map.target_model = 'McpBearerToken' AND target_map.stable_suffix = ''
       JOIN cutover_legacy.cutover_id_map entity_map
         ON entity_map.mapping_version = 1
        AND entity_map.source_model = 'PlatosConnectedEntity'
        AND entity_map.source_id = source."entityPk"
        AND entity_map.target_model = 'Entity' AND entity_map.stable_suffix = ''
       JOIN cutover_legacy.cutover_id_map user_map
         ON user_map.mapping_version = 1 AND user_map.source_model = 'User'
        AND user_map.source_id = source."createdBy"
        AND user_map.target_model = 'User' AND user_map.stable_suffix = ''
      WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."McpBearerToken"
          (id, "entityId", "createdByUserId", "tokenHash", label, "mcpUserId",
           scopes, "createdAt", "lastUsedAt", "expiresAt", "revokedAt")
         VALUES ${parameterTuples(rows.length, 11)}`,
        rows.flatMap((row) => [
          row.target_id,
          row.entity_id,
          row.created_by_user_id,
          validateBatch3TokenHash(row.token_hash),
          row.label,
          row.mcp_user_id,
          row.scopes,
          row.created_at,
          row.last_used_at,
          row.expires_at,
          row.revoked_at,
        ])
      );
    },
    chunkSize
  );
}

export async function backfillRetainedBatch3(
  database: CutoverDatabase,
  options: RetainedBatch3Options,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<RetainedBatch3Evidence> {
  await materializeRetainedBatch3Checkpoint2Mappings(database);
  await validateRetainedBatch3Checkpoint1Source(database);
  await validateRetainedBatch3Checkpoint2Source(database, options, chunkSize);

  const checkpoint1 = Object.freeze({
    entityRows: await backfillBatch3Checkpoint1Entities(database, chunkSize),
    mcpConfigRows: await backfillBatch3Checkpoint1McpConfigs(database, chunkSize),
    mcpClientRows: await backfillBatch3Checkpoint1McpClients(database, chunkSize),
    environmentToolRows: await backfillBatch3Checkpoint1EnvironmentTools(database, chunkSize),
    entityPolicyRows: await backfillBatch3Checkpoint1EntityPolicies(database, chunkSize),
  });
  const entityAuthRows = await backfillBatch3EntityCredentials(database, options, chunkSize);
  const mcpClientAuthRows = await backfillBatch3McpClientCredentials(database, options, chunkSize);
  const anonymousSessionRows = await backfillBatch3AnonymousSessions(database, chunkSize);
  const oidc = await backfillBatch3OidcSessions(database, options, chunkSize);
  const bearerTokenRows = await backfillBatch3BearerTokens(database, chunkSize);
  const evidence = Object.freeze({
    ...checkpoint1,
    entityAuthRows,
    mcpClientAuthRows,
    anonymousSessionRows,
    oidcSessionRows: oidc.sessionRows,
    oidcAuthRows: oidc.authRows,
    bearerTokenRows,
  });
  assertSecretFreeCutoverEvidence(evidence);
  return evidence;
}

const checkpoint2ConservationSql = `
  WITH equations(id, source_count, target_count) AS (
    VALUES
      ('entity-auth-credentials',
       (SELECT count(*) FROM cutover_legacy."PlatosConnectedEntity" entity
         JOIN cutover_legacy."RuntimeEnvironment" environment
           ON environment."projectId" = entity."projectId"
          AND environment."organizationId" = entity."organizationId"),
       (SELECT count(*) FROM public."Credential" target
         JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
          AND map.source_model = 'PlatosConnectedEntity' AND map.target_model = 'Credential'
          AND map.target_id = target.id)),
      ('entity-auth-versions',
       (SELECT count(*) FROM cutover_legacy."PlatosConnectedEntity" entity
         JOIN cutover_legacy."RuntimeEnvironment" environment
           ON environment."projectId" = entity."projectId"
          AND environment."organizationId" = entity."organizationId"),
       (SELECT count(*) FROM public."CredentialSecretVersion" target
         JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
          AND map.source_model = 'PlatosConnectedEntity'
          AND map.target_model = 'CredentialSecretVersion' AND map.target_id = target.id)),
      ('mcp-client-auth',
       (SELECT count(*) FROM cutover_legacy."PlatosEntityMcpClient" WHERE "credsSecretKey" IS NOT NULL),
       (SELECT count(*) FROM public."Credential" target
         JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
          AND map.source_model = 'PlatosEntityMcpClient' AND map.target_model = 'Credential'
          AND map.target_id = target.id)),
      ('anonymous-sessions',
       (SELECT count(*) FROM cutover_legacy."PlatosMcpAnonSession"),
       (SELECT count(*) FROM public."McpAnonymousSession" target
         JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
          AND map.source_model = 'PlatosMcpAnonSession'
          AND map.target_model = 'McpAnonymousSession' AND map.target_id = target.id)),
      ('oidc-sessions',
       (SELECT count(*) FROM cutover_legacy."PlatosMcpOidcSession"),
       (SELECT count(*) FROM public."McpOidcSession" target
         JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
          AND map.source_model = 'PlatosMcpOidcSession'
          AND map.target_model = 'McpOidcSession' AND map.target_id = target.id)),
      ('oidc-auth',
       (SELECT count(*) FROM cutover_legacy."PlatosMcpOidcSession"
         WHERE "entityAccessToken" IS NOT NULL OR "entityRefreshToken" IS NOT NULL),
       (SELECT count(*) FROM public."Credential" target
         JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
          AND map.source_model = 'PlatosMcpOidcSession' AND map.target_model = 'Credential'
          AND map.target_id = target.id)),
      ('bearer-tokens',
       (SELECT count(*) FROM cutover_legacy."PlatosMcpBearerToken"),
       (SELECT count(*) FROM public."McpBearerToken" target
         JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
          AND map.source_model = 'PlatosMcpBearerToken'
          AND map.target_model = 'McpBearerToken' AND map.target_id = target.id))
  ) SELECT id FROM equations WHERE source_count <> target_count ORDER BY id`;

const checkpoint2AncestrySql = `
  WITH issues AS (
    SELECT 'credential-owner' AS issue FROM public."Credential" credential
    JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
     AND map.source_model IN ('PlatosConnectedEntity', 'PlatosEntityMcpClient', 'PlatosMcpOidcSession')
     AND map.target_model = 'Credential' AND map.target_id = credential.id
    LEFT JOIN public."Environment" environment ON environment.id = credential."environmentId"
    LEFT JOIN public."CredentialSecretVersion" version
      ON version.id = credential."activeSecretVersionId" AND version."credentialId" = credential.id
    WHERE environment.id IS NULL OR version.id IS NULL
    UNION ALL
    SELECT 'anonymous-session-owner' FROM public."McpAnonymousSession" session
    JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
     AND map.source_model = 'PlatosMcpAnonSession' AND map.target_model = 'McpAnonymousSession'
     AND map.target_id = session.id
    LEFT JOIN public."Environment" environment ON environment.id = session."environmentId"
    LEFT JOIN public."Entity" entity
      ON entity.id = session."entityId" AND entity."projectId" = environment."projectId"
    WHERE environment.id IS NULL OR entity.id IS NULL
    UNION ALL
    SELECT 'oidc-session-owner' FROM public."McpOidcSession" session
    JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
     AND map.source_model = 'PlatosMcpOidcSession' AND map.target_model = 'McpOidcSession'
     AND map.target_id = session.id
    LEFT JOIN public."Environment" environment ON environment.id = session."environmentId"
    LEFT JOIN public."Entity" entity
      ON entity.id = session."entityId" AND entity."projectId" = environment."projectId"
    LEFT JOIN public."Credential" credential
      ON credential.id = session."credentialId" AND credential."environmentId" = environment.id
    WHERE environment.id IS NULL OR entity.id IS NULL
       OR (session."credentialId" IS NOT NULL AND credential.id IS NULL)
    UNION ALL
    SELECT 'bearer-owner' FROM public."McpBearerToken" token
    JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
     AND map.source_model = 'PlatosMcpBearerToken' AND map.target_model = 'McpBearerToken'
     AND map.target_id = token.id
    LEFT JOIN public."Entity" entity ON entity.id = token."entityId"
    LEFT JOIN public."Project" project ON project.id = entity."projectId"
    LEFT JOIN public."OrganizationMembership" membership
      ON membership."organizationId" = project."organizationId"
     AND membership."userId" = token."createdByUserId" AND membership."deactivatedAt" IS NULL
    WHERE entity.id IS NULL OR membership.id IS NULL
  ) SELECT DISTINCT issue FROM issues ORDER BY issue`;

const checkpoint2ShapeSql = `
  WITH issues AS (
    SELECT 'credential-envelope' AS issue FROM public."Credential" credential
    JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
     AND map.source_model IN ('PlatosConnectedEntity', 'PlatosEntityMcpClient', 'PlatosMcpOidcSession')
     AND map.target_model = 'Credential' AND map.target_id = credential.id
    JOIN public."CredentialSecretVersion" version ON version.id = credential."activeSecretVersionId"
    WHERE version."credentialId" <> credential.id OR version."secretRevision" <> 1
       OR version."formatVersion" <> 1 OR octet_length(version.salt) <> 32
       OR octet_length(version.nonce) <> 12 OR octet_length(version."authTag") <> 16
    UNION ALL
    SELECT 'mcp-client-credential-parity' FROM public."EntityMcpClient" target
    JOIN cutover_legacy."PlatosEntityMcpClient" source ON true
    JOIN cutover_legacy.cutover_id_map entity_map ON entity_map.mapping_version = 1
     AND entity_map.source_model = 'PlatosConnectedEntity'
     AND entity_map.source_id = source."entityPk" AND entity_map.target_model = 'Entity'
     AND entity_map.target_id = target."entityId"
    WHERE (source."credsSecretKey" IS NULL) <> (target."credentialId" IS NULL)
    UNION ALL
    SELECT 'oidc-credential-parity' FROM public."McpOidcSession" target
    JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
     AND map.source_model = 'PlatosMcpOidcSession' AND map.target_model = 'McpOidcSession'
     AND map.target_id = target.id
    JOIN cutover_legacy."PlatosMcpOidcSession" source ON source.id = map.source_id
    WHERE ((source."entityAccessToken" IS NULL AND source."entityRefreshToken" IS NULL)
           <> (target."credentialId" IS NULL))
    UNION ALL
    SELECT 'bearer-hash' FROM public."McpBearerToken" target
    JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
     AND map.source_model = 'PlatosMcpBearerToken' AND map.target_model = 'McpBearerToken'
     AND map.target_id = target.id
    JOIN cutover_legacy."PlatosMcpBearerToken" source ON source.id = map.source_id
    WHERE target."tokenHash" <> source."tokenHash" OR target."tokenHash" !~ '^[0-9a-f]{64}$'
  ) SELECT DISTINCT issue FROM issues ORDER BY issue`;

export async function validateRetainedBatch3(database: CutoverDatabase): Promise<void> {
  await validateRetainedBatch3Checkpoint1(database);
  await assertCheckpoint1Validation(
    database,
    checkpoint2ConservationSql,
    "BATCH3_CHECKPOINT2_CONSERVATION_FAILED",
    "retained Batch 3 checkpoint 2 conservation failed"
  );
  await assertCheckpoint1Validation(
    database,
    checkpoint2AncestrySql,
    "BATCH3_CHECKPOINT2_ANCESTRY_FAILED",
    "retained Batch 3 checkpoint 2 ancestry failed"
  );
  await assertCheckpoint1Validation(
    database,
    checkpoint2ShapeSql,
    "BATCH3_CHECKPOINT2_SHAPE_FAILED",
    "retained Batch 3 checkpoint 2 credential or hash validation failed"
  );
}
