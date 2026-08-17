import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { decryptSecret, generateTotp, hashSecret } from "./auth";
import {
  backfillSupplementalAuthCutover,
  supplementalMfaCutoverCounter,
  validateSupplementalAuthCutover,
  verifySupplementalMfaCodeOnce,
} from "./cutover-auth-supplemental";
import {
  backfillCoreTenancy,
  createCleanCatalog,
  createCutoverJournal,
  materializeCutoverIdMap,
  moveLegacyCatalogToTemporarySchema,
} from "./cutover-backfill";

const runHarness = process.env.RUN_DATABASE_CUTOVER_AUTH_SUPPLEMENTAL_HARNESS === "1";
const describeHarness = runHarness ? describe : describe.skip;
const packageRoot = resolve(__dirname, "..");
const legacyEncryptionKey = "0".repeat(64);
const targetAuthEncryptionKey = "4".repeat(64);
const cutoverAt = new Date("2026-08-17T12:00:00.000Z");

describeHarness("supplemental auth cutover PostgreSQL harness", () => {
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

  test("backfills valid fixture rows, conserves identities, and enforces the replay barrier", async () => {
    await database.query(
      readFileSync(resolve(packageRoot, "test-fixtures/legacy-core-seed.sql"), "utf8")
    );
    await database.query(
      readFileSync(resolve(packageRoot, "test-fixtures/legacy-auth-supplemental-seed.sql"), "utf8")
    );

    // Keep enabled-v1, disabled-null-reference, and pending-v2. The remaining
    // fixture rows are negative vectors covered by the fail-closed unit tests.
    await database.query(
      `DELETE FROM "User" WHERE id IN
        ('cllegacyuser0004', 'cllegacyuser0005', 'cllegacyuser0006', 'cllegacyuser0007')`
    );
    await database.query("BEGIN");
    try {
      await moveLegacyCatalogToTemporarySchema(database);
      await createCleanCatalog(database, packageRoot);
      await createCutoverJournal(database, "03125bd3-8e2e-5500-8942-574db43e9203");
      await materializeCutoverIdMap(database);
      const secretStoreMappings = await database.query<{ source_id: string }>(
        `SELECT DISTINCT source_id FROM cutover_legacy.cutover_id_map
          WHERE source_model = 'SecretStore' ORDER BY source_id`
      );
      expect(secretStoreMappings.rows.map((row) => row.source_id)).toContain(
        "mfa:fixture:enabled-v1"
      );
      expect(secretStoreMappings.rows.map((row) => row.source_id)).not.toContain(
        "mfa-fixture-enabled-v1"
      );
      await backfillCoreTenancy(database);

      const evidence = await backfillSupplementalAuthCutover(database, {
        cutoverAt,
        legacyEncryptionKey,
        targetAuthEncryptionKey,
      });
      expect(evidence).toEqual({
        invitationRows: 2,
        impersonationAuditRows: 2,
        retiredImpersonationSessionRows: 2,
        enabledMfaRows: 1,
        pendingMfaRows: 1,
        disabledMfaUsers: 1,
        recoveryCodeRows: 0,
      });
      const serializedEvidence = JSON.stringify(evidence);
      expect(serializedEvidence).not.toContain("fixture-invite-token");
      expect(serializedEvidence).not.toContain("A1B2C3D4E5F6G7H8I9J0K1L2");

      await validateSupplementalAuthCutover(database, {
        cutoverAt,
        legacyEncryptionKey,
        targetAuthEncryptionKey,
      });

      const invitations = await database.query<{
        tokenHash: string;
        expiresAt: Date;
        createdAt: Date;
      }>(`SELECT "tokenHash", "expiresAt", "createdAt" FROM "OrganizationInvitation"
          ORDER BY "createdAt"`);
      expect(invitations.rows).toHaveLength(2);
      expect(invitations.rows[0]?.tokenHash).toBe(hashSecret("fixture-invite-token-admin"));
      expect(
        invitations.rows[0]?.expiresAt.getTime() - invitations.rows[0]?.createdAt.getTime()
      ).toBe(7 * 24 * 60 * 60 * 1000);

      const recoveryCodes = await database.query(`SELECT id FROM "OperatorMfaRecoveryCode"`);
      expect(recoveryCodes.rowCount).toBe(0);
      const mfaRows = await database.query<{
        encryptedSecret: string | null;
        enabledAt: Date | null;
        lastUsedCounter: string | null;
        pendingEncryptedSecret: string | null;
      }>(`SELECT "encryptedSecret", "enabledAt", "lastUsedCounter"::text AS "lastUsedCounter",
                 "pendingEncryptedSecret"
            FROM "OperatorMfaTotp" ORDER BY "enabledAt" NULLS LAST`);
      expect(mfaRows.rows).toHaveLength(2);
      const enabled = mfaRows.rows[0]!;
      const canonical = decryptSecret(enabled.encryptedSecret!, targetAuthEncryptionKey);
      expect(canonical).toBe("IEYUEMSDGNCDIRJVIY3EON2IHBETSSRQJMYUYMQ");
      const barrier = supplementalMfaCutoverCounter(cutoverAt);
      expect(enabled.lastUsedCounter).toBe(String(barrier));
      expect(
        verifySupplementalMfaCodeOnce({
          encryptedSecret: enabled.encryptedSecret!,
          targetAuthEncryptionKey,
          submittedCode: generateTotp(canonical, cutoverAt),
          at: cutoverAt,
          lastUsedCounter: barrier,
        })
      ).toBeNull();
      const nextAt = new Date(cutoverAt.getTime() + 30_000);
      const nextCode = generateTotp(canonical, nextAt);
      const nextCounter = verifySupplementalMfaCodeOnce({
        encryptedSecret: enabled.encryptedSecret!,
        targetAuthEncryptionKey,
        submittedCode: nextCode,
        at: nextAt,
        lastUsedCounter: barrier,
      });
      expect(nextCounter).toBe(barrier + 1n);
      expect(
        verifySupplementalMfaCodeOnce({
          encryptedSecret: enabled.encryptedSecret!,
          targetAuthEncryptionKey,
          submittedCode: nextCode,
          at: nextAt,
          lastUsedCounter: nextCounter,
        })
      ).toBeNull();
      expect(mfaRows.rows[1]?.encryptedSecret).toBeNull();
      expect(mfaRows.rows[1]?.pendingEncryptedSecret).not.toBeNull();
    } finally {
      await database.query("ROLLBACK");
    }
  }, 180_000);
});
