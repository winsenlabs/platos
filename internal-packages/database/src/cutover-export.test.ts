import { readFileSync, statSync } from "node:fs";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createCutoverExport,
  cutoverExportObjectManifest,
  CutoverExportError,
  ephemeralDispositionContracts,
  unsealCutoverExportPayload,
  type CutoverExportSourceSnapshot,
  type SealedCutoverExport,
} from "./cutover-export";
import { sourceFieldTransformationManifest } from "./source-field-manifest";

const runId = "9de469e9-1f9d-4fce-a82d-03b54935a2d2";
const keyHex = "42".repeat(32);
const secretToken = "tok_export_fixture_never_report_this";
const secretHash = "fixture-source-hash-never-report-this";

function completeRow(
  fields: readonly string[],
  values: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(fields.map((field) => [field, values[field] ?? null]));
}

function snapshots(reversed = false): readonly CutoverExportSourceSnapshot[] {
  const values = cutoverExportObjectManifest.flatMap<CutoverExportSourceSnapshot>((contract) => {
    if (contract.selection === "MIGRATION_HISTORY") return [];
    if (contract.selection === "COUNT_ONLY") {
      const rowCount =
        contract.sourceModel === "MfaBackupCode"
          ? 7n
          : contract.sourceModel === "RuntimeEnvironmentSession"
          ? "11"
          : 0;
      return [{ objectName: contract.objectName, rowCount }];
    }
    if (contract.selection === "MANIFEST_EXPORT_FIELDS") {
      const rows =
        contract.sourceModel === "Organization"
          ? [
              completeRow(contract.exportFields, {
                featureFlags: ["first"],
                onboardingData: { step: 1 },
              }),
              completeRow(contract.exportFields, {
                featureFlags: ["second"],
                onboardingData: { step: 2 },
              }),
            ]
          : [];
      return [{ objectName: contract.objectName, fields: contract.exportFields, rows }];
    }
    if (contract.sourceModel === "EnvironmentVariableValue") {
      return [
        {
          objectName: contract.objectName,
          fields: ["id", "keyHash", "value"],
          rows: [{ id: "env-value-1", keyHash: secretHash, value: secretToken }],
        },
      ];
    }
    return [{ objectName: contract.objectName, fields: ["fixtureField"], rows: [] }];
  });

  if (!reversed) return values;
  return values
    .map((snapshot) => ({
      ...snapshot,
      ...(snapshot.fields === undefined ? {} : { fields: [...snapshot.fields].reverse() }),
      ...(snapshot.rows === undefined
        ? {}
        : {
            rows: [...snapshot.rows]
              .reverse()
              .map((row) => Object.fromEntries(Object.entries(row).reverse())),
          }),
    }))
    .reverse();
}

function migrationHistory() {
  return [
    {
      id: "migration-1",
      migration_name: "001_initial",
      checksum: "a".repeat(64),
      started_at: "2026-08-16T23:59:59.000Z",
      finished_at: "2026-08-17T00:00:00.000Z",
      rolled_back_at: null,
      applied_steps_count: 1,
      logs: `${secretToken}:${secretHash}`,
    },
  ];
}

function dryRun(reversed = false) {
  return createCutoverExport({
    runId,
    mode: "DRY_RUN",
    sealingKey: { reference: "ops/win-123/export-key-v1", keyHex },
    sourceSnapshots: snapshots(reversed),
    migrationHistory: migrationHistory(),
  });
}

describe("WIN-123 cutover export foundations", () => {
  test("derives an exhaustive no-import plan from every disposition and EXPORT field", () => {
    expect(cutoverExportObjectManifest).toHaveLength(130);
    expect(new Set(cutoverExportObjectManifest.map((entry) => entry.objectName)).size).toBe(130);
    expect(
      cutoverExportObjectManifest
        .filter((entry) => entry.disposition === "EXPORT_DROP")
        .every((entry) =>
          entry.selection === "MIGRATION_HISTORY"
            ? entry.sql === 'SELECT * FROM cutover_legacy."_prisma_migrations"'
            : entry.selection === "ALL_SOURCE_FIELDS" && entry.sql.startsWith("SELECT * ")
        )
    ).toBe(true);
    expect(
      cutoverExportObjectManifest.filter((entry) => entry.disposition === "EPHEMERAL_DROP")
    ).toHaveLength(2);
    expect(ephemeralDispositionContracts.map((entry) => entry.sourceModel)).toEqual([
      "MfaBackupCode",
      "RuntimeEnvironmentSession",
    ]);

    const plannedUnsupportedFields = new Set(
      cutoverExportObjectManifest.flatMap((entry) =>
        entry.exportFields.map((field) => `${entry.sourceModel}.${field}`)
      )
    );
    const requiredUnsupportedFields = sourceFieldTransformationManifest
      .filter((entry) => entry.disposition === "EXPORT")
      .map((entry) => `${entry.sourceModel}.${entry.sourceField}`);
    expect(plannedUnsupportedFields).toEqual(new Set(requiredUnsupportedFields));
  });

  test("reports all classes, history/checksums and explicit ephemeral invalidation without secrets", () => {
    const result = dryRun();
    expect(result.artifactPath).toBeUndefined();
    expect(result.report.externalTriggerPolicy).toBe("NO_IMPORT_EXPORT_ONLY");
    expect(result.report.objects).toHaveLength(130);
    expect(
      result.report.objects.find((entry) => entry.sourceModel === "Organization")
    ).toMatchObject({
      disposition: "BACKFILL",
      handling: "BACKFILL_WITH_UNSUPPORTED_EXPORT",
      rowCount: "2",
    });
    expect(
      result.report.objects.find((entry) => entry.sourceModel === "EnvironmentVariableValue")
    ).toMatchObject({
      disposition: "EXPORT_DROP",
      handling: "SEALED_EXPORT_ONLY_NO_IMPORT",
      rowCount: "1",
    });
    expect(result.report.ephemeral).toEqual([
      expect.objectContaining({
        sourceModel: "MfaBackupCode",
        action: "INVALIDATE_MFA_BACKUP_CODES",
        rowCount: "7",
      }),
      expect.objectContaining({
        sourceModel: "RuntimeEnvironmentSession",
        action: "INVALIDATE_RUNTIME_ENVIRONMENT_SESSIONS",
        rowCount: "11",
      }),
    ]);
    expect(result.report.migrationHistory).toMatchObject({
      rowCount: "1",
      migrations: [{ migrationName: "001_initial", checksum: "a".repeat(64) }],
    });
    const serialized = JSON.stringify(result.report);
    expect(serialized).not.toContain(secretToken);
    expect(serialized).not.toContain(secretHash);
  });

  test("blocks a missing key, incomplete inventory and any omitted field-manifest EXPORT column", () => {
    expect(() =>
      createCutoverExport({
        runId,
        mode: "DRY_RUN",
        sealingKey: { reference: "ops/win-123/export-key-v1" },
        sourceSnapshots: snapshots(),
        migrationHistory: [],
      })
    ).toThrowError(expect.objectContaining({ code: "missing_export_key" }));

    expect(() =>
      createCutoverExport({
        runId,
        mode: "DRY_RUN",
        sealingKey: { reference: "ops/win-123/export-key-v1", keyHex },
        sourceSnapshots: snapshots().slice(1),
        migrationHistory: [],
      })
    ).toThrowError(expect.objectContaining({ code: "invalid_source_inventory" }));

    const omitted = snapshots().map((snapshot) =>
      snapshot.objectName === "Organization"
        ? {
            objectName: snapshot.objectName,
            fields: snapshot.fields!.filter((field) => field !== "featureFlags"),
            rows: snapshot.rows!.map(({ featureFlags: _omitted, ...row }) => row),
          }
        : snapshot
    );
    expect(() =>
      createCutoverExport({
        runId,
        mode: "DRY_RUN",
        sealingKey: { reference: "ops/win-123/export-key-v1", keyHex },
        sourceSnapshots: omitted,
        migrationHistory: [],
      })
    ).toThrowError(expect.objectContaining({ code: "invalid_source_fields" }));
  });

  test("uses canonical object, field and row ordering for deterministic checksums", () => {
    const first = dryRun(false).report;
    const reordered = dryRun(true).report;
    expect(reordered.payloadSha256).toBe(first.payloadSha256);
    expect(reordered.reportSha256).toBe(first.reportSha256);
    expect(reordered.objects).toEqual(first.objects);
  });

  test("dry-run writes nothing; WRITE creates a mode 0600 sealed artifact with no plaintext", async () => {
    const directory = await mkdtemp(join(tmpdir(), "platos-cutover-export-"));
    const dry = createCutoverExport({
      runId,
      mode: "DRY_RUN",
      sealingKey: { reference: "ops/win-123/export-key-v1", keyHex },
      sourceSnapshots: snapshots(),
      migrationHistory: migrationHistory(),
      outputDirectory: directory,
    });
    expect(dry.report.artifact.status).toBe("VALIDATED_NOT_WRITTEN");
    expect(await readdir(directory)).toEqual([]);

    const written = createCutoverExport({
      runId,
      mode: "WRITE",
      sealingKey: { reference: "ops/win-123/export-key-v1", keyHex },
      sourceSnapshots: snapshots(),
      migrationHistory: migrationHistory(),
      outputDirectory: directory,
    });
    expect(written.artifactPath).toBeTruthy();
    expect(statSync(written.artifactPath!).mode & 0o777).toBe(0o600);
    const artifact = readFileSync(written.artifactPath!, "utf8");
    expect(artifact).not.toContain(secretToken);
    expect(artifact).not.toContain(secretHash);
    const envelope = JSON.parse(artifact) as SealedCutoverExport;
    const plaintext = unsealCutoverExportPayload(envelope, Buffer.from(keyHex, "hex"));
    expect(plaintext.toString("utf8")).toContain(secretToken);
    expect(plaintext.toString("utf8")).toContain(secretHash);
    expect(written.report.payloadSha256).toBe(dry.report.payloadSha256);
  });

  test("safe failures do not serialize source or key material", () => {
    let error: unknown;
    try {
      createCutoverExport({
        runId,
        mode: "DRY_RUN",
        sealingKey: { reference: "ops/win-123/export-key-v1", keyHex: secretToken },
        sourceSnapshots: snapshots(),
        migrationHistory: [],
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CutoverExportError);
    expect(JSON.stringify(error)).toBe(
      JSON.stringify({ name: "CutoverExportError", code: "invalid_export_key" })
    );
    expect(String(error)).not.toContain(secretToken);
  });
});
