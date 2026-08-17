import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export interface ExpectedLegacyMigration {
  readonly migrationName: string;
  readonly checksum: string;
}

export interface LegacyMigrationRow {
  readonly [key: string]: unknown;
  readonly migration_name: string;
  readonly checksum: string;
  readonly finished_at: Date | string | null;
  readonly rolled_back_at: Date | string | null;
  readonly applied_steps_count: number | string;
  readonly logs?: string | null;
}

export interface LegacyHistoryValidation {
  readonly recognized: boolean;
  readonly blockers: readonly string[];
  readonly appliedCount: number;
  readonly expectedCount: number;
  readonly historyDigest: string;
}

export function loadExpectedLegacyMigrations(packageRoot: string): readonly ExpectedLegacyMigration[] {
  const migrationsRoot = resolve(packageRoot, "legacy-prisma/migrations");
  return readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const sql = readFileSync(resolve(migrationsRoot, entry.name, "migration.sql"));
      return {
        migrationName: entry.name,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    })
    .sort((left, right) => left.migrationName.localeCompare(right.migrationName));
}

export function validateLegacyMigrationHistory(
  actualRows: readonly LegacyMigrationRow[],
  expectedRows: readonly ExpectedLegacyMigration[]
): LegacyHistoryValidation {
  const blockers: string[] = [];
  const expected = new Map(expectedRows.map((row) => [row.migrationName, row.checksum] as const));
  const actual = new Map<string, LegacyMigrationRow>();

  for (const row of actualRows) {
    if (actual.has(row.migration_name)) blockers.push(`duplicate:${row.migration_name}`);
    actual.set(row.migration_name, row);
    const expectedChecksum = expected.get(row.migration_name);
    if (!expectedChecksum) blockers.push(`unknown:${row.migration_name}`);
    else if (row.checksum !== expectedChecksum) blockers.push(`wrong-checksum:${row.migration_name}`);
    if (row.finished_at === null || Number(row.applied_steps_count) < 1) {
      blockers.push(`failed:${row.migration_name}`);
    }
    if (row.rolled_back_at !== null) blockers.push(`rolled-back:${row.migration_name}`);
  }

  for (const row of expectedRows) {
    if (!actual.has(row.migrationName)) blockers.push(`missing:${row.migrationName}`);
  }

  const historyDigest = createHash("sha256")
    .update(
      [...actualRows]
        .sort((left, right) => left.migration_name.localeCompare(right.migration_name))
        .map((row) => `${row.migration_name}:${row.checksum}:${row.finished_at ? "applied" : "failed"}`)
        .join("\n")
    )
    .digest("hex");

  return {
    recognized: blockers.length === 0,
    blockers: [...new Set(blockers)].sort(),
    appliedCount: actualRows.length,
    expectedCount: expectedRows.length,
    historyDigest,
  };
}

export interface CleanHistoryValidation {
  readonly valid: boolean;
  readonly blockers: readonly string[];
}

export function validateCleanMigrationHistory(
  actualRows: readonly LegacyMigrationRow[],
  expectedRows: readonly ExpectedLegacyMigration[]
): CleanHistoryValidation {
  const validation = validateLegacyMigrationHistory(actualRows, expectedRows);
  return { valid: validation.recognized, blockers: validation.blockers };
}
