import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  deferCleanTriggersForBackfill,
  installAndValidateCleanTriggers,
  readCleanTriggerCatalog,
} from "./cutover-clean-triggers";
import type { CutoverDatabase } from "./cutover-types";

const describeDatabase =
  process.env.RUN_DATABASE_CUTOVER_HARNESS === "1" ? describe : describe.skip;
const packageRoot = resolve(__dirname, "..");

function migrate(databaseUrl: string): void {
  execFileSync("pnpm", ["db:migrate:deploy"], {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl },
    stdio: "pipe",
  });
}

describeDatabase("clean trigger defer/install PostgreSQL contract", () => {
  let targetContainer: StartedPostgreSqlContainer;
  let freshContainer: StartedPostgreSqlContainer;
  let target: pg.Client;
  let fresh: pg.Client;

  beforeAll(async () => {
    [targetContainer, freshContainer] = await Promise.all([
      new PostgreSqlContainer("pgvector/pgvector:pg16").start(),
      new PostgreSqlContainer("pgvector/pgvector:pg16").start(),
    ]);
    await Promise.all([
      Promise.resolve().then(() => migrate(targetContainer.getConnectionUri())),
      Promise.resolve().then(() => migrate(freshContainer.getConnectionUri())),
    ]);
    [target, fresh] = [
      new pg.Client({ connectionString: targetContainer.getConnectionUri() }),
      new pg.Client({ connectionString: freshContainer.getConnectionUri() }),
    ];
    await Promise.all([target.connect(), fresh.connect()]);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([target?.end(), fresh?.end()]);
    await Promise.all([targetContainer?.stop(), freshContainer?.stop()]);
  });

  test("drops only the classified trigger, reinstalls exact clean SQL, and transactionally rolls back", async () => {
    const initial = await readCleanTriggerCatalog(target);
    await target.query("BEGIN");
    const deferred = await deferCleanTriggersForBackfill(target, fresh);
    expect(deferred.entries).toHaveLength(initial.entries.length - 1);
    const installed = await installAndValidateCleanTriggers(target, fresh);
    expect(installed.digest).toBe(initial.digest);
    await target.query("ROLLBACK");
    expect((await readCleanTriggerCatalog(target)).digest).toBe(initial.digest);
  });

  test("rolls back a partially executed CREATE TRIGGER when installation reports failure", async () => {
    await target.query("BEGIN");
    await deferCleanTriggersForBackfill(target, fresh);
    const failingDatabase: CutoverDatabase = {
      async query<Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        values?: readonly unknown[]
      ) {
        const result = await target.query(sql, values ? [...values] : undefined);
        if (sql.startsWith('CREATE TRIGGER "MessageAttachment_claimed_lifecycle"')) {
          throw new Error("injected post-create installation failure");
        }
        return {
          rows: result.rows as Row[],
          rowCount: result.rowCount,
        };
      },
    };
    await expect(installAndValidateCleanTriggers(failingDatabase, fresh)).rejects.toMatchObject({
      code: "CLEAN_TRIGGER_INSTALL_FAILED",
    });
    const absent = await target.query<{ present: boolean }>(
      `SELECT to_regclass('public."MessageAttachment"') IS NOT NULL AND EXISTS (
         SELECT 1 FROM pg_trigger trigger
         JOIN pg_class class ON class.oid = trigger.tgrelid
        WHERE class.relname = 'MessageAttachment'
          AND trigger.tgname = 'MessageAttachment_claimed_lifecycle'
          AND NOT trigger.tgisinternal
       ) AS present`
    );
    expect(absent.rows[0]?.present).toBe(false);
    await target.query("ROLLBACK");
  });
});
