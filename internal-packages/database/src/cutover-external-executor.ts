import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import {
  clickHouseRunScopedIdentifier,
  objectKeySha256,
  type ClickHouseTableRekeyEvidence,
  type DisposableRehearsalExternalCutoverReportFragment,
  type ObjectReconciliationReportEvidence,
} from "./cutover-external";
import { clickHouseRekeyManifestSha256 } from "./cutover-external-manifest";
import {
  CLICKHOUSE_REHEARSAL_DATABASE,
  clickHouseMappingTableIdentifier,
  clickHousePhysicalPlanSourceModels,
  clickHousePhysicalRekeyPlan,
  clickHouseSourceSchemaSha256,
  copyProjectionSql,
  createMappingTableSql,
  identityChecksumSql,
  mappingPreflightSql,
  sourceChecksumSql,
  targetChecksumSql,
  targetDdlSql,
  type ClickHouseColumnShape,
  type ClickHousePhysicalTablePlan,
} from "./cutover-external-physical-plan";
import { mapCutoverId } from "./cutover-id";
import type { CutoverDatabase } from "./cutover-types";

const { Client } = pg;
const REHEARSAL_PROOF = "WIN123_DISPOSABLE_REHEARSAL_V1";
const S3_MARKER_KEY = ".win123-disposable-rehearsal/marker-v1";
const ENDPOINT_ROLES = {
  targetPostgres: "TARGET_POSTGRESQL",
  ledgerPostgres: "LEDGER_POSTGRESQL",
  clickHouse: "CLICKHOUSE",
  objectStore: "OBJECT_STORE",
} as const;

export interface CutoverRehearsalConfig {
  readonly enabled: true;
  readonly targetKind: "DISPOSABLE_REHEARSAL";
  readonly proof: typeof REHEARSAL_PROOF;
  readonly operationId: string;
  readonly resume: boolean;
  readonly rehearsalInstanceId: string;
  readonly targetDatabaseUrl: string;
  readonly targetPostgresEndpointId: string;
  readonly ledgerPostgresEndpointId: string;
  readonly clickHouseEndpointId: string;
  readonly objectStoreEndpointId: string;
  readonly clickHouseUrl: string;
  readonly clickHouseUsername: string;
  readonly clickHousePassword: string;
  readonly s3Endpoint: string;
  readonly s3Region: string;
  readonly s3Bucket: string;
  readonly s3AccessKeyId: string;
  readonly s3SecretAccessKey: string;
  readonly ledgerDatabaseUrl: string;
}

const REQUIRED_REHEARSAL_ENVIRONMENT = [
  "CUTOVER_REHEARSAL_TARGET_KIND",
  "CUTOVER_REHEARSAL_PROOF",
  "CUTOVER_REHEARSAL_INSTANCE_ID",
  "CUTOVER_REHEARSAL_TARGET_DATABASE_URL",
  "CUTOVER_REHEARSAL_TARGET_POSTGRES_ENDPOINT_ID",
  "CUTOVER_REHEARSAL_LEDGER_POSTGRES_ENDPOINT_ID",
  "CUTOVER_REHEARSAL_CLICKHOUSE_ENDPOINT_ID",
  "CUTOVER_REHEARSAL_OBJECT_STORE_ENDPOINT_ID",
  "CUTOVER_REHEARSAL_CLICKHOUSE_URL",
  "CUTOVER_REHEARSAL_CLICKHOUSE_USERNAME",
  "CUTOVER_REHEARSAL_CLICKHOUSE_PASSWORD",
  "CUTOVER_REHEARSAL_S3_ENDPOINT",
  "CUTOVER_REHEARSAL_S3_REGION",
  "CUTOVER_REHEARSAL_S3_BUCKET",
  "CUTOVER_REHEARSAL_S3_ACCESS_KEY_ID",
  "CUTOVER_REHEARSAL_S3_SECRET_ACCESS_KEY",
  "CUTOVER_REHEARSAL_LEDGER_DATABASE_URL",
] as const;

function required(environment: Readonly<Record<string, string | undefined>>, name: typeof REQUIRED_REHEARSAL_ENVIRONMENT[number]): string {
  const value = environment[name];
  if (!value) throw new Error("disposable external rehearsal configuration is incomplete");
  return value;
}

function endpoint(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("disposable external rehearsal endpoint configuration is invalid");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("disposable external rehearsal endpoint configuration is invalid");
  }
  return value;
}

function postgresEndpoint(value: string, label: string): string {
  try {
    const parsed = new URL(value);
    if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error();
  } catch {
    throw new Error(`disposable external rehearsal ${label} configuration is invalid`);
  }
  return value;
}

function endpointIdentity(value: string): string {
  const parsed = new URL(value);
  const protocol = parsed.protocol === "postgresql:" ? "postgres:" : parsed.protocol;
  const databaseIdentity = protocol === "postgres:" ? parsed.pathname.replace(/\/$/, "") : "";
  return `${protocol}//${parsed.hostname.toLowerCase()}:${parsed.port || (protocol === "https:" ? "443" : protocol === "postgres:" ? "5432" : "80")}${databaseIdentity}`;
}

function markerId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error("disposable external rehearsal endpoint identity is invalid");
  }
  return value;
}

export function parseCutoverRehearsalConfig(
  environment: Readonly<Record<string, string | undefined>>,
  operation: { readonly operationId: string; readonly resume: boolean }
): CutoverRehearsalConfig | undefined {
  if (environment.CUTOVER_REHEARSAL_EXTERNAL_ENABLED !== "1") return undefined;
  const targetKind = required(environment, "CUTOVER_REHEARSAL_TARGET_KIND");
  const proof = required(environment, "CUTOVER_REHEARSAL_PROOF");
  if (targetKind !== "DISPOSABLE_REHEARSAL" || proof !== REHEARSAL_PROOF) {
    throw new Error("disposable external rehearsal marker configuration is invalid");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operation.operationId)) {
    throw new Error("disposable external rehearsal operation identity is invalid");
  }
  const rehearsalInstanceId = required(environment, "CUTOVER_REHEARSAL_INSTANCE_ID");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(rehearsalInstanceId)) {
    throw new Error("disposable external rehearsal instance identity is invalid");
  }
  const targetDatabaseUrl = postgresEndpoint(required(environment, "CUTOVER_REHEARSAL_TARGET_DATABASE_URL"), "target PostgreSQL");
  const ledgerDatabaseUrl = postgresEndpoint(required(environment, "CUTOVER_REHEARSAL_LEDGER_DATABASE_URL"), "ledger PostgreSQL");
  const clickHouseUrl = endpoint(required(environment, "CUTOVER_REHEARSAL_CLICKHOUSE_URL"));
  const s3Endpoint = endpoint(required(environment, "CUTOVER_REHEARSAL_S3_ENDPOINT"));
  const normalEndpoints = [
    environment.DATABASE_URL,
    environment.CLICKHOUSE_URL,
    environment.PLATOS_OTEL_CLICKHOUSE_URL,
    environment.OBJECT_STORE_BASE_URL,
    environment.MINIO_PUBLIC_ENDPOINT,
  ].filter((value): value is string => Boolean(value));
  const rehearsalEndpoints = [targetDatabaseUrl, ledgerDatabaseUrl, clickHouseUrl, s3Endpoint];
  if (normalEndpoints.some((normal) => rehearsalEndpoints.some((rehearsal) => {
    try { return endpointIdentity(normal) === endpointIdentity(rehearsal); } catch { return false; }
  }))) {
    throw new Error("disposable external rehearsal endpoint matches a configured normal runtime endpoint");
  }
  return {
    enabled: true,
    targetKind: "DISPOSABLE_REHEARSAL",
    proof: REHEARSAL_PROOF,
    operationId: operation.operationId,
    resume: operation.resume,
    rehearsalInstanceId,
    targetDatabaseUrl,
    targetPostgresEndpointId: markerId(required(environment, "CUTOVER_REHEARSAL_TARGET_POSTGRES_ENDPOINT_ID")),
    ledgerPostgresEndpointId: markerId(required(environment, "CUTOVER_REHEARSAL_LEDGER_POSTGRES_ENDPOINT_ID")),
    clickHouseEndpointId: markerId(required(environment, "CUTOVER_REHEARSAL_CLICKHOUSE_ENDPOINT_ID")),
    objectStoreEndpointId: markerId(required(environment, "CUTOVER_REHEARSAL_OBJECT_STORE_ENDPOINT_ID")),
    clickHouseUrl,
    clickHouseUsername: required(environment, "CUTOVER_REHEARSAL_CLICKHOUSE_USERNAME"),
    clickHousePassword: required(environment, "CUTOVER_REHEARSAL_CLICKHOUSE_PASSWORD"),
    s3Endpoint,
    s3Region: required(environment, "CUTOVER_REHEARSAL_S3_REGION"),
    s3Bucket: required(environment, "CUTOVER_REHEARSAL_S3_BUCKET"),
    s3AccessKeyId: required(environment, "CUTOVER_REHEARSAL_S3_ACCESS_KEY_ID"),
    s3SecretAccessKey: required(environment, "CUTOVER_REHEARSAL_S3_SECRET_ACCESS_KEY"),
    ledgerDatabaseUrl,
  };
}

export class ExternalRehearsalFailure extends Error {
  constructor(readonly code: string, message: string, readonly restoreRequired = false) {
    super(message);
    this.name = "ExternalRehearsalFailure";
  }
}

interface ChecksumMetrics {
  readonly row_count: string;
  readonly rows_sha256: string;
}

async function clickHouseRows<T>(client: ClickHouseClient, query: string): Promise<readonly T[]> {
  try {
    const result = await client.query({ query, format: "JSONEachRow" });
    return await result.json<T>();
  } catch {
    throw new ExternalRehearsalFailure(
      "CUTOVER_REHEARSAL_CLICKHOUSE_QUERY_FAILED",
      "disposable ClickHouse rehearsal operation failed"
    );
  }
}

async function clickHouseCommand(client: ClickHouseClient, query: string): Promise<void> {
  try {
    await client.command({ query });
  } catch (error) {
    throw new ExternalRehearsalFailure(
      "CUTOVER_REHEARSAL_CLICKHOUSE_COMMAND_FAILED",
      "disposable ClickHouse rehearsal operation failed"
    );
  }
}

async function clickHouseCommandWithRole(
  client: ClickHouseClient,
  query: string,
  role: string
): Promise<void> {
  try {
    await client.command({ query, role });
  } catch (error) {
    throw new ExternalRehearsalFailure(
      "CUTOVER_REHEARSAL_CLICKHOUSE_COMMAND_FAILED",
      "disposable ClickHouse rehearsal operation failed"
    );
  }
}

async function testOnlyPauseAfterForwardExchange(): Promise<void> {
  if (process.env.NODE_ENV !== "test") return;
  const value = process.env.CUTOVER_REHEARSAL_TEST_PAUSE_AFTER_FORWARD_EXCHANGE_MS;
  if (!value) return;
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 120_000) {
    throw new ExternalRehearsalFailure(
      "CUTOVER_REHEARSAL_TEST_PAUSE_INVALID",
      "test-only external rehearsal pause is invalid"
    );
  }
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function checksum(client: ClickHouseClient, query: string): Promise<{ rowCount: string; sha256: string }> {
  const row = (await clickHouseRows<ChecksumMetrics>(client, query))[0];
  if (!row || !/^(?:0|[1-9][0-9]*)$/.test(row.row_count) || !/^[0-9a-f]{64}$/.test(row.rows_sha256)) {
    throw new ExternalRehearsalFailure(
      "CUTOVER_REHEARSAL_CHECKSUM_INVALID",
      "disposable ClickHouse rehearsal checksum was invalid"
    );
  }
  return { rowCount: row.row_count, sha256: row.rows_sha256 };
}

interface LedgerMetadata {
  readonly rowCount?: string;
  readonly objectCount?: string;
  readonly byteLength?: string;
  readonly rowsSha256?: string;
  readonly objectsSha256?: string;
  readonly contentSha256?: string;
  readonly manifestSha256?: string;
}

interface DurableExchangeIntent {
  readonly table: string;
  readonly original: { readonly rowCount: string; readonly rowsSha256: string; readonly schemaSha256: string };
  readonly replacement: { readonly rowCount: string; readonly rowsSha256: string; readonly schemaSha256: string };
}

interface ClickHouseWriterGrant {
  readonly principalKind: "USER" | "ROLE";
  readonly principalName: string;
  readonly databaseName: string | null;
  readonly tableName: string | null;
  readonly columnName: string | null;
  readonly grantOption: boolean;
}

function durableExchangeIntent(
  table: string,
  original: LedgerMetadata,
  replacement: LedgerMetadata
): DurableExchangeIntent {
  const valid = (metadata: LedgerMetadata): metadata is Required<Pick<LedgerMetadata, "rowCount" | "rowsSha256" | "contentSha256">> =>
    typeof metadata?.rowCount === "string" && /^(?:0|[1-9][0-9]*)$/.test(metadata.rowCount) &&
    typeof metadata?.rowsSha256 === "string" && /^[0-9a-f]{64}$/.test(metadata.rowsSha256) &&
    typeof metadata?.contentSha256 === "string" && /^[0-9a-f]{64}$/.test(metadata.contentSha256);
  if (!clickHousePhysicalRekeyPlan.some((plan) => plan.table === table) || !valid(original) || !valid(replacement)) {
    throw new ExternalRehearsalFailure(
      "CUTOVER_REHEARSAL_LEDGER_RECOVERY_INVALID",
      "disposable rehearsal ledger recovery intent was invalid",
      true
    );
  }
  return {
    table,
    original: { rowCount: original.rowCount, rowsSha256: original.rowsSha256, schemaSha256: original.contentSha256 },
    replacement: { rowCount: replacement.rowCount, rowsSha256: replacement.rowsSha256, schemaSha256: replacement.contentSha256 },
  };
}

class RehearsalLedger {
  private runId = "";
  private sequence = 0;
  private attempt = 0;
  private hadPriorAttempt = false;
  private readonly idempotencyKey: string;

  constructor(
    private readonly client: pg.Client,
    private readonly cutoverRunId: string,
    rehearsalInstanceId: string
  ) {
    this.idempotencyKey = `win123-disposable-rehearsal:${rehearsalInstanceId}:${cutoverRunId}`;
  }

  operationId(): string {
    return this.cutoverRunId;
  }

  async initialize(resume: boolean): Promise<void> {
    try {
      const row = (await this.client.query<{ attempt: number; completed: boolean }>(
        `SELECT attempt, (status = 'ROLLED_BACK' AND report IS NOT NULL) AS completed
           FROM public."ExternalCutoverRun"
          WHERE "idempotencyKey" = $1
          ORDER BY attempt DESC
          LIMIT 1`,
        [this.idempotencyKey]
      )).rows[0];
      this.attempt = row?.attempt ?? 0;
      this.hadPriorAttempt = this.attempt > 0;
      if (this.hadPriorAttempt && !resume) {
        throw new ExternalRehearsalFailure(
          "CUTOVER_REHEARSAL_OPERATION_EXISTS",
          "external rehearsal operation already exists; explicit resume is required"
        );
      }
      if (!this.hadPriorAttempt && resume) {
        throw new ExternalRehearsalFailure(
          "CUTOVER_REHEARSAL_RESUME_NOT_FOUND",
          "external rehearsal operation has no durable state to resume"
        );
      }
      if (resume && row?.completed) {
        throw new ExternalRehearsalFailure(
          "CUTOVER_REHEARSAL_OPERATION_FINISHED",
          "external rehearsal operation is already complete"
        );
      }
    } catch (error) {
      if (error instanceof ExternalRehearsalFailure) throw error;
      throw new ExternalRehearsalFailure(
        "CUTOVER_REHEARSAL_LEDGER_RECOVERY_READ_FAILED",
        "disposable rehearsal ledger recovery state could not be read",
        true
      );
    }
  }

  isRestart(): boolean {
    return this.hadPriorAttempt;
  }

  async snapshot(status: string, report?: DisposableRehearsalExternalCutoverReportFragment): Promise<void> {
    this.attempt += 1;
    this.runId = randomUUID();
    this.sequence = 0;
    try {
      await this.client.query(
        `INSERT INTO public."ExternalCutoverRun"
         (id, "idempotencyKey", attempt, status, "manifestSha256", report, "finishedAt")
         VALUES ($1, $2, $3, $4::public."ExternalCutoverStatus", $5, $6::jsonb,
                 CASE WHEN $4 IN ('COMPLETED', 'ROLLED_BACK', 'FAILED') THEN clock_timestamp() ELSE NULL END)`,
        [this.runId, this.idempotencyKey, this.attempt, status, clickHouseRekeyManifestSha256(), report ? JSON.stringify(report) : null]
      );
    } catch {
      throw new ExternalRehearsalFailure(
        "CUTOVER_REHEARSAL_LEDGER_SNAPSHOT_FAILED",
        "disposable rehearsal ledger snapshot write failed"
      );
    }
  }

  async evidence(input: {
    readonly domain: "CLICKHOUSE" | "OBJECT_STORE";
    readonly action: string;
    readonly outcome: string;
    readonly resourceName?: string;
    readonly expectedMetadata?: LedgerMetadata;
    readonly observedMetadata?: LedgerMetadata;
  }): Promise<void> {
    this.sequence += 1;
    try {
      await this.client.query(
        `INSERT INTO public."ExternalCutoverEvidence"
         (id, "runId", "runAttempt", sequence, domain, action, outcome, "resourceName", "expectedMetadata", "observedMetadata")
         VALUES ($1, $2, $3, $4, $5::public."ExternalCutoverDomain", $6::public."ExternalCutoverAction",
                 $7::public."ExternalCutoverOutcome", $8, $9::jsonb, $10::jsonb)`,
        [randomUUID(), this.runId, this.attempt, this.sequence, input.domain, input.action, input.outcome,
          input.resourceName ?? null, JSON.stringify(input.expectedMetadata ?? {}), JSON.stringify(input.observedMetadata ?? {})]
      );
    } catch {
      throw new ExternalRehearsalFailure(
        "CUTOVER_REHEARSAL_LEDGER_EVIDENCE_FAILED",
        "disposable rehearsal ledger evidence write failed"
      );
    }
  }

  async object(input: {
    readonly metadataRowId: string;
    readonly outcome: "MATCH" | "MISMATCH" | "MISSING" | "INDETERMINATE";
    readonly sourceObjectKeySha256: string;
    readonly targetObjectKeySha256: string;
    readonly expectedByteLength: string;
    readonly observedByteLength?: string;
  }): Promise<void> {
    try {
      await this.client.query(
        `INSERT INTO public."ObjectKeyReconciliation"
         (id, "runId", "runAttempt", "metadataModel", "metadataRowId", attempt, outcome,
          "sourceObjectKeySha256", "targetObjectKeySha256", "expectedMetadata", "observedMetadata")
         VALUES ($1, $2, $3, 'MessageAttachment', $4, 1, $5::public."ExternalCutoverOutcome",
                 $6, $7, $8::jsonb, $9::jsonb)`,
        [randomUUID(), this.runId, this.attempt, input.metadataRowId, input.outcome,
          input.sourceObjectKeySha256, input.targetObjectKeySha256,
          JSON.stringify({ byteLength: input.expectedByteLength }),
          JSON.stringify(input.observedByteLength === undefined ? {} : { byteLength: input.observedByteLength })]
      );
    } catch {
      throw new ExternalRehearsalFailure(
        "CUTOVER_REHEARSAL_LEDGER_OBJECT_FAILED",
        "disposable rehearsal object evidence write failed"
      );
    }
  }

  async persistWriterGrantPlan(grants: readonly ClickHouseWriterGrant[]): Promise<void> {
    try {
      await this.client.query("BEGIN");
      for (const [index, grant] of grants.entries()) {
        await this.client.query(
          `INSERT INTO public."ExternalClickHouseWriterGrant"
           (id, "runId", "runAttempt", sequence, "principalKind", "principalName",
            "databaseName", "tableName", "columnName", "grantOption")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [randomUUID(), this.runId, this.attempt, index + 1, grant.principalKind,
            grant.principalName, grant.databaseName, grant.tableName, grant.columnName,
            grant.grantOption]
        );
      }
      await this.client.query("COMMIT");
    } catch {
      await this.client.query("ROLLBACK").catch(() => undefined);
      throw new ExternalRehearsalFailure(
        "CUTOVER_REHEARSAL_WRITER_PLAN_FAILED",
        "durable ClickHouse writer restoration plan could not be persisted"
      );
    }
  }

  async writerGrantPlan(): Promise<readonly ClickHouseWriterGrant[]> {
    try {
      const result = await this.client.query<{
        principalKind: "USER" | "ROLE";
        principalName: string;
        databaseName: string | null;
        tableName: string | null;
        columnName: string | null;
        grantOption: boolean;
      }>(
        `SELECT writer_grant."principalKind", writer_grant."principalName", writer_grant."databaseName",
                writer_grant."tableName", writer_grant."columnName", writer_grant."grantOption"
           FROM public."ExternalClickHouseWriterGrant" writer_grant
           JOIN public."ExternalCutoverRun" run ON run.id = writer_grant."runId"
          WHERE run."idempotencyKey" = $1
          ORDER BY run.attempt, writer_grant.sequence`,
        [this.idempotencyKey]
      );
      return result.rows;
    } catch {
      throw new ExternalRehearsalFailure(
        "CUTOVER_REHEARSAL_WRITER_PLAN_READ_FAILED",
        "durable ClickHouse writer restoration plan could not be read",
        true
      );
    }
  }

  async pendingExchangeIntents(): Promise<readonly DurableExchangeIntent[]> {
    try {
      const result = await this.client.query<{
        resource_name: string;
        action: "COPY" | "SWAP" | "ROLLBACK";
        outcome: string;
        expected_metadata: LedgerMetadata;
        observed_metadata: LedgerMetadata;
        created_at: Date;
        sequence: number;
      }>(
        `SELECT evidence."resourceName" AS resource_name,
                evidence.action::text AS action,
                evidence.outcome::text AS outcome,
                evidence."expectedMetadata" AS expected_metadata,
                evidence."observedMetadata" AS observed_metadata,
                evidence."createdAt" AS created_at,
                evidence.sequence
           FROM public."ExternalCutoverEvidence" evidence
           JOIN public."ExternalCutoverRun" run ON run.id = evidence."runId"
          WHERE run."idempotencyKey" = $1
            AND evidence.domain = 'CLICKHOUSE'
            AND evidence.action IN ('COPY', 'SWAP', 'ROLLBACK')
          ORDER BY run.attempt, evidence.sequence`,
        [this.idempotencyKey]
      );
      const states = new Map<string, DurableExchangeIntent>();
      for (const row of result.rows) {
        if (!row.resource_name) continue;
        if ((row.action === "COPY" || row.action === "SWAP") && row.outcome === "STARTED") {
          const parsed = durableExchangeIntent(row.resource_name, row.expected_metadata, row.observed_metadata);
          states.set(row.resource_name, parsed);
        } else if (row.action === "ROLLBACK" && row.outcome === "ROLLED_BACK") {
          states.delete(row.resource_name);
        }
      }
      return [...states.values()];
    } catch (error) {
      if (error instanceof ExternalRehearsalFailure) throw error;
      throw new ExternalRehearsalFailure(
        "CUTOVER_REHEARSAL_LEDGER_RECOVERY_READ_FAILED",
        "disposable rehearsal ledger recovery state could not be read",
        true
      );
    }
  }
}

interface PostgresIdentity {
  readonly systemIdentifier: string;
  readonly databaseName: string;
}

async function postgresIdentity(database: CutoverDatabase): Promise<PostgresIdentity> {
  try {
    const row = (await database.query<{ system_identifier: string; database_name: string }>(
      `SELECT system_identifier::text AS system_identifier, current_database() AS database_name
         FROM pg_control_system()`
    )).rows[0];
    if (!row?.system_identifier || !row.database_name) throw new Error();
    return { systemIdentifier: row.system_identifier, databaseName: row.database_name };
  } catch {
    throw new ExternalRehearsalFailure(
      "CUTOVER_REHEARSAL_POSTGRES_IDENTITY_FAILED",
      "disposable rehearsal PostgreSQL database identity could not be proven"
    );
  }
}

async function assertPostgresMarker(
  database: CutoverDatabase,
  config: CutoverRehearsalConfig
): Promise<PostgresIdentity> {
  let rows: readonly { marker: string; target_kind: string; instance_id: string; endpoint_role: string; endpoint_id: string }[] = [];
  try {
    rows = (await database.query<typeof rows[number]>(
      `SELECT marker, target_kind, instance_id::text, endpoint_role, endpoint_id
         FROM cutover_rehearsal.target_marker WHERE singleton = TRUE`
    )).rows;
  } catch {
    // A missing or inaccessible marker is indistinguishable from an invalid target.
  }
  if (
    rows.length !== 1 || rows[0]?.marker !== config.proof ||
    rows[0]?.target_kind !== "DISPOSABLE_REHEARSAL" ||
    rows[0]?.instance_id !== config.rehearsalInstanceId ||
    rows[0]?.endpoint_role !== ENDPOINT_ROLES.targetPostgres ||
    rows[0]?.endpoint_id !== config.targetPostgresEndpointId
  ) {
    throw new ExternalRehearsalFailure(
      "CUTOVER_REHEARSAL_POSTGRES_MARKER_MISSING",
      "target PostgreSQL is not marked as a disposable rehearsal target"
    );
  }
  return postgresIdentity(database);
}

async function assertLedgerMarker(client: pg.Client, config: CutoverRehearsalConfig): Promise<PostgresIdentity> {
  let rows: readonly { marker: string; target_kind: string; instance_id: string; endpoint_role: string; endpoint_id: string }[] = [];
  try {
    rows = (await client.query<typeof rows[number]>(
      `SELECT marker, target_kind, instance_id::text, endpoint_role, endpoint_id
         FROM cutover_rehearsal.ledger_marker WHERE singleton = TRUE`
    )).rows;
  } catch {
    // A missing or inaccessible marker is indistinguishable from an invalid ledger.
  }
  if (
    rows.length !== 1 || rows[0]?.marker !== config.proof ||
    rows[0]?.target_kind !== "DISPOSABLE_REHEARSAL" ||
    rows[0]?.instance_id !== config.rehearsalInstanceId ||
    rows[0]?.endpoint_role !== ENDPOINT_ROLES.ledgerPostgres ||
    rows[0]?.endpoint_id !== config.ledgerPostgresEndpointId
  ) {
    throw new ExternalRehearsalFailure(
      "CUTOVER_REHEARSAL_LEDGER_MARKER_MISSING",
      "evidence PostgreSQL is not marked as a disposable rehearsal ledger"
    );
  }
  return postgresIdentity({ query: (sql, values) => client.query(sql, values as unknown[]) });
}

async function assertClickHouseMarker(client: ClickHouseClient, config: CutoverRehearsalConfig): Promise<void> {
  let database: readonly { engine: string }[] = [];
  let marker: readonly { marker: string; target_kind: string; instance_id: string; endpoint_role: string; endpoint_id: string }[] = [];
  try {
    [database, marker] = await Promise.all([
      clickHouseRows<{ engine: string }>(
        client,
        `SELECT engine FROM system.databases WHERE name = '${CLICKHOUSE_REHEARSAL_DATABASE}'`
      ),
      clickHouseRows<typeof marker[number]>(
        client,
        `SELECT marker, target_kind, instance_id, endpoint_role, endpoint_id
           FROM ${CLICKHOUSE_REHEARSAL_DATABASE}.cutover_rehearsal_marker`
      ),
    ]);
  } catch {
    // Normalize all proof failures to the dedicated marker failure below.
  }
  if (
    database.length !== 1 ||
    marker.length !== 1 ||
    database[0]?.engine !== "Atomic" ||
    marker[0]?.marker !== config.proof ||
    marker[0]?.target_kind !== "DISPOSABLE_REHEARSAL" ||
    marker[0]?.instance_id !== config.rehearsalInstanceId ||
    marker[0]?.endpoint_role !== ENDPOINT_ROLES.clickHouse ||
    marker[0]?.endpoint_id !== config.clickHouseEndpointId
  ) {
    throw new ExternalRehearsalFailure(
      "CUTOVER_REHEARSAL_CLICKHOUSE_MARKER_MISSING",
      "ClickHouse is not an Atomic disposable rehearsal target"
    );
  }
}

async function assertS3Marker(client: S3Client, bucket: string, config: CutoverRehearsalConfig): Promise<void> {
  try {
    const marker = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: S3_MARKER_KEY }));
    if (
      marker.Metadata?.["win123-rehearsal-marker"] !== config.proof ||
      marker.Metadata?.["win123-rehearsal-instance-id"] !== config.rehearsalInstanceId ||
      marker.Metadata?.["win123-rehearsal-endpoint-role"] !== ENDPOINT_ROLES.objectStore ||
      marker.Metadata?.["win123-rehearsal-endpoint-id"] !== config.objectStoreEndpointId
    ) throw new Error();
  } catch {
    throw new ExternalRehearsalFailure(
      "CUTOVER_REHEARSAL_OBJECT_STORE_MARKER_MISSING",
      "object store is not marked as a disposable rehearsal target"
    );
  }
}

interface MappingRow extends Record<string, unknown> {
  readonly source_model: string;
  readonly source_id: string;
}

async function loadMappings(
  targetDatabase: CutoverDatabase,
  clickHouse: ClickHouseClient,
  runId: string,
  ledger: RehearsalLedger,
  executorUsername: string
): Promise<void> {
  let mappings;
  try {
    mappings = await targetDatabase.query<MappingRow>(
      `SELECT DISTINCT source_model COLLATE "C" AS source_model,
                       source_id COLLATE "C" AS source_id
         FROM cutover_legacy.cutover_id_map
        WHERE mapping_version = 1 AND source_model = ANY($1::text[])
        ORDER BY source_model, source_id`,
      [[...clickHousePhysicalPlanSourceModels]]
    );
  } catch {
    throw new ExternalRehearsalFailure(
      "CUTOVER_REHEARSAL_MAPPING_READ_FAILED",
      "deterministic rehearsal mapping read failed"
    );
  }
  await clickHouseCommand(clickHouse, createMappingTableSql(runId));
  await maintenanceCommand({
    client: clickHouse,
    ledger,
    operationId: runId,
    executorUsername,
    resourceName: clickHouseMappingTableIdentifier(runId),
    query: `GRANT INSERT ON ${clickHouseIdentifier(CLICKHOUSE_REHEARSAL_DATABASE)}.${clickHouseIdentifier(clickHouseMappingTableIdentifier(runId))} TO ${clickHouseIdentifier(executorUsername)}`,
  });
  try {
    const values = mappings.rows.map((row) => ({
      mapping_version: 1,
      source_model: row.source_model,
      source_id: row.source_id,
      target_id: mapCutoverId({ sourceModel: row.source_model, sourceId: row.source_id }),
    }));
    await clickHouse.insert({
      table: `${CLICKHOUSE_REHEARSAL_DATABASE}.${clickHouseMappingTableIdentifier(runId)}`,
      format: "JSONEachRow",
      values,
    });
  } catch {
    throw new ExternalRehearsalFailure(
      "CUTOVER_REHEARSAL_MAPPING_LOAD_FAILED",
      "deterministic rehearsal mapping load failed"
    );
  }
}

async function tableColumns(client: ClickHouseClient, table: string): Promise<readonly ClickHouseColumnShape[]> {
  return clickHouseRows<ClickHouseColumnShape>(client, `SELECT
      name,
      type,
      default_kind AS defaultKind,
      default_expression AS defaultExpression
    FROM system.columns
    WHERE database = '${CLICKHOUSE_REHEARSAL_DATABASE}' AND table = '${table}'
    ORDER BY position`);
}

function columnsSha256(columns: readonly ClickHouseColumnShape[]): string {
  return createHash("sha256").update(JSON.stringify(columns), "utf8").digest("hex");
}

type ExchangePairState = "RESTORED" | "SWAPPED" | "AMBIGUOUS";

async function classifyExchangePair(
  client: ClickHouseClient,
  runId: string,
  intent: DurableExchangeIntent
): Promise<ExchangePairState> {
  const shadow = clickHouseRunScopedIdentifier(intent.table, "shadow", runId);
  const catalog = await clickHouseRows<{ name: string }>(client, `SELECT name
    FROM system.tables
    WHERE database = '${CLICKHOUSE_REHEARSAL_DATABASE}'
      AND name IN ('${intent.table}', '${shadow}')
    ORDER BY name`);
  if (catalog.length !== 2) return "AMBIGUOUS";
  const inspect = async (table: string) => {
    const columns = await tableColumns(client, table);
    // SHOW CREATE is intentionally read as part of every recovery inspection so
    // engine/catalog corruption cannot be hidden by a matching column projection.
    await showCreate(client, table);
    const digest = await checksum(client, targetChecksumSql(table, columns));
    const schemaSha256 = columnsSha256(columns);
    const matches = (identity: DurableExchangeIntent["original"]): boolean =>
      digest.rowCount === identity.rowCount && digest.sha256 === identity.rowsSha256 && schemaSha256 === identity.schemaSha256;
    return { original: matches(intent.original), replacement: matches(intent.replacement) };
  };
  const [active, staged] = await Promise.all([inspect(intent.table), inspect(shadow)]);
  if (active.original && !active.replacement && staged.replacement && !staged.original) return "RESTORED";
  if (active.replacement && !active.original && staged.original && !staged.replacement) return "SWAPPED";
  return "AMBIGUOUS";
}

async function showCreate(client: ClickHouseClient, table: string): Promise<string> {
  try {
    const result = await client.query({
      query: `SHOW CREATE TABLE ${CLICKHOUSE_REHEARSAL_DATABASE}.\`${table}\``,
      format: "TabSeparatedRaw",
    });
    return await result.text();
  } catch {
    throw new ExternalRehearsalFailure(
      "CUTOVER_REHEARSAL_SCHEMA_READ_FAILED",
      "ClickHouse rehearsal source schema could not be read"
    );
  }
}

export interface SourceWatermark {
  readonly table: string;
  readonly rowCount: string;
  readonly rowsSha256: string;
}

export function assertStableClickHouseWatermarks(
  before: readonly SourceWatermark[],
  after: readonly SourceWatermark[]
): void {
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new ExternalRehearsalFailure(
    "CUTOVER_REHEARSAL_WRITER_WATERMARK_DRIFT",
    "ClickHouse ingestion changed while the writer fence was being established"
  );
}

const clickHouseIdentifier = (value: string): string => `\`${value.replaceAll("`", "``")}\``;

function canonicalWriterGrants(grants: readonly ClickHouseWriterGrant[]): readonly ClickHouseWriterGrant[] {
  return [...grants].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

interface ClickHouseRoleGrant {
  readonly receiverKind: "USER" | "ROLE";
  readonly receiverName: string;
  readonly grantedRoleName: string;
  readonly grantedRoleIsDefault: boolean;
  readonly withAdminOption: boolean;
}

interface EffectiveClickHouseWriter {
  readonly principalKind: "USER" | "ROLE";
  readonly principalName: string;
  readonly tableName: string;
  readonly columnName: string | null;
}

async function clickHouseText(client: ClickHouseClient, query: string): Promise<string> {
  try {
    const result = await client.query({ query, format: "TabSeparatedRaw" });
    return await result.text();
  } catch {
    throw new ExternalRehearsalFailure(
      "CUTOVER_REHEARSAL_WRITER_ENUMERATION_FAILED",
      "ClickHouse effective writer authorization could not be enumerated"
    );
  }
}

function splitClickHouseList(value: string): readonly string[] {
  const parts: string[] = [];
  let start = 0;
  let parentheses = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "`") {
      if (quoted && value[index + 1] === "`") index += 1;
      else quoted = !quoted;
    } else if (!quoted && character === "(") parentheses += 1;
    else if (!quoted && character === ")") parentheses -= 1;
    else if (!quoted && parentheses === 0 && character === ",") {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quoted || parentheses !== 0) throw new ExternalRehearsalFailure(
    "CUTOVER_REHEARSAL_WRITER_ENUMERATION_INVALID",
    "ClickHouse effective writer authorization was not canonical"
  );
  parts.push(value.slice(start).trim());
  return parts;
}

function unquoteClickHouseIdentifier(value: string): string {
  if (value === "*") return value;
  if (value.startsWith("`") && value.endsWith("`")) {
    return value.slice(1, -1).replaceAll("``", "`");
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new ExternalRehearsalFailure(
    "CUTOVER_REHEARSAL_WRITER_ENUMERATION_INVALID",
    "ClickHouse effective writer authorization was not canonical"
  );
  return value;
}

function parseClickHouseScope(value: string): { databaseName: string; tableName: string } {
  let quoted = false;
  let separator = -1;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "`") {
      if (quoted && value[index + 1] === "`") index += 1;
      else quoted = !quoted;
    } else if (!quoted && value[index] === ".") {
      if (separator !== -1) throw new ExternalRehearsalFailure(
        "CUTOVER_REHEARSAL_WRITER_ENUMERATION_INVALID",
        "ClickHouse effective writer authorization was not canonical"
      );
      separator = index;
    }
  }
  if (quoted || separator < 1 || separator === value.length - 1) throw new ExternalRehearsalFailure(
    "CUTOVER_REHEARSAL_WRITER_ENUMERATION_INVALID",
    "ClickHouse effective writer authorization was not canonical"
  );
  return {
    databaseName: unquoteClickHouseIdentifier(value.slice(0, separator)),
    tableName: unquoteClickHouseIdentifier(value.slice(separator + 1)),
  };
}

function effectiveWriterGrantsFromShow(input: {
  readonly statements: string;
  readonly principalKind: "USER" | "ROLE";
  readonly principalName: string;
}): readonly EffectiveClickHouseWriter[] {
  const effective: EffectiveClickHouseWriter[] = [];
  for (const statement of input.statements.split("\n").map((line) => line.trim()).filter(Boolean)) {
    const match = statement.match(/^GRANT (.+?) ON (.+?) TO /);
    if (!match) continue;
    const insert = splitClickHouseList(match[1]!).find((privilege) => /^INSERT(?:\(.*\))?$/.test(privilege));
    if (!insert) continue;
    const scope = parseClickHouseScope(match[2]!);
    if (scope.databaseName !== "*" && scope.databaseName !== CLICKHOUSE_REHEARSAL_DATABASE) continue;
    const tables = scope.tableName === "*"
      ? clickHousePhysicalRekeyPlan.map((plan) => plan.table)
      : clickHousePhysicalRekeyPlan.some((plan) => plan.table === scope.tableName)
        ? [scope.tableName]
        : [];
    const columnsMatch = insert.match(/^INSERT(?:\((.*)\))?$/)!;
    const columns = columnsMatch[1]
      ? splitClickHouseList(columnsMatch[1]).map(unquoteClickHouseIdentifier)
      : [null];
    for (const tableName of tables) {
      for (const columnName of columns) effective.push({
        principalKind: input.principalKind,
        principalName: input.principalName,
        tableName,
        columnName,
      });
    }
  }
  return effective;
}

function grantCoversEffectiveWriter(grant: ClickHouseWriterGrant, writer: EffectiveClickHouseWriter): boolean {
  return (grant.databaseName === null || grant.databaseName === CLICKHOUSE_REHEARSAL_DATABASE) &&
    (grant.tableName === null || grant.tableName === writer.tableName) &&
    (grant.columnName === null || grant.columnName === writer.columnName);
}

async function enumerateClickHouseWriterGrants(
  client: ClickHouseClient,
  requireNoEffectiveWriters = false,
  excludedControlRole?: string
): Promise<readonly ClickHouseWriterGrant[]> {
  const tables = clickHousePhysicalRekeyPlan.map((plan) => `'${plan.table}'`).join(", ");
  const [rows, users, roles, roleRows] = await Promise.all([clickHouseRows<{
    user_name: string | null;
    role_name: string | null;
    database_name: string | null;
    table_name: string | null;
    column_name: string | null;
    grant_option: number;
  }>(client, `SELECT user_name, role_name,
      nullIf(database, '') AS database_name,
      nullIf(table, '') AS table_name,
      nullIf(column, '') AS column_name,
      grant_option
    FROM system.grants
    WHERE access_type = 'INSERT' AND is_partial_revoke = 0
      AND (database IS NULL OR database IN ('', '${CLICKHOUSE_REHEARSAL_DATABASE}'))
      AND (table IS NULL OR table = '' OR table IN (${tables}))`),
  clickHouseRows<{ name: string; storage: string }>(client, "SELECT name, storage FROM system.users ORDER BY name"),
  clickHouseRows<{ name: string }>(client, "SELECT name FROM system.roles ORDER BY name"),
  clickHouseRows<{
    user_name: string | null;
    role_name: string | null;
    granted_role_name: string;
    granted_role_is_default: number;
    with_admin_option: number;
  }>(client, `SELECT user_name, role_name, granted_role_name,
      granted_role_is_default, with_admin_option
    FROM system.role_grants
    ORDER BY user_name, role_name, granted_role_name`)]);
  const mutableUserNames = new Set(users.filter((entry) => entry.storage !== "users_xml").map((entry) => entry.name));
  const allGrants = rows.map((row): ClickHouseWriterGrant => {
    const principalKind = row.user_name ? "USER" : row.role_name ? "ROLE" : undefined;
    const principalName = row.user_name ?? row.role_name;
    if (!principalKind || !principalName) throw new ExternalRehearsalFailure(
      "CUTOVER_REHEARSAL_WRITER_ENUMERATION_INVALID",
      "ClickHouse effective writer enumeration returned an invalid principal"
    );
    return {
      principalKind,
      principalName,
      databaseName: row.database_name,
      tableName: row.table_name,
      columnName: row.column_name,
      grantOption: row.grant_option === 1,
    };
  });
  const grants = allGrants.filter((grant) =>
    (grant.principalKind !== "USER" || mutableUserNames.has(grant.principalName)) &&
    (grant.principalKind !== "ROLE" || grant.principalName !== excludedControlRole)
  );
  const userNames = new Set(users.map((entry) => entry.name));
  const roleNames = new Set(roles.map((entry) => entry.name));
  const roleGrants = roleRows.map((row): ClickHouseRoleGrant => {
    const receiverKind = row.user_name ? "USER" : row.role_name ? "ROLE" : undefined;
    const receiverName = row.user_name ?? row.role_name;
    if (
      !receiverKind || !receiverName || !row.granted_role_name ||
      (receiverKind === "USER" ? !userNames.has(receiverName) : !roleNames.has(receiverName)) ||
      !roleNames.has(row.granted_role_name)
    ) throw new ExternalRehearsalFailure(
      "CUTOVER_REHEARSAL_WRITER_ROLE_GRAPH_INVALID",
      "ClickHouse writer role inheritance graph could not be proven"
    );
    return {
      receiverKind,
      receiverName,
      grantedRoleName: row.granted_role_name,
      grantedRoleIsDefault: row.granted_role_is_default === 1,
      withAdminOption: row.with_admin_option === 1,
    };
  });
  for (const grant of grants) {
    if (grant.principalKind === "USER" ? !userNames.has(grant.principalName) : !roleNames.has(grant.principalName)) {
      throw new ExternalRehearsalFailure(
        "CUTOVER_REHEARSAL_WRITER_ROLE_GRAPH_INVALID",
        "ClickHouse writer grant principal graph could not be proven"
      );
    }
  }
  const grantedRoles = (principalKind: "USER" | "ROLE", principalName: string): ReadonlySet<string> => {
    const reachable = new Set<string>();
    const pending = roleGrants
      .filter((edge) => edge.receiverKind === principalKind && edge.receiverName === principalName)
      .map((edge) => edge.grantedRoleName);
    if (principalKind === "ROLE") pending.push(principalName);
    while (pending.length > 0) {
      const roleName = pending.pop()!;
      if (reachable.has(roleName)) continue;
      reachable.add(roleName);
      for (const edge of roleGrants) {
        if (edge.receiverKind === "ROLE" && edge.receiverName === roleName) pending.push(edge.grantedRoleName);
      }
    }
    return reachable;
  };
  const effective: EffectiveClickHouseWriter[] = [];
  for (const principal of [
    ...users
      .filter((entry) => mutableUserNames.has(entry.name))
      .map((entry) => ({ principalKind: "USER" as const, principalName: entry.name })),
    ...roles
      .filter((entry) => entry.name !== excludedControlRole)
      .map((entry) => ({ principalKind: "ROLE" as const, principalName: entry.name })),
  ]) {
    const statements = await clickHouseText(
      client,
      `SHOW GRANTS FOR ${clickHouseIdentifier(principal.principalName)} FINAL`
    );
    const writers = effectiveWriterGrantsFromShow({ ...principal, statements });
    const inheritedRoles = grantedRoles(principal.principalKind, principal.principalName);
    const antecedents = grants.filter((grant) =>
      (grant.principalKind === principal.principalKind && grant.principalName === principal.principalName) ||
      (grant.principalKind === "ROLE" && inheritedRoles.has(grant.principalName))
    );
    const controlAntecedents = excludedControlRole && inheritedRoles.has(excludedControlRole)
      ? allGrants.filter((grant) => grant.principalKind === "ROLE" && grant.principalName === excludedControlRole)
      : [];
    const relevantWriters = writers.filter((writer) =>
      antecedents.some((grant) => grantCoversEffectiveWriter(grant, writer)) ||
      !controlAntecedents.some((grant) => grantCoversEffectiveWriter(grant, writer))
    );
    if (relevantWriters.some((writer) => !antecedents.some((grant) => grantCoversEffectiveWriter(grant, writer)))) {
      throw new ExternalRehearsalFailure(
        "CUTOVER_REHEARSAL_WRITER_EFFECTIVE_MISMATCH",
        "ClickHouse effective writer authorization did not match the direct grant and role graph"
      );
    }
    effective.push(...relevantWriters);
  }
  if (effective.length > 0 && grants.length === 0) throw new ExternalRehearsalFailure(
    "CUTOVER_REHEARSAL_WRITER_EFFECTIVE_MISMATCH",
    "ClickHouse effective writer authorization did not match the direct grant and role graph"
  );
  if (requireNoEffectiveWriters && effective.length > 0) throw new ExternalRehearsalFailure(
    "CUTOVER_REHEARSAL_WRITER_FENCE_FAILED",
    "zero effective ClickHouse INSERT writers could not be proven"
  );
  return canonicalWriterGrants(grants);
}

function writerGrantSql(grant: ClickHouseWriterGrant, operation: "GRANT" | "REVOKE"): string {
  const privilege = grant.columnName
    ? `INSERT(${clickHouseIdentifier(grant.columnName)})`
    : "INSERT";
  const scope = `${grant.databaseName ? clickHouseIdentifier(grant.databaseName) : "*"}.${grant.tableName ? clickHouseIdentifier(grant.tableName) : "*"}`;
  const principal = clickHouseIdentifier(grant.principalName);
  return operation === "REVOKE"
    ? `REVOKE ${privilege} ON ${scope} FROM ${principal}`
    : `GRANT ${privilege} ON ${scope} TO ${principal}${grant.grantOption ? " WITH GRANT OPTION" : ""}`;
}

function writerPlanDigest(grants: readonly ClickHouseWriterGrant[]): string {
  return createHash("sha256").update(JSON.stringify(canonicalWriterGrants(grants)), "utf8").digest("hex");
}

function orderedWriterGrants(
  grants: readonly ClickHouseWriterGrant[],
  executorUsername: string,
  operation: "GRANT" | "REVOKE"
): readonly ClickHouseWriterGrant[] {
  return [...grants].sort((left, right) => {
    const leftExecutor = left.principalKind === "USER" && left.principalName === executorUsername;
    const rightExecutor = right.principalKind === "USER" && right.principalName === executorUsername;
    if (leftExecutor !== rightExecutor) {
      return operation === "REVOKE"
        ? leftExecutor ? 1 : -1
        : leftExecutor ? -1 : 1;
    }
    return JSON.stringify(left).localeCompare(JSON.stringify(right));
  });
}

async function revokeWriterPlan(
  client: ClickHouseClient,
  grants: readonly ClickHouseWriterGrant[],
  executorUsername: string,
  operationId: string
): Promise<void> {
  for (const grant of orderedWriterGrants(grants, executorUsername, "REVOKE")) {
    await clickHouseCommand(client, writerGrantSql(grant, "REVOKE"));
  }
  await enumerateClickHouseWriterGrants(client, true, runScopedWriterControlRole(operationId));
}

function runScopedWriterControlRole(operationId: string): string {
  return `win123_rehearsal_writer_control_${operationId.replaceAll("-", "")}`;
}

async function assertMaintenanceRoleContract(
  client: ClickHouseClient,
  operationId: string,
  executorUsername: string
): Promise<void> {
  const roleName = runScopedWriterControlRole(operationId);
  const edges = await clickHouseRows<{
    user_name: string | null;
    role_name: string | null;
    granted_role_name: string;
    granted_role_is_default: number;
  }>(client, `SELECT user_name, role_name, granted_role_name, granted_role_is_default
    FROM system.role_grants
    WHERE granted_role_name = '${roleName}' OR role_name = '${roleName}'
    ORDER BY user_name, role_name, granted_role_name`);
  if (
    edges.length !== 1 || edges[0]?.user_name !== executorUsername ||
    edges[0]?.role_name !== null || edges[0]?.granted_role_name !== roleName ||
    edges[0]?.granted_role_is_default !== 0
  ) throw new ExternalRehearsalFailure(
    "CUTOVER_REHEARSAL_MAINTENANCE_ROLE_INVALID",
    "operation-scoped ClickHouse maintenance role was not executor-only and non-default"
  );
}

async function authorizeRunScopedWrites(
  client: ClickHouseClient,
  operationId: string,
  executorUsername: string,
  ledger: RehearsalLedger,
  resume: boolean
): Promise<void> {
  const controlRole = clickHouseIdentifier(runScopedWriterControlRole(operationId));
  const executor = clickHouseIdentifier(executorUsername);
  const [executorDefaults, existingRole] = await Promise.all([clickHouseRows<{ default_roles_all: number }>(
    client,
    `SELECT default_roles_all FROM system.users WHERE name = '${executorUsername.replaceAll("'", "''")}'`
  ), clickHouseRows<{ count: string }>(
    client,
    `SELECT count() AS count FROM system.roles WHERE name = '${runScopedWriterControlRole(operationId)}'`
  )]);
  const recoveringRole = existingRole[0]?.count === "1";
  if (
    executorDefaults.length !== 1 ||
    (recoveringRole ? !resume : executorDefaults[0]?.default_roles_all !== 1)
  ) {
    throw new ExternalRehearsalFailure(
      "CUTOVER_REHEARSAL_EXECUTOR_ROLE_DEFAULTS_INVALID",
      "ClickHouse rehearsal executor must begin with canonical default-role settings"
    );
  }
  const roleDigest = createHash("sha256").update(runScopedWriterControlRole(operationId), "utf8").digest("hex");
  await ledger.evidence({
    domain: "CLICKHOUSE",
    action: "MAINTENANCE_ENABLE",
    outcome: "STARTED",
    resourceName: "maintenance_role",
    expectedMetadata: { contentSha256: roleDigest },
  });
  if (recoveringRole) {
    await assertMaintenanceRoleContract(client, operationId, executorUsername);
    await ledger.evidence({
      domain: "CLICKHOUSE",
      action: "MAINTENANCE_ENABLE",
      outcome: "SUCCEEDED",
      resourceName: "maintenance_role",
      expectedMetadata: { contentSha256: roleDigest },
      observedMetadata: { contentSha256: roleDigest },
    });
    return;
  }
  await clickHouseCommand(client, `CREATE ROLE IF NOT EXISTS ${controlRole}`);
  await clickHouseCommand(client, `GRANT INSERT ON *.* TO ${controlRole} WITH GRANT OPTION`);
  await clickHouseCommand(client, `GRANT ${controlRole} TO ${executor}`);
  await clickHouseCommand(client, `ALTER USER ${executor} DEFAULT ROLE ALL EXCEPT ${controlRole}`);
  await assertMaintenanceRoleContract(client, operationId, executorUsername);
  await ledger.evidence({
    domain: "CLICKHOUSE",
    action: "MAINTENANCE_ENABLE",
    outcome: "SUCCEEDED",
    resourceName: "maintenance_role",
    expectedMetadata: { contentSha256: roleDigest },
    observedMetadata: { contentSha256: roleDigest },
  });
}

async function maintenanceCommand(input: {
  readonly client: ClickHouseClient;
  readonly ledger: RehearsalLedger;
  readonly operationId: string;
  readonly executorUsername: string;
  readonly resourceName: string;
  readonly query: string;
}): Promise<void> {
  const roleName = runScopedWriterControlRole(input.operationId);
  const roleDigest = createHash("sha256").update(roleName, "utf8").digest("hex");
  await assertMaintenanceRoleContract(input.client, input.operationId, input.executorUsername);
  await input.ledger.evidence({
    domain: "CLICKHOUSE",
    action: "MAINTENANCE_ENABLE",
    outcome: "STARTED",
    resourceName: input.resourceName,
    expectedMetadata: { contentSha256: roleDigest },
  });
  try {
    await clickHouseCommandWithRole(input.client, input.query, roleName);
    await input.ledger.evidence({
      domain: "CLICKHOUSE",
      action: "MAINTENANCE_DISABLE",
      outcome: "SUCCEEDED",
      resourceName: input.resourceName,
      expectedMetadata: { contentSha256: roleDigest },
      observedMetadata: { contentSha256: roleDigest },
    });
  } catch (error) {
    await input.ledger.evidence({
      domain: "CLICKHOUSE",
      action: "MAINTENANCE_DISABLE",
      outcome: "FAILED",
      resourceName: input.resourceName,
      expectedMetadata: { contentSha256: roleDigest },
    }).catch(() => undefined);
    throw error;
  }
}

async function removeRunScopedWriterRole(
  client: ClickHouseClient,
  operationId: string,
  executorUsername: string,
  ledger: RehearsalLedger
): Promise<void> {
  const controlRole = clickHouseIdentifier(runScopedWriterControlRole(operationId));
  const executor = clickHouseIdentifier(executorUsername);
  const roleDigest = createHash("sha256").update(runScopedWriterControlRole(operationId), "utf8").digest("hex");
  await ledger.evidence({
    domain: "CLICKHOUSE",
    action: "MAINTENANCE_DISABLE",
    outcome: "STARTED",
    resourceName: "maintenance_role",
    expectedMetadata: { contentSha256: roleDigest },
  });
  await clickHouseCommand(client, `REVOKE ${controlRole} FROM ${executor}`);
  await clickHouseCommand(client, `DROP ROLE IF EXISTS ${clickHouseIdentifier(runScopedWriterControlRole(operationId))}`);
  await clickHouseCommand(client, `ALTER USER ${executor} DEFAULT ROLE ALL`);
  const remaining = await clickHouseRows<{ count: string }>(client, `SELECT count(*)::text AS count
    FROM system.roles WHERE name = '${runScopedWriterControlRole(operationId)}'`);
  if (remaining[0]?.count !== "0") throw new ExternalRehearsalFailure(
    "CUTOVER_REHEARSAL_MAINTENANCE_ROLE_DISABLE_FAILED",
    "operation-scoped ClickHouse maintenance role disablement could not be proven",
    true
  );
  await ledger.evidence({
    domain: "CLICKHOUSE",
    action: "MAINTENANCE_DISABLE",
    outcome: "SUCCEEDED",
    resourceName: "maintenance_role",
    expectedMetadata: { contentSha256: roleDigest },
    observedMetadata: { contentSha256: roleDigest },
  });
}

async function captureSourceWatermarks(client: ClickHouseClient): Promise<readonly SourceWatermark[]> {
  const watermarks: SourceWatermark[] = [];
  for (const plan of clickHousePhysicalRekeyPlan) {
    const columns = await tableColumns(client, plan.table);
    const value = await checksum(client, targetChecksumSql(plan.table, columns));
    watermarks.push({ table: plan.table, rowCount: value.rowCount, rowsSha256: value.sha256 });
  }
  return watermarks;
}

function aggregateWatermarks(watermarks: readonly SourceWatermark[]): { rowCount: string; rowsSha256: string } {
  const rowCount = watermarks.reduce((sum, entry) => sum + BigInt(entry.rowCount), 0n).toString(10);
  const hash = createHash("sha256");
  for (const entry of [...watermarks].sort((left, right) => left.table.localeCompare(right.table))) {
    for (const value of [entry.table, entry.rowCount, entry.rowsSha256]) {
      const bytes = Buffer.from(value, "utf8");
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.length);
      hash.update(length).update(bytes);
    }
  }
  return { rowCount, rowsSha256: hash.digest("hex") };
}

async function fenceClickHouseWriters(
  client: ClickHouseClient,
  ledger: RehearsalLedger,
  executorUsername: string,
  onPlanPersisted: (grants: readonly ClickHouseWriterGrant[]) => void
): Promise<{ before: readonly SourceWatermark[]; after: readonly SourceWatermark[]; grants: readonly ClickHouseWriterGrant[] }> {
  const before = await captureSourceWatermarks(client);
  const grants = await enumerateClickHouseWriterGrants(
    client,
    false,
    runScopedWriterControlRole(ledger.operationId())
  );
  await ledger.persistWriterGrantPlan(grants);
  await ledger.evidence({
    domain: "CLICKHOUSE",
    action: "FENCE_WRITERS",
    outcome: "STARTED",
    expectedMetadata: { contentSha256: writerPlanDigest(grants) },
  });
  onPlanPersisted(grants);
  await revokeWriterPlan(client, grants, executorUsername, ledger.operationId());
  const after = await captureSourceWatermarks(client);
  assertStableClickHouseWatermarks(before, after);
  return { before, after, grants };
}

async function captureFencedSourceWatermarks(
  client: ClickHouseClient,
  grants: readonly ClickHouseWriterGrant[]
): Promise<{ before: readonly SourceWatermark[]; after: readonly SourceWatermark[]; grants: readonly ClickHouseWriterGrant[] }> {
  const before = await captureSourceWatermarks(client);
  const after = await captureSourceWatermarks(client);
  assertStableClickHouseWatermarks(before, after);
  return { before, after, grants };
}

async function restoreClickHouseWriters(
  client: ClickHouseClient,
  grants: readonly ClickHouseWriterGrant[],
  executorUsername: string,
  operationId: string,
  ledger: RehearsalLedger
): Promise<void> {
  const digest = writerPlanDigest(grants);
  await ledger.evidence({
    domain: "CLICKHOUSE",
    action: "RESTORE_WRITERS",
    outcome: "STARTED",
    resourceName: "writer_grant_plan",
    expectedMetadata: { contentSha256: digest },
  });
  for (const grant of orderedWriterGrants(grants, executorUsername, "GRANT")) {
    await maintenanceCommand({
      client,
      ledger,
      operationId,
      executorUsername,
      resourceName: "writer_grant_plan",
      query: writerGrantSql(grant, "GRANT"),
    });
  }
  const restored = await enumerateClickHouseWriterGrants(
    client,
    false,
    runScopedWriterControlRole(operationId)
  );
  const expected = canonicalWriterGrants(grants);
  if (JSON.stringify(restored) !== JSON.stringify(expected)) {
    throw new ExternalRehearsalFailure(
      "CUTOVER_REHEARSAL_WRITER_UNFENCE_FAILED",
      "exact ClickHouse writer grant restoration could not be proven",
      true
    );
  }
  await ledger.evidence({
    domain: "CLICKHOUSE",
    action: "RESTORE_WRITERS",
    outcome: "SUCCEEDED",
    resourceName: "writer_grant_plan",
    expectedMetadata: { contentSha256: digest },
    observedMetadata: { contentSha256: writerPlanDigest(restored) },
  });
}

async function fenceClickHouseWritersForRecovery(input: {
  readonly client: ClickHouseClient;
  readonly runId: string;
  readonly intents: readonly DurableExchangeIntent[];
  readonly grants: readonly ClickHouseWriterGrant[];
  readonly executorUsername: string;
  readonly onRevoked: () => void;
}): Promise<{ before: readonly SourceWatermark[]; after: readonly SourceWatermark[]; grants: readonly ClickHouseWriterGrant[] }> {
  input.onRevoked();
  const currentlyGranted = await enumerateClickHouseWriterGrants(
    input.client,
    false,
    runScopedWriterControlRole(input.runId)
  );
  await revokeWriterPlan(input.client, currentlyGranted, input.executorUsername, input.runId);
  const watermarks: SourceWatermark[] = [];
  for (const intent of input.intents) {
    const state = await classifyExchangePair(input.client, input.runId, intent).catch(() => "AMBIGUOUS" as const);
    if (state === "AMBIGUOUS") throw new ExternalRehearsalFailure(
      "CUTOVER_REHEARSAL_RESTART_RECOVERY_AMBIGUOUS",
      "ClickHouse restart recovery requires explicit restoration",
      true
    );
    watermarks.push({
      table: intent.table,
      rowCount: intent.original.rowCount,
      rowsSha256: intent.original.rowsSha256,
    });
  }
  return { before: watermarks, after: watermarks, grants: input.grants };
}

function expectedTargetColumns(
  plan: ClickHousePhysicalTablePlan,
  source: readonly ClickHouseColumnShape[]
): readonly ClickHouseColumnShape[] {
  const uuidColumns = new Set(plan.mappings
    .filter((mapping) => !mapping.jsonPath && mapping.emptyValuePolicy === "BLOCK")
    .map((mapping) => mapping.column));
  return source.map((column) => uuidColumns.has(column.name) ? { ...column, type: "UUID" } : column);
}

async function executeClickHouseTables(input: {
  readonly client: ClickHouseClient;
  readonly ledger: RehearsalLedger;
  readonly runId: string;
  readonly exchangeIntents: Map<string, DurableExchangeIntent>;
  readonly sourceWatermarks: ReadonlyMap<string, SourceWatermark>;
  readonly executorUsername: string;
}): Promise<ClickHouseTableRekeyEvidence[]> {
  const staged: Array<{
    plan: ClickHousePhysicalTablePlan;
    columns: readonly ClickHouseColumnShape[];
    evidence: Omit<ClickHouseTableRekeyEvidence, "rollbackOutcome">;
  }> = [];
  for (const plan of clickHousePhysicalRekeyPlan) {
    const sourceShowCreate = await showCreate(input.client, plan.table);
    const sourceSchemaSha256 = clickHouseSourceSchemaSha256(sourceShowCreate);
    if (sourceSchemaSha256 !== plan.sourceSchemaSha256) {
      throw new ExternalRehearsalFailure(
        "CUTOVER_REHEARSAL_SOURCE_SCHEMA_MISMATCH",
        "ClickHouse rehearsal source schema fingerprint mismatch"
      );
    }
    const columns = await tableColumns(input.client, plan.table);
    const missing = (await clickHouseRows<{ missing_count: string }>(
      input.client,
      mappingPreflightSql(plan, input.runId)
    ))[0]?.missing_count;
    if (missing !== "0") {
      throw new ExternalRehearsalFailure(
        "CUTOVER_REHEARSAL_MAPPING_MISSING",
        "ClickHouse rehearsal is blocked by a missing deterministic mapping"
      );
    }
    await clickHouseCommand(input.client, targetDdlSql(plan, input.runId, sourceShowCreate, columns));
    const shadow = clickHouseRunScopedIdentifier(plan.table, "shadow", input.runId);
    await maintenanceCommand({
      client: input.client,
      ledger: input.ledger,
      operationId: input.runId,
      executorUsername: input.executorUsername,
      resourceName: shadow,
      query: `GRANT INSERT ON ${clickHouseIdentifier(CLICKHOUSE_REHEARSAL_DATABASE)}.${clickHouseIdentifier(shadow)} TO ${clickHouseIdentifier(input.executorUsername)}`,
    });
    const targetColumns = await tableColumns(input.client, shadow);
    if (JSON.stringify(targetColumns) !== JSON.stringify(expectedTargetColumns(plan, columns))) {
      throw new ExternalRehearsalFailure(
        "CUTOVER_REHEARSAL_TARGET_SCHEMA_MISMATCH",
        "ClickHouse replacement schema mismatch"
      );
    }
    await clickHouseCommand(input.client, copyProjectionSql(plan, input.runId, columns));
    const [sourceOriginal, sourceNormalized, targetPayload, sourceIdentity, targetIdentity] = await Promise.all([
      checksum(input.client, sourceChecksumSql(plan, input.runId, columns, false)),
      checksum(input.client, sourceChecksumSql(plan, input.runId, columns, true)),
      checksum(input.client, targetChecksumSql(plan.table, targetColumns, input.runId)),
      checksum(input.client, identityChecksumSql(plan, input.runId, "SOURCE_NORMALIZED")),
      checksum(input.client, identityChecksumSql(plan, input.runId, "TARGET_SHADOW")),
    ]);
    const fenced = input.sourceWatermarks.get(plan.table);
    if (!fenced || fenced.rowCount !== sourceOriginal.rowCount || fenced.rowsSha256 !== sourceOriginal.sha256) {
      throw new ExternalRehearsalFailure(
        "CUTOVER_REHEARSAL_WRITER_WATERMARK_DRIFT",
        "ClickHouse source changed after the writer fence was proven"
      );
    }
    if (sourceOriginal.rowCount !== targetPayload.rowCount || sourceNormalized.rowCount !== targetPayload.rowCount) {
      throw new ExternalRehearsalFailure(
        "CUTOVER_REHEARSAL_REPLACEMENT_ROW_COUNT_MISMATCH",
        "ClickHouse replacement row count mismatch"
      );
    }
    if (sourceNormalized.sha256 !== targetPayload.sha256) {
      throw new ExternalRehearsalFailure(
        "CUTOVER_REHEARSAL_REPLACEMENT_CHECKSUM_MISMATCH",
        "ClickHouse replacement payload checksum mismatch"
      );
    }
    if (sourceIdentity.sha256 !== targetIdentity.sha256) {
      throw new ExternalRehearsalFailure(
        "CUTOVER_REHEARSAL_REPLACEMENT_CHECKSUM_MISMATCH",
        "ClickHouse replacement identity checksum mismatch"
      );
    }
    await input.ledger.evidence({
      domain: "CLICKHOUSE",
      action: "VERIFY",
      outcome: "MATCH",
      resourceName: plan.table,
      expectedMetadata: { rowCount: sourceNormalized.rowCount, rowsSha256: sourceNormalized.sha256 },
      observedMetadata: { rowCount: targetPayload.rowCount, rowsSha256: targetPayload.sha256 },
    });
    staged.push({
      plan,
      columns,
      evidence: {
        table: plan.table,
        sourceSchemaSha256,
        sourceRowCount: sourceOriginal.rowCount,
        targetRowCount: targetPayload.rowCount,
        sourceSha256: sourceOriginal.sha256,
        targetSha256: targetPayload.sha256,
        identitySha256: targetIdentity.sha256,
        payloadSha256: targetPayload.sha256,
      },
    });
    const durableIntent: DurableExchangeIntent = {
      table: plan.table,
      original: {
        rowCount: sourceOriginal.rowCount,
        rowsSha256: sourceOriginal.sha256,
        schemaSha256: columnsSha256(columns),
      },
      replacement: {
        rowCount: targetPayload.rowCount,
        rowsSha256: targetPayload.sha256,
        schemaSha256: columnsSha256(targetColumns),
      },
    };
    input.exchangeIntents.set(plan.table, durableIntent);
    await input.ledger.evidence({
      domain: "CLICKHOUSE",
      action: "COPY",
      outcome: "STARTED",
      resourceName: plan.table,
      expectedMetadata: {
        rowCount: durableIntent.original.rowCount,
        rowsSha256: durableIntent.original.rowsSha256,
        contentSha256: durableIntent.original.schemaSha256,
      },
      observedMetadata: {
        rowCount: durableIntent.replacement.rowCount,
        rowsSha256: durableIntent.replacement.rowsSha256,
        contentSha256: durableIntent.replacement.schemaSha256,
      },
    });
  }

  for (const entry of staged) {
    const shadow = clickHouseRunScopedIdentifier(entry.plan.table, "shadow", input.runId);
    const intent = input.exchangeIntents.get(entry.plan.table)!;
    await input.ledger.evidence({
      domain: "CLICKHOUSE",
      action: "SWAP",
      outcome: "STARTED",
      resourceName: entry.plan.table,
      expectedMetadata: {
        rowCount: intent.original.rowCount,
        rowsSha256: intent.original.rowsSha256,
        contentSha256: intent.original.schemaSha256,
      },
      observedMetadata: {
        rowCount: intent.replacement.rowCount,
        rowsSha256: intent.replacement.rowsSha256,
        contentSha256: intent.replacement.schemaSha256,
      },
    });
    try {
      await maintenanceCommand({
        client: input.client,
        ledger: input.ledger,
        operationId: input.runId,
        executorUsername: input.executorUsername,
        resourceName: entry.plan.table,
        query: `EXCHANGE TABLES ${CLICKHOUSE_REHEARSAL_DATABASE}.\`${entry.plan.table}\` AND ${CLICKHOUSE_REHEARSAL_DATABASE}.\`${shadow}\``,
      });
      await testOnlyPauseAfterForwardExchange();
    } catch {
      const state = await classifyExchangePair(input.client, input.runId, intent).catch(() => "AMBIGUOUS" as const);
      if (state === "AMBIGUOUS") {
        throw new ExternalRehearsalFailure(
          "CUTOVER_REHEARSAL_EXCHANGE_RECOVERY_AMBIGUOUS",
          "ClickHouse exchange outcome requires explicit restoration",
          true
        );
      }
      if (state === "RESTORED") throw new ExternalRehearsalFailure(
        "CUTOVER_REHEARSAL_CLICKHOUSE_COMMAND_FAILED",
        "disposable ClickHouse rehearsal operation failed"
      );
    }
    const activeColumns = await tableColumns(input.client, entry.plan.table);
    if (JSON.stringify(activeColumns) !== JSON.stringify(expectedTargetColumns(entry.plan, entry.columns))) {
      throw new ExternalRehearsalFailure(
        "CUTOVER_REHEARSAL_TARGET_SCHEMA_MISMATCH",
        "ClickHouse replacement schema mismatch"
      );
    }
    const active = await checksum(input.client, targetChecksumSql(entry.plan.table, activeColumns));
    if (active.sha256 !== entry.evidence.targetSha256) {
      throw new ExternalRehearsalFailure(
        "CUTOVER_REHEARSAL_EXCHANGE_VERIFICATION_FAILED",
        "ClickHouse rehearsal exchange verification failed"
      );
    }
    await input.ledger.evidence({
      domain: "CLICKHOUSE",
      action: "SWAP",
      outcome: "SUCCEEDED",
      resourceName: entry.plan.table,
      observedMetadata: { rowCount: active.rowCount, rowsSha256: active.sha256 },
    });
  }
  return staged.map((entry) => ({ ...entry.evidence, rollbackOutcome: "ROLLED_BACK" }));
}

interface MigratedAttachmentRow extends Record<string, unknown> {
  readonly metadata_row_id: string;
  readonly source_storage_key: string;
  readonly target_storage_key: string;
  readonly source_bytes: number;
  readonly target_bytes: number;
}

export type OpaqueObjectHeadOutcome =
  | { readonly outcome: "MATCH"; readonly observedByteLength: string }
  | { readonly outcome: "MISMATCH"; readonly observedByteLength?: string }
  | { readonly outcome: "MISSING" }
  | { readonly outcome: "INDETERMINATE" };

export async function reconcileOpaqueObjectHead(input: {
  readonly client: { send(command: HeadObjectCommand): Promise<{ ContentLength?: number }> };
  readonly bucket: string;
  readonly objectKey: string;
  readonly expectedByteLength: string;
}): Promise<OpaqueObjectHeadOutcome> {
  try {
    const head = await input.client.send(new HeadObjectCommand({
      Bucket: input.bucket,
      // Object keys are opaque identifiers. Never decode, normalize, split, or rebuild them.
      Key: input.objectKey,
    }));
    if (typeof head.ContentLength !== "number" || !Number.isSafeInteger(head.ContentLength) || head.ContentLength < 0) {
      return { outcome: "INDETERMINATE" };
    }
    const observedByteLength = String(head.ContentLength);
    return observedByteLength === input.expectedByteLength
      ? { outcome: "MATCH", observedByteLength }
      : { outcome: "MISMATCH", observedByteLength };
  } catch (error) {
    const status = typeof error === "object" && error !== null && "$metadata" in error
      ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
      : undefined;
    return status === 404 ? { outcome: "MISSING" } : { outcome: "INDETERMINATE" };
  }
}

async function reconcileObjects(input: {
  readonly targetDatabase: CutoverDatabase;
  readonly s3: S3Client;
  readonly bucket: string;
  readonly ledger: RehearsalLedger;
}): Promise<ObjectReconciliationReportEvidence[]> {
  const rows = await input.targetDatabase.query<MigratedAttachmentRow>(`
    SELECT target.id::text AS metadata_row_id,
           source."storageKey" AS source_storage_key,
           target."storageKey" AS target_storage_key,
           source.bytes AS source_bytes,
           target.bytes AS target_bytes
      FROM public."MessageAttachment" target
      JOIN cutover_legacy.cutover_id_map mapping
        ON mapping.mapping_version = 1
       AND mapping.source_model = 'PlatosMessageAttachment'
       AND mapping.target_model = 'MessageAttachment'
       AND mapping.target_id = target.id
      JOIN cutover_legacy."PlatosMessageAttachment" source ON source.id = mapping.source_id
     ORDER BY source.id COLLATE "C"`);
  const evidence: ObjectReconciliationReportEvidence[] = [];
  for (const row of rows.rows) {
    const sourceObjectKeySha256 = objectKeySha256(row.source_storage_key);
    const targetObjectKeySha256 = objectKeySha256(row.target_storage_key);
    const expectedByteLength = String(row.target_bytes);
    let outcome: "MATCH" | "MISMATCH" | "MISSING" | "INDETERMINATE";
    let observedByteLength: string | undefined;
    if (row.source_storage_key !== row.target_storage_key || row.source_bytes !== row.target_bytes) {
      outcome = "MISMATCH";
    } else {
      const head = await reconcileOpaqueObjectHead({
        client: input.s3,
        bucket: input.bucket,
        objectKey: row.target_storage_key,
        expectedByteLength,
      });
      outcome = head.outcome;
      observedByteLength = "observedByteLength" in head ? head.observedByteLength : undefined;
    }
    await input.ledger.object({
      metadataRowId: row.metadata_row_id,
      outcome,
      sourceObjectKeySha256,
      targetObjectKeySha256,
      expectedByteLength,
      observedByteLength,
    });
    if (outcome !== "MATCH" || observedByteLength === undefined) {
      throw new ExternalRehearsalFailure(
        `CUTOVER_REHEARSAL_OBJECT_${outcome}`,
        `object-store rehearsal reconciliation outcome was ${outcome}`
      );
    }
    evidence.push({
      metadataModel: "MessageAttachment",
      metadataRowIdSha256: createHash("sha256").update(row.metadata_row_id, "utf8").digest("hex"),
      outcome,
      sourceObjectKeySha256,
      targetObjectKeySha256,
      expectedByteLength,
      observedByteLength,
    });
  }
  await input.ledger.evidence({
    domain: "OBJECT_STORE",
    action: "RECONCILE",
    outcome: "MATCH",
    expectedMetadata: { objectCount: String(rows.rows.length) },
    observedMetadata: { objectCount: String(evidence.length) },
  });
  return evidence;
}

async function inverseExchanges(input: {
  readonly client: ClickHouseClient;
  readonly ledger: RehearsalLedger;
  readonly runId: string;
  readonly exchangeIntents: ReadonlyMap<string, DurableExchangeIntent>;
  readonly executorUsername: string;
}): Promise<void> {
  for (const table of [...input.exchangeIntents.keys()].reverse()) {
    const shadow = clickHouseRunScopedIdentifier(table, "shadow", input.runId);
    const expected = input.exchangeIntents.get(table)!;
    let state = await classifyExchangePair(input.client, input.runId, expected).catch(() => "AMBIGUOUS" as const);
    if (state === "AMBIGUOUS") {
      throw new ExternalRehearsalFailure(
        "CUTOVER_REHEARSAL_INVERSE_EXCHANGE_RECOVERY_AMBIGUOUS",
        "ClickHouse inverse exchange outcome requires explicit restoration",
        true
      );
    }
    await input.ledger.evidence({
      domain: "CLICKHOUSE",
      action: "ROLLBACK",
      outcome: "STARTED",
      resourceName: table,
      expectedMetadata: {
        rowCount: expected.original.rowCount,
        rowsSha256: expected.original.rowsSha256,
        contentSha256: expected.original.schemaSha256,
      },
      observedMetadata: {
        rowCount: expected.replacement.rowCount,
        rowsSha256: expected.replacement.rowsSha256,
        contentSha256: expected.replacement.schemaSha256,
      },
    });
    if (state === "SWAPPED") {
      try {
        await maintenanceCommand({
          client: input.client,
          ledger: input.ledger,
          operationId: input.runId,
          executorUsername: input.executorUsername,
          resourceName: table,
          query: `EXCHANGE TABLES ${CLICKHOUSE_REHEARSAL_DATABASE}.\`${table}\` AND ${CLICKHOUSE_REHEARSAL_DATABASE}.\`${shadow}\``,
        });
      } catch {
        // A lost response is resolved only through catalog/schema/checksum proof.
      }
      state = await classifyExchangePair(input.client, input.runId, expected).catch(() => "AMBIGUOUS" as const);
    }
    if (state !== "RESTORED") throw new ExternalRehearsalFailure(
      "CUTOVER_REHEARSAL_INVERSE_EXCHANGE_VERIFICATION_FAILED",
      "ClickHouse inverse exchange restoration could not be proven",
      true
    );
    await input.ledger.evidence({
      domain: "CLICKHOUSE",
      action: "ROLLBACK",
      outcome: "ROLLED_BACK",
      resourceName: table,
      expectedMetadata: { rowCount: expected.original.rowCount, rowsSha256: expected.original.rowsSha256 },
      observedMetadata: { rowCount: expected.original.rowCount, rowsSha256: expected.original.rowsSha256 },
    });
  }
}

async function proveAllRestored(input: {
  readonly client: ClickHouseClient;
  readonly runId: string;
  readonly exchangeIntents: ReadonlyMap<string, DurableExchangeIntent>;
}): Promise<void> {
  for (const intent of input.exchangeIntents.values()) {
    if (await classifyExchangePair(input.client, input.runId, intent) !== "RESTORED") {
      throw new ExternalRehearsalFailure(
        "CUTOVER_REHEARSAL_FINAL_WATERMARK_DRIFT",
        "ClickHouse restoration watermark proof failed",
        true
      );
    }
  }
}

async function cleanupClickHouse(
  client: ClickHouseClient,
  runId: string,
  exchangeIntents: ReadonlyMap<string, DurableExchangeIntent>
): Promise<void> {
  for (const plan of clickHousePhysicalRekeyPlan) {
    const shadow = clickHouseRunScopedIdentifier(plan.table, "shadow", runId);
    const intent = exchangeIntents.get(plan.table);
    if (!intent) continue;
    const state = await classifyExchangePair(client, runId, intent).catch(() => "AMBIGUOUS" as const);
    // A shadow is disposable only after both identities are proven and the
    // original is proven active. Unknown or swapped shadows are recovery data.
    if (state !== "RESTORED") continue;
    try {
      await client.command({ query: `DROP TABLE IF EXISTS ${CLICKHOUSE_REHEARSAL_DATABASE}.\`${shadow}\`` });
    } catch {
      // Rehearsal evidence already records the operational result; never mask it with endpoint detail.
    }
  }
  try {
    await client.command({
      query: `DROP TABLE IF EXISTS ${CLICKHOUSE_REHEARSAL_DATABASE}.\`${clickHouseMappingTableIdentifier(runId)}\``,
    });
  } catch {
    // Best-effort run-scoped cleanup only.
  }
}

export async function executeDisposableExternalRehearsal(input: {
  readonly runId: string;
  readonly targetDatabase: CutoverDatabase;
  readonly config: CutoverRehearsalConfig;
}): Promise<DisposableRehearsalExternalCutoverReportFragment> {
  if (
    input.config.enabled !== true ||
    input.config.targetKind !== "DISPOSABLE_REHEARSAL" ||
    input.config.proof !== REHEARSAL_PROOF
  ) {
    throw new ExternalRehearsalFailure(
      "CUTOVER_REHEARSAL_TARGET_KIND_INVALID",
      "external execution is restricted to disposable rehearsal targets"
    );
  }
  // Prove the PostgreSQL target before opening any external connection.
  const targetPostgresIdentity = await assertPostgresMarker(input.targetDatabase, input.config);

  const ledgerClient = new Client({
    connectionString: input.config.ledgerDatabaseUrl,
    application_name: "platos-cutover-disposable-rehearsal-ledger",
    connectionTimeoutMillis: 10_000,
  });
  const clickHouse = createClient({
    url: input.config.clickHouseUrl,
    username: input.config.clickHouseUsername,
    password: input.config.clickHousePassword,
    database: CLICKHOUSE_REHEARSAL_DATABASE,
  });
  const s3 = new S3Client({
    endpoint: input.config.s3Endpoint,
    region: input.config.s3Region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: input.config.s3AccessKeyId,
      secretAccessKey: input.config.s3SecretAccessKey,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const exchangeIntents = new Map<string, DurableExchangeIntent>();
  const operationId = input.config.operationId;
  let ledger: RehearsalLedger | undefined;
  let writerFenceApplied = false;
  let restorationProven = true;
  let operationInitialized = false;
  let runScopedRoleAuthorized = false;
  let writerGrants: readonly ClickHouseWriterGrant[] = [];
  let stage = "LEDGER_CONNECT";
  try {
    try {
      await ledgerClient.connect();
    } catch {
      throw new ExternalRehearsalFailure(
        "CUTOVER_REHEARSAL_LEDGER_UNAVAILABLE",
        "disposable rehearsal evidence ledger is unavailable"
      );
    }
    stage = "LEDGER_MARKER";
    const ledgerPostgresIdentity = await assertLedgerMarker(ledgerClient, input.config);
    if (
      targetPostgresIdentity.systemIdentifier === ledgerPostgresIdentity.systemIdentifier &&
      targetPostgresIdentity.databaseName === ledgerPostgresIdentity.databaseName
    ) {
      throw new ExternalRehearsalFailure(
        "CUTOVER_REHEARSAL_POSTGRES_IDENTITY_COLLISION",
        "target and evidence PostgreSQL databases must have distinct identities"
      );
    }
    ledger = new RehearsalLedger(ledgerClient, operationId, input.config.rehearsalInstanceId);
    await ledger.initialize(input.config.resume);
    operationInitialized = true;
    stage = "LEDGER_PLAN_SNAPSHOT";
    await ledger.snapshot("PLANNED");
    stage = "EXTERNAL_MARKERS";
    await Promise.all([
      assertClickHouseMarker(clickHouse, input.config),
      assertS3Marker(s3, input.config.s3Bucket, input.config),
    ]);
    await authorizeRunScopedWrites(
      clickHouse,
      operationId,
      input.config.clickHouseUsername,
      ledger,
      input.config.resume
    );
    runScopedRoleAuthorized = true;
    await ledger.evidence({
      domain: "CLICKHOUSE",
      action: "PLAN",
      outcome: "SUCCEEDED",
      expectedMetadata: { manifestSha256: clickHouseRekeyManifestSha256() },
      observedMetadata: { manifestSha256: clickHouseRekeyManifestSha256() },
    });
    stage = "WRITER_FENCE";
    const pending = await ledger.pendingExchangeIntents();
    const existingWriterPlan = await ledger.writerGrantPlan();
    if (existingWriterPlan.length > 0) writerGrants = existingWriterPlan;
    if (pending.length > 0) {
      restorationProven = false;
      for (const intent of pending) exchangeIntents.set(intent.table, intent);
    }
    let fenced = existingWriterPlan.length > 0
      ? await fenceClickHouseWritersForRecovery({
        client: clickHouse,
        runId: operationId,
        intents: pending,
        grants: existingWriterPlan,
        executorUsername: input.config.clickHouseUsername,
        onRevoked: () => { writerFenceApplied = true; },
      })
      : await fenceClickHouseWriters(
        clickHouse,
        ledger,
        input.config.clickHouseUsername,
        (grants) => {
          writerGrants = grants;
          writerFenceApplied = true;
        }
      );
    writerGrants = fenced.grants;
    const beforeFence = aggregateWatermarks(fenced.before);
    const afterFence = aggregateWatermarks(fenced.after);
    await ledger.snapshot("WRITERS_FENCED");
    await ledger.evidence({
      domain: "CLICKHOUSE",
      action: "FENCE_WRITERS",
      outcome: "SUCCEEDED",
      expectedMetadata: beforeFence,
      observedMetadata: afterFence,
    });
    if (pending.length > 0) {
      await ledger.snapshot("ROLLBACK_REQUIRED");
      await inverseExchanges({
        client: clickHouse,
        ledger,
        runId: operationId,
        exchangeIntents,
        executorUsername: input.config.clickHouseUsername,
      });
      await proveAllRestored({ client: clickHouse, runId: operationId, exchangeIntents });
      restorationProven = true;
      await ledger.snapshot("ROLLED_BACK");
      await cleanupClickHouse(clickHouse, operationId, exchangeIntents);
      exchangeIntents.clear();
      fenced = await captureFencedSourceWatermarks(clickHouse, writerGrants);
      const recoveredBeforeFence = aggregateWatermarks(fenced.before);
      const recoveredAfterFence = aggregateWatermarks(fenced.after);
      await ledger.snapshot("WRITERS_FENCED");
      await ledger.evidence({
        domain: "CLICKHOUSE",
        action: "FENCE_WRITERS",
        outcome: "SUCCEEDED",
        expectedMetadata: recoveredBeforeFence,
        observedMetadata: recoveredAfterFence,
      });
    }
    await ledger.snapshot("COPYING");
    stage = "MAPPING_LOAD";
    await loadMappings(
      input.targetDatabase,
      clickHouse,
      operationId,
      ledger,
      input.config.clickHouseUsername
    );
    stage = "CLICKHOUSE_TABLES";
    const clickHouseTables = await executeClickHouseTables({
      client: clickHouse,
      ledger,
      runId: operationId,
      exchangeIntents,
      sourceWatermarks: new Map(fenced.after.map((entry) => [entry.table, entry])),
      executorUsername: input.config.clickHouseUsername,
    });
    restorationProven = false;
    await ledger.snapshot("COPY_VERIFIED");
    await ledger.snapshot("SWAPPED");
    await ledger.snapshot("OBJECTS_RECONCILING");
    stage = "OBJECT_RECONCILIATION";
    const objectStoreObjects = await reconcileObjects({
      targetDatabase: input.targetDatabase,
      s3,
      bucket: input.config.s3Bucket,
      ledger,
    });
    await ledger.snapshot("VERIFIED");
    await ledger.snapshot("ROLLBACK_REQUIRED");
    stage = "INVERSE_EXCHANGE";
    await inverseExchanges({
      client: clickHouse,
      ledger,
      runId: operationId,
      exchangeIntents,
      executorUsername: input.config.clickHouseUsername,
    });
    await proveAllRestored({ client: clickHouse, runId: operationId, exchangeIntents });
    restorationProven = true;
    const report: DisposableRehearsalExternalCutoverReportFragment = {
      contractVersion: 1,
      implementation: "DISPOSABLE_REHEARSAL",
      targetKind: "DISPOSABLE_REHEARSAL",
      state: "ROLLED_BACK",
      manifestSha256: clickHouseRekeyManifestSha256(),
      clickHouseTables,
      objectStoreObjects,
    };
    stage = "LEDGER_FINAL_SNAPSHOT";
    await ledger.snapshot("ROLLED_BACK", report);
    return report;
  } catch (error) {
    let rolledBackAfterFailure = false;
    if (ledger && exchangeIntents.size > 0) {
      try {
        await ledger.snapshot("ROLLBACK_REQUIRED");
      } catch {
        // Restoration is mandatory even if the append-only ledger is unavailable.
      }
      try {
        await inverseExchanges({
          client: clickHouse,
          ledger,
          runId: operationId,
          exchangeIntents,
          executorUsername: input.config.clickHouseUsername,
        });
        await proveAllRestored({ client: clickHouse, runId: operationId, exchangeIntents });
        restorationProven = true;
        rolledBackAfterFailure = true;
        try {
          await ledger.snapshot("ROLLED_BACK");
        } catch {
          // Preserve the original closed failure after physical restoration.
        }
      } catch {
        restorationProven = false;
        throw new ExternalRehearsalFailure(
          "CUTOVER_REHEARSAL_INVERSE_EXCHANGE_FAILED",
          "disposable ClickHouse rehearsal inverse exchange requires explicit restoration",
          true
        );
      }
    }
    if (ledger && !rolledBackAfterFailure && exchangeIntents.size === 0) {
      try {
        await ledger.snapshot("FAILED");
      } catch {
        // Preserve the original closed failure; the ledger connection failure is not safe to expand.
      }
    }
    if (error instanceof ExternalRehearsalFailure) throw error;
    throw new ExternalRehearsalFailure(
      "CUTOVER_REHEARSAL_EXTERNAL_FAILED",
      `disposable external rehearsal failed during ${stage}`
    );
  } finally {
    let unfenceFailure: ExternalRehearsalFailure | undefined;
    if (writerFenceApplied && restorationProven) {
      await restoreClickHouseWriters(
        clickHouse,
        writerGrants,
        input.config.clickHouseUsername,
        operationId,
        ledger!
      ).catch((error) => {
        unfenceFailure = error instanceof ExternalRehearsalFailure
          ? error
          : new ExternalRehearsalFailure(
            "CUTOVER_REHEARSAL_WRITER_UNFENCE_FAILED",
            "exact ClickHouse writer grant restoration could not be proven",
            true
          );
      });
    }
    if (operationInitialized) await cleanupClickHouse(clickHouse, operationId, exchangeIntents);
    if (runScopedRoleAuthorized && ledger && !unfenceFailure) {
      await removeRunScopedWriterRole(
        clickHouse,
        operationId,
        input.config.clickHouseUsername,
        ledger!
      ).catch((error) => {
        unfenceFailure = error instanceof ExternalRehearsalFailure
          ? error
          : new ExternalRehearsalFailure(
            "CUTOVER_REHEARSAL_WRITER_UNFENCE_FAILED",
            "run-scoped ClickHouse writer authorization could not be removed",
            true
          );
      });
    }
    s3.destroy();
    await clickHouse.close().catch(() => undefined);
    await ledgerClient.end().catch(() => undefined);
    if (unfenceFailure) throw unfenceFailure;
  }
}

export function externalRehearsalFailureCheck(
  error: unknown
): { id: string; summary: string; restoreRequired: boolean } | undefined {
  return error instanceof ExternalRehearsalFailure
    ? { id: error.code, summary: error.message, restoreRequired: error.restoreRequired }
    : undefined;
}
