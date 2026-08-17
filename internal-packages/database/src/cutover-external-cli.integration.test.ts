import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ClickHouseContainer, type StartedClickHouseContainer } from "../../testcontainers/src/clickhouse";
import { MinIOContainer, type StartedMinIOContainer } from "../../testcontainers/src/minio";
import { clickHouseRunScopedIdentifier } from "./cutover-external";

const runHarness = process.env.RUN_DATABASE_CUTOVER_EXTERNAL_CLI_HARNESS === "1";
const describeHarness = runHarness ? describe : describe.skip;
const packageRoot = resolve(__dirname, "..");
const clickHouseSchema = resolve(packageRoot, "../clickhouse/schema");
const INSTANCE_ID = "7a42119c-5d43-4d16-9128-fc7743947587";
const RECOVERY_OPERATION_ID = "1f5b2ad5-f2ce-4d0e-8d59-852f15c8472c";
const UNRESOLVED_OPERATION_ID = "269e24f1-3145-49af-b6aa-f57460854a64";
const EXECUTOR_USER = "win123_cli_executor";
const EXECUTOR_PASSWORD = "win123-cli-executor-password";
const INGESTION_ROLE = "win123_cli_ingestion";
const PROOF = "WIN123_DISPOSABLE_REHEARSAL_V1";
const { Client } = pg;

const fixtureFiles = [
  "legacy-core-seed.sql",
  "legacy-auth-supplemental-seed.sql",
  "legacy-agent-tool-batch1-seed.sql",
  "legacy-conversation-batch2-seed.sql",
  "legacy-retained-batch3-seed.sql",
  "legacy-provider-oauth-batch4-seed.sql",
  "legacy-channel-batch5-seed.sql",
  "legacy-operational-batch6-seed.sql",
  "legacy-eval-job-skill-batch7-seed.sql",
  "legacy-memory-batch8-seed.sql",
  "legacy-combined-cutover-replay.sql",
] as const;

const requiredKeys = {
  ENCRYPTION_KEY: "0".repeat(64),
  PLATOS_ENCRYPTION_KEY: "4".repeat(64),
  PLATOS_CREDENTIAL_ROOT_KEY_VERSION: "1",
  PLATOS_CREDENTIAL_ROOT_KEYS: JSON.stringify({ 1: "2".repeat(64) }),
  PLATOS_MESSAGE_ENCRYPTION_KEY: "11".repeat(32),
  PLATOS_MESSAGE_ENCRYPTION_KEY_V: "1",
  TEST_CUTOVER_EXPORT_KEY: "55".repeat(32),
};

function cliArguments(operationId: string, resume: boolean): string[] {
  return [
    "db:cutover", "--", "--execute", "--core-rehearsal", "--force-rollback-before-commit",
    "--accept-execute", "WIN123_EXECUTE_V1", "--accept-irreversible-effects", "WIN123_IRREVERSIBLE_EFFECTS_V1",
    "--backup-attestation-ref", "fixture-backup", "--backup-restore-test-ref", "fixture-restore",
    "--capacity-attestation-ref", "fixture-capacity", "--writer-fence-attestation-ref", "fixture-fence",
    "--export-key-env", "TEST_CUTOVER_EXPORT_KEY", "--export-key-reference", "ops/win123/cli-harness",
    "--enable-external-rehearsal", "--external-rehearsal-operation-id", operationId,
    ...(resume ? ["--resume-external-rehearsal"] : []),
  ];
}

async function migrate(uri: string, legacy = false): Promise<void> {
  execFileSync(resolve(packageRoot, "node_modules/.bin/prisma"), [
    "migrate", "deploy", "--schema", legacy ? "legacy-prisma/schema.prisma" : "prisma/schema.prisma",
  ], { cwd: packageRoot, env: { ...process.env, DATABASE_URL: uri, DIRECT_URL: uri }, stdio: "pipe" });
}

async function preparePostgres(target: StartedPostgreSqlContainer, fresh: StartedPostgreSqlContainer, ledger: StartedPostgreSqlContainer): Promise<void> {
  await Promise.all([migrate(target.getConnectionUri(), true), migrate(fresh.getConnectionUri()), migrate(ledger.getConnectionUri())]);
  const targetClient = new Client({ connectionString: target.getConnectionUri() });
  const ledgerClient = new Client({ connectionString: ledger.getConnectionUri() });
  await Promise.all([targetClient.connect(), ledgerClient.connect()]);
  try {
    for (const fixture of fixtureFiles) await targetClient.query(readFileSync(resolve(packageRoot, "test-fixtures", fixture), "utf8"));
    await targetClient.query(`DELETE FROM public."PlatosMessageAttachment"`);
    await targetClient.query(`CREATE SCHEMA cutover_rehearsal;
      CREATE TABLE cutover_rehearsal.target_marker (singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton), marker TEXT NOT NULL, target_kind TEXT NOT NULL, instance_id UUID NOT NULL, endpoint_role TEXT NOT NULL, endpoint_id TEXT NOT NULL);
      INSERT INTO cutover_rehearsal.target_marker VALUES (TRUE, '${PROOF}', 'DISPOSABLE_REHEARSAL', '${INSTANCE_ID}', 'TARGET_POSTGRESQL', 'target-postgres-cli');`);
    await ledgerClient.query(`CREATE SCHEMA cutover_rehearsal;
      CREATE TABLE cutover_rehearsal.ledger_marker (singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton), marker TEXT NOT NULL, target_kind TEXT NOT NULL, instance_id UUID NOT NULL, endpoint_role TEXT NOT NULL, endpoint_id TEXT NOT NULL);
      INSERT INTO cutover_rehearsal.ledger_marker VALUES (TRUE, '${PROOF}', 'DISPOSABLE_REHEARSAL', '${INSTANCE_ID}', 'LEDGER_POSTGRESQL', 'ledger-postgres-cli');`);
  } finally {
    await Promise.all([targetClient.end(), ledgerClient.end()]);
  }
}

async function prepareClickHouse(container: StartedClickHouseContainer): Promise<ClickHouseClient> {
  const client = createClient(container.getClientOptions());
  for (const migration of (await readdir(clickHouseSchema)).sort()) {
    const content = await readFile(resolve(clickHouseSchema, migration), "utf8");
    const upSql = (content.split(/--\s*\+goose\s+(Up|Down)/i)[2] ?? "").replace(/--.*$/gm, "");
    for (const query of upSql.split(";")) if (query.trim()) await client.command({ query: query.trim() });
  }
  await client.command({ query: `CREATE TABLE trigger_dev.cutover_rehearsal_marker (marker String, target_kind String, instance_id UUID, endpoint_role String, endpoint_id String, ingestion_role String) ENGINE=MergeTree ORDER BY tuple()` });
  await client.insert({ table: "trigger_dev.cutover_rehearsal_marker", format: "JSONEachRow", values: [{ marker: PROOF, target_kind: "DISPOSABLE_REHEARSAL", instance_id: INSTANCE_ID, endpoint_role: "CLICKHOUSE", endpoint_id: "clickhouse-cli", ingestion_role: INGESTION_ROLE }] });
  await client.command({ query: `CREATE ROLE \`${INGESTION_ROLE}\`` });
  await client.command({ query: `GRANT INSERT ON trigger_dev.* TO \`${INGESTION_ROLE}\`` });
  await client.command({ query: `CREATE USER \`${EXECUTOR_USER}\` IDENTIFIED WITH plaintext_password BY '${EXECUTOR_PASSWORD}'` });
  await client.command({ query: `GRANT SELECT, INSERT, ALTER, CREATE, DROP ON *.* TO \`${EXECUTOR_USER}\` WITH GRANT OPTION` });
  await client.command({ query: `GRANT SHOW ACCESS ON *.* TO \`${EXECUTOR_USER}\`` });
  await client.command({ query: `GRANT ALTER USER, CREATE ROLE, DROP ROLE ON * TO \`${EXECUTOR_USER}\` WITH GRANT OPTION` });
  await client.command({ query: `GRANT ROLE ADMIN ON *.* TO \`${EXECUTOR_USER}\`` });
  return client;
}

async function prepareObjectStore(minio: StartedMinIOContainer, target: StartedPostgreSqlContainer): Promise<void> {
  const s3 = new S3Client({ endpoint: minio.getBaseUrl(), region: minio.getRegion(), forcePathStyle: true, credentials: { accessKeyId: minio.getAccessKeyId(), secretAccessKey: minio.getSecretAccessKey() } });
  const targetClient = new Client({ connectionString: target.getConnectionUri() });
  await targetClient.connect();
  try {
    await s3.send(new PutObjectCommand({ Bucket: "packets", Key: ".win123-disposable-rehearsal/marker-v1", Body: PROOF, Metadata: { "win123-rehearsal-marker": PROOF, "win123-rehearsal-instance-id": INSTANCE_ID, "win123-rehearsal-endpoint-role": "OBJECT_STORE", "win123-rehearsal-endpoint-id": "object-store-cli" } }));
  } finally {
    await targetClient.end();
    s3.destroy();
  }
}

function commandEnvironment(input: { target: StartedPostgreSqlContainer; fresh: StartedPostgreSqlContainer; ledger: StartedPostgreSqlContainer; clickhouse: StartedClickHouseContainer; minio: StartedMinIOContainer; pause?: boolean }) {
  return {
    ...process.env, ...requiredKeys, NODE_ENV: "test", DATABASE_URL: "postgresql://runtime.invalid:5432/runtime", CUTOVER_FRESH_DATABASE_URL: input.fresh.getConnectionUri(),
    CUTOVER_REHEARSAL_EXTERNAL_ENABLED: "1", CUTOVER_REHEARSAL_TARGET_KIND: "DISPOSABLE_REHEARSAL", CUTOVER_REHEARSAL_PROOF: PROOF,
    CUTOVER_REHEARSAL_INSTANCE_ID: INSTANCE_ID, CUTOVER_REHEARSAL_TARGET_DATABASE_URL: input.target.getConnectionUri(), CUTOVER_REHEARSAL_TARGET_POSTGRES_ENDPOINT_ID: "target-postgres-cli",
    CUTOVER_REHEARSAL_LEDGER_POSTGRES_ENDPOINT_ID: "ledger-postgres-cli", CUTOVER_REHEARSAL_CLICKHOUSE_ENDPOINT_ID: "clickhouse-cli", CUTOVER_REHEARSAL_OBJECT_STORE_ENDPOINT_ID: "object-store-cli",
    CUTOVER_REHEARSAL_CLICKHOUSE_URL: input.clickhouse.getHttpUrl(), CUTOVER_REHEARSAL_CLICKHOUSE_USERNAME: EXECUTOR_USER, CUTOVER_REHEARSAL_CLICKHOUSE_PASSWORD: EXECUTOR_PASSWORD,
    CUTOVER_REHEARSAL_S3_ENDPOINT: input.minio.getBaseUrl(), CUTOVER_REHEARSAL_S3_REGION: input.minio.getRegion(), CUTOVER_REHEARSAL_S3_BUCKET: "packets",
    CUTOVER_REHEARSAL_S3_ACCESS_KEY_ID: input.minio.getAccessKeyId(), CUTOVER_REHEARSAL_S3_SECRET_ACCESS_KEY: input.minio.getSecretAccessKey(), CUTOVER_REHEARSAL_LEDGER_DATABASE_URL: input.ledger.getConnectionUri(),
    ...(input.pause ? { CUTOVER_REHEARSAL_TEST_PAUSE_AFTER_FORWARD_EXCHANGE_MS: "120000" } : {}),
  };
}

async function waitForSwap(child: ChildProcess, ledgerUri: string, operationId: string): Promise<void> {
  const client = new Client({ connectionString: ledgerUri });
  await client.connect();
  try {
    for (let index = 0; index < 240; index += 1) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`CLI exited before EXCHANGE (${child.exitCode ?? child.signalCode})`);
      const result = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM public."ExternalCutoverEvidence" evidence JOIN public."ExternalCutoverRun" run ON run.id=evidence."runId" WHERE run."idempotencyKey"=$1 AND evidence.action='SWAP' AND evidence.outcome='STARTED'`, [`win123-disposable-rehearsal:${INSTANCE_ID}:${operationId}`]);
      if (result.rows[0]?.count !== "0") return;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
    throw new Error("CLI did not reach committed forward EXCHANGE");
  } finally { await client.end(); }
}

async function killAfterForwardExchange(child: ChildProcess, ledgerUri: string, operationId: string): Promise<void> {
  await waitForSwap(child, ledgerUri, operationId);
  if (child.pid) process.kill(-child.pid, "SIGKILL");
  await new Promise<void>((resolvePromise) => child.once("close", () => resolvePromise()));
}

describeHarness("production CLI external rehearsal resume harness", () => {
  let target: StartedPostgreSqlContainer; let fresh: StartedPostgreSqlContainer; let ledger: StartedPostgreSqlContainer;
  let clickhouse: StartedClickHouseContainer; let minio: StartedMinIOContainer; let clickHouseClient: ClickHouseClient;
  beforeAll(async () => {
    [target, fresh, ledger, clickhouse, minio] = await Promise.all([
      new PostgreSqlContainer("pgvector/pgvector:pg16").start(), new PostgreSqlContainer("pgvector/pgvector:pg16").start(), new PostgreSqlContainer("pgvector/pgvector:pg16").start(),
      new ClickHouseContainer().withEnvironment({ CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: "1" }).start(), new MinIOContainer().start(),
    ]);
    await preparePostgres(target, fresh, ledger); clickHouseClient = await prepareClickHouse(clickhouse); await prepareObjectStore(minio, target);
    execFileSync("pnpm", ["build"], { cwd: packageRoot, stdio: "pipe" });
  }, 300_000);
  afterAll(async () => { await clickHouseClient?.close(); await Promise.all([target?.stop(), fresh?.stop(), ledger?.stop(), clickhouse?.stop(), minio?.stop()]); });

  test("resumes committed forward EXCHANGE after a lost process response through two production CLI invocations", async () => {
    const first = spawn("node", ["dist/cutover-cli.js", ...cliArguments(RECOVERY_OPERATION_ID, false).slice(2)], { cwd: packageRoot, env: commandEnvironment({ target, fresh, ledger, clickhouse, minio, pause: true }), detached: true, stdio: "inherit" });
    await killAfterForwardExchange(first, ledger.getConnectionUri(), RECOVERY_OPERATION_ID);
    const second = spawnSync("node", ["dist/cutover-cli.js", ...cliArguments(RECOVERY_OPERATION_ID, true).slice(2)], { cwd: packageRoot, env: commandEnvironment({ target, fresh, ledger, clickhouse, minio }), encoding: "utf8", timeout: 240_000 });
    expect(second.status, `${second.stderr}\n${second.stdout}`).toBe(0);
    const report = JSON.parse(second.stdout);
    expect(report, `${second.stderr}\n${JSON.stringify(report.checks)}`).toMatchObject({ runId: RECOVERY_OPERATION_ID, state: "ROLLED_BACK", external: { state: "ROLLED_BACK" } });
  }, 300_000);

  test("reports RESTORE_REQUIRED and leaves ordinary and maintenance access fenced when resumed state is ambiguous", async () => {
    const first = spawn("node", ["dist/cutover-cli.js", ...cliArguments(UNRESOLVED_OPERATION_ID, false).slice(2)], { cwd: packageRoot, env: commandEnvironment({ target, fresh, ledger, clickhouse, minio, pause: true }), detached: true, stdio: "inherit" });
    await killAfterForwardExchange(first, ledger.getConnectionUri(), UNRESOLVED_OPERATION_ID);
    const shadow = clickHouseRunScopedIdentifier("error_occurrences_v1", "shadow", UNRESOLVED_OPERATION_ID);
    await clickHouseClient.command({ query: `DROP TABLE trigger_dev.\`${shadow}\`` });
    const second = spawnSync("node", ["dist/cutover-cli.js", ...cliArguments(UNRESOLVED_OPERATION_ID, true).slice(2)], { cwd: packageRoot, env: commandEnvironment({ target, fresh, ledger, clickhouse, minio }), encoding: "utf8", timeout: 240_000 });
    expect(second.status, `${second.stderr}\n${second.stdout}`).toBe(2);
    expect(JSON.parse(second.stdout)).toMatchObject({ runId: UNRESOLVED_OPERATION_ID, state: "RESTORE_REQUIRED" });
    const grants = await clickHouseClient.query({ query: `SELECT count() AS count FROM system.grants WHERE access_type='INSERT' AND (role_name='${INGESTION_ROLE}' OR user_name='${EXECUTOR_USER}') AND (database IS NULL OR database='' OR database='trigger_dev') AND (table IS NULL OR table='' OR table IN ('error_occurrences_v1','errors_v1','llm_metrics_v1','metrics_v1','platos_spans_v1','task_event_usage_by_hour_v1','task_event_usage_by_minute_v1','task_events_search_v1','task_events_v1','task_events_v2','task_runs_v1','task_runs_v2'))`, format: "JSONEachRow" });
    expect(await grants.json<{ count: string }>()).toEqual([{ count: "0" }]);
    const maintenance = await clickHouseClient.query({ query: `SELECT count() AS count FROM system.roles WHERE name='win123_rehearsal_writer_control_${UNRESOLVED_OPERATION_ID.replaceAll("-", "")}'`, format: "JSONEachRow" });
    expect(await maintenance.json<{ count: string }>()).toEqual([{ count: "0" }]);
  }, 300_000);
});
