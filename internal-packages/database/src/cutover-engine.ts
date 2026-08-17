import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import {
  appendCutoverJournal,
  backfillCoreTenancy,
  countMaterializedCutoverMappings,
  createCleanCatalog,
  createCutoverJournal,
  exportTransactionArtifacts,
  materializeCutoverIdMap,
  moveLegacyCatalogToTemporarySchema,
  validateCoreTenancyBackfill,
} from "./cutover-backfill";
import { compareApplicationCatalogs, readApplicationCatalog } from "./cutover-catalog";
import { createStubExternalCutoverReportFragment } from "./cutover-external";
import {
  probeRetainedCredentialTargets,
  reencryptAndProbeRetainedCryptoTargets,
  type RetainedCredentialProbeEvidence,
  type RetainedCryptoCutoverEvidence,
} from "./cutover-crypto-probes";
import {
  collectCutoverExportSourceSnapshots,
  createCutoverExport,
  type CutoverExportReport,
} from "./cutover-export";
import {
  backfillRetainedAgentToolBatch1,
  validateRetainedAgentToolBatch1,
} from "./cutover-agent-tool-batch1";
import {
  backfillSupplementalAuthCutover,
  supplementalAuthSourceModels,
  validateSupplementalAuthCutover,
} from "./cutover-auth-supplemental";
import {
  backfillRetainedConversationBatch2,
  materializeBatch2MessageOrdinalMappings,
  retainedConversationBatch2SourceModels,
  validateRetainedConversationBatch2,
} from "./cutover-conversation-batch2";
import {
  backfillRetainedEvalJobSkillBatch7,
  retainedEvalJobSkillBatch7MappingTargets,
  retainedEvalJobSkillBatch7SourceModels,
} from "./cutover-eval-job-skill-batch7";
import {
  backfillRetainedMemoryBatch8,
  retainedMemoryBatch8DeferredTargetChecks,
  retainedMemoryBatch8MappingTargets,
  retainedMemoryBatch8SourceModels,
} from "./cutover-memory-batch8";
import {
  backfillRetainedChannelBatch5,
  materializeRetainedChannelBatch5Mappings,
  retainedChannelBatch5SourceModels,
} from "./cutover-channel-batch5";
import {
  backfillRetainedOperationalBatch6,
  retainedOperationalBatch6DeferredTargetChecks,
  retainedOperationalBatch6SourceModels,
} from "./cutover-operational-batch6";
import {
  backfillRetainedProviderOauthBatch4,
  materializeRetainedProviderOauthBatch4Mappings,
  retainedProviderOauthBatch4SourceModels,
} from "./cutover-provider-oauth-batch4";
import {
  backfillRetainedBatch3,
  materializeRetainedBatch3Checkpoint2Mappings,
  retainedBatch3SourceModels,
  validateRetainedBatch3,
} from "./cutover-retained-batch3";
import { CUTOVER_ID_MAPPING_VERSION, CUTOVER_ID_NAMESPACE } from "./cutover-id";
import {
  cutoverDomainPhases,
  implementedRetainedSourceCoverage,
  incompleteCutoverPhaseIds,
} from "./cutover-phases";
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
  startedAt?: string,
  evidence?: Readonly<Record<string, unknown>>
): CutoverPhaseResult {
  return {
    phase: phaseName,
    status,
    summary,
    startedAt,
    finishedAt: new Date().toISOString(),
    evidence,
  };
}

function incompletePhase(phaseName: string, summary: string): CutoverPhaseResult {
  return { phase: phaseName, status: "NOT_RUN", summary };
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
  let retainedCryptoEvidence: RetainedCryptoCutoverEvidence | undefined;
  let credentialProbeEvidence: RetainedCredentialProbeEvidence | undefined;
  let exportReport: CutoverExportReport | undefined;

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
        await database.query(
          readFileSync(
            resolve(
              packageRoot,
              "prisma/migrations/20260817030000_add_external_cutover_reconciliation/migration.sql"
            ),
            "utf8"
          )
        );
        await appendCutoverJournal(database, runId, "create-clean-catalog", "SUCCEEDED", {});
        phases.push(phase("create-clean-catalog", "SUCCEEDED", "clean migrations applied transactionally", createStarted));
        failIfRequested(options, "create-clean-catalog");

        const mapStarted = new Date().toISOString();
        await materializeCutoverIdMap(database);
        const messageOrdinalMappingCount = await materializeBatch2MessageOrdinalMappings(database);
        const retainedBatch3MappingCount =
          await materializeRetainedBatch3Checkpoint2Mappings(database);
        const retainedProviderOauthBatch4MappingCount =
          await materializeRetainedProviderOauthBatch4Mappings(database);
        const retainedChannelBatch5MappingCount =
          await materializeRetainedChannelBatch5Mappings(database);
        const retainedEvalJobSkillBatch7MappingCount =
          await countMaterializedCutoverMappings(
            database,
            retainedEvalJobSkillBatch7MappingTargets
          );
        const retainedMemoryBatch8MappingCount = await countMaterializedCutoverMappings(
          database,
          retainedMemoryBatch8MappingTargets
        );
        const mappingResult = await database.query<{ mapping_count: string }>(
          "SELECT count(*)::text AS mapping_count FROM cutover_legacy.cutover_id_map"
        );
        const mappingCount = Number(mappingResult.rows[0]?.mapping_count);
        if (!Number.isSafeInteger(mappingCount) || mappingCount < 0) {
          throw new CutoverFailure("ID_MAPPING_COUNT_INVALID", "materialized mapping count is invalid");
        }
        await appendCutoverJournal(database, runId, "materialize-id-map", "SUCCEEDED", {
          mappingCount,
          messageOrdinalMappingCount,
          retainedBatch3MappingCount,
          retainedProviderOauthBatch4MappingCount,
          retainedChannelBatch5MappingCount,
          retainedEvalJobSkillBatch7MappingCount,
          retainedMemoryBatch8MappingCount,
        });
        phases.push(phase("materialize-id-map", "SUCCEEDED", `${mappingCount} deterministic UUID mappings materialized`, mapStarted));
        failIfRequested(options, "materialize-id-map");

        const backfillStarted = new Date().toISOString();
        await backfillCoreTenancy(database);
        await validateCoreTenancyBackfill(database);
        await appendCutoverJournal(database, runId, "core-tenancy-auth", "SUCCEEDED", {});
        phases.push(phase("core-tenancy-auth", "SUCCEEDED", "core tenancy/auth backfill and conservation checks passed", backfillStarted));
        failIfRequested(options, "core-tenancy-auth");

        const supplementalAuthStarted = new Date().toISOString();
        const keyMaterial = requiredCutoverKeyMaterial(options);
        const supplementalAuthOptions = {
          cutoverAt: new Date(startedAt),
          legacyEncryptionKey: keyMaterial.legacyEncryptionKey,
          targetAuthEncryptionKey: keyMaterial.targetAuthEncryptionKey,
        };
        const supplementalEvidence = await backfillSupplementalAuthCutover(
          database,
          supplementalAuthOptions
        );
        await validateSupplementalAuthCutover(database, supplementalAuthOptions);
        await appendCutoverJournal(database, runId, "supplemental-auth-mfa", "SUCCEEDED", {
          sourceModels: supplementalAuthSourceModels,
          ...supplementalEvidence,
        });
        phases.push(
          phase(
            "supplemental-auth-mfa",
            "SUCCEEDED",
            "supplemental invitations, impersonation history, and MFA validations passed",
            supplementalAuthStarted
          )
        );
        failIfRequested(options, "supplemental-auth-mfa");

        const retainedBatchStarted = new Date().toISOString();
        await backfillRetainedAgentToolBatch1(database);
        await validateRetainedAgentToolBatch1(database);
        await appendCutoverJournal(database, runId, "retained-agent-tool-batch-1", "SUCCEEDED", {
          sourceModels: [
            "PlatosToolDefinition",
            "PlatosAgent",
            "PlatosAgentVersion",
            "PlatosAgentCluster",
          ],
        });
        phases.push(
          phase(
            "retained-agent-tool-batch-1",
            "SUCCEEDED",
            "retained Tool and Agent-domain backfill validations passed",
            retainedBatchStarted
          )
        );
        failIfRequested(options, "retained-agent-tool-batch-1");

        const conversationBatchStarted = new Date().toISOString();
        await backfillRetainedConversationBatch2(database, keyMaterial.messageEncryptionKeys);
        await validateRetainedConversationBatch2(database);
        await appendCutoverJournal(database, runId, "retained-conversation-batch-2", "SUCCEEDED", {
          sourceModels: retainedConversationBatch2SourceModels,
          finalMessageReEncryptionReadProbes: "DEFERRED_TO_POST_BATCH_GATE",
        });
        phases.push(
          phase(
            "retained-conversation-batch-2",
            "SUCCEEDED",
            "conversation Batch 2 source decoding and normalized backfill validations passed",
            conversationBatchStarted
          )
        );
        failIfRequested(options, "retained-conversation-batch-2");

        const retainedBatch3Started = new Date().toISOString();
        const retainedBatch3Evidence = await backfillRetainedBatch3(database, {
          legacyEncryptionKey: keyMaterial.legacyEncryptionKey,
          platosEncryptionKey: keyMaterial.targetAuthEncryptionKey,
          messageEncryptionKeys: keyMaterial.messageEncryptionKeys,
          credentialRootKeyRing: keyMaterial.credentialRootKeyRing,
        });
        await validateRetainedBatch3(database);
        await appendCutoverJournal(database, runId, "retained-entity-mcp-batch-3", "SUCCEEDED", {
          sourceModels: retainedBatch3SourceModels,
          ...retainedBatch3Evidence,
          cryptographicReadProbes: "DEFERRED_TO_POST_BATCH_GATE",
        });
        phases.push(
          phase(
            "retained-entity-mcp-batch-3",
            "SUCCEEDED",
            "entity and MCP Batch 3 normalized backfill validations passed",
            retainedBatch3Started
          )
        );
        failIfRequested(options, "retained-entity-mcp-batch-3");

        const retainedProviderOauthBatch4Started = new Date().toISOString();
        const retainedProviderOauthBatch4Evidence =
          await backfillRetainedProviderOauthBatch4(database, {
            legacyEncryptionKey: keyMaterial.legacyEncryptionKey,
            credentialRootKeyVersion: keyMaterial.credentialRootKeyRing.activeVersion,
            credentialRootKey: keyMaterial.credentialRootKeyRing.key(
              keyMaterial.credentialRootKeyRing.activeVersion
            ),
          });
        await appendCutoverJournal(
          database,
          runId,
          "retained-provider-oauth-batch-4",
          "SUCCEEDED",
          {
            sourceModels: retainedProviderOauthBatch4SourceModels,
            ...retainedProviderOauthBatch4Evidence,
            cryptographicReadProbes: "DEFERRED_TO_POST_BATCH_GATE",
          }
        );
        phases.push(
          phase(
            "retained-provider-oauth-batch-4",
            "SUCCEEDED",
            "provider and OAuth Batch 4 normalized backfill validations passed",
            retainedProviderOauthBatch4Started
          )
        );
        failIfRequested(options, "retained-provider-oauth-batch-4");

        const retainedChannelBatch5Started = new Date().toISOString();
        const retainedChannelBatch5Evidence = await backfillRetainedChannelBatch5(database, {
          messageEncryptionKeys: keyMaterial.messageEncryptionKeys,
          credentialRootKeyRing: keyMaterial.credentialRootKeyRing,
        });
        await appendCutoverJournal(database, runId, "retained-channel-batch-5", "SUCCEEDED", {
          sourceModels: retainedChannelBatch5SourceModels,
          ...retainedChannelBatch5Evidence,
          cryptographicReadProbes: "DEFERRED_TO_POST_BATCH_GATE",
        });
        phases.push(
          phase(
            "retained-channel-batch-5",
            "SUCCEEDED",
            "channel Batch 5 normalized backfill validations passed",
            retainedChannelBatch5Started
          )
        );
        failIfRequested(options, "retained-channel-batch-5");

        const retainedOperationalBatch6Started = new Date().toISOString();
        const retainedOperationalBatch6Evidence = await backfillRetainedOperationalBatch6(
          database,
          { messageEncryptionKeys: keyMaterial.messageEncryptionKeys }
        );
        await appendCutoverJournal(
          database,
          runId,
          "retained-operational-batch-6",
          "SUCCEEDED",
          {
            sourceModels: retainedOperationalBatch6SourceModels,
            ...retainedOperationalBatch6Evidence,
            retainedEncryptedRepresentations: retainedOperationalBatch6DeferredTargetChecks,
            finalTargetReEncryptionReadProbes: "DEFERRED_TO_POST_BATCH_GATE",
          }
        );
        phases.push(
          phase(
            "retained-operational-batch-6",
            "SUCCEEDED",
            "operational, audit, and governance Batch 6 retained-representation validations passed",
            retainedOperationalBatch6Started
          )
        );
        failIfRequested(options, "retained-operational-batch-6");

        const retainedEvalJobSkillBatch7Started = new Date().toISOString();
        const retainedEvalJobSkillBatch7Evidence =
          await backfillRetainedEvalJobSkillBatch7(database);
        await appendCutoverJournal(
          database,
          runId,
          "retained-eval-job-skill-batch-7",
          "SUCCEEDED",
          {
            sourceModels: retainedEvalJobSkillBatch7SourceModels,
            ...retainedEvalJobSkillBatch7Evidence,
          }
        );
        phases.push(
          phase(
            "retained-eval-job-skill-batch-7",
            "SUCCEEDED",
            "evaluation, job, skill, and macro Batch 7 backfill validations passed",
            retainedEvalJobSkillBatch7Started
          )
        );
        failIfRequested(options, "retained-eval-job-skill-batch-7");

        const retainedMemoryBatch8Started = new Date().toISOString();
        const retainedMemoryBatch8Evidence = await backfillRetainedMemoryBatch8(database, {
          messageEncryptionKeys: keyMaterial.messageEncryptionKeys,
        });
        await appendCutoverJournal(database, runId, "retained-memory-batch-8", "SUCCEEDED", {
          sourceModels: retainedMemoryBatch8SourceModels,
          ...retainedMemoryBatch8Evidence,
          retainedEncryptedRepresentations: retainedMemoryBatch8DeferredTargetChecks,
          finalTargetReEncryptionReadProbes: "DEFERRED_TO_POST_BATCH_GATE",
        });
        phases.push(
          phase(
            "retained-memory-batch-8",
            "SUCCEEDED",
            "memory Batch 8 retained-representation and graph validations passed",
            retainedMemoryBatch8Started
          )
        );
        failIfRequested(options, "retained-memory-batch-8");

        await appendCutoverJournal(
          database,
          runId,
          "remaining-retained-backfill",
          "SUCCEEDED",
          { ...implementedRetainedSourceCoverage }
        );
        phases.push(
          phase(
            "remaining-retained-backfill",
            "SUCCEEDED",
            "executable manifest coverage proved all retained row-level backfills are implemented"
          )
        );
        failIfRequested(options, "remaining-retained-backfill");

        const cryptoStarted = new Date().toISOString();
        retainedCryptoEvidence = await reencryptAndProbeRetainedCryptoTargets(database, {
          sourceMessageEncryptionKeys: keyMaterial.messageEncryptionKeys,
          targetMessageEncryptionKey: keyMaterial.targetMessageEncryptionKey,
          targetMessageEncryptionKeyVersion: keyMaterial.targetMessageEncryptionKeyVersion,
        });
        await appendCutoverJournal(
          database,
          runId,
          "final-message-re-encryption-read-probes",
          "SUCCEEDED",
          { ...retainedCryptoEvidence }
        );
        phases.push(
          phase(
            "final-message-re-encryption-read-probes",
            "SUCCEEDED",
            "retained message, audit, safety, memory, and graph fields were re-encrypted and read through the target contract",
            cryptoStarted,
            { ...retainedCryptoEvidence }
          )
        );
        failIfRequested(options, "final-message-re-encryption-read-probes");

        const credentialProbeStarted = new Date().toISOString();
        credentialProbeEvidence = await probeRetainedCredentialTargets(
          database,
          keyMaterial.credentialRootKeyRing
        );
        await appendCutoverJournal(database, runId, "cryptographic-read-probes", "SUCCEEDED", {
          ...credentialProbeEvidence,
          retainedFieldCount: Object.values(retainedCryptoEvidence.fieldCounts).reduce(
            (sum, count) => sum + count,
            0
          ),
        });
        phases.push(
          phase(
            "cryptographic-read-probes",
            "SUCCEEDED",
            "all mapped active credential envelopes and retained encrypted field families passed persisted target-reader probes",
            credentialProbeStarted,
            { ...credentialProbeEvidence }
          )
        );
        failIfRequested(options, "cryptographic-read-probes");

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

        const exportStarted = new Date().toISOString();
        const sourceSnapshots = await collectCutoverExportSourceSnapshots(database);
        const exportInput = {
          runId,
          sealingKey: {
            reference: options.exportKeyReference ?? "",
            keyHex: keyMaterial.exportSealingKeyHex,
          },
          sourceSnapshots,
          migrationHistory: preflight.legacyHistoryRows,
        } as const;
        const firstValidation = createCutoverExport({ ...exportInput, mode: "DRY_RUN" });
        const repeatedValidation = createCutoverExport({ ...exportInput, mode: "DRY_RUN" });
        if (
          firstValidation.report.payloadSha256 !== repeatedValidation.report.payloadSha256 ||
          firstValidation.report.reportSha256 !== repeatedValidation.report.reportSha256
        ) {
          throw new CutoverFailure(
            "CUTOVER_EXPORT_NONDETERMINISTIC",
            "sealed cutover export validation is not deterministic"
          );
        }
        if (options.exportDirectory) {
          const written = createCutoverExport({
            ...exportInput,
            mode: "WRITE",
            outputDirectory: options.exportDirectory,
          });
          if (written.report.payloadSha256 !== firstValidation.report.payloadSha256) {
            throw new CutoverFailure(
              "CUTOVER_EXPORT_WRITE_MISMATCH",
              "sealed cutover export artifact differs from the validated payload"
            );
          }
          exportReport = written.report;
        } else {
          exportReport = firstValidation.report;
        }
        const exportEvidence = {
          mode: exportReport.mode,
          keyReference: exportReport.keyReference,
          externalTriggerPolicy: exportReport.externalTriggerPolicy,
          payloadSha256: exportReport.payloadSha256,
          objectCount: exportReport.objects.length,
          exportOnlyObjectCount: exportReport.objects.filter(
            (entry) => entry.handling === "SEALED_EXPORT_ONLY_NO_IMPORT"
          ).length,
          migrationHistory: exportReport.migrationHistory,
          artifact: exportReport.artifact,
          reportSha256: exportReport.reportSha256,
        } as const;
        await appendCutoverJournal(database, runId, "unsupported-trigger-export", "SUCCEEDED", {
          ...exportEvidence,
        });
        phases.push(
          phase(
            "unsupported-trigger-export",
            "SUCCEEDED",
            "unsupported and Trigger-owned source data passed deterministic sealed export validation",
            exportStarted,
            { ...exportEvidence }
          )
        );
        failIfRequested(options, "unsupported-trigger-export");

        const ephemeralEvidence = {
          dispositions: exportReport.ephemeral,
          totalRowCount: exportReport.ephemeral
            .reduce((sum, entry) => sum + BigInt(entry.rowCount), 0n)
            .toString(10),
        } as const;
        await appendCutoverJournal(
          database,
          runId,
          "ephemeral-session-recovery-disposition",
          "SUCCEEDED",
          { ...ephemeralEvidence }
        );
        phases.push(
          phase(
            "ephemeral-session-recovery-disposition",
            "SUCCEEDED",
            "legacy MFA recovery codes and runtime environment sessions were counted for invalidation",
            exportStarted,
            { ...ephemeralEvidence }
          )
        );
        failIfRequested(options, "ephemeral-session-recovery-disposition");

        await appendCutoverJournal(database, runId, "forced-pre-commit-rollback", "ROLLED_BACK", {
          reason: "cutover rehearsal cannot commit while domain phases are incomplete",
          incompletePhaseIds: incompleteCutoverPhaseIds,
        });
        if (options.exportDirectory) {
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
          phases.push(phase("export-rehearsal-artifacts", "SUCCEEDED", "owner-only sealed export, mapping, journal, and history evidence exported"));
        } else {
          phases.push(phase("export-rehearsal-artifacts", "SUCCEEDED", "sealed export was validated without writing rehearsal artifacts"));
        }

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

  const reportedPhaseIds = new Set(phases.map((entry) => entry.phase));
  const incompletePhases = cutoverDomainPhases
    .filter((entry) => entry.implementation === "STUB" && !reportedPhaseIds.has(entry.id))
    .map((entry) => incompletePhase(entry.id, entry.summary));
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
    phases: [...phases, ...incompletePhases],
    sourceDigests,
    external: createStubExternalCutoverReportFragment(),
    cryptoEvidence:
      retainedCryptoEvidence && credentialProbeEvidence
        ? { retainedFields: retainedCryptoEvidence, credentials: credentialProbeEvidence }
        : undefined,
    exportReport,
    incompletePhaseIds: incompleteCutoverPhaseIds,
    backupAttestationRef: options.attestations.backupAttestationRef,
    backupRestoreTestRef: options.attestations.backupRestoreTestRef,
    writerFenceAttestationRef: options.attestations.writerFenceAttestationRef,
    capacityAttestationRef: options.attestations.capacityAttestationRef,
  };
  if (options.reportDirectory) writeCutoverReport(options.reportDirectory, report);
  return report;
}

function requiredCutoverKeyMaterial(options: CutoverOptions): {
  readonly legacyEncryptionKey: string;
  readonly targetAuthEncryptionKey: string;
  readonly messageEncryptionKeys: Readonly<Record<string, string>>;
  readonly targetMessageEncryptionKey: string;
  readonly targetMessageEncryptionKeyVersion: number;
  readonly credentialRootKeyRing: NonNullable<NonNullable<CutoverOptions["keyMaterial"]>["credentialRootKeyRing"]>;
  readonly exportSealingKeyHex: string;
} {
  const material = options.keyMaterial;
  if (
    !material?.legacyEncryptionKey ||
    !material.targetAuthEncryptionKey ||
    !material.messageEncryptionKeys ||
    Object.keys(material.messageEncryptionKeys).length === 0 ||
    !material.targetMessageEncryptionKey ||
    !Number.isSafeInteger(material.targetMessageEncryptionKeyVersion) ||
    material.targetMessageEncryptionKeyVersion! < 1 ||
    !material.credentialRootKeyRing ||
    !material.exportSealingKeyHex
  ) {
    throw new CutoverFailure(
      "CUTOVER_KEY_MATERIAL_REQUIRED",
      "implemented auth, conversation, entity, provider, channel, audit, memory, and sealed export phases require all declared cutover key domains"
    );
  }
  return {
    legacyEncryptionKey: material.legacyEncryptionKey,
    targetAuthEncryptionKey: material.targetAuthEncryptionKey,
    messageEncryptionKeys: material.messageEncryptionKeys,
    targetMessageEncryptionKey: material.targetMessageEncryptionKey,
    targetMessageEncryptionKeyVersion: material.targetMessageEncryptionKeyVersion!,
    credentialRootKeyRing: material.credentialRootKeyRing,
    exportSealingKeyHex: material.exportSealingKeyHex,
  };
}

function failIfRequested(options: CutoverOptions, phaseName: string): void {
  if (options.forcedFailurePhase === phaseName) {
    throw new CutoverFailure("FORCED_REHEARSAL_FAILURE", `forced rehearsal failure after ${phaseName}`);
  }
}
