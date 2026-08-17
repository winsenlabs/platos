import { describe, expect, test } from "vitest";
import {
  validateCleanMigrationHistory,
  validateLegacyMigrationHistory,
  type ExpectedLegacyMigration,
  type LegacyMigrationRow,
} from "./cutover-history";

const expected: readonly ExpectedLegacyMigration[] = [
  { migrationName: "001_initial", checksum: "a".repeat(64) },
  { migrationName: "002_latest", checksum: "b".repeat(64) },
];

function applied(
  migrationName: string,
  checksum: string,
  overrides: Partial<LegacyMigrationRow> = {}
): LegacyMigrationRow {
  return {
    migration_name: migrationName,
    checksum,
    finished_at: "2026-08-17T00:00:00.000Z",
    rolled_back_at: null,
    applied_steps_count: 1,
    logs: null,
    ...overrides,
  };
}

describe("recognized cutover migration histories", () => {
  test("accepts only the complete known lineage with exact checksums", () => {
    const result = validateLegacyMigrationHistory(
      [applied("001_initial", "a".repeat(64)), applied("002_latest", "b".repeat(64))],
      expected
    );
    expect(result).toMatchObject({ recognized: true, blockers: [], appliedCount: 2, expectedCount: 2 });
    expect(result.historyDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("fails closed for failed and rolled-back history", () => {
    const result = validateLegacyMigrationHistory(
      [
        applied("001_initial", "a".repeat(64), { finished_at: null, applied_steps_count: 0 }),
        applied("002_latest", "b".repeat(64), { rolled_back_at: "2026-08-17T01:00:00Z" }),
      ],
      expected
    );
    expect(result.recognized).toBe(false);
    expect(result.blockers).toEqual([
      "failed:001_initial",
      "rolled-back:002_latest",
    ]);
  });

  test("fails closed for unknown history and wrong checksums", () => {
    const result = validateLegacyMigrationHistory(
      [
        applied("001_initial", "0".repeat(64)),
        applied("002_latest", "b".repeat(64)),
        applied("003_unknown", "c".repeat(64)),
      ],
      expected
    );
    expect(result.blockers).toEqual([
      "unknown:003_unknown",
      "wrong-checksum:001_initial",
    ]);
  });

  test("fails closed for partial or missing clean history", () => {
    expect(
      validateCleanMigrationHistory([applied("001_initial", "a".repeat(64))], expected)
    ).toEqual({ valid: false, blockers: ["missing:002_latest"] });
    expect(validateCleanMigrationHistory([], expected)).toEqual({
      valid: false,
      blockers: ["missing:001_initial", "missing:002_latest"],
    });
  });
});
