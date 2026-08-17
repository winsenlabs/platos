import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { retainedMemoryBatch8DeferredTargetChecks } from "./cutover-memory-batch8";
import { unsealCutoverExportPayload, type SealedCutoverExport } from "./cutover-export";

const runHarness = process.env.RUN_DATABASE_CUTOVER_HARNESS === "1";
const describeHarness = runHarness ? describe : describe.skip;
const packageRoot = resolve(__dirname, "..");
const pnpm = "pnpm";
const requiredKeys = {
  ENCRYPTION_KEY: "0".repeat(64),
  PLATOS_ENCRYPTION_KEY: "4".repeat(64),
  PLATOS_CREDENTIAL_ROOT_KEY_VERSION: "1",
  PLATOS_CREDENTIAL_ROOT_KEYS: JSON.stringify({ 1: "2".repeat(64) }),
  PLATOS_MESSAGE_ENCRYPTION_KEY: "11".repeat(32),
  PLATOS_MESSAGE_ENCRYPTION_KEY_V: "1",
  TEST_CUTOVER_EXPORT_KEY: "55".repeat(32),
};

const combinedFixtureFiles = [
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

const forcedRollbackArguments = [
  "db:cutover",
  "--",
  "--execute",
  "--core-rehearsal",
  "--force-rollback-before-commit",
  "--accept-execute",
  "WIN123_EXECUTE_V1",
  "--accept-irreversible-effects",
  "WIN123_IRREVERSIBLE_EFFECTS_V1",
  "--backup-attestation-ref",
  "fixture-backup",
  "--backup-restore-test-ref",
  "fixture-restore-test",
  "--capacity-attestation-ref",
  "fixture-capacity",
  "--writer-fence-attestation-ref",
  "fixture-writer-fence",
  "--export-key-env",
  "TEST_CUTOVER_EXPORT_KEY",
  "--export-key-reference",
  "ops/win-123/test-export-key-v1",
] as const;

describeHarness("production database command Testcontainers harness", () => {
  let legacy: StartedPostgreSqlContainer;
  let fresh: StartedPostgreSqlContainer;

  beforeAll(async () => {
    [legacy, fresh] = await Promise.all([
      new PostgreSqlContainer("pgvector/pgvector:pg16").start(),
      new PostgreSqlContainer("pgvector/pgvector:pg16").start(),
    ]);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([legacy?.stop(), fresh?.stop()]);
    rmSync(resolve(packageRoot, ".cutover-test"), { recursive: true, force: true });
  });

  test("fresh install invokes the exact guarded production migration command", async () => {
    execFileSync(pnpm, ["db:migrate:deploy"], {
      cwd: packageRoot,
      env: { ...process.env, DATABASE_URL: fresh.getConnectionUri(), DIRECT_URL: fresh.getConnectionUri() },
      stdio: "pipe",
    });
    const client = new pg.Client({ connectionString: fresh.getConnectionUri() });
    await client.connect();
    const history = await client.query(
      `SELECT migration_name FROM "_prisma_migrations" ORDER BY migration_name`
    );
    const legacyMarker = await client.query(
      `SELECT to_regclass('public."RuntimeEnvironment"')::text AS name`
    );
    await client.end();
    expect(history.rows.map((row) => row.migration_name)).toEqual([
      "00000000000000_initial",
      "20260817000000_add_upload_reservations",
      "20260817010000_add_token_lifecycle_audit",
      "20260817020000_add_attachment_byte_reconciliation",
      "20260817030000_add_external_cutover_reconciliation",
    ]);
    expect(legacyMarker.rows[0].name).toBeNull();
  }, 120_000);

  test("legacy upgrade fixture invokes production db:cutover and is forced to roll back", async () => {
    execFileSync(
      resolve(packageRoot, "node_modules/.bin/prisma"),
      ["migrate", "deploy", "--schema", "legacy-prisma/schema.prisma"],
      {
        cwd: packageRoot,
        env: { ...process.env, DATABASE_URL: legacy.getConnectionUri(), DIRECT_URL: legacy.getConnectionUri() },
        stdio: "pipe",
      }
    );
    const client = new pg.Client({ connectionString: legacy.getConnectionUri() });
    await client.connect();
    for (const fixture of combinedFixtureFiles) {
      await client.query(readFileSync(resolve(packageRoot, "test-fixtures", fixture), "utf8"));
    }
    await client.end();

    const reportDirectory = resolve(packageRoot, ".cutover-test/reports");
    const result = spawnSync(
      pnpm,
      [
        ...forcedRollbackArguments,
        "--report-dir",
        reportDirectory,
        "--export-dir",
        resolve(packageRoot, ".cutover-test/exports"),
      ],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          ...requiredKeys,
          DATABASE_URL: legacy.getConnectionUri(),
          CUTOVER_FRESH_DATABASE_URL: fresh.getConnectionUri(),
        },
        encoding: "utf8",
      }
    );
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    const reportStart = result.stdout.indexOf("{\n");
    expect(reportStart).toBeGreaterThanOrEqual(0);
    expect(result.stdout).not.toContain("fixture-only-service-material");
    expect(result.stdout).not.toContain("fixture-provider-secret-v1");
    expect(result.stdout).not.toContain("fixture-provider-secret-v2");
    expect(result.stdout).not.toContain("fixture-webhook-secret-required");
    expect(result.stdout).not.toContain("fixture-trigger-export-secret-never-report");
    expect(result.stdout).not.toContain(requiredKeys.TEST_CUTOVER_EXPORT_KEY);
    expect(result.stdout).not.toContain(requiredKeys.PLATOS_CREDENTIAL_ROOT_KEYS);
    expect(JSON.parse(result.stdout.slice(reportStart))).toMatchObject({
      state: "ROLLED_BACK",
      incompletePhaseIds: [
        "clean-trigger-defer-install",
        "external-analytics-object-rekey",
      ],
      external: {
        implementation: "STUB",
        state: "STUB_BLOCKED",
        clickHouseTables: [],
        objectStoreObjects: [],
      },
      cryptoEvidence: {
        retainedFields: {
          rowCounts: {
            turns: 1,
            toolCallAudits: 1,
            safetyEvents: 1,
            memories: 2,
            memoryEntities: 2,
            memoryRelationships: 1,
          },
          sourceUnversionedCount: 5,
          sourceVersionCounts: { "1": 10 },
          targetVersionCounts: { "1": 15 },
        },
        credentials: {
          credentialCount: 8,
          kindCounts: [
            { kind: "CHANNEL_SECRET", count: 4 },
            { kind: "ENTITY_SECRET", count: 2 },
            { kind: "SERVICE_CREDENTIAL", count: 2 },
          ],
          rootVersionCounts: { "1": 8 },
        },
      },
      exportReport: {
        mode: "WRITE",
        keyReference: "ops/win-123/test-export-key-v1",
        externalTriggerPolicy: "NO_IMPORT_EXPORT_ONLY",
        artifact: { status: "WRITTEN" },
        ephemeral: [
          expect.objectContaining({ sourceModel: "MfaBackupCode", rowCount: "1" }),
          expect.objectContaining({ sourceModel: "RuntimeEnvironmentSession", rowCount: "1" }),
        ],
      },
    });
    const report = JSON.parse(result.stdout.slice(reportStart)) as {
      phases: { phase: string; status: string; evidence?: Record<string, unknown> }[];
    };
    expect(
      report.phases
        .filter((phase) => [
          "core-tenancy-auth",
          "supplemental-auth-mfa",
          "retained-agent-tool-batch-1",
          "retained-conversation-batch-2",
          "retained-entity-mcp-batch-3",
          "retained-provider-oauth-batch-4",
          "retained-channel-batch-5",
          "retained-operational-batch-6",
          "retained-eval-job-skill-batch-7",
          "retained-memory-batch-8",
          "remaining-retained-backfill",
          "final-message-re-encryption-read-probes",
          "cryptographic-read-probes",
          "unsupported-trigger-export",
          "ephemeral-session-recovery-disposition",
        ].includes(phase.phase))
        .map((phase) => ({ phase: phase.phase, status: phase.status }))
    ).toEqual([
      { phase: "core-tenancy-auth", status: "SUCCEEDED" },
      { phase: "supplemental-auth-mfa", status: "SUCCEEDED" },
      { phase: "retained-agent-tool-batch-1", status: "SUCCEEDED" },
      { phase: "retained-conversation-batch-2", status: "SUCCEEDED" },
      { phase: "retained-entity-mcp-batch-3", status: "SUCCEEDED" },
      { phase: "retained-provider-oauth-batch-4", status: "SUCCEEDED" },
      { phase: "retained-channel-batch-5", status: "SUCCEEDED" },
      { phase: "retained-operational-batch-6", status: "SUCCEEDED" },
      { phase: "retained-eval-job-skill-batch-7", status: "SUCCEEDED" },
      { phase: "retained-memory-batch-8", status: "SUCCEEDED" },
      { phase: "remaining-retained-backfill", status: "SUCCEEDED" },
      { phase: "final-message-re-encryption-read-probes", status: "SUCCEEDED" },
      { phase: "cryptographic-read-probes", status: "SUCCEEDED" },
      { phase: "unsupported-trigger-export", status: "SUCCEEDED" },
      { phase: "ephemeral-session-recovery-disposition", status: "SUCCEEDED" },
    ]);
    expect(report.phases).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "clean-trigger-defer-install", status: "NOT_RUN" }),
      expect.objectContaining({ phase: "external-analytics-object-rekey", status: "NOT_RUN" }),
    ]));

    const exportDirectory = resolve(packageRoot, ".cutover-test/exports");
    for (const file of readdirSync(exportDirectory)) {
      expect(statSync(resolve(exportDirectory, file)).mode & 0o777).toBe(0o600);
    }
    for (const file of readdirSync(reportDirectory)) {
      expect(statSync(resolve(reportDirectory, file)).mode & 0o777).toBe(0o600);
    }
    const sealedExportFile = readdirSync(exportDirectory).find((name) =>
      name.startsWith("cutover-export-")
    );
    expect(sealedExportFile).toBeDefined();
    const sealedExportText = readFileSync(resolve(exportDirectory, sealedExportFile!), "utf8");
    expect(sealedExportText).not.toContain("fixture-trigger-export-secret-never-report");
    const sealedExport = JSON.parse(sealedExportText) as SealedCutoverExport;
    const unsealedExport = unsealCutoverExportPayload(
      sealedExport,
      Buffer.from(requiredKeys.TEST_CUTOVER_EXPORT_KEY, "hex")
    );
    expect(unsealedExport.toString("utf8")).toContain("fixture-trigger-export-secret-never-report");
    const idMapFile = readdirSync(exportDirectory).find((name) => name.startsWith("cutover-id-map-"));
    expect(idMapFile).toBeDefined();
    const idMap = JSON.parse(readFileSync(resolve(exportDirectory, idMapFile!), "utf8")) as {
      source_model: string;
      source_id: string;
      target_model: string;
      stable_suffix: string;
    }[];
    expect(idMap).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source_model: "PlatosToolDefinition",
        source_id: "cllegacytool0001",
        target_model: "Tool",
        stable_suffix: "",
      }),
      expect.objectContaining({
        source_model: "PlatosAgent",
        source_id: "cllegacyagent0001",
        target_model: "AgentBinding",
        stable_suffix: "agent-binding",
      }),
      expect.objectContaining({
        source_model: "PlatosAgentVersion",
        source_id: "cllegacyversion0001",
        target_model: "AgentVersion",
        stable_suffix: "",
      }),
      expect.objectContaining({
        source_model: "PlatosAgentCluster",
        source_id: "cllegacycluster0001",
        target_model: "AgentCluster",
        stable_suffix: "",
      }),
      expect.objectContaining({
        source_model: "OrgMemberInvite",
        source_id: "cllegacyinvite0001",
        target_model: "OrganizationInvitation",
        stable_suffix: "",
      }),
      expect.objectContaining({
        source_model: "User",
        source_id: "cllegacyuser0001",
        target_model: "OperatorMfaTotp",
        stable_suffix: "operator-mfa-totp",
      }),
      expect.objectContaining({
        source_model: "PlatosAgentMessage",
        source_id: "cllegacymessage0002",
        target_model: "Step",
        stable_suffix: "step:0",
      }),
      expect.objectContaining({
        source_model: "PlatosAgentMessage",
        source_id: "cllegacymessage0002",
        target_model: "ToolCall",
        stable_suffix: "tool-call:0",
      }),
      expect.objectContaining({
        source_model: "PlatosConnectedEntity",
        source_id: "cllegacyentity0001",
        target_model: "Credential",
        stable_suffix: expect.stringMatching(/^entity-auth:/),
      }),
      expect.objectContaining({
        source_model: "PlatosProviderKey",
        source_id: "cllegacyproviderkey0001",
        target_model: "Credential",
        stable_suffix: "credential",
      }),
      expect.objectContaining({
        source_model: "PlatosProviderKey",
        source_id: "cllegacyproviderkey0001",
        target_model: "CredentialSecretVersion",
        stable_suffix: "credential-secret-version:1",
      }),
      expect.objectContaining({
        source_model: "PlatosChannelInstallation",
        source_id: "cllegacychannelinstallation0001",
        target_model: "CredentialSecretVersion",
        stable_suffix: "credential-secret-version:1",
      }),
      expect.objectContaining({
        source_model: "PlatosChannelAppThread",
        source_id: "cllegacychannelappthread0002",
        target_model: "ChannelAppThread",
        stable_suffix: "",
      }),
      expect.objectContaining({
        source_model: "PlatosCredentialAudit",
        source_id: "cllegacycredentialaudit0001",
        target_model: "AdminAudit",
        stable_suffix: "",
      }),
      expect.objectContaining({
        source_model: "PlatosErasureOperation",
        source_id: "cllegacyerasure0001",
        target_model: "ErasureOperation",
        stable_suffix: "",
      }),
      expect.objectContaining({
        source_model: "PlatosSkill",
        source_id: "cllegacyskill0001",
        target_model: "EnvironmentSkill",
        stable_suffix: "environment-skill",
      }),
      expect.objectContaining({
        source_model: "PlatosMacro",
        source_id: "cllegacymacro0001",
        target_model: "Macro",
        stable_suffix: "",
      }),
      expect.objectContaining({
        source_model: "PlatosMemoryRelationship",
        source_id: "cllegacymemoryrelationship0001",
        target_model: "MemoryRelationship",
        stable_suffix: "",
      }),
    ]));

    const journalFile = readdirSync(exportDirectory).find((name) => name.startsWith("cutover-journal-"));
    expect(journalFile).toBeDefined();
    const journal = JSON.parse(readFileSync(resolve(exportDirectory, journalFile!), "utf8")) as {
      phase: string;
      evidence: Record<string, unknown>;
    }[];
    expect(journal.map((entry) => entry.phase)).toEqual(expect.arrayContaining([
      "core-tenancy-auth",
      "supplemental-auth-mfa",
      "retained-agent-tool-batch-1",
      "retained-conversation-batch-2",
      "retained-entity-mcp-batch-3",
      "retained-provider-oauth-batch-4",
      "retained-channel-batch-5",
      "retained-operational-batch-6",
      "retained-eval-job-skill-batch-7",
      "retained-memory-batch-8",
      "remaining-retained-backfill",
      "final-message-re-encryption-read-probes",
      "cryptographic-read-probes",
      "unsupported-trigger-export",
      "ephemeral-session-recovery-disposition",
    ]));
    expect(
      journal.filter((entry) => [
        "core-tenancy-auth",
        "supplemental-auth-mfa",
        "retained-agent-tool-batch-1",
        "retained-conversation-batch-2",
        "retained-entity-mcp-batch-3",
        "retained-provider-oauth-batch-4",
        "retained-channel-batch-5",
        "retained-operational-batch-6",
        "retained-eval-job-skill-batch-7",
        "retained-memory-batch-8",
        "remaining-retained-backfill",
        "final-message-re-encryption-read-probes",
        "cryptographic-read-probes",
        "unsupported-trigger-export",
        "ephemeral-session-recovery-disposition",
      ].includes(entry.phase)).map((entry) => entry.phase)
    ).toEqual([
      "core-tenancy-auth",
      "supplemental-auth-mfa",
      "retained-agent-tool-batch-1",
      "retained-conversation-batch-2",
      "retained-entity-mcp-batch-3",
      "retained-provider-oauth-batch-4",
      "retained-channel-batch-5",
      "retained-operational-batch-6",
      "retained-eval-job-skill-batch-7",
      "retained-memory-batch-8",
      "remaining-retained-backfill",
      "final-message-re-encryption-read-probes",
      "cryptographic-read-probes",
      "unsupported-trigger-export",
      "ephemeral-session-recovery-disposition",
    ]);
    expect(JSON.stringify(journal)).not.toContain("fixture-invite-token");
    expect(JSON.stringify(journal)).not.toContain("A1B2C3D4E5F6G7H8I9J0K1L2");
    expect(JSON.stringify(journal)).not.toContain("fixture-only-service-material");
    expect(JSON.stringify(journal)).not.toContain("fixture-provider-secret-v1");
    expect(JSON.stringify(journal)).not.toContain("fixture-provider-secret-v2");
    expect(JSON.stringify(journal)).not.toContain("fixture-webhook-secret-required");
    expect(JSON.stringify(journal)).not.toContain(requiredKeys.PLATOS_CREDENTIAL_ROOT_KEYS);
    expect(
      journal.find((entry) => entry.phase === "materialize-id-map")?.evidence
    ).toMatchObject({
      retainedBatch3MappingCount: 4,
      retainedProviderOauthBatch4MappingCount: 4,
      retainedChannelBatch5MappingCount: 8,
      retainedEvalJobSkillBatch7MappingCount: 10,
      retainedMemoryBatch8MappingCount: 5,
    });
    expect(
      journal.find((entry) => entry.phase === "retained-conversation-batch-2")?.evidence
    ).toMatchObject({ finalMessageReEncryptionReadProbes: "DEFERRED_TO_POST_BATCH_GATE" });
    expect(
      journal.find((entry) => entry.phase === "retained-entity-mcp-batch-3")?.evidence
    ).toMatchObject({
      sourceModels: expect.arrayContaining(["PlatosConnectedEntity", "PlatosMcpBearerToken"]),
      entityRows: 1,
      entityAuthRows: 2,
      cryptographicReadProbes: "DEFERRED_TO_POST_BATCH_GATE",
    });
    expect(
      journal.find((entry) => entry.phase === "retained-channel-batch-5")?.evidence
    ).toMatchObject({
      batch: "retained-channel-batch5",
      sourceModels: expect.arrayContaining(["PlatosChannelConnection", "PlatosChannelInstallation"]),
      sourceRows: {
        connections: 1,
        channelThreads: 1,
        apps: 1,
        installations: 2,
        appThreads: 2,
      },
      cryptographicReadProbes: "DEFERRED_TO_POST_BATCH_GATE",
    });
    expect(
      journal.find((entry) => entry.phase === "retained-operational-batch-6")?.evidence
    ).toMatchObject({
      batch: "retained-operational-batch6",
      sourceModels: expect.arrayContaining(["PlatosToolCallAudit", "PlatosCredentialAudit"]),
      sourceRows: {
        toolHealth: 1,
        toolCallAudits: 1,
        adminAudits: 1,
        credentialAudits: 1,
        agentApprovals: 1,
        budgets: 1,
        safetyEvents: 1,
        events: 1,
        notificationRules: 1,
        erasureOperations: 1,
      },
      mergeCounts: {
        adminAuditSources: 1,
        credentialAuditSources: 1,
        adminAuditTargets: 2,
      },
      retainedEncryptedRepresentations: [
        {
          fields: "ToolCallAudit.arguments,ToolCallAudit.result",
          reEncryption: "DEFERRED",
          readProbe: "AUDIT_DECRYPT_READ",
        },
        {
          fields: "SafetyEvent.detail,SafetyEvent.metadata",
          reEncryption: "DEFERRED",
          readProbe: "AUDIT_DECRYPT_READ",
        },
      ],
      finalTargetReEncryptionReadProbes: "DEFERRED_TO_POST_BATCH_GATE",
    });
    expect(
      journal.find((entry) => entry.phase === "retained-eval-job-skill-batch-7")?.evidence
    ).toMatchObject({
      batch: "retained-eval-job-skill-batch7",
      sourceModels: expect.arrayContaining(["PlatosMessageRating", "PlatosSkill", "PlatosMacro"]),
      sourceRows: {
        messageRatings: 1,
        evalCriteria: 1,
        agentEvals: 1,
        goldenSets: 1,
        jobs: 1,
        skills: 1,
        agentSkills: 1,
        macros: 1,
      },
      splitCounts: {
        skillSources: 1,
        skillTargets: 1,
        projectSkillTargets: 1,
        environmentSkillTargets: 1,
        totalSplitTargets: 3,
      },
    });
    expect(
      journal.find((entry) => entry.phase === "retained-memory-batch-8")?.evidence
    ).toMatchObject({
      batch: "retained-memory-batch8",
      sourceModels: ["PlatosMemory", "PlatosMemoryEntity", "PlatosMemoryRelationship"],
      sourceRows: { memories: 2, entities: 2, relationships: 1 },
      graphCounts: {
        directedEdges: 1,
        fromEndpoints: 1,
        toEndpoints: 1,
        sourcedEdges: 1,
      },
      retainedEncryptedRepresentations: retainedMemoryBatch8DeferredTargetChecks,
      finalTargetReEncryptionReadProbes: "DEFERRED_TO_POST_BATCH_GATE",
    });
    expect(
      journal.find((entry) => entry.phase === "remaining-retained-backfill")?.evidence
    ).toEqual({
      retainedPlatosSourceModelCount: 55,
      supplementalRetainedSourceModelCount: 4,
      implementedRetainedSourceModelCount: 59,
    });
    expect(
      journal.find((entry) => entry.phase === "retained-provider-oauth-batch-4")?.evidence
    ).toMatchObject({
      batch: "retained-provider-oauth-batch4",
      sourceModels: expect.arrayContaining(["PlatosProviderKey", "PlatosOAuthRefreshToken"]),
      sourceRows: { environmentProviders: 2, providerKeys: 2, oauthRefreshTokens: 1 },
      cryptographicReadProbes: "DEFERRED_TO_POST_BATCH_GATE",
    });
    expect(
      journal.find((entry) => entry.phase === "final-message-re-encryption-read-probes")?.evidence
    ).toMatchObject({
      rowCounts: {
        turns: 1,
        toolCallAudits: 1,
        safetyEvents: 1,
        memories: 2,
        memoryEntities: 2,
        memoryRelationships: 1,
      },
      sourceUnversionedCount: 5,
      sourceVersionCounts: { "1": 10 },
      targetVersionCounts: { "1": 15 },
    });
    expect(
      journal.find((entry) => entry.phase === "cryptographic-read-probes")?.evidence
    ).toEqual({
      credentialCount: 8,
      kindCounts: [
        { kind: "CHANNEL_SECRET", count: 4 },
        { kind: "ENTITY_SECRET", count: 2 },
        { kind: "SERVICE_CREDENTIAL", count: 2 },
      ],
      retainedFieldCount: 15,
      rootVersionCounts: { "1": 8 },
    });
    expect(
      journal.find((entry) => entry.phase === "unsupported-trigger-export")?.evidence
    ).toMatchObject({
      mode: "WRITE",
      keyReference: "ops/win-123/test-export-key-v1",
      externalTriggerPolicy: "NO_IMPORT_EXPORT_ONLY",
      objectCount: 130,
      exportOnlyObjectCount: 64,
      artifact: { status: "WRITTEN" },
    });
    expect(
      journal.find((entry) => entry.phase === "ephemeral-session-recovery-disposition")?.evidence
    ).toEqual({
      dispositions: [
        expect.objectContaining({ sourceModel: "MfaBackupCode", rowCount: "1" }),
        expect.objectContaining({ sourceModel: "RuntimeEnvironmentSession", rowCount: "1" }),
      ],
      totalRowCount: "2",
    });
    expect(
      journal.find((entry) => entry.phase === "forced-pre-commit-rollback")?.evidence
    ).toMatchObject({
      incompletePhaseIds: expect.arrayContaining([
        "clean-trigger-defer-install",
        "external-analytics-object-rekey",
      ]),
    });

    const verify = new pg.Client({ connectionString: legacy.getConnectionUri() });
    await verify.connect();
    const legacyTable = await verify.query(`SELECT to_regclass('public."RuntimeEnvironment"')::text AS name`);
    const cleanTable = await verify.query(`SELECT to_regclass('public."Environment"')::text AS name`);
    await verify.end();
    expect(legacyTable.rows[0].name).toBe('"RuntimeEnvironment"');
    expect(cleanTable.rows[0].name).toBeNull();

    rmSync(resolve(packageRoot, ".cutover-test"), { recursive: true, force: true });
    const noArtifactResult = spawnSync(pnpm, [...forcedRollbackArguments], {
      cwd: packageRoot,
      env: {
        ...process.env,
        ...requiredKeys,
        DATABASE_URL: legacy.getConnectionUri(),
        CUTOVER_FRESH_DATABASE_URL: fresh.getConnectionUri(),
      },
      encoding: "utf8",
    });
    expect(noArtifactResult.status, `${noArtifactResult.stderr}\n${noArtifactResult.stdout}`).toBe(0);
    const noArtifactReportStart = noArtifactResult.stdout.indexOf("{\n");
    expect(noArtifactReportStart).toBeGreaterThanOrEqual(0);
    expect(noArtifactResult.stdout).not.toContain("fixture-trigger-export-secret-never-report");
    expect(noArtifactResult.stdout).not.toContain(requiredKeys.TEST_CUTOVER_EXPORT_KEY);
    expect(JSON.parse(noArtifactResult.stdout.slice(noArtifactReportStart))).toMatchObject({
      state: "ROLLED_BACK",
      incompletePhaseIds: [
        "clean-trigger-defer-install",
        "external-analytics-object-rekey",
      ],
      exportReport: {
        mode: "DRY_RUN",
        keyReference: "ops/win-123/test-export-key-v1",
        artifact: { status: "VALIDATED_NOT_WRITTEN" },
      },
      phases: expect.arrayContaining([
        expect.objectContaining({
          phase: "export-rehearsal-artifacts",
          status: "SUCCEEDED",
          summary: "sealed export was validated without writing rehearsal artifacts",
        }),
        expect.objectContaining({
          phase: "forced-pre-commit-rollback",
          status: "ROLLED_BACK",
        }),
      ]),
    });
    expect(existsSync(resolve(packageRoot, ".cutover-test"))).toBe(false);
  }, 900_000);
});
