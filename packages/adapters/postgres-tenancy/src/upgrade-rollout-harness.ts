// A container holding a LEGACY database that has since taken the whole ordered
// migration set — with the V1 stores and the old binary's client both open on
// it at once.
//
// WIN-258 T7. Every other harness in this directory starts from
// `prisma migrate deploy` on an EMPTY database, which is the clean-install
// shape. No suite in the tree had ever pointed the stores at a database whose
// rows were written by a release that predates the migrations, and that is the
// half of the acceptance clause the store layer owns: the V1 stores reading rows
// written WITHOUT any column added since the baseline.
//
// THE LEGACY ROWS COME FROM `@platos/tenancy-database`, and are written by that
// release's OWN rebuilt client rather than by SQL this package composed. A
// hand-written INSERT is a statement somebody believed the old binary would
// emit; a create through the old client cannot name a column that release did
// not have. The fixture is shared with the binary-level rehearsal in that
// package so the two suites cannot drift onto different legacy databases.
//
// IT FAILS WHEN DOCKER IS ABSENT rather than skipping, for the same reason
// `harness.ts` beside it does: a skipped integration suite and a passing one
// look identical in a CI summary.

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

// THE REHEARSAL SURFACE COMES BY MODULE PATH, NOT THROUGH THE BARREL, and the
// reason is measured rather than stylistic: these three modules `spawnSync` the
// Prisma CLI and read the migrations directory, so they import
// `node:child_process`, `node:fs` and `node:url` at the top level. Re-exporting
// them from `@platos/tenancy-database`'s entry point puts them in the Remix
// BROWSER bundle of every `apps/webapp` route that names an enum from that
// package, and the webapp image build refuses it outright. The package has no
// `exports` map — `apps/agent` deep-imports the generated client's runtime
// library and adding one would refuse that — so these paths resolve.
import {
  delegateOf,
  rebuildUpgradeBaseline,
  soleStoredFieldOnlyIn,
  type UpgradeBaseline,
  type UpgradeBaselineClient,
} from "@platos/tenancy-database/dist/upgrade-baseline-clients.js";
import { ROLLOUT_IDS, seedAsLegacyBinary } from "@platos/tenancy-database/dist/upgrade-fixture.js";
import {
  applyFrozenBaseline,
  applyOrderedMigrations,
} from "@platos/tenancy-database/dist/upgrade-rehearsal-support.js";

import type { PostgresTenancyAdapter } from "./adapter.js";
import { buildPostgresTenancyAdapter } from "./adapter.js";
import type { TenancyDatabaseClient } from "./client.js";

export interface RolloutHarness {
  /** The V1 stores, over the migrated legacy database. */
  readonly adapter: PostgresTenancyAdapter;
  /** The V1 client, for the assertions that are about rows rather than ports. */
  readonly client: TenancyDatabaseClient;
  /**
   * origin/main HEAD's client, open on the SAME database.
   *
   * This is what makes the second direction a rehearsal rather than a claim: a
   * row the V1 stores write is read back by the binary being replaced, in the
   * same process, over the same rows.
   */
  readonly rolloutPartner: UpgradeBaselineClient;
  readonly rolloutPartnerDatamodel: UpgradeBaseline;
  /** One delegate off the rollout partner's client, by model name. */
  partnerRow(modelName: string, id: string): Promise<Record<string, unknown> | null>;
  stop(): Promise<void>;
}

export async function startRolloutHarness(): Promise<RolloutHarness> {
  const oracleHead = await rebuildUpgradeBaseline("oracle-head");
  const legacyRelease = await rebuildUpgradeBaseline("origin-main");
  const retryCounter = soleStoredFieldOnlyIn(legacyRelease, oracleHead, "ObservabilityOutbox");

  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    "pgvector/pgvector:pg16",
  ).start();
  const databaseUrl = container.getConnectionUri();

  applyFrozenBaseline(databaseUrl);
  const legacyClient = legacyRelease.connect(databaseUrl);
  await seedAsLegacyBinary(legacyClient, retryCounter);
  await legacyClient.$disconnect();

  applyOrderedMigrations(databaseUrl);

  const { PrismaClient } = await import("@platos/tenancy-database");
  const client = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  }) as TenancyDatabaseClient;
  const adapter = buildPostgresTenancyAdapter(client);
  const rolloutPartner = oracleHead.connect(databaseUrl);

  return {
    adapter,
    client,
    rolloutPartner,
    rolloutPartnerDatamodel: oracleHead,
    partnerRow: (modelName: string, id: string) =>
      delegateOf(rolloutPartner, modelName).findUnique({ where: { id } }),
    async stop(): Promise<void> {
      await rolloutPartner.$disconnect();
      await adapter.close();
      await container.stop();
    },
  };
}

/** The legacy rows' identifiers, re-exported so a suite names them once. */
export { ROLLOUT_IDS };
