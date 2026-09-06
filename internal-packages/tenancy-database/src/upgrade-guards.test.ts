// The refusals the upgrade rehearsal's own machinery makes, each reached.
//
// WIN-258 T7. Everything here guards the rehearsal rather than the product, and
// that is exactly why it needs its own cases: a validator whose only input is
// the repository's own — correct — migration set has no branch a reader can see
// do anything, and a sweep that deleted the branch would find nothing red. Each
// case below builds the broken input the branch exists for.
//
// THE MIGRATION SET'S TWO PROPERTIES ARE SEPARATE CASES. "Total" and "gap-free"
// fail differently and for different reasons: a set with two directories on the
// same stamp is ordered by the filesystem, a set whose lexicographic and numeric
// orders disagree runs in an order nobody reading the names would predict, and a
// stray file beside the directories is something the runner may or may not treat
// as a migration. One case asserting "the real set is fine" would cover none.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import type { UpgradeBaseline, UpgradeBaselineModel } from "./upgrade-baseline-clients";
import {
  columnOf,
  delegateOf,
  soleStoredFieldOnlyIn,
  storedFields,
  UPGRADE_BASELINE_OUTPUT_UNPINNED,
  UPGRADE_BASELINE_SCHEMA_DRIFT,
  UPGRADE_BASELINE_RELEASES,
  UpgradeBaselineError,
  verifyFrozenSchema,
} from "./upgrade-baseline-clients";
import {
  BASELINE_SQL_PATH,
  GENESIS_MIGRATION,
  MIGRATION_BASELINE_DRIFT,
  MIGRATION_ORDER_BROKEN,
  MigrationSetError,
  orderedMigrations,
  verifyFrozenBaseline,
} from "./upgrade-rehearsal-support";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A throwaway migrations directory holding exactly the named migrations. */
function migrationSet(names: readonly string[], extraFiles: readonly string[] = []): string {
  const root = mkdtempSync(resolve(tmpdir(), "pl-t7-migrations-"));
  roots.push(root);
  writeFileSync(resolve(root, "migration_lock.toml"), 'provider = "postgresql"\n');
  for (const name of names) {
    mkdirSync(resolve(root, name), { recursive: true });
    writeFileSync(resolve(root, name, "migration.sql"), `-- ${name}\n`);
  }
  for (const file of extraFiles) writeFileSync(resolve(root, file), "stray\n");
  return root;
}

function refusalCode(work: () => unknown): string {
  try {
    work();
  } catch (error: unknown) {
    if (error instanceof MigrationSetError || error instanceof UpgradeBaselineError) {
      return error.code;
    }
    throw error;
  }
  throw new Error("the input was accepted; this case exists because it must not be");
}

describe("the ordered migration set", () => {
  test("accepts the shape the repository actually ships", () => {
    const set = migrationSet([GENESIS_MIGRATION, "20260824010000_first", "20260825070000_second"]);
    expect(orderedMigrations(set).map((migration) => migration.name)).toEqual([
      GENESIS_MIGRATION,
      "20260824010000_first",
      "20260825070000_second",
    ]);
    // NON-VACUITY. A validator that returned an empty list would satisfy every
    // refusal below without ever reading a migration.
    expect(orderedMigrations(set)[1]?.sha256).toHaveLength(64);
  });

  test("refuses a set whose stamps collide, because the filesystem then decides", () => {
    expect(
      refusalCode(() =>
        orderedMigrations(migrationSet([GENESIS_MIGRATION, "20260824010000_a", "20260824010000_b"])),
      ),
    ).toBe(MIGRATION_ORDER_BROKEN);
  });

  test("orders by name and by number identically, which is why the order is total", () => {
    // DECLARED, NOT KILLED. The name rule forces EXACTLY fourteen digits, and
    // equal-length digit strings sort the same way lexicographically and
    // numerically, so the agreement branch inside `orderedMigrations` cannot be
    // reached by any set the name rule admits. It stays as a tripwire for the
    // day the width rule is relaxed, and the mutation ledger records it as
    // UNFALSIFIABLE rather than counting a kill it did not earn. What is
    // checkable is the property itself, on the set that ships.
    const shipped = orderedMigrations();
    const byName = shipped.map((migration) => migration.stamp);
    const byNumber = [...byName].sort((left, right) => Number(left) - Number(right));
    expect(byName).toEqual(byNumber);
    expect(new Set(byName.map((stamp) => stamp.length))).toEqual(new Set([14]));
  });

  test("refuses a directory that is not a stamp and a snake_case label", () => {
    expect(
      refusalCode(() => orderedMigrations(migrationSet([GENESIS_MIGRATION, "drop_everything"]))),
    ).toBe(MIGRATION_ORDER_BROKEN);
  });

  test("refuses a stray file beside the migration directories", () => {
    expect(
      refusalCode(() => orderedMigrations(migrationSet([GENESIS_MIGRATION], ["notes.sql"]))),
    ).toBe(MIGRATION_ORDER_BROKEN);
  });

  test("refuses a set that does not begin at the genesis migration", () => {
    expect(refusalCode(() => orderedMigrations(migrationSet(["20260824010000_a"])))).toBe(
      MIGRATION_ORDER_BROKEN,
    );
  });

  test("reads the repository's own set, and it satisfies every rule above", () => {
    const shipped = orderedMigrations();
    expect(shipped[0]?.name).toBe(GENESIS_MIGRATION);
    expect(shipped.length).toBeGreaterThan(1);
    expect(new Set(shipped.map((migration) => migration.stamp)).size).toBe(shipped.length);
  });
});

describe("the frozen release schemas", () => {
  const release = UPGRADE_BASELINE_RELEASES["oracle-head"] as (typeof UPGRADE_BASELINE_RELEASES)[string];

  test("refuses a schema that no longer hashes to its pin", () => {
    expect(refusalCode(() => verifyFrozenSchema("edited\n", release))).toBe(
      UPGRADE_BASELINE_SCHEMA_DRIFT,
    );
  });

  test("refuses a schema with no generator output line to redirect", () => {
    // Hashed to its own content, so the digest passes and the SECOND guard is
    // the one reached. Without this the two refusals would be one.
    const source = 'generator client {\n  provider = "prisma-client-js"\n}\n';
    expect(
      refusalCode(() => verifyFrozenSchema(source, { ...release, schemaSha256: sha256(source) })),
    ).toBe(UPGRADE_BASELINE_OUTPUT_UNPINNED);
  });

  test("redirects the generator output, and only that line", () => {
    const source = 'generator client {\n  output          = "../generated/control"\n}\n';
    const redirected = verifyFrozenSchema(source, { ...release, schemaSha256: sha256(source) });
    expect(redirected).toBe('generator client {\n  output          = "./client"\n}\n');
  });

  test("refuses a release nobody froze", () => {
    expect(UPGRADE_BASELINE_RELEASES["no-such-release"]).toBeUndefined();
  });

  test("refuses a frozen baseline SQL that no longer hashes to its pin", () => {
    expect(refusalCode(() => verifyFrozenBaseline("-- edited\n"))).toBe(MIGRATION_BASELINE_DRIFT);
  });

  test("accepts the frozen baseline the repository ships, unchanged", () => {
    const shipped = readFileSync(BASELINE_SQL_PATH, "utf8");
    expect(verifyFrozenBaseline(shipped)).toBe(shipped);
    // NON-VACUITY. An empty file would satisfy an identity check.
    expect(shipped.length).toBeGreaterThan(100_000);
  });
});

describe("addressing a renamed column without spelling it", () => {
  const model = (fields: readonly string[]): UpgradeBaselineModel => ({
    name: "ObservabilityOutbox",
    fields: fields.map((name) => ({
      name,
      kind: "scalar",
      type: "Int",
      isList: false,
      isRequired: true,
      hasDefaultValue: false,
      isId: false,
    })),
  });
  const baselineOf = (fields: readonly string[], name: string): UpgradeBaseline => ({
    release: { name, commit: name, schemaSha256: "0".repeat(64), role: name },
    models: [model(fields)],
    connect: () => {
      throw new Error("this fixture never connects");
    },
  });

  test("finds the one field the older release has and the newer does not", () => {
    const older = baselineOf(["id", "before"], "older");
    const newer = baselineOf(["id", "after"], "newer");
    expect(columnOf(soleStoredFieldOnlyIn(older, newer, "ObservabilityOutbox"))).toBe("before");
    expect(columnOf(soleStoredFieldOnlyIn(newer, older, "ObservabilityOutbox"))).toBe("after");
  });

  test("refuses when the two datamodels differ by more than one stored field", () => {
    const older = baselineOf(["id", "before", "alsoGone"], "older");
    const newer = baselineOf(["id", "after"], "newer");
    expect(refusalCode(() => soleStoredFieldOnlyIn(older, newer, "ObservabilityOutbox"))).toBe(
      UPGRADE_BASELINE_SCHEMA_DRIFT,
    );
  });

  test("refuses when they differ by none, because then there is nothing to rehearse", () => {
    const same = baselineOf(["id", "same"], "same");
    expect(refusalCode(() => soleStoredFieldOnlyIn(same, same, "ObservabilityOutbox"))).toBe(
      UPGRADE_BASELINE_SCHEMA_DRIFT,
    );
  });

  test("refuses a model neither release has", () => {
    const only = baselineOf(["id"], "only");
    expect(refusalCode(() => soleStoredFieldOnlyIn(only, only, "NoSuchModel"))).toBe(
      UPGRADE_BASELINE_SCHEMA_DRIFT,
    );
  });

  test("counts scalar and enum fields and nothing else", () => {
    const withRelation: UpgradeBaselineModel = {
      name: "ObservabilityOutbox",
      fields: [
        { name: "id", kind: "scalar", type: "String", isList: false, isRequired: true, hasDefaultValue: false, isId: true },
        { name: "turn", kind: "object", type: "Turn", isList: false, isRequired: true, hasDefaultValue: false, isId: false },
      ],
    };
    expect(storedFields(withRelation).map((field) => field.name)).toEqual(["id"]);
  });

  test("refuses a delegate the rebuilt client does not expose", () => {
    const client = { $queryRawUnsafe: async () => [], $executeRawUnsafe: async () => 0, $disconnect: async () => {} };
    expect(refusalCode(() => delegateOf(client, "NoSuchModel"))).toBe(
      UPGRADE_BASELINE_SCHEMA_DRIFT,
    );
  });
});

function sha256(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}
