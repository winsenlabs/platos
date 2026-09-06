// The optimistic fence on `EnvironmentVariable.version`, held against BOTH stores.
//
// SPLIT OUT OF `secrets-rules.integration.test.ts` BY THAT FILE'S OWN
// INSTRUCTION. Its entry in scripts/arch/max-file-lines.test.mjs, written by
// WIN-258 T7, reads: "A further case takes it past 460 and the split to make
// then is the fence's own `describe`, moved whole." WIN-259 (M2.4) is the
// further case — a DENIED audit outcome reaching PostgreSQL for the first time
// — and this is the `describe`, moved whole and unedited.
//
// WHY THIS SEAM AND NOT ANOTHER. Everything left behind is a rule the DATABASE
// carries and no port method restates: a raise on UPDATE, a re-read from
// inside a write, a foreign key. This block is the one rule that belongs to the
// PORT rather than to the database — a version the caller read, carried back
// into the WHERE clause so a lost update is refused instead of applied — and it
// is asserted against the in-memory double in the same breath, which nothing
// else in the file next door does.
//
// Excluded from `vitest run` by the package's `test` script and run by
// `pnpm test:postgres-tenancy:integration` in its own CI job. It FAILS when
// Docker is absent rather than skipping.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { inMemorySecretsStore } from "@platos/context-secrets/application/index.js";
import type {
  EnvironmentId,
  TransactionScope,
} from "@platos/context-secrets/application/ports/index.js";

import type { SecretsHarness } from "./secrets-harness.js";
import { AT, LATER, startSecretsHarness, variableIdOf } from "./secrets-harness.js";

let harness: SecretsHarness;
let environmentId: EnvironmentId;
let sequence = 0;

function fresh(): string {
  sequence += 1;
  return `5ec04444-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function inTransaction<Value>(
  work: (transaction: TransactionScope) => Promise<Value>,
): Promise<Value> {
  return harness.base.adapter.unitOfWork.run(work);
}

beforeAll(async () => {
  harness = await startSecretsHarness();
  environmentId = await harness.freshEnvironment();
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

describe("both stores key an upsert on [environmentId, key], and the fence says so", () => {
  // WIN-258 T5 wrote this block to record a DIVERGENCE: the adapter keyed on the
  // compound unique the database carries and the double keyed on `input.id`, so
  // a caller handing a fresh id for an existing key got one updated row here and
  // TWO rows in memory. WIN-258 T7 closes it, because a fence cannot be tested
  // against a double that has no row to be stale about — so the claim this block
  // makes is now the opposite one, and it is made against BOTH stores at once.
  test("a FRESH id for an existing key updates the row that is there, on both stores", async () => {
    const firstId = fresh();
    const secondId = fresh();
    await inTransaction((transaction) =>
      harness.variables.upsert(
        {
          id: variableIdOf(firstId),
          environmentId,
          key: "DIVERGENT",
          kind: "PLAIN",
          value: "one",
          credentialId: null,
          lastUpdatedBy: null,
          at: AT,
          expectedVersion: null,
        },
        transaction,
      ),
    );
    const second = await inTransaction((transaction) =>
      harness.variables.upsert(
        {
          id: variableIdOf(secondId),
          environmentId,
          key: "DIVERGENT",
          kind: "PLAIN",
          value: "two",
          credentialId: null,
          lastUpdatedBy: null,
          at: LATER,
          // The version the caller read, not the id it invented.
          expectedVersion: 1,
        },
        transaction,
      ),
    );
    // The store keys on `[environmentId, key]`, which is what the database is
    // unique on, so the second call UPDATES the first row and the id it was
    // handed is not the id it answers with.
    expect(second).toMatchObject({ ok: true, value: { id: firstId, value: "two", version: 2 } });
    const rows = await harness.base.client.environmentVariable.findMany({
      where: { environmentId, key: "DIVERGENT" },
      select: { id: true },
    });
    expect(rows).toEqual([{ id: firstId }]);

    // THE DOUBLE, ASKED THE SAME TWO QUESTIONS. It now answers `firstId` too and
    // holds ONE row, which is the state `EnvironmentVariable_environmentId_key_key`
    // makes the only reachable one.
    const fake = inMemorySecretsStore();
    const scope = { transactionId: "fake" } as never;
    await fake.upsert(
      {
        id: variableIdOf(firstId),
        environmentId,
        key: "DIVERGENT",
        kind: "PLAIN",
        value: "one",
        credentialId: null,
        lastUpdatedBy: null,
        at: AT,
        expectedVersion: null,
      },
      scope,
    );
    const fakeSecond = await fake.upsert(
      {
        id: variableIdOf(secondId),
        environmentId,
        key: "DIVERGENT",
        kind: "PLAIN",
        value: "two",
        credentialId: null,
        lastUpdatedBy: null,
        at: LATER,
        expectedVersion: 1,
      },
      scope,
    );
    expect(fakeSecond).toMatchObject({ ok: true, value: { id: firstId, version: 2 } });
    expect(fake.allVariables()).toHaveLength(1);
  });

  test("a write that thinks the key is FREE is refused once the row exists, on both stores", async () => {
    const held = fresh();
    await inTransaction((transaction) =>
      harness.variables.upsert(
        {
          id: variableIdOf(held),
          environmentId,
          key: "TAKEN",
          kind: "PLAIN",
          value: "one",
          credentialId: null,
          lastUpdatedBy: null,
          at: AT,
          expectedVersion: null,
        },
        transaction,
      ),
    );
    // `expectedVersion: null` says "I read no row for this key". A row is there,
    // so the caller read a state that no longer holds — the same lost update as a
    // stale version, wearing the shape of an insert.
    const refused = await inTransaction((transaction) =>
      harness.variables.upsert(
        {
          id: variableIdOf(fresh()),
          environmentId,
          key: "TAKEN",
          kind: "PLAIN",
          value: "two",
          credentialId: null,
          lastUpdatedBy: null,
          at: LATER,
          expectedVersion: null,
        },
        transaction,
      ),
    );
    expect(refused).toMatchObject({
      ok: false,
      error: { code: "ENVIRONMENT_VARIABLE_VERSION_CONFLICT" },
    });
    // NOTHING WAS WRITTEN, and the row that was there is untouched.
    const rows = await harness.base.client.environmentVariable.findMany({
      where: { environmentId, key: "TAKEN" },
      select: { id: true, value: true, version: true },
    });
    expect(rows).toEqual([{ id: held, value: "one", version: 1 }]);

    const fake = inMemorySecretsStore();
    const scope = { transactionId: "fake" } as never;
    await fake.upsert(
      {
        id: variableIdOf(held),
        environmentId,
        key: "TAKEN",
        kind: "PLAIN",
        value: "one",
        credentialId: null,
        lastUpdatedBy: null,
        at: AT,
        expectedVersion: null,
      },
      scope,
    );
    const fakeRefused = await fake.upsert(
      {
        id: variableIdOf(fresh()),
        environmentId,
        key: "TAKEN",
        kind: "PLAIN",
        value: "two",
        credentialId: null,
        lastUpdatedBy: null,
        at: LATER,
        expectedVersion: null,
      },
      scope,
    );
    expect(fakeRefused).toMatchObject({
      ok: false,
      error: { code: "ENVIRONMENT_VARIABLE_VERSION_CONFLICT" },
    });
    expect(fake.allVariables()).toHaveLength(1);
  });
});
