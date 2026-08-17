import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  ClickHouseContainer,
  type StartedClickHouseContainer,
} from "../../testcontainers/src/clickhouse";
import { MinIOContainer, type StartedMinIOContainer } from "../../testcontainers/src/minio";
import {
  assertExternalCutoverReportFragment,
  clickHouseRunScopedIdentifier,
  objectKeySha256,
} from "./cutover-external";
import {
  executeDisposableExternalRehearsal,
  type CutoverRehearsalConfig,
} from "./cutover-external-executor";
import {
  clickHousePhysicalRekeyPlan,
  clickHouseSourceSchemaSha256,
  targetChecksumSql,
  targetDdlSql,
  type ClickHouseColumnShape,
} from "./cutover-external-physical-plan";
import { mapCutoverId } from "./cutover-id";

const runHarness = process.env.RUN_DATABASE_CUTOVER_EXTERNAL_HARNESS === "1";
const describeHarness = runHarness ? describe : describe.skip;
const packageRoot = resolve(__dirname, "..");
const clickHouseSchema = resolve(packageRoot, "../clickhouse/schema");
const PROOF = "WIN123_DISPOSABLE_REHEARSAL_V1" as const;
const INSTANCE_ID = "94d497c4-56ad-4b6f-b3d8-2582276c5d46";
const INGESTION_ROLE = "win123_rehearsal_ingestion";
const EXECUTOR_USER = "win123_rehearsal_executor";
const EXECUTOR_PASSWORD = "win123-rehearsal-executor-password";
const DIRECT_WRITER_USER = "win123_direct_writer";
const DIRECT_WRITER_ROLE = "win123_direct_writer_role";
const INHERITED_WRITER_USER = "win123_inherited_writer";
const PARENT_WRITER_ROLE = "win123_parent_writer_role";
const CHILD_WRITER_ROLE = "win123_child_writer_role";
const BUCKET = "packets";
const SUCCESS_RUN_ID = "03125bd3-8e2e-5500-8942-574db43e9203";
const FAILURE_RUN_ID = "598a4bd6-bc70-5bdf-9bc9-2789b2218bd6";
const MISSING_MAPPING_RUN_ID = "3475fca8-d90e-5b8c-bd14-8189a3237ef2";
const MARKER_PROOF_RUN_ID = "52db8689-8f32-493a-a025-dcb72a267b77";
const FENCE_FAILURE_RUN_ID = "02de05aa-3dac-49aa-804f-7d9626aa08d4";
const RESTART_RUN_ID = "b7ff9116-752e-47fa-bfc4-d89b53ec875e";
const { Client } = pg;

const identityMappings = [
  { sourceModel: "Organization", sourceId: "cllegacyorg0001" },
  { sourceModel: "Project", sourceId: "cllegacyproject0001" },
  { sourceModel: "RuntimeEnvironment", sourceId: "cllegacyenv0001" },
  { sourceModel: "PlatosAgent", sourceId: "cllegacyagent0001" },
  { sourceModel: "PlatosAgentThread", sourceId: "cllegacythread0001" },
] as const;

const opaqueFixtures = [
  { key: "legacy/%2Fpercent.bin", body: Buffer.from("percent", "utf8") },
  { key: "legacy/raw/slash.bin", body: Buffer.from("slash", "utf8") },
  { key: "legacy/space key.bin", body: Buffer.from("space", "utf8") },
  { key: "legacy/café-λ.bin", body: Buffer.from("unicode", "utf8") },
  { key: "legacy/tenant%2Fscope/file.bin", body: Buffer.from("encoded", "utf8") },
  { key: "legacy/shared-object.bin", body: Buffer.from("shared", "utf8") },
  { key: "legacy/shared-object.bin", body: Buffer.from("shared", "utf8") },
] as const;
const lookalikeKey = "legacy/tenant/scope/file.bin";
const missingKey = "legacy/missing/%2F object λ.bin";

function rehearsalConfig(input: {
  clickhouse: StartedClickHouseContainer;
  minio: StartedMinIOContainer;
  ledger: StartedPostgreSqlContainer;
  target: StartedPostgreSqlContainer;
}): CutoverRehearsalConfig {
  return {
    enabled: true,
    targetKind: "DISPOSABLE_REHEARSAL",
    proof: PROOF,
    operationId: SUCCESS_RUN_ID,
    resume: false,
    rehearsalInstanceId: INSTANCE_ID,
    targetDatabaseUrl: input.target.getConnectionUri(),
    targetPostgresEndpointId: "target-postgres-1",
    ledgerPostgresEndpointId: "ledger-postgres-1",
    clickHouseEndpointId: "clickhouse-1",
    objectStoreEndpointId: "object-store-1",
    clickHouseUrl: input.clickhouse.getHttpUrl(),
    clickHouseUsername: EXECUTOR_USER,
    clickHousePassword: EXECUTOR_PASSWORD,
    s3Endpoint: input.minio.getBaseUrl(),
    s3Region: input.minio.getRegion(),
    s3Bucket: BUCKET,
    s3AccessKeyId: input.minio.getAccessKeyId(),
    s3SecretAccessKey: input.minio.getSecretAccessKey(),
    ledgerDatabaseUrl: input.ledger.getConnectionUri(),
  };
}

async function showCreate(client: ClickHouseClient, table: string): Promise<string> {
  const result = await client.query({
    query: `SHOW CREATE TABLE trigger_dev.\`${table}\``,
    format: "TabSeparatedRaw",
  });
  return result.text();
}

async function columns(client: ClickHouseClient, table: string): Promise<readonly ClickHouseColumnShape[]> {
  const result = await client.query({
    query: `SELECT name, type, default_kind AS defaultKind, default_expression AS defaultExpression
      FROM system.columns WHERE database = 'trigger_dev' AND table = '${table}' ORDER BY position`,
    format: "JSONEachRow",
  });
  return result.json<ClickHouseColumnShape>();
}

async function tableDigest(client: ClickHouseClient, table: string, shape: readonly ClickHouseColumnShape[]) {
  const result = await client.query({ query: targetChecksumSql(table, shape), format: "JSONEachRow" });
  const row = (await result.json<{ row_count: string; rows_sha256: string }>())[0]!;
  return {
    rowCount: row.row_count,
    rowsSha256: row.rows_sha256,
    schemaSha256: createHash("sha256").update(JSON.stringify(shape), "utf8").digest("hex"),
  };
}

async function prepareTarget(container: StartedPostgreSqlContainer): Promise<void> {
  const client = new Client({ connectionString: container.getConnectionUri() });
  await client.connect();
  try {
    await client.query(`
      CREATE SCHEMA cutover_rehearsal;
      CREATE TABLE cutover_rehearsal.target_marker (
        singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
        marker TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        instance_id UUID NOT NULL,
        endpoint_role TEXT NOT NULL,
        endpoint_id TEXT NOT NULL
      );
      INSERT INTO cutover_rehearsal.target_marker
        (marker, target_kind, instance_id, endpoint_role, endpoint_id)
      VALUES ('${PROOF}', 'DISPOSABLE_REHEARSAL', '${INSTANCE_ID}', 'TARGET_POSTGRESQL', 'target-postgres-1');
      CREATE SCHEMA cutover_legacy;
      CREATE TABLE cutover_legacy.cutover_id_map (
        mapping_version INTEGER NOT NULL,
        source_model TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_model TEXT NOT NULL,
        target_id UUID NOT NULL
      );
      CREATE TABLE cutover_legacy."PlatosMessageAttachment" (
        id TEXT PRIMARY KEY,
        "storageKey" TEXT NOT NULL,
        bytes INTEGER NOT NULL
      );
      CREATE TABLE public."MessageAttachment" (
        id UUID PRIMARY KEY,
        "storageKey" TEXT NOT NULL,
        bytes INTEGER NOT NULL
      );
      CREATE TABLE public.rehearsal_rollback_probe (id INTEGER PRIMARY KEY);
    `);
  } finally {
    await client.end();
  }
}

async function prepareLedger(container: StartedPostgreSqlContainer): Promise<void> {
  const client = new Client({ connectionString: container.getConnectionUri() });
  await client.connect();
  try {
    for (const migration of [
      "20260817030000_add_external_cutover_reconciliation",
      "20260817040000_enable_disposable_external_rehearsal_report",
      "20260817050000_allow_duplicate_external_object_references",
      "20260817060000_add_external_writer_fence_plan",
    ]) {
      await client.query(readFileSync(
        resolve(packageRoot, `prisma/migrations/${migration}/migration.sql`),
        "utf8"
      ));
    }
    await client.query(`
      CREATE SCHEMA cutover_rehearsal;
      CREATE TABLE cutover_rehearsal.ledger_marker (
        singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
        marker TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        instance_id UUID NOT NULL,
        endpoint_role TEXT NOT NULL,
        endpoint_id TEXT NOT NULL
      );
      INSERT INTO cutover_rehearsal.ledger_marker
        (marker, target_kind, instance_id, endpoint_role, endpoint_id)
      VALUES ('${PROOF}', 'DISPOSABLE_REHEARSAL', '${INSTANCE_ID}', 'LEDGER_POSTGRESQL', 'ledger-postgres-1');
    `);
  } finally {
    await client.end();
  }
}

async function prepareClickHouse(
  container: StartedClickHouseContainer
): Promise<ClickHouseClient> {
  const client = createClient(container.getClientOptions());
  for (const migration of (await readdir(clickHouseSchema)).sort()) {
    const content = await readFile(resolve(clickHouseSchema, migration), "utf8");
    const parts = content.split(/--\s*\+goose\s+(Up|Down)/i);
    const upSql = (parts[2] ?? "").replace(/--.*$/gm, "");
    for (const query of upSql.split(";")) {
      if (!query.trim()) continue;
      await client.command({ query: query.trim() });
    }
  }
  await client.command({
    query: `CREATE TABLE trigger_dev.cutover_rehearsal_marker (
      marker String,
      target_kind LowCardinality(String),
      instance_id UUID,
      endpoint_role LowCardinality(String),
      endpoint_id String,
      ingestion_role String
    ) ENGINE = MergeTree ORDER BY tuple()`,
  });
  await client.insert({
    table: "trigger_dev.cutover_rehearsal_marker",
    format: "JSONEachRow",
    values: [{
      marker: PROOF,
      target_kind: "DISPOSABLE_REHEARSAL",
      instance_id: INSTANCE_ID,
      endpoint_role: "CLICKHOUSE",
      endpoint_id: "clickhouse-1",
      ingestion_role: INGESTION_ROLE,
    }],
  });
  await client.command({ query: `CREATE ROLE \`${INGESTION_ROLE}\`` });
  await client.command({ query: `GRANT INSERT ON trigger_dev.* TO \`${INGESTION_ROLE}\`` });
  await client.command({
    query: `CREATE USER \`${EXECUTOR_USER}\` IDENTIFIED WITH plaintext_password BY '${EXECUTOR_PASSWORD}'`,
  });
  await client.command({
    query: `GRANT SELECT, INSERT, ALTER, CREATE, DROP ON *.* TO \`${EXECUTOR_USER}\` WITH GRANT OPTION`,
  });
  await client.command({ query: `GRANT SHOW ACCESS ON *.* TO \`${EXECUTOR_USER}\`` });
  await client.command({
    query: `GRANT ALTER USER, CREATE ROLE, DROP ROLE ON * TO \`${EXECUTOR_USER}\` WITH GRANT OPTION`,
  });
  await client.command({ query: `GRANT ROLE ADMIN ON *.* TO \`${EXECUTOR_USER}\`` });
  await client.command({ query: `CREATE USER \`${DIRECT_WRITER_USER}\`` });
  await client.command({ query: `CREATE ROLE \`${DIRECT_WRITER_ROLE}\`` });
  await client.command({ query: `CREATE USER \`${INHERITED_WRITER_USER}\`` });
  await client.command({ query: `CREATE ROLE \`${PARENT_WRITER_ROLE}\`` });
  await client.command({ query: `CREATE ROLE \`${CHILD_WRITER_ROLE}\`` });
  await client.command({ query: `GRANT INSERT ON trigger_dev.error_occurrences_v1 TO \`${DIRECT_WRITER_USER}\`` });
  await client.command({ query: `GRANT INSERT ON trigger_dev.errors_v1 TO \`${DIRECT_WRITER_ROLE}\`` });
  await client.command({ query: `GRANT INSERT ON trigger_dev.metrics_v1 TO \`${CHILD_WRITER_ROLE}\`` });
  await client.command({ query: `GRANT \`${CHILD_WRITER_ROLE}\` TO \`${PARENT_WRITER_ROLE}\`` });
  await client.command({ query: `GRANT \`${PARENT_WRITER_ROLE}\` TO \`${INHERITED_WRITER_USER}\`` });
  await client.insert({
    table: "trigger_dev.platos_spans_v1",
    format: "JSONEachRow",
    values: [{
      organization_id: "cllegacyorg0001",
      project_id: "cllegacyproject0001",
      environment_id: "cllegacyenv0001",
      agent_id: "cllegacyagent0001",
      thread_id: "cllegacythread0001",
      user_id: "lead-hash-not-a-postgres-identity",
      trace_id: "trace-1",
      span_id: "span-1",
      parent_span_id: "",
      name: "rehearsal",
      kind: "internal",
      start_ns: "1786968000000000000",
      end_ns: "1786968000001000000",
      status: "ok",
      attrs: JSON.stringify({
        "platos.agent.id": "cllegacyagent0001",
        "platos.env.id": "cllegacyenv0001",
        "platos.org.id": "cllegacyorg0001",
        "platos.project.id": "cllegacyproject0001",
        "platos.thread.id": "cllegacythread0001",
        preserved: "unchanged",
      }),
    }, {
      organization_id: "cllegacyorg0001",
      project_id: "cllegacyproject0001",
      environment_id: "cllegacyenv0001",
      agent_id: "",
      thread_id: "",
      user_id: "lead-hash-with-preserved-empty-identities",
      trace_id: "trace-2",
      span_id: "span-2",
      parent_span_id: "",
      name: "rehearsal-empty-identities",
      kind: "internal",
      start_ns: "1786968000002000000",
      end_ns: "1786968000003000000",
      status: "ok",
      attrs: JSON.stringify({
        "platos.env.id": "cllegacyenv0001",
        "platos.org.id": "cllegacyorg0001",
        "platos.project.id": "cllegacyproject0001",
        preserved: "empty-agent-and-thread",
      }),
    }],
  });
  await client.command({
    query: `INSERT INTO trigger_dev.errors_v1
      SELECT
        'cllegacyorg0001',
        'cllegacyproject0001',
        'cllegacyenv0001',
        'rehearsal-task',
        'rehearsal-fingerprint',
        'Error',
        'disposable rehearsal error',
        'stack',
        now(),
        now64(3),
        now64(3),
        sumState(toUInt64(1)),
        uniqState('version-1'),
        anyState('run-1'),
        anyState('friendly-1'),
        sumMapState(['SYSTEM_FAILURE'], [toUInt64(1)])`,
  });
  return client;
}

async function prepareObjectStore(container: StartedMinIOContainer): Promise<void> {
  const client = new S3Client({
    endpoint: container.getBaseUrl(),
    region: container.getRegion(),
    forcePathStyle: true,
    credentials: {
      accessKeyId: container.getAccessKeyId(),
      secretAccessKey: container.getSecretAccessKey(),
    },
  });
  try {
    await client.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: ".win123-disposable-rehearsal/marker-v1",
      Body: Buffer.from(PROOF, "utf8"),
      Metadata: {
        "win123-rehearsal-marker": PROOF,
        "win123-rehearsal-instance-id": INSTANCE_ID,
        "win123-rehearsal-endpoint-role": "OBJECT_STORE",
        "win123-rehearsal-endpoint-id": "object-store-1",
      },
    }));
    for (const fixture of opaqueFixtures) {
      await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: fixture.key, Body: fixture.body }));
    }
    await client.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: lookalikeKey,
      Body: Buffer.from("lookalike-must-not-be-used", "utf8"),
    }));
  } finally {
    client.destroy();
  }
}

async function seedTargetTransaction(input: {
  client: pg.Client;
  objects: readonly { readonly key: string; readonly body: Buffer }[];
}): Promise<void> {
  await input.client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  await input.client.query("INSERT INTO public.rehearsal_rollback_probe (id) VALUES (1)");
  for (const mapping of identityMappings) {
    await input.client.query(
      `INSERT INTO cutover_legacy.cutover_id_map
       (mapping_version, source_model, source_id, target_model, target_id)
       VALUES (1, $1, $2, $3, $4)`,
      [
        mapping.sourceModel,
        mapping.sourceId,
        mapping.sourceModel,
        mapCutoverId({ sourceModel: mapping.sourceModel, sourceId: mapping.sourceId }),
      ]
    );
  }
  for (const [index, fixture] of input.objects.entries()) {
    const sourceId = `cllegacyattachment${String(index + 1).padStart(4, "0")}`;
    const targetId = mapCutoverId({ sourceModel: "PlatosMessageAttachment", sourceId });
    await input.client.query(
      `INSERT INTO cutover_legacy."PlatosMessageAttachment" (id, "storageKey", bytes)
       VALUES ($1, $2, $3)`,
      [sourceId, fixture.key, fixture.body.byteLength]
    );
    await input.client.query(
      `INSERT INTO public."MessageAttachment" (id, "storageKey", bytes)
       VALUES ($1, $2, $3)`,
      [targetId, fixture.key, fixture.body.byteLength]
    );
    await input.client.query(
      `INSERT INTO cutover_legacy.cutover_id_map
       (mapping_version, source_model, source_id, target_model, target_id)
       VALUES (1, 'PlatosMessageAttachment', $1, 'MessageAttachment', $2)`,
      [sourceId, targetId]
    );
  }
}

async function assertTargetRolledBack(container: StartedPostgreSqlContainer): Promise<void> {
  const verify = new Client({ connectionString: container.getConnectionUri() });
  await verify.connect();
  try {
    const result = await verify.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.rehearsal_rollback_probe"
    );
    expect(result.rows[0]?.count).toBe("0");
  } finally {
    await verify.end();
  }
}

describeHarness("disposable external rehearsal executor coordinated harness", () => {
  let target: StartedPostgreSqlContainer;
  let ledger: StartedPostgreSqlContainer;
  let clickhouse: StartedClickHouseContainer;
  let minio: StartedMinIOContainer;
  let clickHouseClient: ClickHouseClient;
  let config: CutoverRehearsalConfig;

  beforeAll(async () => {
    [target, ledger, clickhouse, minio] = await Promise.all([
      new PostgreSqlContainer("pgvector/pgvector:pg16").start(),
      new PostgreSqlContainer("pgvector/pgvector:pg16").start(),
      new ClickHouseContainer()
        .withEnvironment({ CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: "1" })
        .start(),
      new MinIOContainer().start(),
    ]);
    await Promise.all([prepareTarget(target), prepareLedger(ledger), prepareObjectStore(minio)]);
    clickHouseClient = await prepareClickHouse(clickhouse);
    config = rehearsalConfig({ clickhouse, minio, ledger, target });
  }, 240_000);

  afterAll(async () => {
    await clickHouseClient?.close();
    await Promise.all([target?.stop(), ledger?.stop(), clickhouse?.stop(), minio?.stop()]);
  });

  test("rekeys all 12 tables, reconciles exact opaque keys, inversely exchanges, and preserves ledger evidence", async () => {
    for (const plan of clickHousePhysicalRekeyPlan) {
      expect(clickHouseSourceSchemaSha256(await showCreate(clickHouseClient, plan.table)))
        .toBe(plan.sourceSchemaSha256);
    }
    const targetClient = new Client({ connectionString: target.getConnectionUri() });
    await targetClient.connect();
    try {
      await seedTargetTransaction({ client: targetClient, objects: opaqueFixtures });
      const report = await executeDisposableExternalRehearsal({
        runId: SUCCESS_RUN_ID,
        targetDatabase: targetClient,
        config: { ...config, operationId: SUCCESS_RUN_ID },
      });
      expect(() => assertExternalCutoverReportFragment(report)).not.toThrow();
      expect(report.clickHouseTables.map((entry) => entry.table))
        .toEqual(clickHousePhysicalRekeyPlan.map((entry) => entry.table));
      expect(report.clickHouseTables.every((entry) => entry.rollbackOutcome === "ROLLED_BACK"))
        .toBe(true);
      expect(report.clickHouseTables.find((entry) => entry.table === "platos_spans_v1"))
        .toMatchObject({ sourceRowCount: "2", targetRowCount: "2" });
      expect(report.clickHouseTables.find((entry) => entry.table === "errors_v1"))
        .toMatchObject({ sourceRowCount: "1", targetRowCount: "1" });
      expect(report.objectStoreObjects).toHaveLength(opaqueFixtures.length);
      expect(report.objectStoreObjects.map((entry) => entry.targetObjectKeySha256))
        .toEqual(opaqueFixtures.map((fixture) => objectKeySha256(fixture.key)));
      const serializedReport = JSON.stringify(report);
      for (const sensitive of [
        opaqueFixtures[0]!.key,
        config.clickHouseUrl,
        config.clickHouseUsername,
        config.clickHousePassword,
        config.s3Endpoint,
        config.s3Bucket,
        config.s3AccessKeyId,
        config.s3SecretAccessKey,
        config.ledgerDatabaseUrl,
      ]) {
        expect(serializedReport).not.toContain(sensitive);
      }
      await targetClient.query("ROLLBACK");
    } finally {
      await targetClient.end();
    }
    await assertTargetRolledBack(target);

    for (const plan of clickHousePhysicalRekeyPlan) {
      expect(clickHouseSourceSchemaSha256(await showCreate(clickHouseClient, plan.table)))
        .toBe(plan.sourceSchemaSha256);
    }
    const ledgerClient = new Client({ connectionString: ledger.getConnectionUri() });
    await ledgerClient.connect();
    try {
      const snapshots = await ledgerClient.query<{ status: string; report: unknown }>(
        `SELECT status::text, report
           FROM public."ExternalCutoverRun"
          WHERE "idempotencyKey" = $1
          ORDER BY attempt`,
        [`win123-disposable-rehearsal:${INSTANCE_ID}:${SUCCESS_RUN_ID}`]
      );
      expect(snapshots.rows.map((row) => row.status)).toEqual([
        "PLANNED",
        "WRITERS_FENCED",
        "COPYING",
        "COPY_VERIFIED",
        "SWAPPED",
        "OBJECTS_RECONCILING",
        "VERIFIED",
        "ROLLBACK_REQUIRED",
        "ROLLED_BACK",
      ]);
      expect(snapshots.rows.at(-1)?.report).toMatchObject({
        implementation: "DISPOSABLE_REHEARSAL",
        state: "ROLLED_BACK",
      });
      const objects = await ledgerClient.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM public."ObjectKeyReconciliation" object_evidence
           JOIN public."ExternalCutoverRun" run ON run.id = object_evidence."runId"
          WHERE run."idempotencyKey" = $1 AND object_evidence.outcome = 'MATCH'`,
        [`win123-disposable-rehearsal:${INSTANCE_ID}:${SUCCESS_RUN_ID}`]
      );
      expect(objects.rows[0]?.count).toBe(String(opaqueFixtures.length));
      const intents = await ledgerClient.query<{ action: string; count: string; schema_count: string }>(
        `SELECT evidence.action::text,
                count(*)::text AS count,
                count(*) FILTER (
                  WHERE evidence."expectedMetadata" ? 'contentSha256'
                    AND evidence."observedMetadata" ? 'contentSha256'
                )::text AS schema_count
           FROM public."ExternalCutoverEvidence" evidence
           JOIN public."ExternalCutoverRun" run ON run.id = evidence."runId"
          WHERE run."idempotencyKey" = $1
            AND evidence.outcome = 'STARTED'
            AND evidence.action IN ('COPY', 'SWAP', 'ROLLBACK')
          GROUP BY evidence.action
          ORDER BY evidence.action`,
        [`win123-disposable-rehearsal:${INSTANCE_ID}:${SUCCESS_RUN_ID}`]
      );
      expect(intents.rows).toEqual([
        { action: "COPY", count: "12", schema_count: "12" },
        { action: "SWAP", count: "12", schema_count: "12" },
        { action: "ROLLBACK", count: "12", schema_count: "12" },
      ]);
      const maintenance = await ledgerClient.query<{ action: string; outcome: string; count: string }>(
        `SELECT evidence.action::text, evidence.outcome::text, count(*)::text AS count
           FROM public."ExternalCutoverEvidence" evidence
           JOIN public."ExternalCutoverRun" run ON run.id = evidence."runId"
          WHERE run."idempotencyKey" = $1
            AND evidence.action IN ('MAINTENANCE_ENABLE', 'MAINTENANCE_DISABLE', 'RESTORE_WRITERS')
          GROUP BY evidence.action, evidence.outcome
          ORDER BY evidence.action, evidence.outcome`,
        [`win123-disposable-rehearsal:${INSTANCE_ID}:${SUCCESS_RUN_ID}`]
      );
      expect(maintenance.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: "MAINTENANCE_ENABLE", outcome: "STARTED" }),
        expect.objectContaining({ action: "MAINTENANCE_DISABLE", outcome: "SUCCEEDED" }),
        { action: "RESTORE_WRITERS", outcome: "STARTED", count: "1" },
        { action: "RESTORE_WRITERS", outcome: "SUCCEEDED", count: "1" },
      ]));
    } finally {
      await ledgerClient.end();
    }
  }, 180_000);

  test("classifies a missing exact key, blocks, and inverse-exchanges already-swapped tables in reverse order", async () => {
    const targetClient = new Client({ connectionString: target.getConnectionUri() });
    await targetClient.connect();
    try {
      await seedTargetTransaction({
        client: targetClient,
        objects: [{ key: missingKey, body: Buffer.from("missing", "utf8") }],
      });
      await expect(executeDisposableExternalRehearsal({
        runId: FAILURE_RUN_ID,
        targetDatabase: targetClient,
        config: { ...config, operationId: FAILURE_RUN_ID },
      })).rejects.toThrow("object-store rehearsal reconciliation outcome was MISSING");
      await targetClient.query("ROLLBACK");
    } finally {
      await targetClient.end();
    }
    await assertTargetRolledBack(target);

    for (const plan of clickHousePhysicalRekeyPlan) {
      expect(clickHouseSourceSchemaSha256(await showCreate(clickHouseClient, plan.table)))
        .toBe(plan.sourceSchemaSha256);
    }
    const restoredGrants = await clickHouseClient.query({
      query: `SELECT user_name, role_name, database, table
        FROM system.grants
        WHERE access_type = 'INSERT' AND (
          user_name IN ('${DIRECT_WRITER_USER}', '${INHERITED_WRITER_USER}') OR
          role_name IN ('${DIRECT_WRITER_ROLE}', '${CHILD_WRITER_ROLE}', '${PARENT_WRITER_ROLE}')
        ) ORDER BY user_name, role_name, database, table`,
      format: "JSONEachRow",
    });
    expect(await restoredGrants.json()).toHaveLength(3);
    const maintenanceRole = await clickHouseClient.query({
      query: `SELECT count() AS count FROM system.roles
        WHERE name = 'win123_rehearsal_writer_control_${SUCCESS_RUN_ID.replaceAll("-", "")}'`,
      format: "JSONEachRow",
    });
    expect(await maintenanceRole.json<{ count: string }>()).toEqual([{ count: "0" }]);
    const ledgerClient = new Client({ connectionString: ledger.getConnectionUri() });
    await ledgerClient.connect();
    try {
      const rollback = await ledgerClient.query<{ resourceName: string }>(
        `SELECT evidence."resourceName"
           FROM public."ExternalCutoverEvidence" evidence
           JOIN public."ExternalCutoverRun" run ON run.id = evidence."runId"
          WHERE run."idempotencyKey" = $1
            AND evidence.action = 'ROLLBACK' AND evidence.outcome = 'ROLLED_BACK'
          ORDER BY run.attempt, evidence.sequence`,
        [`win123-disposable-rehearsal:${INSTANCE_ID}:${FAILURE_RUN_ID}`]
      );
      expect(rollback.rows.map((row) => row.resourceName)).toEqual(
        clickHousePhysicalRekeyPlan.map((entry) => entry.table).reverse()
      );
      const outcomes = await ledgerClient.query<{ outcome: string }>(
        `SELECT object_evidence.outcome::text
           FROM public."ObjectKeyReconciliation" object_evidence
           JOIN public."ExternalCutoverRun" run ON run.id = object_evidence."runId"
          WHERE run."idempotencyKey" = $1`,
        [`win123-disposable-rehearsal:${INSTANCE_ID}:${FAILURE_RUN_ID}`]
      );
      expect(outcomes.rows).toEqual([{ outcome: "MISSING" }]);
    } finally {
      await ledgerClient.end();
    }
  }, 180_000);

  test("recovers a durable pre-crash exchange intent while the ingestion fence remains active", async () => {
    const plan = clickHousePhysicalRekeyPlan.find((entry) => entry.table === "error_occurrences_v1")!;
    const sourceDdl = await showCreate(clickHouseClient, plan.table);
    const sourceColumns = await columns(clickHouseClient, plan.table);
    await clickHouseClient.command({
      query: targetDdlSql(plan, RESTART_RUN_ID, sourceDdl, sourceColumns),
    });
    const shadow = clickHouseRunScopedIdentifier(plan.table, "shadow", RESTART_RUN_ID);
    const shadowColumns = await columns(clickHouseClient, shadow);
    const [original, replacement] = await Promise.all([
      tableDigest(clickHouseClient, plan.table, sourceColumns),
      tableDigest(clickHouseClient, shadow, shadowColumns),
    ]);

    const ledgerClient = new Client({ connectionString: ledger.getConnectionUri() });
    await ledgerClient.connect();
    try {
      const ledgerRunId = randomUUID();
      await ledgerClient.query(
        `INSERT INTO public."ExternalCutoverRun"
         (id, "idempotencyKey", attempt, status, "manifestSha256")
         VALUES ($1, $2, 1, 'COPYING', $3)`,
        [
          ledgerRunId,
          `win123-disposable-rehearsal:${INSTANCE_ID}:${RESTART_RUN_ID}`,
          "b197643697635e462b3a4748de0e88e8b23131b7e260aae73b07448cf798e768",
        ]
      );
      await ledgerClient.query(
        `INSERT INTO public."ExternalCutoverEvidence"
         (id, "runId", "runAttempt", sequence, domain, action, outcome, "resourceName",
          "expectedMetadata", "observedMetadata")
         VALUES ($1, $2, 1, 1, 'CLICKHOUSE', 'SWAP', 'STARTED', $3, $4::jsonb, $5::jsonb)`,
        [
          randomUUID(),
          ledgerRunId,
          plan.table,
          JSON.stringify({
            rowCount: original.rowCount,
            rowsSha256: original.rowsSha256,
            contentSha256: original.schemaSha256,
          }),
          JSON.stringify({
            rowCount: replacement.rowCount,
            rowsSha256: replacement.rowsSha256,
            contentSha256: replacement.schemaSha256,
          }),
        ]
      );
    } finally {
      await ledgerClient.end();
    }
    await clickHouseClient.command({
      query: `EXCHANGE TABLES trigger_dev.\`${plan.table}\` AND trigger_dev.\`${shadow}\``,
    });
    await clickHouseClient.command({
      query: `REVOKE INSERT ON trigger_dev.* FROM \`${INGESTION_ROLE}\``,
    });

    const targetClient = new Client({ connectionString: target.getConnectionUri() });
    await targetClient.connect();
    try {
      await seedTargetTransaction({ client: targetClient, objects: [] });
      await expect(executeDisposableExternalRehearsal({
        runId: RESTART_RUN_ID,
        targetDatabase: targetClient,
        config: { ...config, operationId: RESTART_RUN_ID, resume: true },
      })).resolves.toMatchObject({ state: "ROLLED_BACK" });
      await targetClient.query("ROLLBACK");
    } finally {
      await targetClient.end();
    }
    expect(clickHouseSourceSchemaSha256(await showCreate(clickHouseClient, plan.table)))
      .toBe(plan.sourceSchemaSha256);
  }, 180_000);

  test("blocks a missing deterministic mapping before any table exchange", async () => {
    const targetClient = new Client({ connectionString: target.getConnectionUri() });
    await targetClient.connect();
    try {
      await seedTargetTransaction({ client: targetClient, objects: [] });
      await targetClient.query(
        `DELETE FROM cutover_legacy.cutover_id_map WHERE source_model = 'Project'`
      );
      await expect(executeDisposableExternalRehearsal({
        runId: MISSING_MAPPING_RUN_ID,
        targetDatabase: targetClient,
        config: { ...config, operationId: MISSING_MAPPING_RUN_ID },
      })).rejects.toThrow("missing deterministic mapping");
      await targetClient.query("ROLLBACK");
    } finally {
      await targetClient.end();
    }
    await assertTargetRolledBack(target);
    for (const plan of clickHousePhysicalRekeyPlan) {
      expect(clickHouseSourceSchemaSha256(await showCreate(clickHouseClient, plan.table)))
        .toBe(plan.sourceSchemaSha256);
    }

    const ledgerClient = new Client({ connectionString: ledger.getConnectionUri() });
    await ledgerClient.connect();
    try {
      const swaps = await ledgerClient.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM public."ExternalCutoverEvidence" evidence
           JOIN public."ExternalCutoverRun" run ON run.id = evidence."runId"
          WHERE run."idempotencyKey" = $1 AND evidence.action = 'SWAP'`,
        [`win123-disposable-rehearsal:${INSTANCE_ID}:${MISSING_MAPPING_RUN_ID}`]
      );
      expect(swaps.rows[0]?.count).toBe("0");
    } finally {
      await ledgerClient.end();
    }
  }, 180_000);

  test("rejects rehearsal instance and endpoint marker mismatches", async () => {
    const targetClient = new Client({ connectionString: target.getConnectionUri() });
    await targetClient.connect();
    try {
      await expect(executeDisposableExternalRehearsal({
        runId: MARKER_PROOF_RUN_ID,
        targetDatabase: targetClient,
        config: { ...config, operationId: MARKER_PROOF_RUN_ID, rehearsalInstanceId: "b626eb23-1d2e-4cd6-99f2-37070713680e" },
      })).rejects.toThrow("target PostgreSQL is not marked");
      await expect(executeDisposableExternalRehearsal({
        runId: MARKER_PROOF_RUN_ID,
        targetDatabase: targetClient,
        config: { ...config, operationId: MARKER_PROOF_RUN_ID, targetPostgresEndpointId: "ledger-postgres-1" },
      })).rejects.toThrow("target PostgreSQL is not marked");
      await targetClient.query(
        `UPDATE cutover_rehearsal.target_marker SET endpoint_role = 'LEDGER_POSTGRESQL'`
      );
      await expect(executeDisposableExternalRehearsal({
        runId: MARKER_PROOF_RUN_ID,
        targetDatabase: targetClient,
        config: { ...config, operationId: MARKER_PROOF_RUN_ID },
      })).rejects.toThrow("target PostgreSQL is not marked");
      await targetClient.query(
        `UPDATE cutover_rehearsal.target_marker SET endpoint_role = 'TARGET_POSTGRESQL'`
      );
      await expect(executeDisposableExternalRehearsal({
        runId: MARKER_PROOF_RUN_ID,
        targetDatabase: targetClient,
        config: { ...config, operationId: MARKER_PROOF_RUN_ID, clickHouseEndpointId: "wrong-clickhouse" },
      })).rejects.toThrow("ClickHouse is not an Atomic disposable rehearsal target");
      await expect(executeDisposableExternalRehearsal({
        runId: MARKER_PROOF_RUN_ID,
        targetDatabase: targetClient,
        config: { ...config, operationId: MARKER_PROOF_RUN_ID, resume: true, objectStoreEndpointId: "wrong-object-store" },
      })).rejects.toThrow("object store is not marked as a disposable rehearsal target");
    } finally {
      await targetClient.end();
    }
  }, 180_000);

  test("requires explicit resume and does not let another operation adopt durable state", async () => {
    const targetClient = new Client({ connectionString: target.getConnectionUri() });
    await targetClient.connect();
    try {
      await expect(executeDisposableExternalRehearsal({
        runId: SUCCESS_RUN_ID,
        targetDatabase: targetClient,
        config: { ...config, operationId: SUCCESS_RUN_ID },
      })).rejects.toThrow("explicit resume is required");
      await expect(executeDisposableExternalRehearsal({
        runId: FENCE_FAILURE_RUN_ID,
        targetDatabase: targetClient,
        config: { ...config, operationId: FENCE_FAILURE_RUN_ID, resume: true },
      })).rejects.toThrow("no durable state to resume");
      const ledgerClient = new Client({ connectionString: ledger.getConnectionUri() });
      await ledgerClient.connect();
      try {
        const result = await ledgerClient.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM public."ExternalCutoverRun"
            WHERE "idempotencyKey" = $1 AND status = 'WRITERS_FENCED'`,
          [`win123-disposable-rehearsal:${INSTANCE_ID}:${FENCE_FAILURE_RUN_ID}`]
        );
        expect(result.rows[0]?.count).toBe("0");
      } finally {
        await ledgerClient.end();
      }
    } finally {
      await targetClient.end();
    }
  }, 180_000);
});
