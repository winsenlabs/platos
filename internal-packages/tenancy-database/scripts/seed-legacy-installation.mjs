// PUT A DATABASE INTO THE STATE A LEGACY INSTALLATION IS IN, FROM OUTSIDE ANY
// APPLICATION.
//
// WIN-269 (M4.3). Two suites need the same pre-refactor rows — the reconnect
// proof in `apps/core-api/src/composition` and the live-socket characterization
// in `apps/agent/src/tool-gateway` — and only one of them may hold the ORM.
//
// `scripts/arch/boundary-rules.mjs`'s `tenancy-prisma-only` bans `@prisma/*`,
// `prisma` and `@platos/tenancy-database` from everything outside the two homes
// entitled to a client, and its own comment names `apps/core-api` as inside that
// scan. So the core-api suite cannot IMPORT this fixture, and a copy of it there
// would be a second fixture that agrees until one of them is edited.
//
// A PROCESS IS THE ANSWER, AND IT IS THE HONEST ONE. The legacy binary was a
// process; putting its rows there through its own rebuilt client, in its own
// process, is closer to the thing being rehearsed than any in-process fake. The
// caller spawns this with a `DATABASE_URL` and reads the identifiers back as
// JSON on stdout, exactly as those suites already spawn `prisma migrate deploy`.
//
// WHAT IT DOES, IN THE ORDER `upgrade-rollout-harness.ts` DOES IT:
//
//   1. apply the FROZEN baseline SQL — the initial migration of the release that
//      provisioned the legacy database, not this repository's — and record the
//      checksum that installation would have recorded.
//   2. rebuild that release's OWN Prisma client and write the fixture through it,
//      so no row can name a column the release did not have.
//   3. run the ordered migration set forward.
//
// It writes NOTHING of its own. Every row comes from `seedAsLegacyBinary`, which
// both rehearsal suites already share, so this script cannot drift from them.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const databaseUrl = process.argv[2] ?? process.env["DATABASE_URL"];
if (typeof databaseUrl !== "string" || databaseUrl.trim() === "") {
  process.stderr.write(
    "usage: node scripts/seed-legacy-installation.mjs <database-url>\n" +
      "  (or set DATABASE_URL). The database must be EMPTY: the frozen baseline is\n" +
      "  applied to it as a genesis migration.\n",
  );
  process.exit(2);
}

// Built output, not source. The package has no `exports` map, so these resolve;
// the rollout harness in `packages/adapters/postgres-tenancy` reaches the same
// three modules by the same paths and for the same reason.
const { rebuildUpgradeBaseline, soleStoredFieldOnlyIn } = await import(
  resolve(packageRoot, "dist/upgrade-baseline-clients.js")
);
const { ROLLOUT_IDS, LEGACY_RETRY_COUNT, seedAsLegacyBinary } = await import(
  resolve(packageRoot, "dist/upgrade-fixture.js")
);
const { applyFrozenBaseline, applyOrderedMigrations, BASELINE_SQL_PATH, BASELINE_SQL_SHA256 } =
  await import(resolve(packageRoot, "dist/upgrade-rehearsal-support.js"));

// READ BACK BEFORE ANYTHING IS WRITTEN. `applyFrozenBaseline` verifies the digest
// itself and refuses on drift; this reads the file a second time only so the
// caller can be handed the pin it was seeded under, which is what lets a suite
// assert it is talking about the baseline it thinks it is.
const baselineBytes = readFileSync(BASELINE_SQL_PATH, "utf8").length;

const oracleHead = await rebuildUpgradeBaseline("oracle-head");
const legacyRelease = await rebuildUpgradeBaseline("origin-main");
// The retry counter's column is renamed by the ordered set, so the fixture takes
// the field rather than spelling either name. Derived from the difference
// between the two frozen datamodels, exactly as the rollout harness derives it.
const retryCounter = soleStoredFieldOnlyIn(legacyRelease, oracleHead, "ObservabilityOutbox");

applyFrozenBaseline(databaseUrl);
const legacyClient = legacyRelease.connect(databaseUrl);
try {
  await seedAsLegacyBinary(legacyClient, retryCounter);
} finally {
  await legacyClient.$disconnect();
}
applyOrderedMigrations(databaseUrl);

process.stdout.write(
  `${JSON.stringify({
    ids: ROLLOUT_IDS,
    legacyRetryCount: LEGACY_RETRY_COUNT,
    baselineSha256: BASELINE_SQL_SHA256,
    baselineBytes,
    legacyRelease: legacyRelease.release.commit,
  })}\n`,
);
