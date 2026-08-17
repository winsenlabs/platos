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
  PLATOS_ENCRYPTION_KEY: "1".repeat(64),
  PLATOS_CREDENTIAL_ROOT_KEY_VERSION: "1",
  PLATOS_CREDENTIAL_ROOT_KEYS: JSON.stringify({ 1: "2".repeat(64) }),
  PLATOS_MESSAGE_ENCRYPTION_KEY: "3".repeat(64),
};

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
    await client.query(readFileSync(resolve(packageRoot, "test-fixtures/legacy-core-seed.sql"), "utf8"));
    await client.query(
      readFileSync(
        resolve(packageRoot, "test-fixtures/legacy-agent-tool-batch1-seed.sql"),
        "utf8"
      )
    );
    await client.end();

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
        resolve(packageRoot, ".cutover-test/reports"),
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
    expect(result.status, result.stderr).toBe(0);
    const reportStart = result.stdout.indexOf("{\n");
    expect(reportStart).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(result.stdout.slice(reportStart))).toMatchObject({
      state: "ROLLED_BACK",
      phases: expect.arrayContaining([
        expect.objectContaining({
          phase: "retained-agent-tool-batch-1",
          status: "SUCCEEDED",
        }),
      ]),
      incompletePhaseIds: expect.arrayContaining(["remaining-retained-backfill"]),
    });

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
    ]));

    const verify = new pg.Client({ connectionString: legacy.getConnectionUri() });
    await verify.connect();
    const legacyTable = await verify.query(`SELECT to_regclass('public."RuntimeEnvironment"')::text AS name`);
    const cleanTable = await verify.query(`SELECT to_regclass('public."Environment"')::text AS name`);
    await verify.end();
    expect(legacyTable.rows[0].name).toBe('"RuntimeEnvironment"');
    expect(cleanTable.rows[0].name).toBeNull();
  }, 600_000);
});
