import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { CutoverDatabase } from "./cutover-types";
import { CutoverFailure } from "./cutover-types";
import { validateCleanMigrationHistory, type LegacyMigrationRow } from "./cutover-history";

export interface PostCommitPrismaResult {
  readonly resolvedMigrations: readonly string[];
  readonly cleanInitialChecksum: string;
  readonly status: "CLEAN";
  readonly deploy: "NO_OP";
}

/**
 * Post-commit only. Any failure after the PostgreSQL cutover transaction has
 * committed is restore-required; this function never attempts SQL rollback or
 * hand-writes Prisma migration rows.
 */
export async function runPostCommitPrismaGate(
  database: CutoverDatabase,
  packageRoot: string,
  databaseUrl: string
): Promise<PostCommitPrismaResult> {
  const migrationsRoot = resolve(packageRoot, "prisma/migrations");
  const migrations = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const expected = migrations.map((migrationName) => ({
    migrationName,
    checksum: createHash("sha256")
      .update(readFileSync(resolve(migrationsRoot, migrationName, "migration.sql")))
      .digest("hex"),
  }));
  const prisma = resolve(packageRoot, "node_modules/.bin/prisma");
  const env = { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl };

  try {
    for (const migration of migrations) {
      execFileSync(
        prisma,
        ["migrate", "resolve", "--applied", migration, "--schema", "prisma/schema.prisma"],
        { cwd: packageRoot, env, stdio: "pipe" }
      );
    }
    const history = await database.query<LegacyMigrationRow>(
      `SELECT migration_name, checksum, finished_at, rolled_back_at, applied_steps_count, logs
         FROM public."_prisma_migrations" ORDER BY migration_name`
    );
    const validation = validateCleanMigrationHistory(history.rows, expected);
    if (!validation.valid) {
      throw new Error(`clean migration history validation failed: ${validation.blockers.join(",")}`);
    }
    execFileSync(prisma, ["migrate", "status", "--schema", "prisma/schema.prisma"], {
      cwd: packageRoot,
      env,
      stdio: "pipe",
    });
    const before = history.rows.map((row) => `${row.migration_name}:${row.checksum}`).join("\n");
    execFileSync(prisma, ["migrate", "deploy", "--schema", "prisma/schema.prisma"], {
      cwd: packageRoot,
      env,
      stdio: "pipe",
    });
    const afterHistory = await database.query<LegacyMigrationRow>(
      `SELECT migration_name, checksum, finished_at, rolled_back_at, applied_steps_count, logs
         FROM public."_prisma_migrations" ORDER BY migration_name`
    );
    const after = afterHistory.rows.map((row) => `${row.migration_name}:${row.checksum}`).join("\n");
    if (after !== before) throw new Error("Prisma deploy was not a no-op");
    return {
      resolvedMigrations: migrations,
      cleanInitialChecksum: expected[0]!.checksum,
      status: "CLEAN",
      deploy: "NO_OP",
    };
  } catch (error) {
    throw new CutoverFailure(
      "POST_COMMIT_PRISMA_GATE_FAILED",
      error instanceof Error ? error.message : "post-commit Prisma gate failed",
      true
    );
  }
}
