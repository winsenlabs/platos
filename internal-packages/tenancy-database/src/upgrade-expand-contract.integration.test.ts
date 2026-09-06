// The rehearsal WIN-258's acceptance asks for and no tranche has run: the OLD
// binary and the V1 binary, both pointed at ONE database that has taken the
// whole ordered migration set, each reading what the other wrote.
//
// WHAT WAS OFFERED BEFORE, AND WHY IT IS NOT THIS. Every tranche so far closed
// the "expand/contract compatible during rollout" clause with an argument of the
// form "the migrations add and never remove, so by construction nothing old can
// break". `upgrade-rehearsal.integration.test.ts` beside this file rehearses the
// FORWARD direction — a legacy database taking the migrations and then serving
// the V1 runtime — which is the upgrade, not the rollout. The rollout is the
// window in which BOTH binaries are live, and nothing in the tree had ever had
// an old binary's client in the same process as a migrated database.
//
// TWO OLD BINARIES, BECAUSE THE CLAUSE HAS TWO READINGS.
//
//   oracle-head  — origin/main at 89c12b8a. The rollout partner: the release
//                  being replaced. Expected to be wholly compatible.
//   origin-main  — c25432c5, the release whose genesis migration IS the frozen
//                  baseline SQL. The legacy upgrade path: a database that never
//                  ran a post-genesis migration, and the binary that wrote it.
//
// WHAT THE REAL DATABASE SAID. The measured catalogue difference is NOT a pure
// expansion. Six operations in it narrow what a binary predating them may do,
// and each is pinned below as a NAMED case rather than smoothed over: a column
// rename on ObservabilityOutbox, three ownership columns made mandatory without
// a default, one unique index replaced by a wider one, and a value rewrite over
// `Memory` rows fenced by two new CHECKs. The rollout partner survives all six
// because it already ships them; the legacy binary does not, and the rehearsal
// says so with an SQLSTATE instead of a caveat.
//
// THE DECLARED SET IS CHECKED BOTH WAYS. Every measured operation outside a pure
// expansion has to appear in `CONTRACT_OPERATIONS`, and every entry there has to
// be observed. A one-way check would pass on a database where the migrations did
// nothing at all.

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { PrismaClient } from "../generated/control";
import type {
  UpgradeBaseline,
  UpgradeBaselineClient,
  UpgradeBaselineField,
} from "./upgrade-baseline-clients";
import {
  columnOf,
  delegateOf,
  rebuildUpgradeBaseline,
  soleStoredFieldOnlyIn,
  storedFields,
} from "./upgrade-baseline-clients";
import type { Catalogue, CatalogueDifference } from "./upgrade-catalogue";
import { compareCatalogues, isMandatoryWithoutDefault, readCatalogue } from "./upgrade-catalogue";
import { LEGACY_RETRY_COUNT, ROLLOUT_IDS, seedAsLegacyBinary } from "./upgrade-fixture";
import {
  applyFrozenBaseline,
  applyOrderedMigrations,
  orderedMigrations,
} from "./upgrade-rehearsal-support";

const ids = ROLLOUT_IDS;
const AT = new Date("2026-05-01T09:00:00.000Z");

/** Rows the V1 binary writes into the same database, after the upgrade. */
const v1Ids = {
  fork: "31000000-0000-4000-8000-000000000001",
  execution: "31000000-0000-4000-8000-000000000002",
  request: "31000000-0000-4000-8000-000000000003",
  handle: "31000000-0000-4000-8000-000000000004",
  grant: "31000000-0000-4000-8000-000000000005",
  attachment: "31000000-0000-4000-8000-000000000006",
} as const;

/** Rows the legacy binary tries to write AFTER the upgrade, and may not. */
const refusedIds = {
  attachment: "32000000-0000-4000-8000-000000000001",
  policy: "32000000-0000-4000-8000-000000000002",
} as const;

/**
 * The operations the upgrade performs that are NOT pure expansion.
 *
 * "Pure expansion" means an addition an old writer can ignore: a new table, a
 * nullable column, a NOT NULL column carrying a DEFAULT, a new index. Anything
 * else narrows what a binary that predates it may do, and every one is named
 * here with the release it breaks. The renamed column is DERIVED from the two
 * frozen datamodels rather than spelled, so the case cannot pass on a database
 * where a different column was renamed instead.
 */
const CONTRACT_OPERATIONS = [
  {
    id: "observability-outbox-column-rename",
    table: "ObservabilityOutbox",
    kind: "column-renamed",
    brokenFor: "origin-main",
  },
  {
    id: "message-attachment-agent-owner-mandatory",
    table: "MessageAttachment",
    kind: "column-mandatory",
    column: "agentId",
    brokenFor: "origin-main",
  },
  {
    id: "message-attachment-thread-owner-mandatory",
    table: "MessageAttachment",
    kind: "column-mandatory",
    column: "threadId",
    brokenFor: "origin-main",
  },
  {
    id: "entity-tool-policy-environment-owner-mandatory",
    table: "EntityToolPolicy",
    kind: "column-mandatory",
    column: "environmentId",
    brokenFor: "origin-main",
  },
  {
    id: "entity-tool-policy-uniqueness-widened",
    table: "EntityToolPolicy",
    kind: "index-dropped",
    index: "EntityToolPolicy_entityId_toolId_key",
    brokenFor: "origin-main",
  },
  {
    id: "memory-vocabulary-rewritten",
    table: "Memory",
    kind: "values-rewritten",
    constraints: ["Memory_source_check", "Memory_visibility_check"],
    brokenFor: "origin-main",
  },
] as const;

/** Tables the upgrade introduces. Invisible to a binary that predates them. */
const ADDED_TABLES = ["AccessKeyBootstrapGrant", "PostmanExecution"] as const;

const mandatoryColumns = CONTRACT_OPERATIONS.filter(
  (operation): operation is Extract<(typeof CONTRACT_OPERATIONS)[number], { column: string }> =>
    operation.kind === "column-mandatory",
);
const droppedIndexes = CONTRACT_OPERATIONS.filter(
  (operation): operation is Extract<(typeof CONTRACT_OPERATIONS)[number], { index: string }> =>
    operation.kind === "index-dropped",
);
const fencedConstraints = CONTRACT_OPERATIONS.flatMap((operation) =>
  operation.kind === "values-rewritten" ? [...operation.constraints] : [],
);

describe.runIf(process.env.CI === "true")("WIN-258 T7 expand/contract rollout rehearsal", () => {
  let container: StartedPostgreSqlContainer;
  let v1: PrismaClient;
  let oracleHead: UpgradeBaseline;
  let legacyRelease: UpgradeBaseline;
  let oracleHeadClient: UpgradeBaselineClient;
  let legacyClient: UpgradeBaselineClient;
  let baseline: Catalogue;
  let migrated: Catalogue;
  let difference: CatalogueDifference;
  let renamedColumn: UpgradeBaselineField;
  let replacementColumn: UpgradeBaselineField;

  beforeAll(async () => {
    oracleHead = await rebuildUpgradeBaseline("oracle-head");
    legacyRelease = await rebuildUpgradeBaseline("origin-main");
    renamedColumn = soleStoredFieldOnlyIn(legacyRelease, oracleHead, "ObservabilityOutbox");
    replacementColumn = soleStoredFieldOnlyIn(oracleHead, legacyRelease, "ObservabilityOutbox");

    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    const databaseUrl = container.getConnectionUri();
    applyFrozenBaseline(databaseUrl);

    legacyClient = legacyRelease.connect(databaseUrl);
    await seedAsLegacyBinary(legacyClient, renamedColumn);
    baseline = await readCatalogue(legacyClient);

    applyOrderedMigrations(databaseUrl);

    v1 = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    migrated = await readCatalogue(v1);
    difference = compareCatalogues(baseline, migrated);
    oracleHeadClient = oracleHead.connect(databaseUrl);
    await writeAsV1Binary(v1);
  }, 900_000);

  afterAll(async () => {
    await oracleHeadClient?.$disconnect();
    await legacyClient?.$disconnect();
    await v1?.$disconnect();
    await container?.stop();
  });

  test("the ordered migration set is total and gap-free, and the database applied exactly it", async () => {
    const ordered = orderedMigrations();
    expect(ordered.length).toBeGreaterThan(1);

    // ORDER BY started_at, not by name: the claim is that the runner applied the
    // set in the order the set declares. A set applied out of order sorts
    // identically and would satisfy a name-ordered comparison.
    const applied = await v1.$queryRawUnsafe<Array<{ name: string; checksum: string }>>(
      'SELECT "migration_name" AS name, "checksum" FROM "_prisma_migrations" ' +
        'WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL ORDER BY "started_at"',
    );
    expect(applied.map((row) => row.name)).toEqual(ordered.map((migration) => migration.name));

    // The genesis row carries the LEGACY checksum, because the legacy release
    // provisioned this database. Every later row carries this repository's own.
    for (const migration of ordered.slice(1)) {
      const row = applied.find((candidate) => candidate.name === migration.name);
      expect({ name: migration.name, checksum: row?.checksum }).toEqual({
        name: migration.name,
        checksum: migration.sha256,
      });
    }
  });

  test("the measured catalogue difference holds no operation outside the declared set", () => {
    // NON-VACUITY FIRST. A difference that measured nothing would satisfy every
    // subset check below it.
    expect(difference.columns.added.length).toBeGreaterThan(0);
    expect(difference.constraints.added.length).toBeGreaterThan(0);
    expect(difference.routines.added.length).toBeGreaterThan(0);

    const addedTables = new Set<string>(ADDED_TABLES);
    const narrowing = difference.columns.added.filter(
      (column) => !addedTables.has(column.table) && isMandatoryWithoutDefault(column),
    );
    expect(narrowing.map((column) => `${column.table}.${column.column}`).sort()).toEqual(
      mandatoryColumns.map((operation) => `${operation.table}.${operation.column}`).sort(),
    );

    // A column that DISAPPEARED is a rename or a drop; either way an old SELECT
    // stops working. Exactly one is expected, and it is the derived one.
    expect(difference.columns.removed.map((column) => `${column.table}.${column.column}`)).toEqual([
      `ObservabilityOutbox.${columnOf(renamedColumn)}`,
    ]);
    expect(
      difference.columns.added.some(
        (column) =>
          column.table === "ObservabilityOutbox" && column.column === columnOf(replacementColumn),
      ),
    ).toBe(true);

    // A column whose type or nullability changed IN PLACE narrows an old reader.
    // None is expected: the ownership columns arrive already NOT NULL.
    expect(difference.columns.changed.map((change) => `${change.after.table}.${change.after.column}`))
      .toEqual([]);

    // A dropped index changes what a duplicate write means.
    expect(difference.indexes.removed.map((index) => index.name).sort()).toEqual(
      droppedIndexes.map((operation) => operation.index).sort(),
    );

    // Every CHECK the declared set names actually landed, and nothing was lost.
    const added = new Set(difference.constraints.added.map((item) => item.name));
    for (const constraint of fencedConstraints) {
      expect({ constraint, present: added.has(constraint) }).toEqual({ constraint, present: true });
    }
    expect(difference.constraints.removed.map((item) => item.name)).toEqual([]);
    expect(difference.routines.removed).toEqual([]);
  });

  test("the rollout partner can SELECT every table it knows, on the migrated database", async () => {
    const failures: string[] = [];
    for (const model of oracleHead.models) {
      try {
        await delegateOf(oracleHeadClient, model.name).findMany({ take: 1 });
      } catch (error: unknown) {
        failures.push(`${model.name}: ${describeError(error)}`);
      }
    }
    expect(failures).toEqual([]);
    // NON-VACUITY. A datamodel this sweep found empty would pass silently.
    expect(oracleHead.models.length).toBeGreaterThan(100);
  }, 600_000);

  test("every physical column the rollout partner names survived, with its shape", () => {
    const byKey = new Map(
      migrated.columns.map((column) => [`${column.table}.${column.column}`, column]),
    );
    const missing: string[] = [];
    const loosened: string[] = [];
    for (const model of oracleHead.models) {
      const table = model.dbName ?? model.name;
      for (const field of storedFields(model)) {
        const key = `${table}.${columnOf(field)}`;
        const column = byKey.get(key);
        if (column === undefined) missing.push(key);
        else if (column.isNullable && field.isRequired && !field.hasDefaultValue) {
          loosened.push(`${key} is nullable under a field the old client requires`);
        }
      }
    }
    expect(missing).toEqual([]);
    expect(loosened).toEqual([]);
  });

  test("the legacy binary's SELECT is refused on exactly the renamed column's table", async () => {
    const failures: Array<{ model: string; message: string }> = [];
    for (const model of legacyRelease.models) {
      try {
        await delegateOf(legacyClient, model.name).findMany({ take: 1 });
      } catch (error: unknown) {
        failures.push({ model: model.name, message: describeError(error) });
      }
    }
    expect(failures.map((failure) => failure.model)).toEqual(["ObservabilityOutbox"]);
    // The refusal has to NAME the column that went, or the case would pass on a
    // refusal that came from anything at all.
    expect(failures[0]?.message).toContain(columnOf(renamedColumn));
  }, 600_000);

  test("the legacy binary's INSERT is refused wherever the upgrade made a column mandatory", async () => {
    await expect(
      delegateOf(legacyClient, "MessageAttachment").create({
        data: {
          id: refusedIds.attachment,
          environmentId: ids.environment,
          endUserId: ids.endUser,
          turnId: ids.turn,
          kind: "document",
          mimeType: "text/plain",
          bytes: 11,
          storageKey: "legacy-writer-after-upgrade",
        },
      }),
    ).rejects.toThrow(/agentId|threadId|null value|not-null/i);

    await expect(
      delegateOf(legacyClient, "EntityToolPolicy").create({
        data: {
          id: refusedIds.policy,
          entityId: ids.entity,
          toolId: ids.tool,
          effect: "DENY",
          minIdentityMode: "oidc",
          addedBy: "legacy-writer-after-upgrade",
        },
      }),
    ).rejects.toThrow(/environmentId|null value|not-null/i);
  });

  test("the legacy binary's vocabulary is fenced, and the rows it wrote were rewritten", async () => {
    await expect(
      delegateOf(legacyClient, "Memory").create({
        data: {
          environmentId: ids.environment,
          endUserId: ids.endUser,
          agentId: ids.agent,
          kind: "fact",
          content: "written after the upgrade in the old vocabulary",
          visibility: "subject",
          agentVisible: false,
          source: "turn",
        },
      }),
    ).rejects.toThrow(/Memory_source_check|Memory_visibility_check|constraint/i);

    // And the row it wrote BEFORE the upgrade no longer reads back as written.
    const stored = await v1.$queryRawUnsafe<Array<{ source: string; visibility: string }>>(
      'SELECT "source", "visibility" FROM "Memory" WHERE "id" = $1::uuid',
      ids.memory,
    );
    expect(stored).toEqual([{ source: "extracted", visibility: "private" }]);
  });

  test("the rollout partner reads back, field for field, the rows the V1 binary wrote", async () => {
    await expect(
      delegateOf(oracleHeadClient, "Thread").findUnique({ where: { id: v1Ids.fork } }),
    ).resolves.toMatchObject({
      id: v1Ids.fork,
      parentThreadId: ids.thread,
      forkedUpToTurnId: ids.turn,
      forkedTurnIds: [ids.turn],
      title: "V1 fork",
    });

    await expect(
      delegateOf(oracleHeadClient, "MessageAttachment").findUnique({
        where: { id: v1Ids.attachment },
      }),
    ).resolves.toMatchObject({
      environmentId: ids.environment,
      endUserId: ids.endUser,
      agentId: ids.agent,
      threadId: ids.thread,
      turnId: ids.turn,
      storageKey: "written-by-v1",
    });

    await expect(
      delegateOf(oracleHeadClient, "PostmanExecution").findUnique({
        where: { id: v1Ids.execution },
      }),
    ).resolves.toMatchObject({ id: v1Ids.execution, turnId: ids.turn });

    await expect(
      delegateOf(oracleHeadClient, "Environment").findUnique({ where: { id: ids.environment } }),
    ).resolves.toMatchObject({ accessKeyRevocationVersion: 7 });

    // The retry count the legacy binary set under the old name reads back under
    // the new one, with its value carried across the rename.
    const outbox = await delegateOf(oracleHeadClient, "ObservabilityOutbox").findUnique({
      where: { id: ids.outbox },
    });
    expect(outbox?.[replacementColumn.name]).toBe(LEGACY_RETRY_COUNT);
  });

  test("a table the upgrade introduced is invisible to the rollout partner, not broken for it", async () => {
    const known = new Set(oracleHead.models.map((model) => model.dbName ?? model.name));
    expect(ADDED_TABLES.filter((table) => !known.has(table))).toEqual([
      "AccessKeyBootstrapGrant",
    ]);
    const grants = await v1.$queryRawUnsafe<Array<{ count: bigint }>>(
      'SELECT count(*)::bigint AS count FROM "AccessKeyBootstrapGrant"',
    );
    expect(Number(grants[0]?.count)).toBe(1);
  });
});

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What the V1 binary writes into the SAME database, after the upgrade. */
async function writeAsV1Binary(client: PrismaClient): Promise<void> {
  await client.thread.create({
    data: {
      id: v1Ids.fork,
      environmentId: ids.environment,
      agentId: ids.agent,
      endUserId: ids.endUser,
      parentThreadId: ids.thread,
      forkedUpToTurnId: ids.turn,
      forkedTurnIds: [ids.turn],
      title: "V1 fork",
    },
  });
  await client.messageAttachment.create({
    data: {
      id: v1Ids.attachment,
      environmentId: ids.environment,
      endUserId: ids.endUser,
      agentId: ids.agent,
      threadId: ids.thread,
      turnId: ids.turn,
      kind: "document",
      mimeType: "text/plain",
      bytes: 23,
      storageKey: "written-by-v1",
    },
  });
  await client.postmanExecution.create({
    data: {
      id: v1Ids.execution,
      environmentId: ids.environment,
      agentId: ids.agent,
      requestId: v1Ids.request,
      requestFingerprint: "ab".repeat(32),
      actorUserId: ids.user,
      simulatedEndUserId: ids.endUser,
      contextHandle: v1Ids.handle,
      contextExpiresAt: AT,
      threadId: ids.thread,
      turnId: ids.turn,
    },
  });
  await client.environment.update({
    where: { id: ids.environment },
    data: { accessKeyRevocationVersion: 7 },
  });
  await client.accessKeyBootstrapGrant.create({
    data: {
      id: v1Ids.grant,
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
      tokenFingerprint: "cd".repeat(32),
    },
  });
}
