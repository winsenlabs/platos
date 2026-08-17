import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  ClickHouseContainer,
  type StartedClickHouseContainer,
} from "../../testcontainers/src/clickhouse";
import { MinIOContainer, type StartedMinIOContainer } from "../../testcontainers/src/minio";
import {
  canonicalExternalRowsSha256,
  clickHouseRunScopedIdentifier,
  createObjectRekeyEvidence,
  createStubExternalCutoverReportFragment,
  objectKeySha256,
  objectStoreRunPrefix,
  redactExternalEvidence,
  type CanonicalExternalRow,
  type ClickHouseTableRekeyEvidence,
  type ObjectRekeyEvidence,
} from "./cutover-external";
import { mapCutoverId } from "./cutover-id";

const runHarness = process.env.RUN_DATABASE_CUTOVER_EXTERNAL_HARNESS === "1";
const describeHarness = runHarness ? describe : describe.skip;
const RUN_ID = "03125bd3-8e2e-5500-8942-574db43e9203";
const DATABASE = "trigger_dev";
const SOURCE_TABLE = "errors_v1";
const SHADOW_TABLE = clickHouseRunScopedIdentifier(SOURCE_TABLE, "shadow", RUN_ID);
const MAPPING_TABLE = `cutover_uuid_map__win123_${RUN_ID.replaceAll("-", "")}`;
const BUCKET = "packets";
const execFileAsync = promisify(execFile);

const sourceRows = [
  {
    event_id: "evt-2",
    organization_id: "cllegacyorg0001",
    project_id: "cllegacyproject0001",
    environment_id: "cllegacyenv0001",
    payload: "second",
  },
  {
    event_id: "evt-1",
    organization_id: "cllegacyorg0001",
    project_id: "cllegacyproject0001",
    environment_id: "cllegacyenv0001",
    payload: "first",
  },
] as const;

const mappingInputs = [
  { source_model: "Organization", source_id: "cllegacyorg0001" },
  { source_model: "Project", source_id: "cllegacyproject0001" },
  { source_model: "RuntimeEnvironment", source_id: "cllegacyenv0001" },
] as const;

const targetRows = sourceRows.map((row) => ({
  event_id: row.event_id,
  organization_id: mapCutoverId({
    sourceModel: "Organization",
    sourceId: row.organization_id,
  }),
  project_id: mapCutoverId({ sourceModel: "Project", sourceId: row.project_id }),
  environment_id: mapCutoverId({
    sourceModel: "RuntimeEnvironment",
    sourceId: row.environment_id,
  }),
  payload: row.payload,
}));

const sourceSchema = [
  { name: "event_id", type: "String" },
  { name: "organization_id", type: "String" },
  { name: "project_id", type: "String" },
  { name: "environment_id", type: "String" },
  { name: "payload", type: "String" },
] as const;

const targetSchema = [
  { name: "event_id", type: "String" },
  { name: "organization_id", type: "UUID" },
  { name: "project_id", type: "UUID" },
  { name: "environment_id", type: "UUID" },
  { name: "payload", type: "String" },
] as const;

function canonicalRows(
  rows: readonly {
    event_id: string;
    organization_id: string;
    project_id: string;
    environment_id: string;
    payload: string;
  }[]
): readonly CanonicalExternalRow[] {
  return rows.map((row) =>
    Object.entries(row).map(([name, value]) => ({
      name,
      value: { type: "UTF8" as const, value },
    }))
  );
}

async function clickHouseRequest(
  container: StartedClickHouseContainer,
  query: string
): Promise<string> {
  const url = new URL(container.getHttpUrl());
  url.searchParams.set("database", DATABASE);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(
        `${container.getUsername()}:${container.getPassword()}`
      ).toString("base64")}`,
      "content-type": "text/plain; charset=utf-8",
    },
    body: query,
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`local ClickHouse fixture command failed with status ${response.status}`);
  }
  return body;
}

async function clickHouseRows<T>(
  container: StartedClickHouseContainer,
  query: string
): Promise<readonly T[]> {
  const body = await clickHouseRequest(container, `${query}\nFORMAT JSONEachRow`);
  return body
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function insertJsonRows(
  container: StartedClickHouseContainer,
  table: string,
  rows: readonly Record<string, unknown>[]
): Promise<void> {
  await clickHouseRequest(
    container,
    `INSERT INTO ${DATABASE}.${table} FORMAT JSONEachRow\n${rows
      .map((row) => JSON.stringify(row))
      .join("\n")}`
  );
}

async function resetClickHouseFixture(container: StartedClickHouseContainer): Promise<void> {
  for (const table of [SHADOW_TABLE, SOURCE_TABLE, MAPPING_TABLE]) {
    await clickHouseRequest(container, `DROP TABLE IF EXISTS ${DATABASE}.${table}`);
  }
  await clickHouseRequest(
    container,
    `CREATE TABLE ${DATABASE}.${SOURCE_TABLE}
     (
       event_id String,
       organization_id String,
       project_id String,
       environment_id String,
       payload String
     ) ENGINE = MergeTree ORDER BY event_id`
  );
  await clickHouseRequest(
    container,
    `CREATE TABLE ${DATABASE}.${SHADOW_TABLE}
     (
       event_id String,
       organization_id UUID,
       project_id UUID,
       environment_id UUID,
       payload String
     ) ENGINE = MergeTree ORDER BY event_id`
  );
  await clickHouseRequest(
    container,
    `CREATE TABLE ${DATABASE}.${MAPPING_TABLE}
     (
       mapping_version UInt16,
       source_model LowCardinality(String),
       source_id String,
       target_id UUID
     ) ENGINE = MergeTree ORDER BY (source_model, source_id)`
  );
  await insertJsonRows(container, SOURCE_TABLE, sourceRows);
}

async function loadDeterministicMappings(
  container: StartedClickHouseContainer,
  inputs: readonly { readonly source_model: string; readonly source_id: string }[]
): Promise<void> {
  await insertJsonRows(
    container,
    MAPPING_TABLE,
    inputs.map((input) => ({
      mapping_version: 1,
      source_model: input.source_model,
      source_id: input.source_id,
      target_id: mapCutoverId({ sourceModel: input.source_model, sourceId: input.source_id }),
    }))
  );
}

async function assertNoMissingMappings(container: StartedClickHouseContainer): Promise<void> {
  const rows = await clickHouseRows<{ missing_count: string }>(
    container,
    `SELECT count() AS missing_count
       FROM
       (
         SELECT organization_id AS source_id, 'Organization' AS source_model
           FROM ${DATABASE}.${SOURCE_TABLE}
         UNION ALL
         SELECT project_id AS source_id, 'Project' AS source_model
           FROM ${DATABASE}.${SOURCE_TABLE}
         UNION ALL
         SELECT environment_id AS source_id, 'RuntimeEnvironment' AS source_model
           FROM ${DATABASE}.${SOURCE_TABLE}
       ) AS reference
       LEFT JOIN ${DATABASE}.${MAPPING_TABLE} AS mapping
         ON mapping.mapping_version = 1
        AND mapping.source_model = reference.source_model
        AND mapping.source_id = reference.source_id
      WHERE mapping.source_id = ''`
  );
  if (rows[0]?.missing_count !== "0") {
    throw new Error("ClickHouse cutover blocked: required deterministic mapping is missing");
  }
}

async function copyToShadow(container: StartedClickHouseContainer): Promise<void> {
  await assertNoMissingMappings(container);
  await clickHouseRequest(
    container,
    `INSERT INTO ${DATABASE}.${SHADOW_TABLE}
     SELECT
       source.event_id,
       organization.target_id,
       project.target_id,
       environment.target_id,
       source.payload
       FROM ${DATABASE}.${SOURCE_TABLE} AS source
       INNER JOIN ${DATABASE}.${MAPPING_TABLE} AS organization
         ON organization.mapping_version = 1
        AND organization.source_model = 'Organization'
        AND organization.source_id = source.organization_id
       INNER JOIN ${DATABASE}.${MAPPING_TABLE} AS project
         ON project.mapping_version = 1
        AND project.source_model = 'Project'
        AND project.source_id = source.project_id
       INNER JOIN ${DATABASE}.${MAPPING_TABLE} AS environment
         ON environment.mapping_version = 1
        AND environment.source_model = 'RuntimeEnvironment'
        AND environment.source_id = source.environment_id`
  );
}

async function tableSchema(
  container: StartedClickHouseContainer,
  table: string
): Promise<readonly { name: string; type: string }[]> {
  return clickHouseRows(
    container,
    `SELECT name, type
       FROM system.columns
      WHERE database = '${DATABASE}' AND table = '${table}'
      ORDER BY position`
  );
}

async function tableCount(container: StartedClickHouseContainer, table: string): Promise<string> {
  const rows = await clickHouseRows<{ row_count: string }>(
    container,
    `SELECT count() AS row_count FROM ${DATABASE}.${table}`
  );
  return rows[0]!.row_count;
}

async function tableChecksum(
  container: StartedClickHouseContainer,
  table: string
): Promise<string> {
  const rows = await clickHouseRows<{
    event_id: string;
    organization_id: string;
    project_id: string;
    environment_id: string;
    payload: string;
  }>(
    container,
    `SELECT event_id, organization_id, project_id, environment_id, payload
       FROM ${DATABASE}.${table}`
  );
  return canonicalExternalRowsSha256(canonicalRows(rows));
}

async function validateAndExchange(input: {
  readonly container: StartedClickHouseContainer;
  readonly expectedSourceSha256: string;
  readonly expectedTargetSha256: string;
}): Promise<ClickHouseTableRekeyEvidence> {
  const [actualSourceSchema, actualTargetSchema, sourceRowCount, targetRowCount] =
    await Promise.all([
      tableSchema(input.container, SOURCE_TABLE),
      tableSchema(input.container, SHADOW_TABLE),
      tableCount(input.container, SOURCE_TABLE),
      tableCount(input.container, SHADOW_TABLE),
    ]);
  if (
    JSON.stringify(actualSourceSchema) !== JSON.stringify(sourceSchema) ||
    JSON.stringify(actualTargetSchema) !== JSON.stringify(targetSchema)
  ) {
    throw new Error("ClickHouse cutover blocked: replacement schema mismatch");
  }
  if (sourceRowCount !== targetRowCount) {
    throw new Error("ClickHouse cutover blocked: replacement row count mismatch");
  }

  const [sourceSha256, targetSha256] = await Promise.all([
    tableChecksum(input.container, SOURCE_TABLE),
    tableChecksum(input.container, SHADOW_TABLE),
  ]);
  if (sourceSha256 !== input.expectedSourceSha256 || targetSha256 !== input.expectedTargetSha256) {
    throw new Error("ClickHouse cutover blocked: replacement checksum mismatch");
  }

  await clickHouseRequest(
    input.container,
    `EXCHANGE TABLES ${DATABASE}.${SOURCE_TABLE} AND ${DATABASE}.${SHADOW_TABLE}`
  );
  return {
    table: SOURCE_TABLE,
    sourceSchemaSha256: "1".repeat(64),
    sourceRowCount,
    targetRowCount,
    sourceSha256,
    targetSha256,
    identitySha256: targetSha256,
    payloadSha256: targetSha256,
    rollbackOutcome: "ROLLED_BACK",
  };
}

type ObjectHeadOutcome =
  | { readonly status: "MATCH"; readonly evidence: ObjectRekeyEvidence }
  | { readonly status: "MISSING"; readonly targetObjectKeySha256: string }
  | {
      readonly status: "MISMATCH";
      readonly targetObjectKeySha256: string;
      readonly expectedByteLength: string;
      readonly actualByteLength: string;
    }
  | {
      readonly status: "INDETERMINATE";
      readonly targetObjectKeySha256: string;
      readonly reason: "HEAD_UNAVAILABLE" | "HEAD_METADATA_INVALID";
    };

function exactObjectUrl(baseUrl: string, bucket: string, objectKey: string): string {
  const encodedKey = objectKey
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${baseUrl}/${encodeURIComponent(bucket)}/${encodedKey}`;
}

async function verifyExactObjectHead(input: {
  readonly baseUrl: string;
  readonly bucket: string;
  readonly sourceObjectKey: string;
  readonly targetObjectKey: string;
  readonly expectedByteLength: bigint;
}): Promise<ObjectHeadOutcome> {
  const targetObjectKeySha256 = objectKeySha256(input.targetObjectKey);
  let response: Response;
  try {
    response = await fetch(exactObjectUrl(input.baseUrl, input.bucket, input.targetObjectKey), {
      method: "HEAD",
    });
  } catch {
    return { status: "INDETERMINATE", targetObjectKeySha256, reason: "HEAD_UNAVAILABLE" };
  }
  if (response.status === 404) return { status: "MISSING", targetObjectKeySha256 };
  if (!response.ok) {
    return { status: "INDETERMINATE", targetObjectKeySha256, reason: "HEAD_UNAVAILABLE" };
  }

  const rawByteLength = response.headers.get("content-length");
  if (rawByteLength === null || !/^(?:0|[1-9][0-9]*)$/.test(rawByteLength)) {
    return { status: "INDETERMINATE", targetObjectKeySha256, reason: "HEAD_METADATA_INVALID" };
  }
  const actualByteLength = BigInt(rawByteLength);
  if (actualByteLength !== input.expectedByteLength) {
    return {
      status: "MISMATCH",
      targetObjectKeySha256,
      expectedByteLength: input.expectedByteLength.toString(10),
      actualByteLength: actualByteLength.toString(10),
    };
  }
  return {
    status: "MATCH",
    evidence: createObjectRekeyEvidence({
      sourceObjectKey: input.sourceObjectKey,
      targetObjectKey: input.targetObjectKey,
      byteLength: actualByteLength,
    }),
  };
}

async function preparePublicMinioObject(
  container: StartedMinIOContainer,
  objectKey: string,
  contents: Buffer
): Promise<void> {
  const encoded = contents.toString("base64");
  try {
    await execFileAsync("docker", [
      "exec",
      container.getId(),
      "sh",
      "-c",
      `printf '%s' '${encoded}' | base64 -d > /tmp/win123-external-fixture`,
    ]);
    await execFileAsync("docker", [
      "exec",
      container.getId(),
      "mc",
      "cp",
      "/tmp/win123-external-fixture",
      `local/${BUCKET}/${objectKey}`,
    ]);
    await execFileAsync("docker", [
      "exec",
      container.getId(),
      "mc",
      "anonymous",
      "set",
      "download",
      `local/${BUCKET}`,
    ]);
  } catch {
    throw new Error("local MinIO fixture setup failed");
  }
}

describeHarness("external cutover contract Testcontainers harness", () => {
  let clickhouse: StartedClickHouseContainer;
  let minio: StartedMinIOContainer;

  beforeAll(async () => {
    [clickhouse, minio] = await Promise.all([
      new ClickHouseContainer().withDatabase(DATABASE).start(),
      new MinIOContainer().start(),
    ]);
  }, 180_000);

  afterAll(async () => {
    await Promise.all([clickhouse?.stop(), minio?.stop()]);
  });

  test("blocks incomplete evidence, validates an Atomic UUID shadow, and swaps and rolls back", async () => {
    await resetClickHouseFixture(clickhouse);
    const database = await clickHouseRows<{ engine: string }>(
      clickhouse,
      `SELECT engine FROM system.databases WHERE name = '${DATABASE}'`
    );
    expect(database).toEqual([{ engine: "Atomic" }]);

    await loadDeterministicMappings(clickhouse, mappingInputs.slice(0, -1));
    await expect(copyToShadow(clickhouse)).rejects.toThrow(
      "required deterministic mapping is missing"
    );
    expect(await tableCount(clickhouse, SHADOW_TABLE)).toBe("0");

    await clickHouseRequest(clickhouse, `TRUNCATE TABLE ${DATABASE}.${MAPPING_TABLE}`);
    await loadDeterministicMappings(clickhouse, [...mappingInputs].reverse());
    const loadedMappings = await clickHouseRows<{
      mapping_version: number;
      source_model: string;
      source_id: string;
      target_id: string;
    }>(
      clickhouse,
      `SELECT mapping_version, source_model, source_id, toString(target_id) AS target_id
         FROM ${DATABASE}.${MAPPING_TABLE}
        ORDER BY source_model, source_id`
    );
    expect(loadedMappings).toEqual(
      mappingInputs
        .map((input) => ({
          mapping_version: 1,
          source_model: input.source_model,
          source_id: input.source_id,
          target_id: mapCutoverId({ sourceModel: input.source_model, sourceId: input.source_id }),
        }))
        .sort((left, right) =>
          Buffer.compare(Buffer.from(left.source_model), Buffer.from(right.source_model))
        )
    );

    await copyToShadow(clickhouse);
    const expectedSourceSha256 = canonicalExternalRowsSha256(canonicalRows(sourceRows));
    const expectedTargetSha256 = canonicalExternalRowsSha256(canonicalRows(targetRows));
    await expect(
      validateAndExchange({
        container: clickhouse,
        expectedSourceSha256,
        expectedTargetSha256: "0".repeat(64),
      })
    ).rejects.toThrow("replacement checksum mismatch");
    expect(await tableSchema(clickhouse, SOURCE_TABLE)).toEqual(sourceSchema);

    const evidence = await validateAndExchange({
      container: clickhouse,
      expectedSourceSha256,
      expectedTargetSha256,
    });
    expect(evidence).toEqual({
      table: SOURCE_TABLE,
      sourceSchemaSha256: "1".repeat(64),
      sourceRowCount: "2",
      targetRowCount: "2",
      sourceSha256: expectedSourceSha256,
      targetSha256: expectedTargetSha256,
      identitySha256: expectedTargetSha256,
      payloadSha256: expectedTargetSha256,
      rollbackOutcome: "ROLLED_BACK",
    });
    expect(await tableSchema(clickhouse, SOURCE_TABLE)).toEqual(targetSchema);
    expect(await tableChecksum(clickhouse, SOURCE_TABLE)).toBe(expectedTargetSha256);

    await clickHouseRequest(
      clickhouse,
      `EXCHANGE TABLES ${DATABASE}.${SOURCE_TABLE} AND ${DATABASE}.${SHADOW_TABLE}`
    );
    expect(await tableSchema(clickhouse, SOURCE_TABLE)).toEqual(sourceSchema);
    expect(await tableChecksum(clickhouse, SOURCE_TABLE)).toBe(expectedSourceSha256);
  }, 120_000);

  test("uses opaque exact-key HEAD checks and emits only redacted report diagnostics", async () => {
    const contents = Buffer.from("opaque-minio-fixture\u0000bytes", "utf8");
    const sourceObjectKey = "legacy/raw tenant/source + café.bin";
    const targetObjectKey = `${objectStoreRunPrefix(RUN_ID)}opaque/tenant%2Fscope/file + café.bin`;
    const lookalikeObjectKey = targetObjectKey.replace("tenant%2Fscope", "tenant/scope");
    await preparePublicMinioObject(minio, targetObjectKey, contents);

    const match = await verifyExactObjectHead({
      baseUrl: minio.getBaseUrl(),
      bucket: BUCKET,
      sourceObjectKey,
      targetObjectKey,
      expectedByteLength: BigInt(contents.byteLength),
    });
    expect(match).toEqual({
      status: "MATCH",
      evidence: createObjectRekeyEvidence({
        sourceObjectKey,
        targetObjectKey,
        byteLength: BigInt(contents.byteLength),
      }),
    });
    expect(
      await verifyExactObjectHead({
        baseUrl: minio.getBaseUrl(),
        bucket: BUCKET,
        sourceObjectKey,
        targetObjectKey: lookalikeObjectKey,
        expectedByteLength: BigInt(contents.byteLength),
      })
    ).toMatchObject({ status: "MISSING" });
    expect(
      await verifyExactObjectHead({
        baseUrl: minio.getBaseUrl(),
        bucket: BUCKET,
        sourceObjectKey,
        targetObjectKey,
        expectedByteLength: BigInt(contents.byteLength + 1),
      })
    ).toMatchObject({
      status: "MISMATCH",
      expectedByteLength: String(contents.byteLength + 1),
      actualByteLength: String(contents.byteLength),
    });
    expect(
      await verifyExactObjectHead({
        baseUrl: "http://127.0.0.1:1",
        bucket: BUCKET,
        sourceObjectKey,
        targetObjectKey,
        expectedByteLength: BigInt(contents.byteLength),
      })
    ).toMatchObject({ status: "INDETERMINATE", reason: "HEAD_UNAVAILABLE" });

    const redacted = redactExternalEvidence({
      endpoint: minio.getBaseUrl(),
      sourceObjectKey,
      targetObjectKey,
      accessKeyId: minio.getAccessKeyId(),
      secretAccessKey: minio.getSecretAccessKey(),
      authorization: `Basic ${minio.getAccessKeyId()}:${minio.getSecretAccessKey()}`,
      outcome: match,
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain(sourceObjectKey);
    expect(serialized).not.toContain(targetObjectKey);
    expect(serialized).not.toContain(minio.getBaseUrl());
    expect(serialized).not.toContain(minio.getAccessKeyId());
    expect(serialized).not.toContain(minio.getSecretAccessKey());
    expect(serialized).toContain(objectKeySha256(sourceObjectKey));
    expect(serialized).toContain(objectKeySha256(targetObjectKey));

    expect(createStubExternalCutoverReportFragment()).toMatchObject({
      implementation: "STUB",
      state: "STUB_BLOCKED",
      clickHouseTables: [],
      objectStoreObjects: [],
    });
  }, 120_000);
});
