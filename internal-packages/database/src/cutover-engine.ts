import { randomUUID, createHash } from "node:crypto";
import { resolve } from "node:path";
import pg from "pg";
import {
  appendCutoverJournal,
  backfillCoreTenancy,
  createCleanCatalog,
  createCutoverJournal,
  exportTransactionArtifacts,
  materializeCutoverIdMap,
  moveLegacyCatalogToTemporarySchema,
  validateCoreTenancyBackfill,
} from "./cutover-backfill";
import { compareApplicationCatalogs, readApplicationCatalog } from "./cutover-catalog";
import { CUTOVER_ID_MAPPING_VERSION, CUTOVER_ID_NAMESPACE } from "./cutover-id";
import { incompleteCutoverPhaseIds } from "./cutover-phases";
import { CUTOVER_ADVISORY_LOCK, runCutoverPreflight } from "./cutover-preflight";
import { writeCutoverReport, writeJsonExport } from "./cutover-report";
import type {
  CutoverOptions,
  CutoverPhaseResult,
  CutoverReport,
  CutoverState,
} from "./cutover-types";
import { CutoverFailure } from "./cutover-types";

const { Client } = pg;

function phase(
  phaseName: string,
  status: CutoverPhaseResult["status"],
  summary: string,
  startedAt?: string
): CutoverPhaseResult {
  return {
    phase: phaseName,
    status,
    summary,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

export async function runCutover(
  options: CutoverOptions,
  packageRoot = resolve(__dirname, "..")
): Promise<CutoverReport> {
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  const phases: CutoverPhaseResult[] = [];
  const database = new Client({
    connectionString: options.databaseUrl,
    application_name: "platos-cutover-engine",
    connectionTimeoutMillis: 10_000,
  });
  await database.connect();

  let checks = [] as Awaited<ReturnType<typeof runCutoverPreflight>>["checks"];
  let sourceDigests = [] as Awaited<ReturnType<typeof runCutoverPreflight>>["sourceDigests"];
  let state: CutoverState = "PREFLIGHT_BLOCKED";
  let transactionOpen = false;
  let rolledBackAfterExecutionFailure = false;

  try {
    await database.query("SET statement_timeout = '60s'");
    await database.query("SET lock_timeout = '5s'");
    await database.query("SET idle_in_transaction_session_timeout = '5min'");

    if (options.mode === "DRY_RUN") {
      const preflight = await runCutoverPreflight(database, options, packageRoot);
      checks = preflight.checks;
      sourceDigests = preflight.sourceDigests;
      state = preflight.checks.some((entry) => entry.status === "BLOCK")
        ? "PREFLIGHT_BLOCKED"
        : "INCOMPLETE_IMPLEMENTATION";
      phases.push(phase("read-only-preflight", state === "PREFLIGHT_BLOCKED" ? "BLOCKED" : "SUCCEEDED", "read-only preflight completed"));
    } else {
      const lock = await database.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1, $2) AS acquired",
        [...CUTOVER_ADVISORY_LOCK]
      );
      if (lock.rows[0]?.acquired !== true) {
        throw new CutoverFailure("ADVISORY_LOCK_UNAVAILABLE", "cutover advisory lock is unavailable");
      }
      const preflight = await runCutoverPreflight(database, options, packageRoot, true);
      checks = preflight.checks;
      sourceDigests = preflight.sourceDigests;
      if (!preflight.readyForRequestedMode) {
        state = options.mode === "FULL_EXECUTE" && !checks.some((entry) => entry.status === "BLOCK")
          ? "INCOMPLETE_IMPLEMENTATION"
          : "PREFLIGHT_BLOCKED";
        phases.push(phase("read-only-preflight", "BLOCKED", "mutation preflight failed closed"));
      } else {
        if (options.mode !== "CORE_REHEARSAL_ROLLBACK") {
          throw new CutoverFailure(
            "INCOMPLETE_DOMAIN_PHASES",
            "full cutover cannot execute while domain phases are incomplete"
          );
        }
        if (!options.freshCatalogDatabaseUrl) {
          throw new CutoverFailure(
            "FRESH_CATALOG_REQUIRED",
            "core rehearsal requires a fresh clean catalog comparison database"
          );
        }
        if (!options.exportDirectory || !options.reportDirectory) {
          throw new CutoverFailure(
            "ARTIFACT_DIRECTORIES_REQUIRED",
            "core rehearsal requires explicit export and report directories"
          );
        }
        phases.push(phase("read-only-preflight", "SUCCEEDED", "mutation preflight passed"));
        await database.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        transactionOpen = true;

        const moveStarted = new Date().toISOString();
        await moveLegacyCatalogToTemporarySchema(database);
        await createCutoverJournal(database, runId);
        await appendCutoverJournal(database, runId, "move-legacy-catalog", "SUCCEEDED", {
          inventoryContract: "legacyPhysicalTableDispositionLedger",
        });
        phases.push(phase("move-legacy-catalog", "SUCCEEDED", "legacy catalog moved to cutover_legacy", moveStarted));
        failIfRequested(options, "move-legacy-catalog");

        const createStarted = new Date().toISOString();
        await createCleanCatalog(database, packageRoot);
        await appendCutoverJournal(database, runId, "create-clean-catalog", "SUCCEEDED", {});
        phases.push(phase("create-clean-catalog", "SUCCEEDED", "clean migrations applied transactionally", createStarted));
        failIfRequested(options, "create-clean-catalog");

        const mapStarted = new Date().toISOString();
        const mappingCount = await materializeCutoverIdMap(database);
        await appendCutoverJournal(database, runId, "materialize-id-map", "SUCCEEDED", { mappingCount });
        phases.push(phase("materialize-id-map", "SUCCEEDED", `${mappingCount} deterministic UUID mappings materialized`, mapStarted));
        failIfRequested(options, "materialize-id-map");

        const backfillStarted = new Date().toISOString();
        await backfillCoreTenancy(database);
        await validateCoreTenancyBackfill(database);
        await appendCutoverJournal(database, runId, "core-tenancy-auth", "SUCCEEDED", {});
        phases.push(phase("core-tenancy-auth", "SUCCEEDED", "core tenancy/auth backfill and conservation checks passed", backfillStarted));
        failIfRequested(options, "core-tenancy-auth");

        const reference = new Client({
          connectionString: options.freshCatalogDatabaseUrl,
          application_name: "platos-cutover-fresh-catalog-reference",
          connectionTimeoutMillis: 10_000,
        });
        await reference.connect();
        try {
          const comparison = compareApplicationCatalogs(
            await readApplicationCatalog(database),
            await readApplicationCatalog(reference)
          );
          if (!comparison.equal) {
            throw new CutoverFailure(
              "APPLICATION_CATALOG_MISMATCH",
              `application catalog parity failed (${comparison.missing.length} missing, ${comparison.unexpected.length} unexpected)`
            );
          }
          await appendCutoverJournal(database, runId, "application-catalog-parity", "SUCCEEDED", {
            digest: comparison.actualDigest,
          });
          phases.push(phase("application-catalog-parity", "SUCCEEDED", "catalog matches fresh clean database excluding migration history"));
        } finally {
          await reference.end();
        }
        failIfRequested(options, "application-catalog-parity");

        const artifacts = await exportTransactionArtifacts(database);
        writeJsonExport(options.exportDirectory, `cutover-id-map-${runId}.json`, artifacts.idMap);
        writeJsonExport(options.exportDirectory, `cutover-journal-${runId}.json`, artifacts.journal);
        writeJsonExport(
          options.exportDirectory,
          `legacy-history-${runId}.json`,
          preflight.legacyHistoryRows.map((row) => ({
            migrationName: row.migration_name,
            checksum: row.checksum,
            finishedAt: row.finished_at,
            rolledBackAt: row.rolled_back_at,
            appliedStepsCount: row.applied_steps_count,
            logsPresent: Boolean(row.logs),
            logsSha256: row.logs ? createHash("sha256").update(row.logs).digest("hex") : undefined,
          }))
        );
        phases.push(phase("export-rehearsal-artifacts", "SUCCEEDED", "secret-free mapping, journal, and history evidence exported"));

        await appendCutoverJournal(database, runId, "forced-pre-commit-rollback", "ROLLED_BACK", {
          reason: "core rehearsal cannot commit while domain phases are incomplete",
        });
        await database.query("ROLLBACK");
        transactionOpen = false;
        state = "ROLLED_BACK";
        phases.push(phase("forced-pre-commit-rollback", "ROLLED_BACK", "transaction rolled back by mandatory rehearsal contract"));
      }
    }
  } catch (error) {
    if (transactionOpen) {
      try {
        await database.query("ROLLBACK");
        phases.push(phase("transaction", "ROLLED_BACK", "pre-commit failure rolled back the transaction"));
        rolledBackAfterExecutionFailure = true;
      } finally {
        transactionOpen = false;
      }
    }
    state = error instanceof CutoverFailure && error.restoreRequired
      ? "RESTORE_REQUIRED"
      : rolledBackAfterExecutionFailure
        ? "ROLLED_BACK"
        : "PREFLIGHT_BLOCKED";
    checks = [
      ...checks,
      {
        id: error instanceof CutoverFailure ? error.code : "CUTOVER_EXECUTION_FAILED",
        status: "BLOCK" as const,
        summary: error instanceof Error ? error.message : "cutover execution failed",
      },
    ];
  } finally {
    try {
      await database.query("SELECT pg_advisory_unlock($1, $2)", [...CUTOVER_ADVISORY_LOCK]);
    } catch {
      // Connection close also releases the session lock.
    }
    await database.end();
  }

  const report: CutoverReport = {
    reportVersion: 1,
    runId,
    mappingVersion: CUTOVER_ID_MAPPING_VERSION,
    mappingNamespace: CUTOVER_ID_NAMESPACE,
    mode: options.mode,
    state,
    startedAt,
    finishedAt: new Date().toISOString(),
    checks,
    phases,
    sourceDigests,
    incompletePhaseIds: incompleteCutoverPhaseIds,
    backupAttestationRef: options.attestations.backupAttestationRef,
    backupRestoreTestRef: options.attestations.backupRestoreTestRef,
    writerFenceAttestationRef: options.attestations.writerFenceAttestationRef,
    capacityAttestationRef: options.attestations.capacityAttestationRef,
  };
  if (options.reportDirectory) writeCutoverReport(options.reportDirectory, report);
  return report;
}

function failIfRequested(options: CutoverOptions, phaseName: string): void {
  if (options.forcedFailurePhase === phaseName) {
    throw new CutoverFailure("FORCED_REHEARSAL_FAILURE", `forced rehearsal failure after ${phaseName}`);
  }
}
