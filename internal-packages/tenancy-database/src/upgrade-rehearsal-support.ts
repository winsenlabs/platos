// Putting a database into the two states an upgrade rehearsal needs, and saying
// what the ordered migration set IS.
//
// WIN-258 T7. Two suites need this — the binary-level rehearsal in this package
// and the store-level one in `packages/adapters/postgres-tenancy` — and the
// bootstrap is delicate enough that two copies of it would be two different
// bootstraps within a month. The frozen baseline SQL is NOT the initial
// migration this repository ships: it is the initial migration of the release
// that provisioned the legacy database, so the migration runner has to be told
// that the genesis migration is already applied AND told the checksum the legacy
// installation would have recorded. Get either half wrong and `migrate deploy`
// either re-runs the genesis over a populated database or refuses the whole set
// as drifted.
//
// NO CONTAINER LIVES HERE. This module is exported from the package barrel, and
// the barrel is what applications import; a container library reached from it
// would put a test-only dependency into every consumer's module graph. A caller
// brings its own database and hands over a URL.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const packageRoot = resolve(__dirname, "..");
const prismaBinary = resolve(packageRoot, "node_modules/.bin/prisma");
const schemaPath = resolve(packageRoot, "prisma/schema.prisma");
const migrationsRoot = resolve(packageRoot, "prisma/migrations");

/** The genesis migration every installation starts from. */
export const GENESIS_MIGRATION = "00000000000000_initial";

/** The frozen legacy baseline, and the checksum a legacy install recorded. */
export const BASELINE_SQL_PATH = resolve(
  packageRoot,
  "prisma/upgrade-baselines/origin-main/00000000000000_initial.sql",
);
export const BASELINE_SQL_SHA256 =
  "5c43055e8b4d134676d7252ceba59bfe72d90b63c34be03e1807512b30ea19d3";

/** Refused when the on-disk migration set is not a total, gap-free order. */
export const MIGRATION_ORDER_BROKEN = "tenancy.migrations.order_broken";

/** Refused when the frozen baseline SQL no longer hashes to its pin. */
export const MIGRATION_BASELINE_DRIFT = "tenancy.migrations.baseline_drift";

export class MigrationSetError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MigrationSetError";
    this.code = code;
  }
}

export interface OrderedMigration {
  readonly name: string;
  /** The 14-digit stamp the directory name leads with. */
  readonly stamp: string;
  /** sha256 of the migration body, as the runner records it. */
  readonly sha256: string;
}

const MIGRATION_NAME = /^(\d{14})_[a-z0-9]+(?:_[a-z0-9]+)*$/u;

/**
 * The migration set, in the order the runner will apply it, validated.
 *
 * TOTAL means every pair is ordered: no two directories carry the same stamp, so
 * no two are incomparable and no tie is broken by the filesystem. GAP-FREE means
 * the set has no member the runner would skip and no member without a body: each
 * directory holds a `migration.sql`, and nothing else in `prisma/migrations/`
 * looks like a migration without being one. Both are checked here rather than
 * asserted in a suite, because the SAME function is what a suite compares the
 * live `_prisma_migrations` table against — a validator the runner disagreed
 * with would report a healthy set on a database that skipped one.
 *
 * `root` is injectable so each refusal below has a NAMED case that can reach it.
 * A validator whose only input is the repository's own — correct — migration set
 * is a validator none of whose branches can be shown to do anything.
 */
export function orderedMigrations(root: string = migrationsRoot): readonly OrderedMigration[] {
  const entries = readdirSync(root, { withFileTypes: true });
  const files = entries.filter((entry) => !entry.isDirectory()).map((entry) => entry.name);
  const unexpected = files.filter((name) => name !== "migration_lock.toml");
  if (unexpected.length > 0) {
    throw new MigrationSetError(
      MIGRATION_ORDER_BROKEN,
      `prisma/migrations holds ${unexpected.join(", ")}; only migration directories and ` +
        "migration_lock.toml belong there",
    );
  }

  const migrations = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const matched = MIGRATION_NAME.exec(name);
      if (matched === null) {
        throw new MigrationSetError(
          MIGRATION_ORDER_BROKEN,
          `migration directory ${name} is not <14-digit stamp>_<snake_case label>`,
        );
      }
      const body = readFileSync(resolve(root, name, "migration.sql"), "utf8");
      return {
        name,
        stamp: matched[1] as string,
        sha256: createHash("sha256").update(body).digest("hex"),
      };
    });

  const stamps = migrations.map((migration) => migration.stamp);
  const duplicates = stamps.filter((stamp, index) => stamps.indexOf(stamp) !== index);
  if (duplicates.length > 0) {
    throw new MigrationSetError(
      MIGRATION_ORDER_BROKEN,
      `stamp(s) ${[...new Set(duplicates)].join(", ")} are used by more than one migration, so ` +
        "the set has no total order and the filesystem decides which runs first",
    );
  }
  for (let index = 1; index < stamps.length; index += 1) {
    const previous = stamps[index - 1] as string;
    const current = stamps[index] as string;
    if (!(Number(current) > Number(previous))) {
      throw new MigrationSetError(
        MIGRATION_ORDER_BROKEN,
        `lexicographic order puts ${current} after ${previous}, but numerically it does not ` +
          "come later; the two orders disagree",
      );
    }
  }
  if (migrations[0]?.name !== GENESIS_MIGRATION) {
    throw new MigrationSetError(
      MIGRATION_ORDER_BROKEN,
      `the first migration is ${String(migrations[0]?.name)}, not ${GENESIS_MIGRATION}`,
    );
  }
  return migrations;
}

/**
 * Check the frozen baseline SQL and hand back the statements to apply.
 *
 * PURE, AND EXPORTED, for the same reason `verifyFrozenSchema` is: a digest
 * check whose only input is the file it guards has no branch anything can be
 * seen to take. The pinned digest is ALSO the checksum a legacy installation
 * recorded for its genesis migration, which is why the value is one constant and
 * not two — a rehearsal that applied one file and claimed another's checksum
 * would put the database into a state no installation was ever in.
 */
export function verifyFrozenBaseline(sql: string): string {
  const digest = createHash("sha256").update(sql).digest("hex");
  if (digest !== BASELINE_SQL_SHA256) {
    throw new MigrationSetError(
      MIGRATION_BASELINE_DRIFT,
      `the frozen upgrade baseline hashes to ${digest}, not the pinned ${BASELINE_SQL_SHA256}; ` +
        "it is the genesis migration of c25432c5 verbatim and may not be edited",
    );
  }
  return sql;
}

function runPrisma(args: readonly string[], databaseUrl: string): string {
  try {
    return execFileSync(prismaBinary, [...args, "--schema", schemaPath], {
      cwd: packageRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error: unknown) {
    const shell = error as { stdout?: Buffer | string; stderr?: Buffer | string };
    const stdout = Buffer.isBuffer(shell.stdout) ? shell.stdout.toString("utf8") : shell.stdout ?? "";
    const stderr = Buffer.isBuffer(shell.stderr) ? shell.stderr.toString("utf8") : shell.stderr ?? "";
    throw new Error(`${stdout}\n${stderr}`.trim() || "prisma command failed");
  }
}

function executeSql(sql: string, databaseUrl: string): void {
  try {
    execFileSync(prismaBinary, ["db", "execute", "--stdin", "--schema", schemaPath], {
      cwd: packageRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      input: sql,
      stdio: "pipe",
    });
  } catch (error: unknown) {
    const shell = error as { stdout?: Buffer | string; stderr?: Buffer | string };
    const stdout = Buffer.isBuffer(shell.stdout) ? shell.stdout.toString("utf8") : "";
    const stderr = Buffer.isBuffer(shell.stderr) ? shell.stderr.toString("utf8") : "";
    throw new Error(`${stdout}\n${stderr}`.trim() || "prisma db execute failed");
  }
}

/**
 * Put an empty database into the exact shape a legacy installation has.
 *
 * The frozen SQL is applied verbatim and the genesis migration is then recorded
 * as applied WITH THE LEGACY CHECKSUM, because that is the row a legacy
 * installation actually holds. Recording this repository's own genesis checksum
 * instead would hide precisely the drift the rehearsal is for.
 */
export function applyFrozenBaseline(databaseUrl: string): void {
  const sql = verifyFrozenBaseline(readFileSync(BASELINE_SQL_PATH, "utf8"));
  executeSql(sql, databaseUrl);
  runPrisma(["migrate", "resolve", "--applied", GENESIS_MIGRATION], databaseUrl);
  executeSql(
    `UPDATE "_prisma_migrations" SET "checksum" = '${BASELINE_SQL_SHA256}' ` +
      `WHERE "migration_name" = '${GENESIS_MIGRATION}';`,
    databaseUrl,
  );
}

/** Run the ordered set forward. Throws with the runner's own output on refusal. */
export function applyOrderedMigrations(databaseUrl: string): string {
  return runPrisma(["migrate", "deploy"], databaseUrl);
}

/** Apply the whole set to an empty database, genesis included. */
export function applyFromEmpty(databaseUrl: string): string {
  return applyOrderedMigrations(databaseUrl);
}

/** Run one statement outside any client, for a rehearsal's own bookkeeping. */
export function executeRehearsalSql(sql: string, databaseUrl: string): void {
  executeSql(sql, databaseUrl);
}
