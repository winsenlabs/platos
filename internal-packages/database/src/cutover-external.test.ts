import { describe, expect, test } from "vitest";
import {
  assertValidClickHouseRekeyManifest,
  clickHouseRekeyManifest,
  clickHouseRekeyManifestSha256,
  currentClickHouseRekeyCatalog,
} from "./cutover-external-manifest";
import {
  assertClickHouseRunScopedIdentifier,
  assertExternalCutoverReportFragment,
  assertExternalPhaseTransition,
  canonicalExternalRowsSha256,
  clickHouseRunScopedIdentifier,
  createObjectRekeyEvidence,
  createStubExternalCutoverReportFragment,
  objectStoreRunPrefix,
  redactExternalEvidence,
  serializeCanonicalExternalRow,
  type CanonicalExternalRow,
  type DisposableRehearsalExternalCutoverReportFragment,
} from "./cutover-external";
import {
  clickHousePhysicalRekeyPlan,
  copyProjectionSql,
  mappingPreflightSql,
  sourceChecksumSql,
  targetDdlSql,
} from "./cutover-external-physical-plan";
import {
  assertStableClickHouseWatermarks,
  ExternalRehearsalFailure,
  externalRehearsalFailureCheck,
  reconcileOpaqueObjectHead,
} from "./cutover-external-executor";
import { serializeCutoverReport } from "./cutover-report";

const RUN_ID = "03125bd3-8e2e-5500-8942-574db43e9203";

describe("external cutover manifest", () => {
  test("maps every affected current physical ClickHouse table and column exactly once", () => {
    expect(() => assertValidClickHouseRekeyManifest(clickHouseRekeyManifest)).not.toThrow();
    expect(Object.keys(currentClickHouseRekeyCatalog)).toEqual([
      "error_occurrences_v1",
      "errors_v1",
      "llm_metrics_v1",
      "metrics_v1",
      "platos_spans_v1",
      "task_event_usage_by_hour_v1",
      "task_event_usage_by_minute_v1",
      "task_events_search_v1",
      "task_events_v1",
      "task_events_v2",
      "task_runs_v1",
      "task_runs_v2",
    ]);
    expect(clickHouseRekeyManifest.tables).toHaveLength(12);
    expect(clickHouseRekeyManifestSha256()).toBe(
      "b197643697635e462b3a4748de0e88e8b23131b7e260aae73b07448cf798e768"
    );
    expect(currentClickHouseRekeyCatalog.platos_spans_v1).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column: "attrs", jsonPath: "platos.org.id" }),
        expect.objectContaining({ column: "attrs", jsonPath: "platos.thread.id" }),
      ])
    );
  });

  test("blocks unknown tables, unknown columns, omissions, and aliases", () => {
    const unknownTable = structuredClone(clickHouseRekeyManifest) as unknown as {
      tables: Array<{ table: string }>;
    };
    unknownTable.tables[0]!.table = "errors_alias";
    expect(() => assertValidClickHouseRekeyManifest(unknownTable)).toThrow("unknown or duplicate table");

    const unknownColumn = structuredClone(clickHouseRekeyManifest) as unknown as {
      tables: Array<{ mappings: Array<{ column: string }> }>;
    };
    unknownColumn.tables[0]!.mappings[0]!.column = "unknown_column";
    expect(() => assertValidClickHouseRekeyManifest(unknownColumn)).toThrow(
      "unknown or duplicate column mapping"
    );

    const missingMapping = structuredClone(clickHouseRekeyManifest) as unknown as {
      tables: Array<{ mappings: unknown[] }>;
    };
    missingMapping.tables[0]!.mappings.pop();
    expect(() => assertValidClickHouseRekeyManifest(missingMapping)).toThrow(
      "missing a required column mapping"
    );

    const aliasField = structuredClone(clickHouseRekeyManifest) as unknown as Record<string, unknown>;
    aliasField.tableAliases = {};
    expect(() => assertValidClickHouseRekeyManifest(aliasField)).toThrow("unknown or missing fields");
  });
});

describe("disposable ClickHouse physical plan", () => {
  test("pins every manifest table to a closed source fingerprint and UUID shadow DDL", () => {
    expect(clickHousePhysicalRekeyPlan).toHaveLength(12);
    expect(clickHousePhysicalRekeyPlan.map((entry) => [entry.table, entry.sourceSchemaSha256]))
      .toEqual([
        ["error_occurrences_v1", "107f13fcbee1239773e64165cf882aac4f5c47b9fc333a983bd0aba635d8980e"],
        ["errors_v1", "2937ab0216bf5d15daad55ff70291e714cbfb63147bf6c36cbecbcd35cfca346"],
        ["llm_metrics_v1", "119458b26e2a510c8558ac85e982a17a11cbe32772b79df931ccf782597565e6"],
        ["metrics_v1", "fb7f2e13de71f53a578598375a2b9366571ef7bd1f81ed70658cd2ca31a30d71"],
        ["platos_spans_v1", "d3eb8f1b29ee807b5ad1bc6fc8b2e1b797cf98e418614453ece07548987912b8"],
        ["task_event_usage_by_hour_v1", "3bcf32b307530790c870507355f213a310752486ba4ca9bb52d82cf10595718e"],
        ["task_event_usage_by_minute_v1", "9941584a5441b7300c9996af725e8e81744951dacbd9abdff4441e7639f8dcbd"],
        ["task_events_search_v1", "824733ca8d288a5f587d642ea7238debcfc60cdcb059bd757b59ec36b52a283c"],
        ["task_events_v1", "1c589bab007c191745e76d9f94a0c23785f3b00eb96fdaabf89b2f21fd8953d8"],
        ["task_events_v2", "90f59dd214be3e5f46cb59c5fe12a512cb199715597fab1f967e19fe6b4cb1cf"],
        ["task_runs_v1", "e4eeb00a428db5d7c7f8856688793bb39632fd0c81c9466162ed49b6b975968d"],
        ["task_runs_v2", "73da10f61dee9c5c02ea8cec9a67367cc2f2afb6b421a44e17023a7e2595af47"],
    ]);
    const errors = clickHousePhysicalRekeyPlan.find((entry) => entry.table === "errors_v1")!;
    const targetDdl = targetDdlSql(
      errors,
      RUN_ID,
      "CREATE TABLE trigger_dev.errors_v1\n(\n  `organization_id` LowCardinality(String),\n  `project_id` String,\n  `environment_id` String,\n  `payload` String\n)\nENGINE = MergeTree\nORDER BY organization_id",
      [
        { name: "organization_id", type: "LowCardinality(String)", defaultKind: "", defaultExpression: "" },
        { name: "project_id", type: "String", defaultKind: "", defaultExpression: "" },
        { name: "environment_id", type: "String", defaultKind: "", defaultExpression: "" },
        { name: "payload", type: "String", defaultKind: "", defaultExpression: "" },
      ]
    );
    expect(targetDdl).toContain("CREATE TABLE `trigger_dev`.`errors_v1__win123_shadow_");
    expect(targetDdl).toContain("`organization_id` UUID");
    expect(targetDdl).toContain("`project_id` UUID");
    expect(targetDdl).toContain("`environment_id` UUID");
    const aggregateChecksum = sourceChecksumSql(errors, RUN_ID, [
      { name: "occurrence_count", type: "AggregateFunction(sum, UInt64)", defaultKind: "", defaultExpression: "" },
    ], false);
    expect(aggregateChecksum).toContain("finalizeAggregation(source.`occurrence_count`)");
    expect(aggregateChecksum).toContain("SHA256(toJSONString(tuple(");
    expect(aggregateChecksum).toContain("arraySort(groupArray(row_sha256))");
    expect(aggregateChecksum).not.toContain("groupBitXor");
    expect(aggregateChecksum).not.toContain("sumWithOverflow");
  });

  test("blocks missing mappings without dropping preserved-empty rows and patches dotted attrs keys", () => {
    const spans = clickHousePhysicalRekeyPlan.find((entry) => entry.table === "platos_spans_v1")!;
    const preflight = mappingPreflightSql(spans, RUN_ID);
    expect(preflight).toContain("LEFT ANTI JOIN");
    const copy = copyProjectionSql(spans, RUN_ID, [
      { name: "agent_id", type: "String", defaultKind: "", defaultExpression: "" },
      { name: "attrs", type: "String", defaultKind: "", defaultExpression: "" },
      { name: "environment_id", type: "String", defaultKind: "", defaultExpression: "" },
      { name: "materialized", type: "String", defaultKind: "MATERIALIZED", defaultExpression: "x" },
    ]);
    expect(copy).toContain("LEFT JOIN");
    expect(copy).toContain("INNER JOIN");
    expect(copy).toContain("if(toString(source.`agent_id`) = '', '', toString(mapping_0.target_id))");
    expect(copy).toContain("'platos.agent.id'");
    expect(copy).toContain("'platos.thread.id'");
    expect(copy).not.toContain("`materialized`");
  });
});

describe("canonical external checksums", () => {
  const first: CanonicalExternalRow = [
    { name: "target_id", value: { type: "UTF8", value: "uuid-a" } },
    { name: "source_id", value: { type: "UTF8", value: "legacy-a" } },
    { name: "row_count", value: { type: "UINT64", value: "2" } },
  ];
  const second: CanonicalExternalRow = [
    { name: "source_id", value: { type: "UTF8", value: "legacy-b" } },
    { name: "target_id", value: { type: "UTF8", value: "uuid-b" } },
    { name: "row_count", value: { type: "UINT64", value: "1" } },
  ];

  test("uses typed length prefixes and canonical order independent of input order", () => {
    const reorderedFirst: CanonicalExternalRow = [first[2]!, first[1]!, first[0]!];
    const left = canonicalExternalRowsSha256([first, second]);
    const right = canonicalExternalRowsSha256([second, reorderedFirst]);
    expect(left).toBe(right);
    expect(left).toBe("21ffb535398f57115225f4855323af35d70c5be9a285effb40921d2dbb4c4cca");
    expect(serializeCanonicalExternalRow(first).subarray(0, 1).toString("ascii")).toBe("R");
  });

  test("keeps value types and duplicate multiplicity in the digest", () => {
    const stringCount: CanonicalExternalRow = [
      { name: "row_count", value: { type: "UTF8", value: "2" } },
    ];
    const integerCount: CanonicalExternalRow = [
      { name: "row_count", value: { type: "UINT64", value: "2" } },
    ];
    expect(canonicalExternalRowsSha256([stringCount])).not.toBe(
      canonicalExternalRowsSha256([integerCount])
    );
    expect(canonicalExternalRowsSha256([first])).not.toBe(
      canonicalExternalRowsSha256([first, first])
    );
    expect(() =>
      serializeCanonicalExternalRow([
        { name: "id", value: { type: "UTF8", value: "a" } },
        { name: "id", value: { type: "UTF8", value: "b" } },
      ])
    ).toThrow("duplicate field");
  });

  test("blocks a writer watermark drift instead of claiming a fence", () => {
    const before = [{ table: "errors_v1", rowCount: "2", rowsSha256: "1".repeat(64) }];
    expect(() => assertStableClickHouseWatermarks(before, before)).not.toThrow();
    expect(() => assertStableClickHouseWatermarks(before, [
      { table: "errors_v1", rowCount: "3", rowsSha256: "2".repeat(64) },
    ])).toThrow("ingestion changed while the writer fence was being established");
  });
});

describe("external identifiers, evidence, and report safety", () => {
  test("uses the exact opaque S3 key and closes MATCH, MISMATCH, MISSING, and INDETERMINATE outcomes", async () => {
    const objectKey = "raw/%2F slash/space + café/tenant%2Fscope";
    const requests: Array<{ Bucket?: string; Key?: string }> = [];
    const client = (result: unknown) => ({
      async send(command: { input: { Bucket?: string; Key?: string } }) {
        requests.push(command.input);
        if (result instanceof Error || (result && typeof result === "object" && "$metadata" in result)) {
          throw result;
        }
        return result as { ContentLength?: number };
      },
    });
    await expect(reconcileOpaqueObjectHead({
      client: client({ ContentLength: 7 }),
      bucket: "rehearsal-bucket",
      objectKey,
      expectedByteLength: "7",
    })).resolves.toEqual({ outcome: "MATCH", observedByteLength: "7" });
    expect(requests[0]).toEqual({ Bucket: "rehearsal-bucket", Key: objectKey });
    expect(requests[0]?.Key).not.toBe(objectKey.replace("tenant%2Fscope", "tenant/scope"));
    await expect(reconcileOpaqueObjectHead({
      client: client({ ContentLength: 8 }), bucket: "b", objectKey, expectedByteLength: "7",
    })).resolves.toEqual({ outcome: "MISMATCH", observedByteLength: "8" });
    await expect(reconcileOpaqueObjectHead({
      client: client({ $metadata: { httpStatusCode: 404 } }), bucket: "b", objectKey, expectedByteLength: "7",
    })).resolves.toEqual({ outcome: "MISSING" });
    await expect(reconcileOpaqueObjectHead({
      client: client({ $metadata: { httpStatusCode: 403 } }), bucket: "b", objectKey, expectedByteLength: "7",
    })).resolves.toEqual({ outcome: "INDETERMINATE" });
    await expect(reconcileOpaqueObjectHead({
      client: client(new Error("transport unavailable")), bucket: "b", objectKey, expectedByteLength: "7",
    })).resolves.toEqual({ outcome: "INDETERMINATE" });
    await expect(reconcileOpaqueObjectHead({
      client: client({}), bucket: "b", objectKey, expectedByteLength: "7",
    })).resolves.toEqual({ outcome: "INDETERMINATE" });
  });

  test("requires canonical run scope for temporary ClickHouse and object-store names", () => {
    const identifier = clickHouseRunScopedIdentifier("platos_spans_v1", "shadow", RUN_ID);
    expect(identifier).toBe(
      "platos_spans_v1__win123_shadow_03125bd38e2e55008942574db43e9203"
    );
    expect(() =>
      assertClickHouseRunScopedIdentifier(identifier, "platos_spans_v1", "shadow", RUN_ID)
    ).not.toThrow();
    expect(() =>
      assertClickHouseRunScopedIdentifier(
        "platos_spans_v1__win123_shadow_other",
        "platos_spans_v1",
        "shadow",
        RUN_ID
      )
    ).toThrow("not scoped");
    expect(() => clickHouseRunScopedIdentifier("unknown", "shadow", RUN_ID)).toThrow(
      "unknown ClickHouse table"
    );
    expect(() => objectStoreRunPrefix("../../escape")).toThrow("canonical lower-case UUID");
  });

  test("hashes raw object keys and redacts credentials from evidence", () => {
    const sourceKey = "legacy-org/legacy-project/legacy-env/raw-file.txt";
    const targetKey = "new-org/new-project/new-env/raw-file.txt";
    const evidence = createObjectRekeyEvidence({
      sourceObjectKey: sourceKey,
      targetObjectKey: targetKey,
      byteLength: 42n,
    });
    expect(evidence).toMatchObject({
      sourceObjectKeySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      targetObjectKeySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      byteLength: "42",
    });
    expect(JSON.stringify(evidence)).not.toContain(sourceKey);
    expect(JSON.stringify(evidence)).not.toContain(targetKey);

    const credential = "sentinel-clickhouse-password";
    const redacted = redactExternalEvidence({
      sourceObjectKey: sourceKey,
      clickHousePassword: credential,
      nested: { authorization: `Basic ${credential}` },
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain(sourceKey);
    expect(serialized).not.toContain(credential);
    expect(serialized).toContain("sourceObjectKeySha256");
    expect(serialized).toContain("[REDACTED]");
  });

  test("integrates a validated secret-free STUB fragment into the cutover report", () => {
    const external = createStubExternalCutoverReportFragment();
    expect(() => assertExternalCutoverReportFragment(external)).not.toThrow();
    const output = serializeCutoverReport({
      reportVersion: 1,
      runId: RUN_ID,
      mappingVersion: 1,
      mappingNamespace: "75803f94-05d5-5eb3-b37d-65774e2aaa6c",
      mode: "DRY_RUN",
      state: "INCOMPLETE_IMPLEMENTATION",
      startedAt: "2026-08-17T00:00:00.000Z",
      finishedAt: "2026-08-17T00:00:01.000Z",
      checks: [],
      phases: [],
      sourceDigests: [],
      external,
      incompletePhaseIds: [],
    });
    expect(JSON.parse(output).external).toMatchObject({
      implementation: "STUB",
      state: "STUB_BLOCKED",
      clickHouseTables: [],
      objectStoreObjects: [],
    });

    const credentialBearing = {
      ...external,
      clickHousePassword: "sentinel-password",
    };
    expect(() => assertExternalCutoverReportFragment(credentialBearing)).toThrow(
      "unknown or missing fields"
    );
    expect(() =>
      assertExternalCutoverReportFragment({
        ...external,
        implementation: "IMPLEMENTED",
        state: "COMPLETED",
      })
    ).toThrow("external cutover report fragment is invalid");
  });

  test("accepts only complete rolled-back disposable rehearsal evidence", () => {
    const digest = "1".repeat(64);
    const report: DisposableRehearsalExternalCutoverReportFragment = {
      contractVersion: 1,
      implementation: "DISPOSABLE_REHEARSAL",
      targetKind: "DISPOSABLE_REHEARSAL",
      state: "ROLLED_BACK",
      manifestSha256: clickHouseRekeyManifestSha256(),
      clickHouseTables: clickHousePhysicalRekeyPlan.map((entry) => ({
        table: entry.table,
        sourceSchemaSha256: entry.sourceSchemaSha256,
        sourceRowCount: "1",
        targetRowCount: "1",
        sourceSha256: digest,
        targetSha256: digest,
        identitySha256: digest,
        payloadSha256: digest,
        rollbackOutcome: "ROLLED_BACK",
      })),
      objectStoreObjects: [{
        metadataModel: "MessageAttachment",
        metadataRowIdSha256: digest,
        outcome: "MATCH",
        sourceObjectKeySha256: digest,
        targetObjectKeySha256: digest,
        expectedByteLength: "42",
        observedByteLength: "42",
      }],
    };
    expect(() => assertExternalCutoverReportFragment(report)).not.toThrow();
    expect(() => assertExternalCutoverReportFragment({
      ...report,
      clickHouseTables: report.clickHouseTables.slice(1),
    })).toThrow("must cover every ClickHouse table");
    expect(() => assertExternalCutoverReportFragment({
      ...report,
      clickHouseTables: [...report.clickHouseTables.slice(0, -1), report.clickHouseTables[0]],
    })).toThrow("ClickHouse report evidence is invalid");
    expect(() => assertExternalCutoverReportFragment({
      ...report,
      objectStoreObjects: [{ ...report.objectStoreObjects[0], outcome: "MISSING" }],
    })).toThrow("object-store rehearsal report evidence is invalid");

    const serialized = JSON.stringify(report);
    for (const raw of ["postgresql://", "http://", "password", "bucket", "opaque/key"]) {
      expect(serialized).not.toContain(raw);
    }
  });
});

describe("external phase state machine", () => {
  test("accepts only explicit forward and recovery transitions", () => {
    expect(() =>
      assertExternalPhaseTransition({ runId: RUN_ID, from: "PLANNED", to: "WRITERS_FENCED" })
    ).not.toThrow();
    expect(() =>
      assertExternalPhaseTransition({
        runId: RUN_ID,
        from: "ROLLBACK_REQUIRED",
        to: "ROLLED_BACK",
      })
    ).not.toThrow();
    expect(() =>
      assertExternalPhaseTransition({ runId: RUN_ID, from: "PLANNED", to: "SWAPPED" })
    ).toThrow("not allowed");
    expect(() =>
      assertExternalPhaseTransition({
        runId: RUN_ID,
        from: "STUB_BLOCKED",
        to: "PLANNED",
      })
    ).toThrow("not allowed");
    expect(() =>
      assertExternalPhaseTransition({ runId: RUN_ID, from: "SWAPPED", to: "FAILED" })
    ).toThrow("not allowed");
  });

  test("preserves unresolved external recovery as RESTORE_REQUIRED engine evidence", () => {
    expect(externalRehearsalFailureCheck(new ExternalRehearsalFailure(
      "CUTOVER_REHEARSAL_EXCHANGE_RECOVERY_AMBIGUOUS",
      "restore is required",
      true
    ))).toEqual({
      id: "CUTOVER_REHEARSAL_EXCHANGE_RECOVERY_AMBIGUOUS",
      summary: "restore is required",
      restoreRequired: true,
    });
  });
});
