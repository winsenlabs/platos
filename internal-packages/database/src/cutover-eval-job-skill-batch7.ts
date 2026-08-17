import { CUTOVER_CHUNK_SIZE } from "./cutover-backfill";
import { assertSecretFreeCutoverEvidence } from "./cutover-crypto";
import { normalizeJsonField, type JsonField, type JsonValue } from "./json";
import type { CutoverDatabase } from "./cutover-types";
import { CutoverFailure } from "./cutover-types";

export const retainedEvalJobSkillBatch7SourceModels = [
  "PlatosMessageRating",
  "PlatosEvalCriterion",
  "PlatosAgentEval",
  "PlatosGoldenSet",
  "PlatosTask",
  "PlatosSkill",
  "PlatosAgentSkill",
  "PlatosMacro",
] as const;

export const retainedEvalJobSkillBatch7MappingTargets = [
  { sourceModel: "PlatosMessageRating", targetModel: "MessageRating", stableSuffix: "" },
  { sourceModel: "PlatosEvalCriterion", targetModel: "EvalCriterion", stableSuffix: "" },
  { sourceModel: "PlatosAgentEval", targetModel: "AgentEval", stableSuffix: "" },
  { sourceModel: "PlatosGoldenSet", targetModel: "GoldenSet", stableSuffix: "" },
  { sourceModel: "PlatosTask", targetModel: "Job", stableSuffix: "" },
  { sourceModel: "PlatosSkill", targetModel: "Skill", stableSuffix: "" },
  { sourceModel: "PlatosSkill", targetModel: "ProjectSkill", stableSuffix: "project-skill" },
  {
    sourceModel: "PlatosSkill",
    targetModel: "EnvironmentSkill",
    stableSuffix: "environment-skill",
  },
  { sourceModel: "PlatosAgentSkill", targetModel: "AgentSkill", stableSuffix: "" },
  { sourceModel: "PlatosMacro", targetModel: "Macro", stableSuffix: "" },
] as const;

export interface RetainedEvalJobSkillBatch7Evidence {
  readonly batch: "retained-eval-job-skill-batch7";
  readonly sourceRows: Readonly<Record<string, number>>;
  readonly targetRows: Readonly<Record<string, number>>;
  readonly splitCounts: Readonly<{
    skillSources: number;
    skillTargets: number;
    projectSkillTargets: number;
    environmentSkillTargets: number;
    totalSplitTargets: number;
  }>;
}

function batch7Failure(code: string, summary: string): CutoverFailure {
  return new CutoverFailure(code, summary);
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

async function forEachBatch7SourceChunk<Row extends Record<string, unknown>>(
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
      throw batch7Failure("BATCH7_CHUNK_ORDER_INVALID", "Batch 7 source chunk order is not stable");
    }
    cursor = nextCursor;
    count += result.rows.length;
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw batch7Failure("BATCH7_SOURCE_VALUE_INVALID", `${label} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.includes("\0")) {
    throw batch7Failure("BATCH7_SOURCE_VALUE_INVALID", `${label} must be a string or null`);
  }
  return value;
}

function nullableNonNegativeInteger(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw batch7Failure("BATCH7_SOURCE_VALUE_INVALID", `${label} must be a non-negative integer`);
  }
  return value as number;
}

function normalizeBatch7Json(field: JsonField, value: unknown): JsonValue {
  try {
    return normalizeJsonField(field, value) as unknown as JsonValue;
  } catch {
    throw batch7Failure("BATCH7_JSON_INVALID", `${field} has a malformed JSON root`);
  }
}

function normalizeNullableBatch7Json(field: JsonField, value: unknown): JsonValue | null {
  if (value === null || value === undefined) return null;
  return normalizeBatch7Json(field, value);
}

function normalizeStringArray(
  value: unknown,
  label: string,
  requireUniqueReferences = true
): readonly string[] {
  if (!Array.isArray(value)) {
    throw batch7Failure("BATCH7_ARRAY_INVALID", `${label} must be an array`);
  }
  const normalized = value.map((entry, index) => nonEmptyString(entry, `${label}[${index}]`));
  if (requireUniqueReferences && new Set(normalized).size !== normalized.length) {
    throw batch7Failure("BATCH7_ARRAY_INVALID", `${label} must not contain duplicate references`);
  }
  return normalized;
}

export function normalizeBatch7Rating(value: unknown): 1 | 5 {
  if (value === -1) return 1;
  if (value === 1) return 5;
  throw batch7Failure(
    "BATCH7_RATING_INVALID",
    "message rating is not representable on the 1..5 scale"
  );
}

export function normalizeBatch7JobStatus(value: unknown): "ACTIVE" | "CANCELLED" {
  if (value === true) return "ACTIVE";
  if (value === false) return "CANCELLED";
  throw batch7Failure("BATCH7_STATUS_INVALID", "job status is not representable");
}

/** Canonical decimal(18,6) text; rejects negative, non-finite, or overflowing costs. */
export function normalizeBatch7CostCents(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value >= 1_000_000_000_000
  ) {
    throw batch7Failure("BATCH7_COST_INVALID", "eval cost is not representable as decimal(18,6)");
  }
  const fixed = value.toFixed(6);
  if (Number(fixed) !== value) {
    throw batch7Failure(
      "BATCH7_COST_INVALID",
      "eval cost exceeds canonical decimal(18,6) precision"
    );
  }
  return fixed;
}

function normalizeBatch7Score(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw batch7Failure(
      "BATCH7_SCORE_INVALID",
      "eval score is not representable on the 0..100 scale"
    );
  }
  return value;
}

const sourceAndMappingValidationSql = `
  WITH expected(source_model, target_model, stable_suffix) AS (VALUES
    ('PlatosMessageRating','MessageRating',''),
    ('PlatosEvalCriterion','EvalCriterion',''),
    ('PlatosAgentEval','AgentEval',''),
    ('PlatosGoldenSet','GoldenSet',''),
    ('PlatosTask','Job',''),
    ('PlatosSkill','Skill',''),
    ('PlatosSkill','ProjectSkill','project-skill'),
    ('PlatosSkill','EnvironmentSkill','environment-skill'),
    ('PlatosAgentSkill','AgentSkill',''),
    ('PlatosMacro','Macro','')
  ), source_ids(source_model, source_id) AS (
    SELECT 'PlatosMessageRating', id FROM cutover_legacy."PlatosMessageRating"
    UNION ALL SELECT 'PlatosEvalCriterion', id FROM cutover_legacy."PlatosEvalCriterion"
    UNION ALL SELECT 'PlatosAgentEval', id FROM cutover_legacy."PlatosAgentEval"
    UNION ALL SELECT 'PlatosGoldenSet', id FROM cutover_legacy."PlatosGoldenSet"
    UNION ALL SELECT 'PlatosTask', id FROM cutover_legacy."PlatosTask"
    UNION ALL SELECT 'PlatosSkill', id FROM cutover_legacy."PlatosSkill"
    UNION ALL SELECT 'PlatosAgentSkill', id FROM cutover_legacy."PlatosAgentSkill"
    UNION ALL SELECT 'PlatosMacro', id FROM cutover_legacy."PlatosMacro"
  ), scoped(source_model, source_id, organization_id, project_id, environment_id) AS (
    SELECT 'PlatosMessageRating', id, "organizationId", "projectId", "environmentId" FROM cutover_legacy."PlatosMessageRating"
    UNION ALL SELECT 'PlatosEvalCriterion', id, "organizationId", "projectId", "environmentId" FROM cutover_legacy."PlatosEvalCriterion"
    UNION ALL SELECT 'PlatosAgentEval', id, "organizationId", "projectId", "environmentId" FROM cutover_legacy."PlatosAgentEval"
    UNION ALL SELECT 'PlatosGoldenSet', id, "organizationId", "projectId", "environmentId" FROM cutover_legacy."PlatosGoldenSet"
    UNION ALL SELECT 'PlatosTask', id, "organizationId", "projectId", "environmentId" FROM cutover_legacy."PlatosTask"
    UNION ALL SELECT 'PlatosSkill', id, "organizationId", "projectId", "environmentId" FROM cutover_legacy."PlatosSkill"
    UNION ALL SELECT 'PlatosAgentSkill', id, "organizationId", "projectId", "environmentId" FROM cutover_legacy."PlatosAgentSkill"
    UNION ALL SELECT 'PlatosMacro', id, "organizationId", "projectId", "environmentId" FROM cutover_legacy."PlatosMacro"
  ), issues AS (
    SELECT 'missing-or-duplicate-id-map' AS issue WHERE EXISTS (
      SELECT 1 FROM source_ids source JOIN expected USING (source_model)
       WHERE (SELECT count(*) FROM cutover_legacy.cutover_id_map map
               WHERE map.mapping_version=1 AND map.source_model=source.source_model
                 AND map.source_id=source.source_id AND map.target_model=expected.target_model
                 AND map.stable_suffix=expected.stable_suffix) <> 1)
    UNION ALL SELECT 'scope-ancestry' WHERE EXISTS (
      SELECT 1 FROM scoped source
      LEFT JOIN cutover_legacy."RuntimeEnvironment" environment ON environment.id=source.environment_id
      LEFT JOIN cutover_legacy."Project" project ON project.id=source.project_id
      WHERE source.organization_id IS NULL OR source.project_id IS NULL OR source.environment_id IS NULL
         OR environment.id IS NULL OR project.id IS NULL
         OR environment."projectId"<>source.project_id
         OR environment."organizationId"<>source.organization_id
         OR project."organizationId"<>source.organization_id)
    UNION ALL SELECT 'message-rating-reference' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosMessageRating" source
      LEFT JOIN cutover_legacy."PlatosAgentMessage" message ON message.id=source."messageId" AND message."threadId"=source."threadId"
      LEFT JOIN cutover_legacy."PlatosAgentThread" thread ON thread.id=source."threadId"
       AND thread."environmentId"=source."environmentId" AND thread."agentId"=source."agentId"
      LEFT JOIN cutover_legacy."PlatosAgentVersion" version ON version.id=source."agentVersionId" AND version."agentId"=source."agentId"
      WHERE message.id IS NULL OR thread.id IS NULL
         OR (source."agentVersionId" IS NOT NULL AND version.id IS NULL)
         OR (SELECT count(*) FROM cutover_legacy."PlatosEndUser" end_user
              WHERE end_user."organizationId"=source."organizationId"
                AND end_user."projectId"=source."projectId"
                AND end_user."environmentId"=source."environmentId"
                AND source."userId" IN (end_user.id,end_user."externalUserId",end_user."linkedExternalId")) <> 1)
    UNION ALL SELECT 'eval-criterion-reference' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosEvalCriterion" source
      LEFT JOIN cutover_legacy."PlatosAgent" agent ON agent.id=source."agentId"
       AND agent."organizationId"=source."organizationId" AND agent."projectId"=source."projectId"
       AND agent."environmentId"=source."environmentId"
      WHERE source."agentId" IS NOT NULL AND agent.id IS NULL)
    UNION ALL SELECT 'agent-eval-reference' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosAgentEval" source
      LEFT JOIN cutover_legacy."PlatosAgent" agent ON agent.id=source."agentId"
       AND agent."organizationId"=source."organizationId" AND agent."projectId"=source."projectId"
       AND agent."environmentId"=source."environmentId"
      LEFT JOIN cutover_legacy."PlatosAgentVersion" version ON version.id=source."agentVersionId" AND version."agentId"=source."agentId"
      LEFT JOIN cutover_legacy."PlatosAgentThread" thread ON thread.id=source."threadId"
       AND thread."environmentId"=source."environmentId" AND thread."agentId"=source."agentId"
      LEFT JOIN cutover_legacy."PlatosAgentMessage" message ON message.id=source."messageId" AND message."threadId"=source."threadId"
      LEFT JOIN cutover_legacy."PlatosEvalCriterion" criterion ON criterion.id=source."criterionId"
       AND criterion."organizationId"=source."organizationId" AND criterion."projectId"=source."projectId"
       AND criterion."environmentId"=source."environmentId"
       AND (criterion."agentId" IS NULL OR criterion."agentId"=source."agentId")
      WHERE agent.id IS NULL OR thread.id IS NULL OR criterion.id IS NULL
         OR (source."agentVersionId" IS NOT NULL AND version.id IS NULL)
         OR (source."messageId" IS NOT NULL AND message.id IS NULL))
    UNION ALL SELECT 'golden-set-reference' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosGoldenSet" source
      LEFT JOIN cutover_legacy."PlatosAgent" agent ON agent.id=source."agentId"
       AND agent."organizationId"=source."organizationId" AND agent."projectId"=source."projectId"
       AND agent."environmentId"=source."environmentId"
      WHERE agent.id IS NULL
         OR cardinality(source."threadIds")<>(SELECT count(*) FROM unnest(source."threadIds") item(id))
         OR cardinality(source."criterionIds")<>(SELECT count(*) FROM unnest(source."criterionIds") item(id))
         OR EXISTS (SELECT 1 FROM unnest(source."threadIds") item(id) WHERE item.id IS NULL)
         OR EXISTS (SELECT 1 FROM unnest(source."criterionIds") item(id) WHERE item.id IS NULL)
         OR (SELECT count(*) FROM unnest(source."threadIds") item(id))<>(SELECT count(DISTINCT id) FROM unnest(source."threadIds") item(id))
         OR (SELECT count(*) FROM unnest(source."criterionIds") item(id))<>(SELECT count(DISTINCT id) FROM unnest(source."criterionIds") item(id))
         OR EXISTS (SELECT 1 FROM unnest(source."threadIds") item(id)
                    LEFT JOIN cutover_legacy."PlatosAgentThread" thread ON thread.id=item.id
                     AND thread."environmentId"=source."environmentId" AND thread."agentId"=source."agentId"
                    WHERE thread.id IS NULL)
         OR EXISTS (SELECT 1 FROM unnest(source."criterionIds") item(id)
                    LEFT JOIN cutover_legacy."PlatosEvalCriterion" criterion ON criterion.id=item.id
                     AND criterion."environmentId"=source."environmentId"
                     AND (criterion."agentId" IS NULL OR criterion."agentId"=source."agentId")
                    WHERE criterion.id IS NULL))
    UNION ALL SELECT 'job-agent-reference' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosTask" source
      WHERE EXISTS (SELECT 1 FROM unnest(source."allowedAgentIds") item(id)
                    LEFT JOIN cutover_legacy."PlatosAgent" agent ON agent.id=item.id
                     AND agent."organizationId"=source."organizationId" AND agent."projectId"=source."projectId"
                     AND agent."environmentId"=source."environmentId" WHERE item.id IS NULL OR agent.id IS NULL)
         OR (SELECT count(*) FROM unnest(source."allowedAgentIds") item(id))<>(SELECT count(DISTINCT id) FROM unnest(source."allowedAgentIds") item(id)))
    UNION ALL SELECT 'skill-association' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosSkill" source
      WHERE source."projectId" IS NULL OR source."environmentId" IS NULL)
      OR EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosAgentSkill" association
      LEFT JOIN cutover_legacy."PlatosAgent" agent ON agent.id=association."agentId"
       AND agent."organizationId"=association."organizationId" AND agent."projectId"=association."projectId"
       AND agent."environmentId"=association."environmentId"
      LEFT JOIN cutover_legacy."PlatosAgentVersion" version ON version.id=agent."currentVersionId" AND version."agentId"=agent.id
      LEFT JOIN cutover_legacy."PlatosSkill" skill ON skill.id=association."skillId"
       AND skill."organizationId"=association."organizationId" AND skill."projectId"=association."projectId"
       AND skill."environmentId"=association."environmentId"
      WHERE agent.id IS NULL OR version.id IS NULL OR skill.id IS NULL)
    UNION ALL SELECT 'duplicate-skill-slug' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosSkill" GROUP BY "organizationId","skillId",version HAVING count(*)>1)
    UNION ALL SELECT 'target-unique-collision' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosEvalCriterion" GROUP BY "environmentId",name HAVING count(*)>1
      UNION ALL SELECT 1 FROM cutover_legacy."PlatosGoldenSet" GROUP BY "environmentId","agentId",name HAVING count(*)>1
      UNION ALL SELECT 1 FROM cutover_legacy."PlatosMacro" GROUP BY "environmentId",name HAVING count(*)>1)
    UNION ALL SELECT 'json-root' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosAgentEval" WHERE jsonb_typeof("criterionSnapshot")<>'object'
      UNION ALL SELECT 1 FROM cutover_legacy."PlatosTask" WHERE "payloadSchema" IS NOT NULL AND jsonb_typeof("payloadSchema")<>'object'
      UNION ALL SELECT 1 FROM cutover_legacy."PlatosSkill" WHERE jsonb_typeof(manifest)<>'object'
        OR ("providesTools" IS NOT NULL AND jsonb_typeof("providesTools")<>'array')
      UNION ALL SELECT 1 FROM cutover_legacy."PlatosAgentSkill" WHERE config IS NOT NULL AND jsonb_typeof(config)<>'object'
      UNION ALL SELECT 1 FROM cutover_legacy."PlatosMacro" WHERE jsonb_typeof(steps)<>'array'
        OR ("paramSchema" IS NOT NULL AND jsonb_typeof("paramSchema")<>'object'))
    UNION ALL SELECT 'unrepresentable-scalar' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosMessageRating" WHERE rating NOT IN (-1,1)
      UNION ALL SELECT 1 FROM cutover_legacy."PlatosEvalCriterion" WHERE "scoreScaleMin">="scoreScaleMax"
      UNION ALL SELECT 1 FROM cutover_legacy."PlatosAgentEval" WHERE score<0 OR score>100 OR score IN ('-Infinity'::float8,'Infinity'::float8,'NaN'::float8)
        OR "costCents"<'0'::float8 OR "costCents"='Infinity'::float8 OR "costCents"='NaN'::float8
        OR "latencyMs"<0
      UNION ALL SELECT 1 FROM cutover_legacy."PlatosTask" WHERE "maxRetries"<0)
  ) SELECT DISTINCT issue FROM issues ORDER BY issue`;

export async function validateRetainedEvalJobSkillBatch7Source(
  database: CutoverDatabase
): Promise<void> {
  const issues = await database.query<{ issue: string }>(sourceAndMappingValidationSql);
  if (issues.rows.length > 0) {
    throw batch7Failure(
      "BATCH7_SOURCE_OR_MAPPING_INVALID",
      `retained eval/job/skill Batch 7 source validation failed: ${issues.rows
        .map((row) => row.issue)
        .join(", ")}`
    );
  }
}

interface MessageRatingRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  environment_id: string;
  turn_id: string;
  agent_id: string;
  agent_version_id: string | null;
  end_user_id: string;
  rating: number;
  comment: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function backfillBatch7MessageRatings(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch7SourceChunk<MessageRatingRow>(
    database,
    `SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
            environment_map.target_id::text AS environment_id, turn_map.target_id::text AS turn_id,
            agent_map.target_id::text AS agent_id, version_map.target_id::text AS agent_version_id,
            end_user_map.target_id::text AS end_user_id, source.rating, source.comment,
            source."createdAt" AS created_at, source."updatedAt" AS updated_at
       FROM cutover_legacy."PlatosMessageRating" source
       JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version=1 AND target_map.source_model='PlatosMessageRating' AND target_map.source_id=source.id AND target_map.target_model='MessageRating' AND target_map.stable_suffix=''
       JOIN cutover_legacy.cutover_id_map environment_map ON environment_map.mapping_version=1 AND environment_map.source_model='RuntimeEnvironment' AND environment_map.source_id=source."environmentId" AND environment_map.target_model='Environment' AND environment_map.stable_suffix=''
       JOIN cutover_legacy.cutover_id_map turn_map ON turn_map.mapping_version=1 AND turn_map.source_model='PlatosAgentMessage' AND turn_map.source_id=source."messageId" AND turn_map.target_model='Turn' AND turn_map.stable_suffix=''
       JOIN cutover_legacy.cutover_id_map agent_map ON agent_map.mapping_version=1 AND agent_map.source_model='PlatosAgent' AND agent_map.source_id=source."agentId" AND agent_map.target_model='Agent' AND agent_map.stable_suffix=''
       LEFT JOIN cutover_legacy.cutover_id_map version_map ON version_map.mapping_version=1 AND version_map.source_model='PlatosAgentVersion' AND version_map.source_id=source."agentVersionId" AND version_map.target_model='AgentVersion' AND version_map.stable_suffix=''
       JOIN LATERAL (SELECT end_user.id FROM cutover_legacy."PlatosEndUser" end_user
                      WHERE end_user."organizationId"=source."organizationId" AND end_user."projectId"=source."projectId"
                        AND end_user."environmentId"=source."environmentId"
                        AND source."userId" IN (end_user.id,end_user."externalUserId",end_user."linkedExternalId")) resolved ON true
       JOIN cutover_legacy.cutover_id_map end_user_map ON end_user_map.mapping_version=1 AND end_user_map.source_model='PlatosEndUser' AND end_user_map.source_id=resolved.id AND end_user_map.target_model='EndUser' AND end_user_map.stable_suffix=''
      WHERE source.id>$1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."MessageRating" (id,"environmentId","turnId","agentId","agentVersionId","endUserId",rating,comment,"createdAt","updatedAt") VALUES ${parameterTuples(
          rows.length,
          10
        )}`,
        rows.flatMap((row) => [
          row.target_id,
          row.environment_id,
          row.turn_id,
          row.agent_id,
          row.agent_version_id,
          row.end_user_id,
          normalizeBatch7Rating(row.rating),
          nullableString(row.comment, "PlatosMessageRating.comment"),
          row.created_at,
          row.updated_at,
        ])
      );
    },
    chunkSize
  );
}

interface EvalCriterionRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  environment_id: string;
  agent_id: string | null;
  name: string;
  description: string | null;
  judge_prompt: string;
  rubric: string | null;
  judge_model: string | null;
  score_scale_min: number;
  score_scale_max: number;
  is_active: boolean;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export async function backfillBatch7EvalCriteria(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch7SourceChunk<EvalCriterionRow>(
    database,
    `SELECT source.id::text AS source_id,target_map.target_id::text AS target_id,environment_map.target_id::text AS environment_id,
            agent_map.target_id::text AS agent_id,source.name,source.description,source."judgePrompt" AS judge_prompt,
            source.rubric,source."judgeModel" AS judge_model,source."scoreScaleMin" AS score_scale_min,
            source."scoreScaleMax" AS score_scale_max,source."isActive" AS is_active,source."createdBy" AS created_by,
            source."createdAt" AS created_at,source."updatedAt" AS updated_at
       FROM cutover_legacy."PlatosEvalCriterion" source
       JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version=1 AND target_map.source_model='PlatosEvalCriterion' AND target_map.source_id=source.id AND target_map.target_model='EvalCriterion' AND target_map.stable_suffix=''
       JOIN cutover_legacy.cutover_id_map environment_map ON environment_map.mapping_version=1 AND environment_map.source_model='RuntimeEnvironment' AND environment_map.source_id=source."environmentId" AND environment_map.target_model='Environment' AND environment_map.stable_suffix=''
       LEFT JOIN cutover_legacy.cutover_id_map agent_map ON agent_map.mapping_version=1 AND agent_map.source_model='PlatosAgent' AND agent_map.source_id=source."agentId" AND agent_map.target_model='Agent' AND agent_map.stable_suffix=''
      WHERE source.id>$1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."EvalCriterion" (id,"environmentId","agentId",name,description,"judgePrompt",rubric,"judgeModel","scoreScaleMin","scoreScaleMax","isActive","createdBy","createdAt","updatedAt") VALUES ${parameterTuples(
          rows.length,
          14
        )}`,
        rows.flatMap((row) => [
          row.target_id,
          row.environment_id,
          row.agent_id,
          nonEmptyString(row.name, "PlatosEvalCriterion.name"),
          nullableString(row.description, "PlatosEvalCriterion.description"),
          nonEmptyString(row.judge_prompt, "PlatosEvalCriterion.judgePrompt"),
          nullableString(row.rubric, "PlatosEvalCriterion.rubric"),
          nullableString(row.judge_model, "PlatosEvalCriterion.judgeModel"),
          row.score_scale_min,
          row.score_scale_max,
          row.is_active,
          nonEmptyString(row.created_by, "PlatosEvalCriterion.createdBy"),
          row.created_at,
          row.updated_at,
        ])
      );
    },
    chunkSize
  );
}

interface AgentEvalRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  environment_id: string;
  agent_id: string;
  agent_version_id: string | null;
  thread_id: string;
  turn_id: string | null;
  criterion_id: string;
  criterion_snapshot: unknown;
  judge_model: string;
  judge_prompt_used: string;
  raw_response: string | null;
  score: number;
  rationale: string | null;
  passed: boolean;
  cost_cents: number | null;
  latency_ms: number | null;
  created_at: Date;
}

export async function backfillBatch7AgentEvals(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch7SourceChunk<AgentEvalRow>(
    database,
    `SELECT source.id::text AS source_id,target_map.target_id::text AS target_id,environment_map.target_id::text AS environment_id,
            agent_map.target_id::text AS agent_id,version_map.target_id::text AS agent_version_id,thread_map.target_id::text AS thread_id,
            turn_map.target_id::text AS turn_id,criterion_map.target_id::text AS criterion_id,source."criterionSnapshot" AS criterion_snapshot,
            source."judgeModel" AS judge_model,source."judgePromptUsed" AS judge_prompt_used,source."rawResponse" AS raw_response,
            source.score,source.rationale,source.passed,source."costCents" AS cost_cents,source."latencyMs" AS latency_ms,source."createdAt" AS created_at
       FROM cutover_legacy."PlatosAgentEval" source
       JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version=1 AND target_map.source_model='PlatosAgentEval' AND target_map.source_id=source.id AND target_map.target_model='AgentEval' AND target_map.stable_suffix=''
       JOIN cutover_legacy.cutover_id_map environment_map ON environment_map.mapping_version=1 AND environment_map.source_model='RuntimeEnvironment' AND environment_map.source_id=source."environmentId" AND environment_map.target_model='Environment' AND environment_map.stable_suffix=''
       JOIN cutover_legacy.cutover_id_map agent_map ON agent_map.mapping_version=1 AND agent_map.source_model='PlatosAgent' AND agent_map.source_id=source."agentId" AND agent_map.target_model='Agent' AND agent_map.stable_suffix=''
       LEFT JOIN cutover_legacy.cutover_id_map version_map ON version_map.mapping_version=1 AND version_map.source_model='PlatosAgentVersion' AND version_map.source_id=source."agentVersionId" AND version_map.target_model='AgentVersion' AND version_map.stable_suffix=''
       JOIN cutover_legacy.cutover_id_map thread_map ON thread_map.mapping_version=1 AND thread_map.source_model='PlatosAgentThread' AND thread_map.source_id=source."threadId" AND thread_map.target_model='Thread' AND thread_map.stable_suffix=''
       LEFT JOIN cutover_legacy.cutover_id_map turn_map ON turn_map.mapping_version=1 AND turn_map.source_model='PlatosAgentMessage' AND turn_map.source_id=source."messageId" AND turn_map.target_model='Turn' AND turn_map.stable_suffix=''
       JOIN cutover_legacy.cutover_id_map criterion_map ON criterion_map.mapping_version=1 AND criterion_map.source_model='PlatosEvalCriterion' AND criterion_map.source_id=source."criterionId" AND criterion_map.target_model='EvalCriterion' AND criterion_map.stable_suffix=''
      WHERE source.id>$1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."AgentEval" (id,"environmentId","agentId","agentVersionId","threadId","turnId","criterionId","criterionSnapshot","judgeModel","judgePromptUsed","rawResponse",score,rationale,passed,"costCents","latencyMs","createdAt") VALUES ${parameterTuples(
          rows.length,
          17
        )}`,
        rows.flatMap((row) => [
          row.target_id,
          row.environment_id,
          row.agent_id,
          row.agent_version_id,
          row.thread_id,
          row.turn_id,
          row.criterion_id,
          JSON.stringify(
            normalizeBatch7Json("AgentEval.criterionSnapshot", row.criterion_snapshot)
          ),
          nonEmptyString(row.judge_model, "PlatosAgentEval.judgeModel"),
          nonEmptyString(row.judge_prompt_used, "PlatosAgentEval.judgePromptUsed"),
          nullableString(row.raw_response, "PlatosAgentEval.rawResponse"),
          normalizeBatch7Score(row.score),
          nullableString(row.rationale, "PlatosAgentEval.rationale"),
          row.passed,
          normalizeBatch7CostCents(row.cost_cents),
          nullableNonNegativeInteger(row.latency_ms, "PlatosAgentEval.latencyMs"),
          row.created_at,
        ])
      );
    },
    chunkSize
  );
}

interface GoldenSetRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  environment_id: string;
  agent_id: string;
  name: string;
  description: string | null;
  thread_ids: unknown;
  criterion_ids: unknown;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export async function backfillBatch7GoldenSets(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch7SourceChunk<GoldenSetRow>(
    database,
    `SELECT source.id::text AS source_id,target_map.target_id::text AS target_id,environment_map.target_id::text AS environment_id,agent_map.target_id::text AS agent_id,
            source.name,source.description,
            ARRAY(SELECT map.target_id::text FROM unnest(source."threadIds") WITH ORDINALITY item(source_id,ordinality) JOIN cutover_legacy.cutover_id_map map ON map.mapping_version=1 AND map.source_model='PlatosAgentThread' AND map.source_id=item.source_id AND map.target_model='Thread' AND map.stable_suffix='' ORDER BY item.ordinality) AS thread_ids,
            ARRAY(SELECT map.target_id::text FROM unnest(source."criterionIds") WITH ORDINALITY item(source_id,ordinality) JOIN cutover_legacy.cutover_id_map map ON map.mapping_version=1 AND map.source_model='PlatosEvalCriterion' AND map.source_id=item.source_id AND map.target_model='EvalCriterion' AND map.stable_suffix='' ORDER BY item.ordinality) AS criterion_ids,
            source."createdBy" AS created_by,source."createdAt" AS created_at,source."updatedAt" AS updated_at
       FROM cutover_legacy."PlatosGoldenSet" source
       JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version=1 AND target_map.source_model='PlatosGoldenSet' AND target_map.source_id=source.id AND target_map.target_model='GoldenSet' AND target_map.stable_suffix=''
       JOIN cutover_legacy.cutover_id_map environment_map ON environment_map.mapping_version=1 AND environment_map.source_model='RuntimeEnvironment' AND environment_map.source_id=source."environmentId" AND environment_map.target_model='Environment' AND environment_map.stable_suffix=''
       JOIN cutover_legacy.cutover_id_map agent_map ON agent_map.mapping_version=1 AND agent_map.source_model='PlatosAgent' AND agent_map.source_id=source."agentId" AND agent_map.target_model='Agent' AND agent_map.stable_suffix=''
      WHERE source.id>$1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."GoldenSet" (id,"environmentId","agentId",name,description,"threadIds","criterionIds","createdBy","createdAt","updatedAt") VALUES ${parameterTuples(
          rows.length,
          10
        )}`,
        rows.flatMap((row) => [
          row.target_id,
          row.environment_id,
          row.agent_id,
          nonEmptyString(row.name, "PlatosGoldenSet.name"),
          nullableString(row.description, "PlatosGoldenSet.description"),
          normalizeStringArray(row.thread_ids, "GoldenSet.threadIds"),
          normalizeStringArray(row.criterion_ids, "GoldenSet.criterionIds"),
          nonEmptyString(row.created_by, "PlatosGoldenSet.createdBy"),
          row.created_at,
          row.updated_at,
        ])
      );
    },
    chunkSize
  );
}

interface JobRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  environment_id: string;
  display_name: string;
  description: string | null;
  trigger_type: string;
  schedule_cron: string | null;
  schedule_timezone: string | null;
  allowed_agent_ids: unknown;
  payload_schema: unknown;
  handler: string;
  max_retries: number;
  is_active: boolean;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export async function backfillBatch7Jobs(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch7SourceChunk<JobRow>(
    database,
    `SELECT source.id::text AS source_id,target_map.target_id::text AS target_id,environment_map.target_id::text AS environment_id,
            source."displayName" AS display_name,source.description,source."triggerType" AS trigger_type,source."scheduleCron" AS schedule_cron,
            source."scheduleTimezone" AS schedule_timezone,
            ARRAY(SELECT map.target_id::text FROM unnest(source."allowedAgentIds") WITH ORDINALITY item(source_id,ordinality) JOIN cutover_legacy.cutover_id_map map ON map.mapping_version=1 AND map.source_model='PlatosAgent' AND map.source_id=item.source_id AND map.target_model='Agent' AND map.stable_suffix='' ORDER BY item.ordinality) AS allowed_agent_ids,
            source."payloadSchema" AS payload_schema,source.handler,source."maxRetries" AS max_retries,source."isActive" AS is_active,
            source."createdBy" AS created_by,source."createdAt" AS created_at,source."updatedAt" AS updated_at
       FROM cutover_legacy."PlatosTask" source
       JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version=1 AND target_map.source_model='PlatosTask' AND target_map.source_id=source.id AND target_map.target_model='Job' AND target_map.stable_suffix=''
       JOIN cutover_legacy.cutover_id_map environment_map ON environment_map.mapping_version=1 AND environment_map.source_model='RuntimeEnvironment' AND environment_map.source_id=source."environmentId" AND environment_map.target_model='Environment' AND environment_map.stable_suffix=''
      WHERE source.id>$1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."Job" (id,"environmentId","displayName",description,"triggerType","scheduleCron","scheduleTimezone","allowedAgentIds","payloadSchema",handler,"maxRetries",status,"createdBy","createdAt","updatedAt") VALUES ${parameterTuples(
          rows.length,
          15
        )}`,
        rows.flatMap((row) => [
          row.target_id,
          row.environment_id,
          nonEmptyString(row.display_name, "PlatosTask.displayName"),
          nullableString(row.description, "PlatosTask.description"),
          nonEmptyString(row.trigger_type, "PlatosTask.triggerType"),
          nullableString(row.schedule_cron, "PlatosTask.scheduleCron"),
          nullableString(row.schedule_timezone, "PlatosTask.scheduleTimezone"),
          normalizeStringArray(row.allowed_agent_ids, "Job.allowedAgentIds"),
          row.payload_schema === null
            ? null
            : JSON.stringify(normalizeNullableBatch7Json("Job.payloadSchema", row.payload_schema)),
          nonEmptyString(row.handler, "PlatosTask.handler"),
          nullableNonNegativeInteger(row.max_retries, "PlatosTask.maxRetries"),
          normalizeBatch7JobStatus(row.is_active),
          nonEmptyString(row.created_by, "PlatosTask.createdBy"),
          row.created_at,
          row.updated_at,
        ])
      );
    },
    chunkSize
  );
}

interface SkillRow extends Record<string, unknown> {
  source_id: string;
  skill_id: string;
  project_skill_id: string;
  environment_skill_id: string;
  organization_id: string;
  project_id: string;
  environment_id: string;
  slug: string;
  name: string;
  description: string;
  version: string;
  author: string | null;
  origin: string;
  is_official: boolean;
  tags: unknown;
  source_text: string;
  manifest: unknown;
  prompt_block: string;
  provides_tools: unknown;
  created_at: Date;
  updated_at: Date;
}

async function selectBatch7SkillChunks(
  database: CutoverDatabase,
  consume: (rows: readonly SkillRow[]) => Promise<void>,
  chunkSize: number
): Promise<number> {
  return forEachBatch7SourceChunk<SkillRow>(
    database,
    `SELECT source.id::text AS source_id,skill_map.target_id::text AS skill_id,project_skill_map.target_id::text AS project_skill_id,
            environment_skill_map.target_id::text AS environment_skill_id,organization_map.target_id::text AS organization_id,
            project_map.target_id::text AS project_id,environment_map.target_id::text AS environment_id,source."skillId" AS slug,source.name,
            source.description,source.version,source.author,source.origin,source."isOfficial" AS is_official,source.tags,source.source AS source_text,
            source.manifest,source."promptBlock" AS prompt_block,source."providesTools" AS provides_tools,source."createdAt" AS created_at,source."updatedAt" AS updated_at
       FROM cutover_legacy."PlatosSkill" source
       JOIN cutover_legacy.cutover_id_map skill_map ON skill_map.mapping_version=1 AND skill_map.source_model='PlatosSkill' AND skill_map.source_id=source.id AND skill_map.target_model='Skill' AND skill_map.stable_suffix=''
       JOIN cutover_legacy.cutover_id_map project_skill_map ON project_skill_map.mapping_version=1 AND project_skill_map.source_model='PlatosSkill' AND project_skill_map.source_id=source.id AND project_skill_map.target_model='ProjectSkill' AND project_skill_map.stable_suffix='project-skill'
       JOIN cutover_legacy.cutover_id_map environment_skill_map ON environment_skill_map.mapping_version=1 AND environment_skill_map.source_model='PlatosSkill' AND environment_skill_map.source_id=source.id AND environment_skill_map.target_model='EnvironmentSkill' AND environment_skill_map.stable_suffix='environment-skill'
       JOIN cutover_legacy.cutover_id_map organization_map ON organization_map.mapping_version=1 AND organization_map.source_model='Organization' AND organization_map.source_id=source."organizationId" AND organization_map.target_model='Organization' AND organization_map.stable_suffix=''
       JOIN cutover_legacy.cutover_id_map project_map ON project_map.mapping_version=1 AND project_map.source_model='Project' AND project_map.source_id=source."projectId" AND project_map.target_model='Project' AND project_map.stable_suffix=''
       JOIN cutover_legacy.cutover_id_map environment_map ON environment_map.mapping_version=1 AND environment_map.source_model='RuntimeEnvironment' AND environment_map.source_id=source."environmentId" AND environment_map.target_model='Environment' AND environment_map.stable_suffix=''
      WHERE source.id>$1 ORDER BY source.id LIMIT $2`,
    consume,
    chunkSize
  );
}

export async function backfillBatch7Skills(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return selectBatch7SkillChunks(
    database,
    async (rows) => {
      await database.query(
        `INSERT INTO public."Skill" (id,"organizationId",slug,name,description,version,author,origin,"isOfficial",tags,source,manifest,"promptBlock","providesTools","createdAt","updatedAt") VALUES ${parameterTuples(
          rows.length,
          16
        )}`,
        rows.flatMap((row) => [
          row.skill_id,
          row.organization_id,
          nonEmptyString(row.slug, "PlatosSkill.skillId"),
          nonEmptyString(row.name, "PlatosSkill.name"),
          nonEmptyString(row.description, "PlatosSkill.description"),
          nonEmptyString(row.version, "PlatosSkill.version"),
          nullableString(row.author, "PlatosSkill.author"),
          nonEmptyString(row.origin, "PlatosSkill.origin"),
          row.is_official,
          normalizeStringArray(row.tags, "PlatosSkill.tags", false),
          nonEmptyString(row.source_text, "PlatosSkill.source"),
          JSON.stringify(normalizeBatch7Json("Skill.manifest", row.manifest)),
          nonEmptyString(row.prompt_block, "PlatosSkill.promptBlock"),
          JSON.stringify(normalizeBatch7Json("Skill.providesTools", row.provides_tools ?? [])),
          row.created_at,
          row.updated_at,
        ])
      );
    },
    chunkSize
  );
}

export async function backfillBatch7ProjectSkills(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return selectBatch7SkillChunks(
    database,
    async (rows) => {
      await database.query(
        `INSERT INTO public."ProjectSkill" (id,"projectId","skillId",enabled,"createdAt","updatedAt") VALUES ${parameterTuples(
          rows.length,
          6
        )}`,
        rows.flatMap((row) => [
          row.project_skill_id,
          row.project_id,
          row.skill_id,
          true,
          row.created_at,
          row.updated_at,
        ])
      );
    },
    chunkSize
  );
}

export async function backfillBatch7EnvironmentSkills(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return selectBatch7SkillChunks(
    database,
    async (rows) => {
      await database.query(
        `INSERT INTO public."EnvironmentSkill" (id,"environmentId","projectSkillId",enabled,config,"createdAt","updatedAt") VALUES ${parameterTuples(
          rows.length,
          7
        )}`,
        rows.flatMap((row) => [
          row.environment_skill_id,
          row.environment_id,
          row.project_skill_id,
          true,
          JSON.stringify({}),
          row.created_at,
          row.updated_at,
        ])
      );
    },
    chunkSize
  );
}

interface AgentSkillRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  agent_version_id: string;
  environment_skill_id: string;
  enabled: boolean;
  config: unknown;
  updated_at: Date;
}

export async function backfillBatch7AgentSkills(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch7SourceChunk<AgentSkillRow>(
    database,
    `SELECT source.id::text AS source_id,target_map.target_id::text AS target_id,version_map.target_id::text AS agent_version_id,
            environment_skill_map.target_id::text AS environment_skill_id,source.enabled,source.config,source."updatedAt" AS updated_at
       FROM cutover_legacy."PlatosAgentSkill" source
       JOIN cutover_legacy."PlatosAgent" agent ON agent.id=source."agentId"
       JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version=1 AND target_map.source_model='PlatosAgentSkill' AND target_map.source_id=source.id AND target_map.target_model='AgentSkill' AND target_map.stable_suffix=''
       JOIN cutover_legacy.cutover_id_map version_map ON version_map.mapping_version=1 AND version_map.source_model='PlatosAgentVersion' AND version_map.source_id=agent."currentVersionId" AND version_map.target_model='AgentVersion' AND version_map.stable_suffix=''
       JOIN cutover_legacy.cutover_id_map environment_skill_map ON environment_skill_map.mapping_version=1 AND environment_skill_map.source_model='PlatosSkill' AND environment_skill_map.source_id=source."skillId" AND environment_skill_map.target_model='EnvironmentSkill' AND environment_skill_map.stable_suffix='environment-skill'
      WHERE source.id>$1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."AgentSkill" (id,"agentVersionId","environmentSkillId",enabled,config,"createdAt","updatedAt") VALUES ${rows
          .map((_, index) => {
            const offset = index * 6;
            return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${
              offset + 5
            },transaction_timestamp(),$${offset + 6})`;
          })
          .join(", ")}`,
        rows.flatMap((row) => [
          row.target_id,
          row.agent_version_id,
          row.environment_skill_id,
          row.enabled,
          JSON.stringify(normalizeBatch7Json("AgentSkill.config", row.config ?? {})),
          row.updated_at,
        ])
      );
    },
    chunkSize
  );
}

interface MacroRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  environment_id: string;
  name: string;
  description: string | null;
  steps: unknown;
  param_schema: unknown;
  shared_with_organization: boolean;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export async function backfillBatch7Macros(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch7SourceChunk<MacroRow>(
    database,
    `SELECT source.id::text AS source_id,target_map.target_id::text AS target_id,
            environment_map.target_id::text AS environment_id,source.name,source.description,
            source.steps,source."paramSchema" AS param_schema,
            source."sharedWithOrg" AS shared_with_organization,source."createdBy" AS created_by,
            source."createdAt" AS created_at,source."updatedAt" AS updated_at
       FROM cutover_legacy."PlatosMacro" source
       JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version=1 AND target_map.source_model='PlatosMacro' AND target_map.source_id=source.id AND target_map.target_model='Macro' AND target_map.stable_suffix=''
       JOIN cutover_legacy.cutover_id_map environment_map ON environment_map.mapping_version=1 AND environment_map.source_model='RuntimeEnvironment' AND environment_map.source_id=source."environmentId" AND environment_map.target_model='Environment' AND environment_map.stable_suffix=''
      WHERE source.id>$1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."Macro" (id,"environmentId",name,description,steps,"paramSchema","sharedWithOrganization","createdBy","createdAt","updatedAt") VALUES ${parameterTuples(
          rows.length,
          10
        )}`,
        rows.flatMap((row) => [
          row.target_id,
          row.environment_id,
          nonEmptyString(row.name, "PlatosMacro.name"),
          nullableString(row.description, "PlatosMacro.description"),
          JSON.stringify(normalizeBatch7Json("Macro.steps", row.steps)),
          row.param_schema === null
            ? null
            : JSON.stringify(normalizeNullableBatch7Json("Macro.paramSchema", row.param_schema)),
          row.shared_with_organization,
          nonEmptyString(row.created_by, "PlatosMacro.createdBy"),
          row.created_at,
          row.updated_at,
        ])
      );
    },
    chunkSize
  );
}

const conservationValidationSql = `
  WITH equations(id,source_count,target_count) AS (VALUES
    ('message-ratings',(SELECT count(*) FROM cutover_legacy."PlatosMessageRating"),(SELECT count(*) FROM public."MessageRating" target JOIN cutover_legacy.cutover_id_map map ON map.mapping_version=1 AND map.source_model='PlatosMessageRating' AND map.target_model='MessageRating' AND map.target_id=target.id)),
    ('eval-criteria',(SELECT count(*) FROM cutover_legacy."PlatosEvalCriterion"),(SELECT count(*) FROM public."EvalCriterion" target JOIN cutover_legacy.cutover_id_map map ON map.mapping_version=1 AND map.source_model='PlatosEvalCriterion' AND map.target_model='EvalCriterion' AND map.target_id=target.id)),
    ('agent-evals',(SELECT count(*) FROM cutover_legacy."PlatosAgentEval"),(SELECT count(*) FROM public."AgentEval" target JOIN cutover_legacy.cutover_id_map map ON map.mapping_version=1 AND map.source_model='PlatosAgentEval' AND map.target_model='AgentEval' AND map.target_id=target.id)),
    ('golden-sets',(SELECT count(*) FROM cutover_legacy."PlatosGoldenSet"),(SELECT count(*) FROM public."GoldenSet" target JOIN cutover_legacy.cutover_id_map map ON map.mapping_version=1 AND map.source_model='PlatosGoldenSet' AND map.target_model='GoldenSet' AND map.target_id=target.id)),
    ('jobs',(SELECT count(*) FROM cutover_legacy."PlatosTask"),(SELECT count(*) FROM public."Job" target JOIN cutover_legacy.cutover_id_map map ON map.mapping_version=1 AND map.source_model='PlatosTask' AND map.target_model='Job' AND map.target_id=target.id)),
    ('skills',(SELECT count(*) FROM cutover_legacy."PlatosSkill"),(SELECT count(*) FROM public."Skill" target JOIN cutover_legacy.cutover_id_map map ON map.mapping_version=1 AND map.source_model='PlatosSkill' AND map.target_model='Skill' AND map.target_id=target.id)),
    ('project-skills',(SELECT count(*) FROM cutover_legacy."PlatosSkill"),(SELECT count(*) FROM public."ProjectSkill" target JOIN cutover_legacy.cutover_id_map map ON map.mapping_version=1 AND map.source_model='PlatosSkill' AND map.target_model='ProjectSkill' AND map.stable_suffix='project-skill' AND map.target_id=target.id)),
    ('environment-skills',(SELECT count(*) FROM cutover_legacy."PlatosSkill"),(SELECT count(*) FROM public."EnvironmentSkill" target JOIN cutover_legacy.cutover_id_map map ON map.mapping_version=1 AND map.source_model='PlatosSkill' AND map.target_model='EnvironmentSkill' AND map.stable_suffix='environment-skill' AND map.target_id=target.id)),
    ('agent-skills',(SELECT count(*) FROM cutover_legacy."PlatosAgentSkill"),(SELECT count(*) FROM public."AgentSkill" target JOIN cutover_legacy.cutover_id_map map ON map.mapping_version=1 AND map.source_model='PlatosAgentSkill' AND map.target_model='AgentSkill' AND map.target_id=target.id)),
    ('macros',(SELECT count(*) FROM cutover_legacy."PlatosMacro"),(SELECT count(*) FROM public."Macro" target JOIN cutover_legacy.cutover_id_map map ON map.mapping_version=1 AND map.source_model='PlatosMacro' AND map.target_model='Macro' AND map.target_id=target.id)),
    ('skill-split-total',(SELECT count(*)*3 FROM cutover_legacy."PlatosSkill"),
      (SELECT count(*) FROM (SELECT id FROM public."Skill" UNION ALL SELECT id FROM public."ProjectSkill" UNION ALL SELECT id FROM public."EnvironmentSkill") target
        JOIN cutover_legacy.cutover_id_map map ON map.mapping_version=1 AND map.source_model='PlatosSkill' AND map.target_id=target.id))
  ) SELECT id FROM equations WHERE source_count<>target_count ORDER BY id`;

const ancestryValidationSql = `
  WITH issues AS (
    SELECT 'message-rating' AS issue FROM public."MessageRating" target JOIN cutover_legacy.cutover_id_map map ON map.mapping_version=1 AND map.source_model='PlatosMessageRating' AND map.target_model='MessageRating' AND map.target_id=target.id
      JOIN public."Turn" turn ON turn.id=target."turnId" JOIN public."Thread" thread ON thread.id=turn."threadId"
      JOIN public."EndUser" end_user ON end_user.id=target."endUserId"
      LEFT JOIN public."AgentVersion" version ON version.id=target."agentVersionId"
      WHERE thread."environmentId"<>target."environmentId" OR thread."agentId"<>target."agentId" OR thread."endUserId"<>target."endUserId" OR (target."agentVersionId" IS NOT NULL AND version."agentId"<>target."agentId")
    UNION ALL SELECT 'agent-eval' FROM public."AgentEval" target JOIN cutover_legacy.cutover_id_map map ON map.mapping_version=1 AND map.source_model='PlatosAgentEval' AND map.target_model='AgentEval' AND map.target_id=target.id
      JOIN public."Thread" thread ON thread.id=target."threadId" JOIN public."EvalCriterion" criterion ON criterion.id=target."criterionId"
      LEFT JOIN public."Turn" turn ON turn.id=target."turnId" LEFT JOIN public."AgentVersion" version ON version.id=target."agentVersionId"
      WHERE thread."environmentId"<>target."environmentId" OR thread."agentId"<>target."agentId" OR criterion."environmentId"<>target."environmentId"
        OR (criterion."agentId" IS NOT NULL AND criterion."agentId"<>target."agentId") OR (target."turnId" IS NOT NULL AND turn."threadId"<>target."threadId")
        OR (target."agentVersionId" IS NOT NULL AND version."agentId"<>target."agentId")
    UNION ALL SELECT 'skill-chain' FROM public."EnvironmentSkill" environment_skill
      JOIN cutover_legacy.cutover_id_map map ON map.mapping_version=1 AND map.source_model='PlatosSkill' AND map.target_model='EnvironmentSkill' AND map.target_id=environment_skill.id
      JOIN public."Environment" environment ON environment.id=environment_skill."environmentId" JOIN public."ProjectSkill" project_skill ON project_skill.id=environment_skill."projectSkillId"
      JOIN public."Project" project ON project.id=project_skill."projectId" JOIN public."Skill" skill ON skill.id=project_skill."skillId"
      WHERE environment."projectId"<>project.id OR project."organizationId"<>skill."organizationId"
    UNION ALL SELECT 'agent-skill' FROM public."AgentSkill" target JOIN cutover_legacy.cutover_id_map map ON map.mapping_version=1 AND map.source_model='PlatosAgentSkill' AND map.target_model='AgentSkill' AND map.target_id=target.id
      JOIN public."AgentVersion" version ON version.id=target."agentVersionId" JOIN public."Agent" agent ON agent.id=version."agentId"
      JOIN public."EnvironmentSkill" environment_skill ON environment_skill.id=target."environmentSkillId" JOIN public."Environment" environment ON environment.id=environment_skill."environmentId"
      WHERE agent."projectId"<>environment."projectId"
    UNION ALL SELECT 'macro' FROM public."Macro" target JOIN cutover_legacy.cutover_id_map map ON map.mapping_version=1 AND map.source_model='PlatosMacro' AND map.target_model='Macro' AND map.target_id=target.id
      JOIN cutover_legacy."PlatosMacro" source ON source.id=map.source_id
      JOIN cutover_legacy.cutover_id_map environment_map ON environment_map.mapping_version=1 AND environment_map.source_model='RuntimeEnvironment' AND environment_map.source_id=source."environmentId" AND environment_map.target_model='Environment'
      WHERE target."environmentId"<>environment_map.target_id
  ) SELECT DISTINCT issue FROM issues ORDER BY issue`;

const semanticValidationSql = `
  WITH issues AS (
    SELECT 'rating-normalization' AS issue FROM public."MessageRating" target JOIN cutover_legacy.cutover_id_map map ON map.mapping_version=1 AND map.source_model='PlatosMessageRating' AND map.target_model='MessageRating' AND map.target_id=target.id
      JOIN cutover_legacy."PlatosMessageRating" source ON source.id=map.source_id WHERE target.rating<>CASE source.rating WHEN -1 THEN 1 ELSE 5 END
    UNION ALL SELECT 'eval-json-or-cost' FROM public."AgentEval" target JOIN cutover_legacy.cutover_id_map map ON map.mapping_version=1 AND map.source_model='PlatosAgentEval' AND map.target_model='AgentEval' AND map.target_id=target.id
      JOIN cutover_legacy."PlatosAgentEval" source ON source.id=map.source_id WHERE jsonb_typeof(target."criterionSnapshot")<>'object' OR target."costCents" IS DISTINCT FROM source."costCents"::numeric(18,6)
    UNION ALL SELECT 'golden-arrays' FROM public."GoldenSet" target JOIN cutover_legacy.cutover_id_map identity ON identity.mapping_version=1 AND identity.source_model='PlatosGoldenSet' AND identity.target_model='GoldenSet' AND identity.target_id=target.id
      JOIN cutover_legacy."PlatosGoldenSet" source ON source.id=identity.source_id
      WHERE target."threadIds"<>ARRAY(SELECT map.target_id::text FROM unnest(source."threadIds") WITH ORDINALITY item(source_id,ordinality) JOIN cutover_legacy.cutover_id_map map ON map.mapping_version=1 AND map.source_model='PlatosAgentThread' AND map.source_id=item.source_id AND map.target_model='Thread' ORDER BY item.ordinality)
         OR target."criterionIds"<>ARRAY(SELECT map.target_id::text FROM unnest(source."criterionIds") WITH ORDINALITY item(source_id,ordinality) JOIN cutover_legacy.cutover_id_map map ON map.mapping_version=1 AND map.source_model='PlatosEvalCriterion' AND map.source_id=item.source_id AND map.target_model='EvalCriterion' ORDER BY item.ordinality)
    UNION ALL SELECT 'job-status-or-array' FROM public."Job" target JOIN cutover_legacy.cutover_id_map identity ON identity.mapping_version=1 AND identity.source_model='PlatosTask' AND identity.target_model='Job' AND identity.target_id=target.id
      JOIN cutover_legacy."PlatosTask" source ON source.id=identity.source_id
      WHERE target.status<>CASE WHEN source."isActive" THEN 'ACTIVE'::"WorkStatus" ELSE 'CANCELLED'::"WorkStatus" END
         OR target."allowedAgentIds"<>ARRAY(SELECT map.target_id::text FROM unnest(source."allowedAgentIds") WITH ORDINALITY item(source_id,ordinality) JOIN cutover_legacy.cutover_id_map map ON map.mapping_version=1 AND map.source_model='PlatosAgent' AND map.source_id=item.source_id AND map.target_model='Agent' ORDER BY item.ordinality)
    UNION ALL SELECT 'skill-json' FROM public."Skill" target JOIN cutover_legacy.cutover_id_map map ON map.mapping_version=1 AND map.source_model='PlatosSkill' AND map.target_model='Skill' AND map.target_id=target.id
      WHERE jsonb_typeof(target.manifest)<>'object' OR jsonb_typeof(target."providesTools")<>'array'
    UNION ALL SELECT 'agent-skill-resolution' FROM public."AgentSkill" target JOIN cutover_legacy.cutover_id_map map ON map.mapping_version=1 AND map.source_model='PlatosAgentSkill' AND map.target_model='AgentSkill' AND map.target_id=target.id
      JOIN cutover_legacy."PlatosAgentSkill" source ON source.id=map.source_id JOIN cutover_legacy."PlatosAgent" agent ON agent.id=source."agentId"
      JOIN cutover_legacy.cutover_id_map version_map ON version_map.mapping_version=1 AND version_map.source_model='PlatosAgentVersion' AND version_map.source_id=agent."currentVersionId" AND version_map.target_model='AgentVersion'
      JOIN cutover_legacy.cutover_id_map skill_map ON skill_map.mapping_version=1 AND skill_map.source_model='PlatosSkill' AND skill_map.source_id=source."skillId" AND skill_map.target_model='EnvironmentSkill' AND skill_map.stable_suffix='environment-skill'
      WHERE target."agentVersionId"<>version_map.target_id OR target."environmentSkillId"<>skill_map.target_id OR jsonb_typeof(target.config)<>'object'
    UNION ALL SELECT 'macro-json-or-fields' FROM public."Macro" target JOIN cutover_legacy.cutover_id_map map ON map.mapping_version=1 AND map.source_model='PlatosMacro' AND map.target_model='Macro' AND map.target_id=target.id
      JOIN cutover_legacy."PlatosMacro" source ON source.id=map.source_id
      WHERE jsonb_typeof(target.steps)<>'array'
         OR (target."paramSchema" IS NOT NULL AND jsonb_typeof(target."paramSchema")<>'object')
         OR target.steps<>source.steps OR target."paramSchema" IS DISTINCT FROM source."paramSchema"
         OR target."sharedWithOrganization"<>source."sharedWithOrg"
  ) SELECT DISTINCT issue FROM issues ORDER BY issue`;

async function assertBatch7ValidationQuery(
  database: CutoverDatabase,
  sql: string,
  code: string,
  summary: string
): Promise<void> {
  const issues = await database.query<{ id?: string; issue?: string }>(sql);
  if (issues.rows.length > 0)
    throw batch7Failure(
      code,
      `${summary}: ${issues.rows.map((row) => row.id ?? row.issue ?? "unknown").join(", ")}`
    );
}

export async function validateRetainedEvalJobSkillBatch7(database: CutoverDatabase): Promise<void> {
  await assertBatch7ValidationQuery(
    database,
    conservationValidationSql,
    "BATCH7_CONSERVATION_FAILED",
    "retained eval/job/skill Batch 7 conservation failed"
  );
  await assertBatch7ValidationQuery(
    database,
    ancestryValidationSql,
    "BATCH7_ANCESTRY_FAILED",
    "retained eval/job/skill Batch 7 ancestry failed"
  );
  await assertBatch7ValidationQuery(
    database,
    semanticValidationSql,
    "BATCH7_SEMANTIC_VALIDATION_FAILED",
    "retained eval/job/skill Batch 7 semantic validation failed"
  );
}

export async function backfillRetainedEvalJobSkillBatch7(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<RetainedEvalJobSkillBatch7Evidence> {
  await validateRetainedEvalJobSkillBatch7Source(database);
  const messageRatings = await backfillBatch7MessageRatings(database, chunkSize);
  const evalCriteria = await backfillBatch7EvalCriteria(database, chunkSize);
  const agentEvals = await backfillBatch7AgentEvals(database, chunkSize);
  const goldenSets = await backfillBatch7GoldenSets(database, chunkSize);
  const jobs = await backfillBatch7Jobs(database, chunkSize);
  const skills = await backfillBatch7Skills(database, chunkSize);
  const projectSkills = await backfillBatch7ProjectSkills(database, chunkSize);
  const environmentSkills = await backfillBatch7EnvironmentSkills(database, chunkSize);
  const agentSkills = await backfillBatch7AgentSkills(database, chunkSize);
  const macros = await backfillBatch7Macros(database, chunkSize);
  await validateRetainedEvalJobSkillBatch7(database);
  const evidence: RetainedEvalJobSkillBatch7Evidence = {
    batch: "retained-eval-job-skill-batch7",
    sourceRows: Object.freeze({
      messageRatings,
      evalCriteria,
      agentEvals,
      goldenSets,
      jobs,
      skills,
      agentSkills,
      macros,
    }),
    targetRows: Object.freeze({
      messageRatings,
      evalCriteria,
      agentEvals,
      goldenSets,
      jobs,
      skills,
      projectSkills,
      environmentSkills,
      agentSkills,
      macros,
    }),
    splitCounts: Object.freeze({
      skillSources: skills,
      skillTargets: skills,
      projectSkillTargets: projectSkills,
      environmentSkillTargets: environmentSkills,
      totalSplitTargets: skills + projectSkills + environmentSkills,
    }),
  };
  assertSecretFreeCutoverEvidence(evidence);
  return Object.freeze(evidence);
}
