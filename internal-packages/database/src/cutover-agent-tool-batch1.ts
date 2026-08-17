import {
  normalizeAgentVersionJson,
  normalizeJsonField,
  type JsonValue,
} from "./json";
import type { CutoverDatabase } from "./cutover-types";
import { CutoverFailure } from "./cutover-types";
import { CUTOVER_CHUNK_SIZE } from "./cutover-backfill";

export const retainedAgentToolBatch1SourceModels = [
  "PlatosToolDefinition",
  "PlatosAgent",
  "PlatosAgentVersion",
  "PlatosAgentCluster",
] as const;

export const retainedAgentToolBatch1MappingTargets = [
  { sourceModel: "PlatosToolDefinition", targetModel: "Tool", stableSuffix: "" },
  { sourceModel: "PlatosAgent", targetModel: "Agent", stableSuffix: "" },
  { sourceModel: "PlatosAgent", targetModel: "AgentBinding", stableSuffix: "agent-binding" },
  { sourceModel: "PlatosAgentVersion", targetModel: "AgentVersion", stableSuffix: "" },
  { sourceModel: "PlatosAgentCluster", targetModel: "AgentCluster", stableSuffix: "" },
] as const;

interface AgentVersionSnapshotRecord {
  readonly model: string;
  readonly promptBlocks: JsonValue;
  readonly dynamicBlocks: JsonValue;
  readonly toolsBlockConfig: JsonValue;
  readonly modelRoutes: JsonValue;
  readonly memoryConfig: JsonValue;
  readonly outputSchema?: JsonValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Applies only the snapshot fields authorized by source-field-manifest. Legacy
 * agent columns and unlisted snapshot properties are intentionally not copied.
 */
export function normalizeBatch1AgentVersionSnapshot(input: unknown): AgentVersionSnapshotRecord {
  if (!isRecord(input)) {
    throw new CutoverFailure(
      "BATCH1_MALFORMED_AGENT_VERSION_SNAPSHOT",
      "PlatosAgentVersion snapshot must have an object root"
    );
  }
  if (typeof input.model !== "string" || input.model.trim().length === 0) {
    throw new CutoverFailure(
      "BATCH1_MALFORMED_AGENT_VERSION_SNAPSHOT",
      "PlatosAgentVersion snapshot model must be a non-empty string"
    );
  }

  try {
    const normalized = normalizeAgentVersionJson({
      promptBlocks: input.promptBlocks ?? [],
      dynamicBlocks: input.dynamicBlocks ?? [],
      toolsBlockConfig: input.toolsBlockConfig ?? {},
      modelRoutes: input.modelRoutes ?? [],
      memoryConfig: input.memoryConfig ?? {},
      ...(input.outputSchema == null ? {} : { outputSchema: input.outputSchema }),
    });
    return {
      model: input.model,
      promptBlocks: normalized.promptBlocks as unknown as JsonValue,
      dynamicBlocks: normalized.dynamicBlocks as unknown as JsonValue,
      toolsBlockConfig: normalized.toolsBlockConfig as unknown as JsonValue,
      modelRoutes: normalized.modelRoutes as unknown as JsonValue,
      memoryConfig: (normalized.memoryConfig ?? {}) as unknown as JsonValue,
      ...(normalized.outputSchema === undefined
        ? {}
        : { outputSchema: normalized.outputSchema as unknown as JsonValue }),
    };
  } catch (error) {
    throw new CutoverFailure(
      "BATCH1_MALFORMED_AGENT_VERSION_SNAPSHOT",
      error instanceof Error ? error.message : "PlatosAgentVersion snapshot normalization failed"
    );
  }
}

const sourceAndMappingValidationSql = `
  WITH issues AS (
    SELECT 'missing-tool-map' AS issue
      WHERE EXISTS (
        SELECT 1 FROM cutover_legacy."PlatosToolDefinition" source
         WHERE (SELECT count(*) FROM cutover_legacy.cutover_id_map map
                 WHERE map.mapping_version = 1 AND map.source_model = 'PlatosToolDefinition'
                   AND map.source_id = source.id AND map.target_model = 'Tool'
                   AND map.stable_suffix = '') <> 1)
    UNION ALL
    SELECT 'missing-agent-map'
      WHERE EXISTS (
        SELECT 1 FROM cutover_legacy."PlatosAgent" source
         WHERE (SELECT count(*) FROM cutover_legacy.cutover_id_map map
                 WHERE map.mapping_version = 1 AND map.source_model = 'PlatosAgent'
                   AND map.source_id = source.id AND map.target_model = 'Agent'
                   AND map.stable_suffix = '') <> 1)
    UNION ALL
    SELECT 'missing-agent-binding-map'
      WHERE EXISTS (
        SELECT 1 FROM cutover_legacy."PlatosAgent" source
         WHERE (SELECT count(*) FROM cutover_legacy.cutover_id_map map
                 WHERE map.mapping_version = 1 AND map.source_model = 'PlatosAgent'
                   AND map.source_id = source.id AND map.target_model = 'AgentBinding'
                   AND map.stable_suffix = 'agent-binding') <> 1)
    UNION ALL
    SELECT 'missing-agent-version-map'
      WHERE EXISTS (
        SELECT 1 FROM cutover_legacy."PlatosAgentVersion" source
         WHERE (SELECT count(*) FROM cutover_legacy.cutover_id_map map
                 WHERE map.mapping_version = 1 AND map.source_model = 'PlatosAgentVersion'
                   AND map.source_id = source.id AND map.target_model = 'AgentVersion'
                   AND map.stable_suffix = '') <> 1)
    UNION ALL
    SELECT 'missing-agent-cluster-map'
      WHERE EXISTS (
        SELECT 1 FROM cutover_legacy."PlatosAgentCluster" source
         WHERE (SELECT count(*) FROM cutover_legacy.cutover_id_map map
                 WHERE map.mapping_version = 1 AND map.source_model = 'PlatosAgentCluster'
                   AND map.source_id = source.id AND map.target_model = 'AgentCluster'
                   AND map.stable_suffix = '') <> 1)
    UNION ALL
    SELECT 'agent-source-ancestry'
      WHERE EXISTS (
        SELECT 1 FROM cutover_legacy."PlatosAgent" source
        LEFT JOIN cutover_legacy."Project" project ON project.id = source."projectId"
        LEFT JOIN cutover_legacy."RuntimeEnvironment" environment ON environment.id = source."environmentId"
        WHERE project.id IS NULL OR environment.id IS NULL
           OR project."organizationId" <> source."organizationId"
           OR environment."organizationId" <> source."organizationId"
           OR environment."projectId" <> source."projectId")
    UNION ALL
    SELECT 'agent-cluster-source-ancestry'
      WHERE EXISTS (
        SELECT 1 FROM cutover_legacy."PlatosAgentCluster" source
        LEFT JOIN cutover_legacy."Project" project ON project.id = source."projectId"
        LEFT JOIN cutover_legacy."RuntimeEnvironment" environment ON environment.id = source."environmentId"
        WHERE project.id IS NULL OR environment.id IS NULL
           OR project."organizationId" <> source."organizationId"
           OR environment."organizationId" <> source."organizationId"
           OR environment."projectId" <> source."projectId")
    UNION ALL
    SELECT 'agent-version-source-ancestry'
      WHERE EXISTS (
        SELECT 1 FROM cutover_legacy."PlatosAgentVersion" version
        LEFT JOIN cutover_legacy."PlatosAgent" agent ON agent.id = version."agentId"
        WHERE agent.id IS NULL)
    UNION ALL
    SELECT 'active-agent-version-pointer'
      WHERE EXISTS (
        SELECT 1 FROM cutover_legacy."PlatosAgent" agent
        LEFT JOIN cutover_legacy."PlatosAgentVersion" version
          ON version.id = agent."currentVersionId" AND version."agentId" = agent.id
        WHERE agent."currentVersionId" IS NULL OR version.id IS NULL)
    UNION ALL
    SELECT 'missing-parent-map'
      WHERE EXISTS (
        SELECT 1 FROM cutover_legacy."PlatosAgent" agent
        WHERE NOT EXISTS (SELECT 1 FROM cutover_legacy.cutover_id_map map
                           WHERE map.mapping_version = 1 AND map.source_model = 'Project'
                             AND map.source_id = agent."projectId" AND map.target_model = 'Project')
           OR NOT EXISTS (SELECT 1 FROM cutover_legacy.cutover_id_map map
                           WHERE map.mapping_version = 1 AND map.source_model = 'RuntimeEnvironment'
                             AND map.source_id = agent."environmentId" AND map.target_model = 'Environment')
           OR NOT EXISTS (SELECT 1 FROM cutover_legacy.cutover_id_map map
                           WHERE map.mapping_version = 1 AND map.source_model = 'PlatosAgentVersion'
                             AND map.source_id = agent."currentVersionId" AND map.target_model = 'AgentVersion'))
    UNION ALL
    SELECT 'missing-cluster-environment-map'
      WHERE EXISTS (
        SELECT 1 FROM cutover_legacy."PlatosAgentCluster" cluster
        WHERE NOT EXISTS (SELECT 1 FROM cutover_legacy.cutover_id_map map
                           WHERE map.mapping_version = 1 AND map.source_model = 'RuntimeEnvironment'
                             AND map.source_id = cluster."environmentId" AND map.target_model = 'Environment'))
    UNION ALL
    SELECT 'agent-target-slug-collision'
      WHERE EXISTS (
        SELECT 1 FROM cutover_legacy."PlatosAgent"
        GROUP BY "projectId", slug HAVING count(*) > 1)
    UNION ALL
    SELECT 'tool-target-key-collision'
      WHERE EXISTS (
        SELECT 1 FROM cutover_legacy."PlatosToolDefinition"
        GROUP BY name, "schemaHash" HAVING count(*) > 1)
    UNION ALL
    SELECT 'invalid-slug-or-name'
      WHERE EXISTS (
        SELECT 1 FROM cutover_legacy."PlatosAgent"
         WHERE btrim(slug) = '' OR btrim(name) = ''
        UNION ALL
        SELECT 1 FROM cutover_legacy."PlatosAgentCluster"
         WHERE btrim(slug) = '' OR btrim(name) = ''
        UNION ALL
        SELECT 1 FROM cutover_legacy."PlatosToolDefinition"
         WHERE btrim(name) = '' OR btrim("schemaHash") = '')
    UNION ALL
    SELECT 'invalid-canary-percent'
      WHERE EXISTS (
        SELECT 1 FROM cutover_legacy."PlatosAgent"
         WHERE "canaryPercent" < 0 OR "canaryPercent" > 100)
  )
  SELECT issue FROM issues ORDER BY issue`;

export async function validateRetainedAgentToolBatch1Source(
  database: CutoverDatabase
): Promise<void> {
  const issues = await database.query<{ issue: string }>(sourceAndMappingValidationSql);
  if (issues.rows.length > 0) {
    throw new CutoverFailure(
      "BATCH1_SOURCE_OR_MAPPING_INVALID",
      `retained agent/tool Batch 1 source validation failed: ${issues.rows.map((row) => row.issue).join(", ")}`
    );
  }
}

async function forEachSourceChunk<Row extends Record<string, unknown>>(
  database: CutoverDatabase,
  selectSql: string,
  consume: (rows: readonly Row[]) => Promise<void>,
  chunkSize: number
): Promise<void> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new TypeError("cutover chunk size must be a positive integer");
  }
  let cursor = "";
  while (true) {
    const result = await database.query<Row>(selectSql, [cursor, chunkSize]);
    if (result.rows.length === 0) return;
    await consume(result.rows);
    const nextCursor = result.rows[result.rows.length - 1]?.source_id;
    if (typeof nextCursor !== "string" || nextCursor <= cursor) {
      throw new CutoverFailure("BATCH1_CHUNK_ORDER_INVALID", "Batch 1 source chunk order is not stable");
    }
    cursor = nextCursor;
  }
}

function parameterTuples(rowCount: number, width: number): string {
  return Array.from({ length: rowCount }, (_, rowIndex) => {
    const offset = rowIndex * width;
    return `(${Array.from({ length: width }, (__, columnIndex) => `$${offset + columnIndex + 1}`).join(", ")})`;
  }).join(", ");
}

interface ToolSourceRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  name: string;
  description: string;
  param_schema: unknown;
  category: string | null;
  schema_hash: string;
  created_at: Date;
  updated_at: Date;
}

export async function backfillBatch1Tools(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<void> {
  await forEachSourceChunk<ToolSourceRow>(
    database,
    `SELECT source.id::text AS source_id, tool_map.target_id::text AS target_id,
            source.name, source.description, source."paramSchema" AS param_schema,
            source.category, source."schemaHash" AS schema_hash,
            source."createdAt" AS created_at, source."updatedAt" AS updated_at
       FROM cutover_legacy."PlatosToolDefinition" source
       JOIN cutover_legacy.cutover_id_map tool_map
         ON tool_map.mapping_version = 1 AND tool_map.source_model = 'PlatosToolDefinition'
        AND tool_map.source_id = source.id AND tool_map.target_model = 'Tool'
        AND tool_map.stable_suffix = ''
      WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      const values = rows.flatMap((row) => [
        row.target_id,
        row.name,
        row.description,
        JSON.stringify(normalizeJsonField("Tool.paramSchema", row.param_schema)),
        row.category,
        row.schema_hash,
        row.created_at,
        row.updated_at,
      ]);
      await database.query(
        `INSERT INTO public."Tool"
          (id, name, description, "paramSchema", category, "schemaHash", "createdAt", "updatedAt")
         VALUES ${parameterTuples(rows.length, 8)}`,
        values
      );
    },
    chunkSize
  );
}

interface ClusterSourceRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  environment_id: string;
  name: string;
  slug: string;
  description: string | null;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
}

export async function backfillBatch1AgentClusters(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<void> {
  await forEachSourceChunk<ClusterSourceRow>(
    database,
    `SELECT source.id::text AS source_id, cluster_map.target_id::text AS target_id,
            environment_map.target_id::text AS environment_id,
            source.name, source.slug, source.description, source.metadata,
            source."createdAt" AS created_at, source."updatedAt" AS updated_at
       FROM cutover_legacy."PlatosAgentCluster" source
       JOIN cutover_legacy.cutover_id_map cluster_map
         ON cluster_map.mapping_version = 1 AND cluster_map.source_model = 'PlatosAgentCluster'
        AND cluster_map.source_id = source.id AND cluster_map.target_model = 'AgentCluster'
        AND cluster_map.stable_suffix = ''
       JOIN cutover_legacy.cutover_id_map environment_map
         ON environment_map.mapping_version = 1 AND environment_map.source_model = 'RuntimeEnvironment'
        AND environment_map.source_id = source."environmentId" AND environment_map.target_model = 'Environment'
      WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      const values = rows.flatMap((row) => [
        row.target_id,
        row.environment_id,
        row.name,
        row.slug,
        row.description,
        row.metadata == null
          ? null
          : JSON.stringify(normalizeJsonField("AgentCluster.metadata", row.metadata)),
        row.created_at,
        row.updated_at,
      ]);
      await database.query(
        `INSERT INTO public."AgentCluster"
          (id, "environmentId", name, slug, description, metadata, "createdAt", "updatedAt")
         VALUES ${parameterTuples(rows.length, 8)}`,
        values
      );
    },
    chunkSize
  );
}

interface AgentSourceRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  project_id: string;
  name: string;
  slug: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export async function backfillBatch1Agents(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<void> {
  await forEachSourceChunk<AgentSourceRow>(
    database,
    `SELECT source.id::text AS source_id, agent_map.target_id::text AS target_id,
            project_map.target_id::text AS project_id, source.name, source.slug,
            source."isActive" AS is_active, source."createdAt" AS created_at,
            source."updatedAt" AS updated_at
       FROM cutover_legacy."PlatosAgent" source
       JOIN cutover_legacy.cutover_id_map agent_map
         ON agent_map.mapping_version = 1 AND agent_map.source_model = 'PlatosAgent'
        AND agent_map.source_id = source.id AND agent_map.target_model = 'Agent'
        AND agent_map.stable_suffix = ''
       JOIN cutover_legacy.cutover_id_map project_map
         ON project_map.mapping_version = 1 AND project_map.source_model = 'Project'
        AND project_map.source_id = source."projectId" AND project_map.target_model = 'Project'
      WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      const values = rows.flatMap((row) => [
        row.target_id,
        row.project_id,
        row.name,
        row.slug,
        row.is_active,
        row.created_at,
        row.updated_at,
      ]);
      await database.query(
        `INSERT INTO public."Agent"
          (id, "projectId", name, slug, "isActive", "createdAt", "updatedAt")
         VALUES ${parameterTuples(rows.length, 7)}`,
        values
      );
    },
    chunkSize
  );
}

interface VersionSourceRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  agent_id: string;
  version_number: number;
  created_by: string;
  note: string | null;
  snapshot: unknown;
  created_at: Date;
}

export async function backfillBatch1AgentVersions(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<void> {
  await forEachSourceChunk<VersionSourceRow>(
    database,
    `SELECT source.id::text AS source_id, version_map.target_id::text AS target_id,
            agent_map.target_id::text AS agent_id, source."versionNumber" AS version_number,
            source."createdBy" AS created_by, source.note, source.snapshot,
            source."createdAt" AS created_at
       FROM cutover_legacy."PlatosAgentVersion" source
       JOIN cutover_legacy.cutover_id_map version_map
         ON version_map.mapping_version = 1 AND version_map.source_model = 'PlatosAgentVersion'
        AND version_map.source_id = source.id AND version_map.target_model = 'AgentVersion'
        AND version_map.stable_suffix = ''
       JOIN cutover_legacy.cutover_id_map agent_map
         ON agent_map.mapping_version = 1 AND agent_map.source_model = 'PlatosAgent'
        AND agent_map.source_id = source."agentId" AND agent_map.target_model = 'Agent'
        AND agent_map.stable_suffix = ''
      WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      const values = rows.flatMap((row) => {
        const snapshot = normalizeBatch1AgentVersionSnapshot(row.snapshot);
        return [
          row.target_id,
          row.agent_id,
          row.version_number,
          snapshot.model,
          JSON.stringify(snapshot.promptBlocks),
          JSON.stringify(snapshot.dynamicBlocks),
          JSON.stringify(snapshot.toolsBlockConfig),
          JSON.stringify(snapshot.modelRoutes),
          JSON.stringify(snapshot.memoryConfig),
          snapshot.outputSchema === undefined ? null : JSON.stringify(snapshot.outputSchema),
          row.note,
          row.created_by,
          row.created_at,
        ];
      });
      await database.query(
        `INSERT INTO public."AgentVersion"
          (id, "agentId", "versionNumber", model, "promptBlocks", "dynamicBlocks",
           "toolsBlockConfig", "modelRoutes", "memoryConfig", "outputSchema", note,
           "createdBy", "createdAt")
         VALUES ${parameterTuples(rows.length, 13)}`,
        values
      );
    },
    chunkSize
  );
}

interface BindingSourceRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  environment_id: string;
  agent_id: string;
  active_agent_version_id: string;
  canary_percent: number;
  created_at: Date;
  updated_at: Date;
}

/** Installs active pointers only after every mapped AgentVersion has been inserted. */
export async function backfillBatch1AgentBindings(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<void> {
  await forEachSourceChunk<BindingSourceRow>(
    database,
    `SELECT source.id::text AS source_id, binding_map.target_id::text AS target_id,
            environment_map.target_id::text AS environment_id,
            agent_map.target_id::text AS agent_id,
            version_map.target_id::text AS active_agent_version_id,
            source."canaryPercent" AS canary_percent,
            source."createdAt" AS created_at, source."updatedAt" AS updated_at
       FROM cutover_legacy."PlatosAgent" source
       JOIN cutover_legacy.cutover_id_map binding_map
         ON binding_map.mapping_version = 1 AND binding_map.source_model = 'PlatosAgent'
        AND binding_map.source_id = source.id AND binding_map.target_model = 'AgentBinding'
        AND binding_map.stable_suffix = 'agent-binding'
       JOIN cutover_legacy.cutover_id_map environment_map
         ON environment_map.mapping_version = 1 AND environment_map.source_model = 'RuntimeEnvironment'
        AND environment_map.source_id = source."environmentId" AND environment_map.target_model = 'Environment'
       JOIN cutover_legacy.cutover_id_map agent_map
         ON agent_map.mapping_version = 1 AND agent_map.source_model = 'PlatosAgent'
        AND agent_map.source_id = source.id AND agent_map.target_model = 'Agent'
        AND agent_map.stable_suffix = ''
       JOIN cutover_legacy.cutover_id_map version_map
         ON version_map.mapping_version = 1 AND version_map.source_model = 'PlatosAgentVersion'
        AND version_map.source_id = source."currentVersionId" AND version_map.target_model = 'AgentVersion'
        AND version_map.stable_suffix = ''
      WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      const values = rows.flatMap((row) => [
        row.target_id,
        row.environment_id,
        row.agent_id,
        row.active_agent_version_id,
        row.canary_percent,
        row.created_at,
        row.updated_at,
      ]);
      await database.query(
        `INSERT INTO public."AgentBinding"
          (id, "environmentId", "agentId", "activeAgentVersionId", "canaryPercent",
           "createdAt", "updatedAt")
         VALUES ${parameterTuples(rows.length, 7)}`,
        values
      );
    },
    chunkSize
  );
}

export async function backfillRetainedAgentToolBatch1(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<void> {
  await validateRetainedAgentToolBatch1Source(database);
  await backfillBatch1Tools(database, chunkSize);
  await backfillBatch1AgentClusters(database, chunkSize);
  await backfillBatch1Agents(database, chunkSize);
  await backfillBatch1AgentVersions(database, chunkSize);
  await backfillBatch1AgentBindings(database, chunkSize);
}

const conservationValidationSql = `
  WITH equations(id, source_count, target_count) AS (
    VALUES
      ('tools',
       (SELECT count(*) FROM cutover_legacy."PlatosToolDefinition"),
       (SELECT count(*) FROM public."Tool" target JOIN cutover_legacy.cutover_id_map map
          ON map.mapping_version = 1 AND map.source_model = 'PlatosToolDefinition'
         AND map.target_model = 'Tool' AND map.target_id = target.id)),
      ('agent-clusters',
       (SELECT count(*) FROM cutover_legacy."PlatosAgentCluster"),
       (SELECT count(*) FROM public."AgentCluster" target JOIN cutover_legacy.cutover_id_map map
          ON map.mapping_version = 1 AND map.source_model = 'PlatosAgentCluster'
         AND map.target_model = 'AgentCluster' AND map.target_id = target.id)),
      ('agents',
       (SELECT count(*) FROM cutover_legacy."PlatosAgent"),
       (SELECT count(*) FROM public."Agent" target JOIN cutover_legacy.cutover_id_map map
          ON map.mapping_version = 1 AND map.source_model = 'PlatosAgent'
         AND map.target_model = 'Agent' AND map.target_id = target.id)),
      ('agent-versions',
       (SELECT count(*) FROM cutover_legacy."PlatosAgentVersion"),
       (SELECT count(*) FROM public."AgentVersion" target JOIN cutover_legacy.cutover_id_map map
          ON map.mapping_version = 1 AND map.source_model = 'PlatosAgentVersion'
         AND map.target_model = 'AgentVersion' AND map.target_id = target.id)),
      ('agent-bindings',
       (SELECT count(*) FROM cutover_legacy."PlatosAgent"),
       (SELECT count(*) FROM public."AgentBinding" target JOIN cutover_legacy.cutover_id_map map
          ON map.mapping_version = 1 AND map.source_model = 'PlatosAgent'
         AND map.target_model = 'AgentBinding' AND map.target_id = target.id))
  )
  SELECT id FROM equations WHERE source_count <> target_count ORDER BY id`;

const ancestryValidationSql = `
  WITH issues AS (
    SELECT 'agent' AS issue FROM public."Agent" agent
    JOIN cutover_legacy.cutover_id_map map
      ON map.mapping_version = 1 AND map.source_model = 'PlatosAgent'
     AND map.target_model = 'Agent' AND map.target_id = agent.id
    LEFT JOIN public."Project" project ON project.id = agent."projectId"
    WHERE project.id IS NULL
    UNION ALL
    SELECT 'cluster' FROM public."AgentCluster" cluster
    JOIN cutover_legacy.cutover_id_map map
      ON map.mapping_version = 1 AND map.source_model = 'PlatosAgentCluster'
     AND map.target_model = 'AgentCluster' AND map.target_id = cluster.id
    LEFT JOIN public."Environment" environment ON environment.id = cluster."environmentId"
    WHERE environment.id IS NULL
    UNION ALL
    SELECT 'version' FROM public."AgentVersion" version
    JOIN cutover_legacy.cutover_id_map map
      ON map.mapping_version = 1 AND map.source_model = 'PlatosAgentVersion'
     AND map.target_model = 'AgentVersion' AND map.target_id = version.id
    LEFT JOIN public."Agent" agent ON agent.id = version."agentId"
    WHERE agent.id IS NULL
    UNION ALL
    SELECT 'binding' FROM public."AgentBinding" binding
    JOIN cutover_legacy.cutover_id_map map
      ON map.mapping_version = 1 AND map.source_model = 'PlatosAgent'
     AND map.target_model = 'AgentBinding' AND map.target_id = binding.id
    LEFT JOIN public."Environment" environment ON environment.id = binding."environmentId"
    LEFT JOIN public."Agent" agent
      ON agent.id = binding."agentId" AND agent."projectId" = environment."projectId"
    LEFT JOIN public."AgentVersion" version
      ON version.id = binding."activeAgentVersionId" AND version."agentId" = agent.id
    WHERE environment.id IS NULL OR agent.id IS NULL OR version.id IS NULL
       OR binding."canaryAgentVersionId" IS NOT NULL OR binding."clusterId" IS NOT NULL
  )
  SELECT DISTINCT issue FROM issues ORDER BY issue`;

const jsonValidationSql = `
  WITH issues AS (
    SELECT 'tool-param-schema' AS issue FROM public."Tool" target
    JOIN cutover_legacy.cutover_id_map map
      ON map.mapping_version = 1 AND map.source_model = 'PlatosToolDefinition'
     AND map.target_model = 'Tool' AND map.target_id = target.id
    WHERE jsonb_typeof(target."paramSchema") <> 'object' OR target.kind <> 'ENTITY'
    UNION ALL
    SELECT 'cluster-metadata' FROM public."AgentCluster" target
    JOIN cutover_legacy.cutover_id_map map
      ON map.mapping_version = 1 AND map.source_model = 'PlatosAgentCluster'
     AND map.target_model = 'AgentCluster' AND map.target_id = target.id
    WHERE target.metadata IS NOT NULL AND jsonb_typeof(target.metadata) <> 'object'
    UNION ALL
    SELECT 'version-json-or-export-field' FROM public."AgentVersion" target
    JOIN cutover_legacy.cutover_id_map map
      ON map.mapping_version = 1 AND map.source_model = 'PlatosAgentVersion'
     AND map.target_model = 'AgentVersion' AND map.target_id = target.id
    WHERE jsonb_typeof(target."promptBlocks") <> 'array'
       OR jsonb_typeof(target."dynamicBlocks") <> 'array'
       OR jsonb_typeof(target."toolsBlockConfig") <> 'object'
       OR jsonb_typeof(target."modelRoutes") <> 'array'
       OR jsonb_typeof(target."memoryConfig") <> 'object'
       OR (target."outputSchema" IS NOT NULL AND jsonb_typeof(target."outputSchema") <> 'object')
       OR target."systemPrompt" IS NOT NULL
       OR target."maxSteps" <> 10 OR target."contextLimit" <> 128000
       OR target."toolDefaultPolicy" <> 'NONE'
  )
  SELECT DISTINCT issue FROM issues ORDER BY issue`;

async function assertValidationQuery(
  database: CutoverDatabase,
  sql: string,
  code: string,
  summary: string
): Promise<void> {
  const issues = await database.query<{ id?: string; issue?: string }>(sql);
  if (issues.rows.length > 0) {
    throw new CutoverFailure(
      code,
      `${summary}: ${issues.rows.map((row) => row.id ?? row.issue ?? "unknown").join(", ")}`
    );
  }
}

export async function validateRetainedAgentToolBatch1(database: CutoverDatabase): Promise<void> {
  await assertValidationQuery(
    database,
    conservationValidationSql,
    "BATCH1_CONSERVATION_FAILED",
    "retained agent/tool Batch 1 conservation failed"
  );
  await assertValidationQuery(
    database,
    ancestryValidationSql,
    "BATCH1_ANCESTRY_FAILED",
    "retained agent/tool Batch 1 ancestry failed"
  );
  await assertValidationQuery(
    database,
    jsonValidationSql,
    "BATCH1_JSON_VALIDATION_FAILED",
    "retained agent/tool Batch 1 JSON validation failed"
  );
}
