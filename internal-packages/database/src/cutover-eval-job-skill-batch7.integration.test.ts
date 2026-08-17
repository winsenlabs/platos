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
import {
  backfillRetainedEvalJobSkillBatch7,
  validateRetainedEvalJobSkillBatch7,
  validateRetainedEvalJobSkillBatch7Source,
} from "./cutover-eval-job-skill-batch7";
import { mapCutoverId } from "./cutover-id";

const runHarness = process.env.RUN_DATABASE_CUTOVER_BATCH7_HARNESS === "1";
const describeHarness = runHarness ? describe : describe.skip;
const packageRoot = resolve(__dirname, "..");
const messageEncryptionKeys = Object.freeze({ "1": "11".repeat(32) });

describeHarness("retained evaluation/job/skill Batch 7 PostgreSQL replay", () => {
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

  test("conserves mapped eval/job rows and the three-way skill split", async () => {
    for (const fixture of [
      "legacy-core-seed.sql",
      "legacy-agent-tool-batch1-seed.sql",
      "legacy-conversation-batch2-seed.sql",
      "legacy-eval-job-skill-batch7-seed.sql",
    ]) {
      await database.query(readFileSync(resolve(packageRoot, "test-fixtures", fixture), "utf8"));
    }

    await database.query("BEGIN");
    try {
      await moveLegacyCatalogToTemporarySchema(database);
      await createCleanCatalog(database, packageRoot);
      await createCutoverJournal(database, "03125bd3-8e2e-5500-8942-574db43e9203");
      await materializeCutoverIdMap(database);
      await materializeBatch2MessageOrdinalMappings(database);
      await backfillCoreTenancy(database);
      await validateCoreTenancyBackfill(database);
      await backfillRetainedAgentToolBatch1(database);
      await validateRetainedAgentToolBatch1(database);
      await backfillRetainedConversationBatch2(database, messageEncryptionKeys);
      await validateRetainedConversationBatch2(database);

      await database.query("SAVEPOINT batch7_malformed_json");
      await database.query(
        `UPDATE cutover_legacy."PlatosSkill"
            SET manifest='[]'::jsonb, "providesTools"='{}'::jsonb
          WHERE id='cllegacyskill0001'`
      );
      await expect(validateRetainedEvalJobSkillBatch7Source(database)).rejects.toThrow("json-root");
      await database.query("ROLLBACK TO SAVEPOINT batch7_malformed_json");

      await database.query("SAVEPOINT batch7_cross_scope");
      await database.query(
        `UPDATE cutover_legacy."PlatosAgentSkill"
            SET "environmentId"='cllegacyenv0002'
          WHERE id='cllegacyagentskill0001'`
      );
      await expect(validateRetainedEvalJobSkillBatch7Source(database)).rejects.toThrow(
        "skill-association"
      );
      await database.query("ROLLBACK TO SAVEPOINT batch7_cross_scope");

      await database.query("SAVEPOINT batch7_duplicate_slug");
      await database.query(
        `INSERT INTO cutover_legacy."PlatosSkill"
          (id,"organizationId","projectId","environmentId","skillId",name,description,
           version,origin,"isOfficial",tags,source,manifest,"promptBlock","providesTools",
           "requiredEnv","optionalEnv","createdAt","updatedAt")
         SELECT 'cllegacyskill0002',"organizationId","projectId",'cllegacyenv0002',"skillId",
                name,description,version,origin,"isOfficial",tags,source,manifest,"promptBlock",
                "providesTools","requiredEnv","optionalEnv","createdAt","updatedAt"
           FROM cutover_legacy."PlatosSkill" WHERE id='cllegacyskill0001'`
      );
      for (const [targetModel, stableSuffix] of [
        ["Skill", ""],
        ["ProjectSkill", "project-skill"],
        ["EnvironmentSkill", "environment-skill"],
      ] as const) {
        await database.query(
          `INSERT INTO cutover_legacy.cutover_id_map
            (mapping_version,source_model,source_id,target_model,stable_suffix,target_id)
           VALUES (1,'PlatosSkill','cllegacyskill0002',$1,$2,$3::uuid)`,
          [
            targetModel,
            stableSuffix,
            mapCutoverId({
              sourceModel: "PlatosSkill",
              sourceId: "cllegacyskill0002",
              suffix: stableSuffix || undefined,
            }),
          ]
        );
      }
      await expect(validateRetainedEvalJobSkillBatch7Source(database)).rejects.toThrow(
        "duplicate-skill-slug"
      );
      await database.query("ROLLBACK TO SAVEPOINT batch7_duplicate_slug");

      const evidence = await backfillRetainedEvalJobSkillBatch7(database, 1);
      expect(evidence.sourceRows).toEqual({
        messageRatings: 1,
        evalCriteria: 1,
        agentEvals: 1,
        goldenSets: 1,
        jobs: 1,
        skills: 1,
        agentSkills: 1,
        macros: 1,
      });
      expect(evidence.splitCounts).toEqual({
        skillSources: 1,
        skillTargets: 1,
        projectSkillTargets: 1,
        environmentSkillTargets: 1,
        totalSplitTargets: 3,
      });
      expect(JSON.stringify(evidence)).not.toContain("export-only-webhook-secret");

      await validateRetainedEvalJobSkillBatch7(database);

      const rating = await database.query<{ rating: number }>(
        `SELECT rating FROM public."MessageRating"`
      );
      expect(rating.rows).toEqual([{ rating: 5 }]);

      const evalResult = await database.query<{ costCents: string; snapshotRoot: string }>(
        `SELECT "costCents"::text AS "costCents", jsonb_typeof("criterionSnapshot") AS "snapshotRoot"
           FROM public."AgentEval"`
      );
      expect(evalResult.rows).toEqual([{ costCents: "0.125000", snapshotRoot: "object" }]);

      const mappedArrays = await database.query<{
        threadIds: string[];
        criterionIds: string[];
        allowedAgentIds: string[];
        status: string;
      }>(`SELECT golden."threadIds", golden."criterionIds", job."allowedAgentIds", job.status::text AS status
             FROM public."GoldenSet" golden CROSS JOIN public."Job" job`);
      expect(mappedArrays.rows[0]?.threadIds[0]).toMatch(/^[0-9a-f-]{36}$/);
      expect(mappedArrays.rows[0]?.criterionIds[0]).toMatch(/^[0-9a-f-]{36}$/);
      expect(mappedArrays.rows[0]?.allowedAgentIds[0]).toMatch(/^[0-9a-f-]{36}$/);
      expect(mappedArrays.rows[0]?.status).toBe("CANCELLED");

      const skillChain = await database.query<{
        skillId: string;
        projectSkillId: string;
        environmentSkillId: string;
        agentSkillVersionId: string;
        currentVersionId: string;
      }>(`SELECT skill.id::text AS "skillId", project_skill.id::text AS "projectSkillId",
                 environment_skill.id::text AS "environmentSkillId",
                 agent_skill."agentVersionId"::text AS "agentSkillVersionId",
                 version_map.target_id::text AS "currentVersionId"
            FROM public."Skill" skill
            JOIN public."ProjectSkill" project_skill ON project_skill."skillId"=skill.id
            JOIN public."EnvironmentSkill" environment_skill ON environment_skill."projectSkillId"=project_skill.id
            JOIN public."AgentSkill" agent_skill ON agent_skill."environmentSkillId"=environment_skill.id
            JOIN cutover_legacy."PlatosAgentSkill" source_association ON source_association.id='cllegacyagentskill0001'
            JOIN cutover_legacy."PlatosAgent" source_agent ON source_agent.id=source_association."agentId"
            JOIN cutover_legacy.cutover_id_map version_map ON version_map.mapping_version=1
             AND version_map.source_model='PlatosAgentVersion' AND version_map.source_id=source_agent."currentVersionId"
             AND version_map.target_model='AgentVersion'`);
      expect(skillChain.rows).toHaveLength(1);
      expect(skillChain.rows[0]?.agentSkillVersionId).toBe(skillChain.rows[0]?.currentVersionId);
      expect(skillChain.rows[0]?.skillId).not.toBe(skillChain.rows[0]?.projectSkillId);
      expect(skillChain.rows[0]?.projectSkillId).not.toBe(skillChain.rows[0]?.environmentSkillId);

      const macros = await database.query<{
        stepsRoot: string;
        paramSchemaRoot: string;
        sharedWithOrganization: boolean;
      }>(`SELECT jsonb_typeof(steps) AS "stepsRoot",
                 jsonb_typeof("paramSchema") AS "paramSchemaRoot",
                 "sharedWithOrganization"
            FROM public."Macro"`);
      expect(macros.rows).toEqual([{
        stepsRoot: "array",
        paramSchemaRoot: "object",
        sharedWithOrganization: true,
      }]);
    } finally {
      await database.query("ROLLBACK");
    }
  }, 240_000);
});
