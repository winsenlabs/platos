import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  reencryptAndProbeRetainedCryptoTargets,
  type CutoverCryptoProbeOptions,
  type RetainedCryptoProbeField,
} from "./cutover-crypto-probes";

interface FixtureCase {
  readonly field: RetainedCryptoProbeField;
  readonly variant: "PLAINTEXT" | "ENVELOPE";
  readonly sourceValue: unknown;
  readonly sourceKeyVersion?: number | null;
}

interface ReplayFixture {
  readonly sourceKeys: Readonly<Record<string, string>>;
  readonly target: Readonly<{ version: number; key: string }>;
  readonly cases: readonly FixtureCase[];
}

const runHarness = process.env.RUN_DATABASE_CUTOVER_CRYPTO_PROBES_HARNESS === "1";
const describeHarness = runHarness ? describe : describe.skip;
const packageRoot = resolve(__dirname, "..");
const fixture = JSON.parse(
  readFileSync(resolve(packageRoot, "test-fixtures/cutover-crypto-probes-matrix.json"), "utf8")
) as ReplayFixture;
const options: CutoverCryptoProbeOptions = Object.freeze({
  sourceMessageEncryptionKeys: fixture.sourceKeys,
  targetMessageEncryptionKey: fixture.target.key,
  targetMessageEncryptionKeyVersion: fixture.target.version,
});

function fixtureCase(
  field: RetainedCryptoProbeField,
  variant: FixtureCase["variant"]
): FixtureCase {
  return fixture.cases.find((entry) => entry.field === field && entry.variant === variant)!;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

describeHarness("retained crypto probes isolated PostgreSQL replay", () => {
  let container: StartedPostgreSqlContainer;
  let database: pg.Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    database = new pg.Client({ connectionString: container.getConnectionUri() });
    await database.connect();
    await database.query(
      readFileSync(resolve(packageRoot, "test-fixtures/cutover-crypto-probes-replay.sql"), "utf8")
    );

    for (const variant of ["PLAINTEXT", "ENVELOPE"] as const) {
      const suffix = variant === "PLAINTEXT" ? "plain" : "historical";
      const turnOutput = fixtureCase("Turn.outputText", variant);
      const turnThinking = fixtureCase("Turn.thinkingContent", variant);
      const toolArguments = fixtureCase("ToolCallAudit.arguments", variant);
      const toolResult = fixtureCase("ToolCallAudit.result", variant);
      const safetyDetail = fixtureCase("SafetyEvent.detail", variant);
      const safetyMetadata = fixtureCase("SafetyEvent.metadata", variant);
      const memoryContent = fixtureCase("Memory.content", variant);
      const memoryMetadata = fixtureCase("Memory.metadata", variant);
      const entityLabel = fixtureCase("MemoryEntity.label", variant);
      const entityMetadata = fixtureCase("MemoryEntity.metadata", variant);
      const relationshipMetadata = fixtureCase("MemoryRelationship.metadata", variant);

      await database.query(
        `INSERT INTO cutover_legacy."PlatosAgentMessage"
           (id,role,content,"thinkingContent","encKeyVersion") VALUES ($1,'assistant',$2,$3,$4)`,
        [
          `turn-${suffix}`,
          turnOutput.sourceValue,
          turnThinking.sourceValue,
          turnOutput.sourceKeyVersion,
        ]
      );
      await database.query(
        `INSERT INTO cutover_legacy."PlatosToolCallAudit" (id,args,result)
         VALUES ($1,$2::jsonb,$3::jsonb)`,
        [`tool-${suffix}`, json(toolArguments.sourceValue), json(toolResult.sourceValue)]
      );
      await database.query(
        `INSERT INTO cutover_legacy."PlatosSafetyEvent" (id,detail,meta)
         VALUES ($1,$2,$3::jsonb)`,
        [`safety-${suffix}`, safetyDetail.sourceValue, json(safetyMetadata.sourceValue)]
      );
      await database.query(
        `INSERT INTO cutover_legacy."PlatosMemory" (id,content,metadata)
         VALUES ($1,$2,$3::jsonb)`,
        [`memory-${suffix}`, memoryContent.sourceValue, json(memoryMetadata.sourceValue)]
      );
      await database.query(
        `INSERT INTO cutover_legacy."PlatosMemoryEntity" (id,label,metadata)
         VALUES ($1,$2,$3::jsonb)`,
        [`entity-${suffix}`, entityLabel.sourceValue, json(entityMetadata.sourceValue)]
      );
      await database.query(
        `INSERT INTO cutover_legacy."PlatosMemoryRelationship" (id,metadata)
         VALUES ($1,$2::jsonb)`,
        [`relationship-${suffix}`, json(relationshipMetadata.sourceValue)]
      );

      for (const [sourceModel, targetModel, id] of [
        ["PlatosAgentMessage", "Turn", `turn-${suffix}`],
        ["PlatosToolCallAudit", "ToolCallAudit", `tool-${suffix}`],
        ["PlatosSafetyEvent", "SafetyEvent", `safety-${suffix}`],
        ["PlatosMemory", "Memory", `memory-${suffix}`],
        ["PlatosMemoryEntity", "MemoryEntity", `entity-${suffix}`],
        ["PlatosMemoryRelationship", "MemoryRelationship", `relationship-${suffix}`],
      ]) {
        await database.query(
          `INSERT INTO cutover_legacy.cutover_id_map
             (mapping_version,source_model,source_id,target_model,target_id,stable_suffix)
           VALUES (1,$1,$2,$3,$2,'')`,
          [sourceModel, id, targetModel]
        );
      }
      await database.query(`INSERT INTO public."Turn" VALUES ($1,NULL,NULL)`, [`turn-${suffix}`]);
      await database.query(`INSERT INTO public."ToolCallAudit" VALUES ($1,'{}'::jsonb,NULL)`, [
        `tool-${suffix}`,
      ]);
      await database.query(`INSERT INTO public."SafetyEvent" VALUES ($1,NULL,NULL)`, [
        `safety-${suffix}`,
      ]);
      await database.query(`INSERT INTO public."Memory" VALUES ($1,'placeholder',NULL)`, [
        `memory-${suffix}`,
      ]);
      await database.query(`INSERT INTO public."MemoryEntity" VALUES ($1,'placeholder',NULL)`, [
        `entity-${suffix}`,
      ]);
      await database.query(`INSERT INTO public."MemoryRelationship" VALUES ($1,NULL)`, [
        `relationship-${suffix}`,
      ]);
    }
  }, 120_000);

  afterAll(async () => {
    await database?.end();
    await container?.stop();
  });

  test("re-encrypts mixed plaintext/historical rows and probes persisted target semantics", async () => {
    const evidence = await reencryptAndProbeRetainedCryptoTargets(database, options, 1);
    expect(evidence.rowCounts).toEqual({
      turns: 2,
      toolCallAudits: 2,
      safetyEvents: 2,
      memories: 2,
      memoryEntities: 2,
      memoryRelationships: 2,
    });
    expect(Object.values(evidence.fieldCounts)).toEqual(Array(11).fill(2));
    expect(evidence.sourceUnversionedCount).toBe(11);
    expect(evidence.sourceVersionCounts).toEqual({ "1": 4, "2": 7 });
    expect(evidence.targetVersionCounts).toEqual({ [fixture.target.version]: 22 });
    expect(JSON.stringify(evidence)).not.toContain(fixture.target.key);
    expect(JSON.stringify(evidence)).not.toContain("fixture retained memory");

    const textVersions = await database.query<{ version: number }>(`
      SELECT (("outputText"::jsonb)->>'v')::integer AS version FROM public."Turn"
      UNION ALL SELECT (("thinkingContent"::jsonb)->>'v')::integer FROM public."Turn"
      UNION ALL SELECT ((detail::jsonb)->>'v')::integer FROM public."SafetyEvent"
      UNION ALL SELECT ((content::jsonb)->>'v')::integer FROM public."Memory"
      UNION ALL SELECT ((label::jsonb)->>'v')::integer FROM public."MemoryEntity"
    `);
    expect(textVersions.rows).toHaveLength(10);
    expect(new Set(textVersions.rows.map((row) => row.version))).toEqual(new Set([3]));

    const jsonVersions = await database.query<{ version: number }>(`
      SELECT (arguments->>'v')::integer AS version FROM public."ToolCallAudit"
      UNION ALL SELECT (result->>'v')::integer FROM public."ToolCallAudit"
      UNION ALL SELECT (metadata->>'v')::integer FROM public."SafetyEvent"
      UNION ALL SELECT (metadata->>'v')::integer FROM public."Memory"
      UNION ALL SELECT (metadata->>'v')::integer FROM public."MemoryEntity"
      UNION ALL SELECT (metadata->>'v')::integer FROM public."MemoryRelationship"
    `);
    expect(jsonVersions.rows).toHaveLength(12);
    expect(new Set(jsonVersions.rows.map((row) => row.version))).toEqual(new Set([3]));
  }, 60_000);
});
