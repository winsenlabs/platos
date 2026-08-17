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
} from "./cutover-external";
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
});

describe("external identifiers, evidence, and report safety", () => {
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
      incompletePhaseIds: ["external-analytics-object-rekey"],
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
});
