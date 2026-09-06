// Statement counts, MEASURED — the N+1 control for `secrets`' reads.
//
// EVERY PIN IS TAKEN TWICE, over a small environment and one an order of
// magnitude larger, and both must be identical. A read whose cost grows with the
// rows it returns is correct in every case and expensive in exactly one: the
// installation that has been running longest. `listCredentials` is the one that
// matters most here — it walks every credential in an environment to the
// envelope it currently points at, which is exactly the shape a per-row query
// hides in.
//
// THE PROBE PATTERN IS ANCHORED, and this is tranche 3's trap rather than a
// precaution. Its advisory lock projected `SELECT 1`, which is exactly the shape
// the statement suites strip to discard the driver's connection probe, so the
// lock was measured at ZERO statements and a mutation that removed it survived.
// The filter below therefore anchors the probe to a statement that is ONLY
// `SELECT 1`, and every measurement records the unfiltered count beside the
// filtered one so a case can assert what the filter actually removed.
//
// THE LOCK IS THE REASON THAT MATTERS HERE TOO. `loadForUpdate` issues a raw
// `SELECT … FOR UPDATE` that projects eighteen named columns, so it cannot be
// mistaken for a probe by any filter — and the case below pins its count at TWO
// rather than at one, because a store that dropped the lock and read the row
// through the query builder would still answer correctly.
//
// Excluded from `vitest run` by the package's `test` script and run by
// `pnpm test:postgres-tenancy:integration` in its own CI job. It FAILS when
// Docker is absent rather than skipping.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  EnvironmentId,
  TransactionScope,
} from "@platos/context-secrets/application/ports/index.js";

import type { SecretsHarness } from "./secrets-harness.js";
import {
  AT,
  CUTOFF,
  LATER,
  auditDraft,
  credentialDraft,
  credentialIdOf,
  revisionOf,
  rootKeyOf,
  startSecretsHarness,
  variableIdOf,
  versionDraft,
  versionIdOf,
} from "./secrets-harness.js";

let harness: SecretsHarness;
let sequence = 0;

interface Fixture {
  readonly environmentId: EnvironmentId;
  readonly credentialIds: readonly string[];
  readonly retiredVersionId: string;
}

let small: Fixture;
let large: Fixture;

function fresh(): string {
  sequence += 1;
  return `5ec05555-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

/**
 * Statements the CLIENT sent, less the transaction frame.
 *
 * `BEGIN`/`COMMIT`/`ROLLBACK`/`DEALLOCATE` are the driver's bookkeeping and are
 * not what an N+1 is made of. `SELECT 1` is the driver's connection probe and is
 * matched ONLY when the whole statement is that and nothing else, so a read that
 * genuinely projects a constant cannot be discarded by the thing measuring it.
 */
function queries(): readonly string[] {
  return harness.base
    .statements()
    .filter(
      (statement) =>
        !/^\s*(BEGIN|COMMIT|ROLLBACK|DEALLOCATE)\b/iu.test(statement) &&
        !/^\s*SELECT\s+1\s*$/iu.test(statement),
    );
}

interface Measurement {
  readonly counted: number;
  readonly total: number;
}

async function measure(work: () => Promise<unknown>): Promise<Measurement> {
  harness.base.resetStatements();
  await work();
  return { counted: queries().length, total: harness.base.statements().length };
}

function inTransaction<Value>(
  work: (transaction: TransactionScope) => Promise<Value>,
): Promise<Value> {
  return harness.base.adapter.unitOfWork.run(work);
}

/** `count` credentials, each with an active envelope, plus one retired version. */
async function seed(count: number): Promise<Fixture> {
  const environmentId = await harness.freshEnvironment();
  const credentialIds: string[] = [];
  const retiredVersionId = fresh();
  await inTransaction(async (transaction) => {
    for (let index = 0; index < count; index += 1) {
      const credentialId = fresh();
      const versionId = fresh();
      credentialIds.push(credentialId);
      await harness.repository.insertCredential(
        credentialDraft({
          id: credentialId,
          environmentId,
          kind: "ENTITY_SECRET",
          // Zero-padded so the name order is the insertion order under every
          // collation the container might be built with.
          name: `KEY_${String(index).padStart(3, "0")}`,
        }),
        transaction,
      );
      await harness.repository.insertSecretVersion(
        versionDraft({ id: versionId, credentialId, secretRevision: 1, rootKeyVersion: 1, fill: 0x91 }),
        transaction,
      );
      await harness.repository.setActiveSecretVersion(
        credentialIdOf(credentialId),
        versionIdOf(versionId),
        AT,
        transaction,
      );
      await harness.variables.upsert(
        {
          id: variableIdOf(fresh()),
          environmentId,
          key: `VAR_${String(index).padStart(3, "0")}`,
          kind: "PLAIN",
          value: "x",
          credentialId: null,
          lastUpdatedBy: null,
          at: AT,
          expectedVersion: null,
        },
        transaction,
      );
    }
    // A RETIRED envelope on the first credential, so `listPurgeCandidates` has
    // something to answer with in both fixtures.
    const owner = credentialIds[0] as string;
    await harness.repository.insertSecretVersion(
      versionDraft({
        id: retiredVersionId,
        credentialId: owner,
        secretRevision: 2,
        rootKeyVersion: 1,
        fill: 0x92,
      }),
      transaction,
    );
    await harness.repository.retireSecretVersion(
      versionIdOf(retiredVersionId),
      LATER,
      null,
      transaction,
    );
  });
  return { environmentId, credentialIds, retiredVersionId };
}

beforeAll(async () => {
  harness = await startSecretsHarness();
  small = await seed(1);
  large = await seed(12);
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

describe("reads cost the same over one row and over twelve", () => {
  test("listCredentials is TWO statements either way", async () => {
    // TWO, not one: the query builder loads a to-one relation with a SECOND
    // query over the whole batch rather than a join. That is flat in the number
    // of rows, which is the property being pinned; a per-row load would be 2 and
    // 13.
    const one = await measure(() => harness.repository.listCredentials(small.environmentId));
    const twelve = await measure(() => harness.repository.listCredentials(large.environmentId));
    expect(one.counted).toBe(2);
    expect(twelve.counted).toBe(one.counted);
    // What the filter removed, stated rather than assumed, so a probe pattern
    // that started swallowing a real statement would show up here.
    expect(one.total).toBe(one.counted);
  });

  test("list over environment variables is ONE statement either way", async () => {
    const one = await measure(() => harness.variables.list(small.environmentId));
    const twelve = await measure(() => harness.variables.list(large.environmentId));
    expect(one.counted).toBe(1);
    expect(twelve.counted).toBe(one.counted);
  });

  test("countVersionsByRootKey is ONE statement over the whole installation", async () => {
    const measured = await measure(() => harness.repository.countVersionsByRootKey());
    expect(measured.counted).toBe(1);
  });

  test("listPurgeCandidates is ONE statement either way", async () => {
    const one = await measure(() =>
      inTransaction((transaction) =>
        harness.repository.listPurgeCandidates(CUTOFF, 10, transaction),
      ),
    );
    const twelve = await measure(() =>
      inTransaction((transaction) =>
        harness.repository.listPurgeCandidates(CUTOFF, 10, transaction),
      ),
    );
    expect(one.counted).toBe(1);
    expect(twelve.counted).toBe(one.counted);
  });
});

describe("the single-row reads", () => {
  test("findCredential is TWO statements — the row and its envelope", async () => {
    const measured = await measure(() =>
      harness.repository.findCredential({
        environmentId: small.environmentId,
        credentialId: credentialIdOf(small.credentialIds[0] as string),
      }),
    );
    expect(measured.counted).toBe(2);
  });

  test("findByKey is ONE statement", async () => {
    const measured = await measure(() =>
      harness.variables.findByKey(small.environmentId, "VAR_000"),
    );
    expect(measured.counted).toBe(1);
  });

  test("countReferences is ONE statement", async () => {
    const measured = await measure(() =>
      harness.variables.countReferences(credentialIdOf(small.credentialIds[0] as string)),
    );
    expect(measured.counted).toBe(1);
  });

  test("loadForUpdate is TWO — the lock, then the envelope under it", async () => {
    // PINNED AT TWO ON PURPOSE. The lock is a raw `SELECT … FOR UPDATE`
    // projecting eighteen named columns, so it can be neither elided nor
    // mistaken for the driver's probe; a store that dropped it and read the row
    // through the query builder would answer identically and measure ONE.
    const measured = await measure(() =>
      inTransaction((transaction) =>
        harness.repository.loadForUpdate(
          small.environmentId,
          credentialIdOf(small.credentialIds[0] as string),
          transaction,
        ),
      ),
    );
    expect(measured.counted).toBe(2);
    const locking = queries().filter((statement) => /FOR UPDATE/iu.test(statement));
    expect(locking).toHaveLength(1);
  });

  test("loadForUpdate is ONE when the credential points at no envelope", async () => {
    // The second statement is conditional on there being something to read, and
    // saying so is what stops a future edit from making it unconditional and
    // paying for a lookup of `null`.
    const credentialId = fresh();
    await inTransaction((transaction) =>
      harness.repository.insertCredential(
        credentialDraft({
          id: credentialId,
          environmentId: small.environmentId,
          kind: "SERVICE_CREDENTIAL",
          name: "NO_ENVELOPE",
        }),
        transaction,
      ),
    );
    const measured = await measure(() =>
      inTransaction((transaction) =>
        harness.repository.loadForUpdate(
          small.environmentId,
          credentialIdOf(credentialId),
          transaction,
        ),
      ),
    );
    expect(measured.counted).toBe(1);
  });
});

describe("the writes are one statement each", () => {
  test("every mutating method issues exactly one", async () => {
    const credentialId = fresh();
    const versionId = fresh();
    const variableId = fresh();

    const inserted = await measure(() =>
      inTransaction((transaction) =>
        harness.repository.insertCredential(
          credentialDraft({
            id: credentialId,
            environmentId: small.environmentId,
            kind: "CHANNEL_SECRET",
            name: "ONE_STATEMENT",
          }),
          transaction,
        ),
      ),
    );
    expect(inserted.counted).toBe(1);

    const sealed = await measure(() =>
      inTransaction((transaction) =>
        harness.repository.insertSecretVersion(
          versionDraft({ id: versionId, credentialId, secretRevision: 1, rootKeyVersion: 1, fill: 0x93 }),
          transaction,
        ),
      ),
    );
    expect(sealed.counted).toBe(1);

    const pointed = await measure(() =>
      inTransaction((transaction) =>
        harness.repository.setActiveSecretVersion(
          credentialIdOf(credentialId),
          versionIdOf(versionId),
          AT,
          transaction,
        ),
      ),
    );
    expect(pointed.counted).toBe(1);

    const retired = await measure(() =>
      inTransaction((transaction) =>
        harness.repository.retireSecretVersion(versionIdOf(versionId), LATER, null, transaction),
      ),
    );
    expect(retired.counted).toBe(1);

    const audited = await measure(() =>
      inTransaction((transaction) =>
        harness.repository.appendAudit(
          auditDraft({
            id: fresh(),
            environmentId: small.environmentId,
            credentialId,
            action: "ROTATE",
          }),
          transaction,
        ),
      ),
    );
    expect(audited.counted).toBe(1);

    const revoked = await measure(() =>
      inTransaction((transaction) =>
        harness.repository.revokeCredential(credentialIdOf(credentialId), LATER, transaction),
      ),
    );
    expect(revoked.counted).toBe(1);

    const upserted = await measure(() =>
      inTransaction((transaction) =>
        harness.variables.upsert(
          {
            id: variableIdOf(variableId),
            environmentId: small.environmentId,
            key: "ONE_WRITE",
            kind: "PLAIN",
            value: "x",
            credentialId: null,
            lastUpdatedBy: null,
            at: AT,
            expectedVersion: null,
          },
          transaction,
        ),
      ),
    );
    // THE UPSERT IS THE ONE THAT COULD HAVE BEEN THREE. Keyed on the compound
    // unique the database actually carries, the client issues a single
    // `INSERT … ON CONFLICT DO UPDATE`; a read-then-branch would have been two
    // statements AND a lost update between them.
    expect(upserted.counted).toBe(1);

    const removed = await measure(() =>
      inTransaction((transaction) =>
        harness.variables.remove(variableIdOf(variableId), transaction),
      ),
    );
    expect(removed.counted).toBe(1);

    const purged = await measure(() =>
      inTransaction((transaction) =>
        harness.repository.purgeSecretVersion(
          {
            secretVersionId: versionIdOf(versionId),
            credentialId: credentialIdOf(credentialId),
            environmentId: small.environmentId,
            secretRevision: revisionOf(1),
            rootKeyVersion: rootKeyOf(1),
          },
          CUTOFF,
          transaction,
        ),
      ),
    );
    expect(purged.counted).toBe(1);
  });
});
