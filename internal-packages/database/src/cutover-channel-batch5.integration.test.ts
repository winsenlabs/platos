import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  backfillRetainedAgentToolBatch1,
  validateRetainedAgentToolBatch1,
} from "./cutover-agent-tool-batch1";
import {
  backfillCoreTenancy,
  createCleanCatalog,
  createCutoverJournal,
  materializeCutoverIdMap,
  moveLegacyCatalogToTemporarySchema,
  validateCoreTenancyBackfill,
} from "./cutover-backfill";
import { backfillRetainedChannelBatch5 } from "./cutover-channel-batch5";
import {
  backfillRetainedConversationBatch2,
  materializeBatch2MessageOrdinalMappings,
  validateRetainedConversationBatch2,
} from "./cutover-conversation-batch2";
import { CredentialRootKeyRing } from "./secrets";

const runHarness = process.env.RUN_DATABASE_CUTOVER_CHANNEL_BATCH5_HARNESS === "1";
const describeHarness = runHarness ? describe : describe.skip;
const packageRoot = resolve(__dirname, "..");
const messageEncryptionKeys = Object.freeze({ "1": "11".repeat(32) });
const credentialRootKeyRing = new CredentialRootKeyRing({
  activeVersion: 5,
  keys: { 5: "55".repeat(32) },
});

describeHarness("retained channel Batch 5 PostgreSQL replay", () => {
  let container: StartedPostgreSqlContainer;
  let database: pg.Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    const databaseUrl = container.getConnectionUri();
    execFileSync(
      resolve(packageRoot, "node_modules/.bin/prisma"),
      ["migrate", "deploy", "--schema", resolve(packageRoot, "legacy-prisma/schema.prisma")],
      {
        cwd: packageRoot,
        env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl },
        stdio: "pipe",
      }
    );
    database = new pg.Client({ connectionString: databaseUrl });
    await database.connect();
  }, 120_000);

  afterAll(async () => {
    await database?.end();
    await container?.stop();
  });

  test("conserves channel rows with parent-owned credentials and secret-free evidence", async () => {
    for (const fixture of [
      "legacy-core-seed.sql",
      "legacy-agent-tool-batch1-seed.sql",
      "legacy-conversation-batch2-seed.sql",
      "legacy-channel-batch5-seed.sql",
    ]) {
      await database.query(readFileSync(resolve(packageRoot, "test-fixtures", fixture), "utf8"));
    }

    await database.query("BEGIN");
    try {
      await moveLegacyCatalogToTemporarySchema(database);
      await createCleanCatalog(database, packageRoot);
      await createCutoverJournal(database, "03125bd3-8e2e-5500-8942-574db43e9203");
      await materializeCutoverIdMap(database);
      await materializeBatch2MessageOrdinalMappings(database);
      await backfillCoreTenancy(database);
      await validateCoreTenancyBackfill(database);
      await backfillRetainedAgentToolBatch1(database);
      await validateRetainedAgentToolBatch1(database);
      await backfillRetainedConversationBatch2(database, messageEncryptionKeys);
      await validateRetainedConversationBatch2(database);

      const evidence = await backfillRetainedChannelBatch5(
        database,
        {
          messageEncryptionKeys,
          credentialRootKeyRing,
        },
        1
      );
      expect(evidence.sourceRows).toEqual({
        connections: 1,
        channelThreads: 1,
        apps: 1,
        installations: 2,
        appThreads: 2,
      });
      expect(JSON.stringify(evidence)).not.toContain("fixture-webhook-secret-required");
      expect(JSON.stringify(evidence)).not.toContain("fixture-channel-client-secret");
      expect(JSON.stringify(evidence)).not.toContain("fixture-channel-bot-token-team");

      const installations = await database.query<{
        externalInstallationId: string;
        environmentId: string;
        credentialEnvironmentId: string;
      }>(`SELECT installation."externalInstallationId",
                 app."environmentId"::text AS "environmentId",
                 credential."environmentId"::text AS "credentialEnvironmentId"
            FROM public."ChannelInstallation" installation
            JOIN public."ChannelApp" app ON app.id = installation."appId"
            JOIN public."Credential" credential ON credential.id = installation."credentialId"
           ORDER BY installation."externalInstallationId"`);
      expect(installations.rows.map((row) => row.externalInstallationId)).toEqual([
        "slack:enterprise:E-FIXTURE",
        "slack:team:T-FIXTURE",
      ]);
      expect(
        installations.rows.every((row) => row.environmentId === row.credentialEnvironmentId)
      ).toBe(true);

      const credentials = await database.query<{
        kind: string;
        active: boolean;
        versionCount: string;
      }>(`SELECT credential.kind::text AS kind,
                 credential."activeSecretVersionId" IS NOT NULL AS active,
                 count(version.id)::text AS "versionCount"
            FROM public."Credential" credential
            LEFT JOIN public."CredentialSecretVersion" version
              ON version."credentialId" = credential.id
           WHERE credential.kind = 'CHANNEL_SECRET'
           GROUP BY credential.id ORDER BY credential.name`);
      expect(credentials.rows).toHaveLength(4);
      expect(credentials.rows.every((row) => row.active && row.versionCount === "1")).toBe(true);
    } finally {
      await database.query("ROLLBACK");
    }
  }, 240_000);
});
