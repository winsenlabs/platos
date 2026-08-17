import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

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
};

const combinedFixtureFiles = [
  "legacy-core-seed.sql",
  "legacy-auth-supplemental-seed.sql",
  "legacy-agent-tool-batch1-seed.sql",
  "legacy-conversation-batch2-seed.sql",
  "legacy-retained-batch3-seed.sql",
  "legacy-provider-oauth-batch4-seed.sql",
  "legacy-combined-cutover-replay.sql",
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
    expect(result.stdout).not.toContain(requiredKeys.PLATOS_CREDENTIAL_ROOT_KEYS);
    expect(JSON.parse(result.stdout.slice(reportStart))).toMatchObject({
      state: "ROLLED_BACK",
      incompletePhaseIds: expect.arrayContaining([
        "final-message-re-encryption-read-probes",
        "remaining-retained-backfill",
      ]),
    });
    const report = JSON.parse(result.stdout.slice(reportStart)) as {
      phases: { phase: string; status: string }[];
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
        ].includes(phase.phase))
        .map((phase) => ({ phase: phase.phase, status: phase.status }))
    ).toEqual([
      { phase: "core-tenancy-auth", status: "SUCCEEDED" },
      { phase: "supplemental-auth-mfa", status: "SUCCEEDED" },
      { phase: "retained-agent-tool-batch-1", status: "SUCCEEDED" },
      { phase: "retained-conversation-batch-2", status: "SUCCEEDED" },
      { phase: "retained-entity-mcp-batch-3", status: "SUCCEEDED" },
      { phase: "retained-provider-oauth-batch-4", status: "SUCCEEDED" },
    ]);
    expect(report.phases).toEqual(expect.arrayContaining([
      {
        phase: "final-message-re-encryption-read-probes",
        status: "NOT_RUN",
        summary: expect.stringContaining("message re-encryption"),
      },
      expect.objectContaining({ phase: "remaining-retained-backfill", status: "NOT_RUN" }),
    ]));

    const exportDirectory = resolve(packageRoot, ".cutover-test/exports");
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
    ]));
    expect(
      journal.filter((entry) => [
        "core-tenancy-auth",
        "supplemental-auth-mfa",
        "retained-agent-tool-batch-1",
        "retained-conversation-batch-2",
        "retained-entity-mcp-batch-3",
        "retained-provider-oauth-batch-4",
      ].includes(entry.phase)).map((entry) => entry.phase)
    ).toEqual([
      "core-tenancy-auth",
      "supplemental-auth-mfa",
      "retained-agent-tool-batch-1",
      "retained-conversation-batch-2",
      "retained-entity-mcp-batch-3",
      "retained-provider-oauth-batch-4",
    ]);
    expect(JSON.stringify(journal)).not.toContain("fixture-invite-token");
    expect(JSON.stringify(journal)).not.toContain("A1B2C3D4E5F6G7H8I9J0K1L2");
    expect(JSON.stringify(journal)).not.toContain("fixture-only-service-material");
    expect(JSON.stringify(journal)).not.toContain("fixture-provider-secret-v1");
    expect(JSON.stringify(journal)).not.toContain("fixture-provider-secret-v2");
    expect(JSON.stringify(journal)).not.toContain(requiredKeys.PLATOS_CREDENTIAL_ROOT_KEYS);
    expect(
      journal.find((entry) => entry.phase === "materialize-id-map")?.evidence
    ).toMatchObject({
      retainedBatch3MappingCount: 4,
      retainedProviderOauthBatch4MappingCount: 4,
    });
    expect(
      journal.find((entry) => entry.phase === "retained-conversation-batch-2")?.evidence
    ).toMatchObject({ finalMessageReEncryptionReadProbes: "INCOMPLETE" });
    expect(
      journal.find((entry) => entry.phase === "retained-entity-mcp-batch-3")?.evidence
    ).toMatchObject({
      sourceModels: expect.arrayContaining(["PlatosConnectedEntity", "PlatosMcpBearerToken"]),
      entityRows: 1,
      entityAuthRows: 2,
      cryptographicReadProbes: "INCOMPLETE",
    });
    expect(
      journal.find((entry) => entry.phase === "retained-provider-oauth-batch-4")?.evidence
    ).toMatchObject({
      batch: "retained-provider-oauth-batch4",
      sourceModels: expect.arrayContaining(["PlatosProviderKey", "PlatosOAuthRefreshToken"]),
      sourceRows: { environmentProviders: 2, providerKeys: 2, oauthRefreshTokens: 1 },
      cryptographicReadProbes: "INCOMPLETE",
    });
    expect(
      journal.find((entry) => entry.phase === "forced-pre-commit-rollback")?.evidence
    ).toMatchObject({
      incompletePhaseIds: expect.arrayContaining([
        "final-message-re-encryption-read-probes",
        "remaining-retained-backfill",
      ]),
    });

    const verify = new pg.Client({ connectionString: legacy.getConnectionUri() });
    await verify.connect();
    const legacyTable = await verify.query(`SELECT to_regclass('public."RuntimeEnvironment"')::text AS name`);
    const cleanTable = await verify.query(`SELECT to_regclass('public."Environment"')::text AS name`);
    await verify.end();
    expect(legacyTable.rows[0].name).toBe('"RuntimeEnvironment"');
    expect(cleanTable.rows[0].name).toBeNull();
  }, 600_000);
});
