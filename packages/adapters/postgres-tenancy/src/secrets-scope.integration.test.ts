// The clauses that decide WHICH ROW a call reaches, and the lock that stops two
// sweeps reaching the same one.
//
// EVERY CASE HERE EXISTS BECAUSE A MUTATION SURVIVED WITHOUT IT. The guard
// ledger beside this package requires each entry to be killed by a NAMED case,
// and six of the store's clauses had none anywhere in the tree:
//
//   * `loadForUpdate`'s `AND "environmentId" = …`. Without it a caller in one
//     environment locks and reads a credential in another — the one failure in
//     this store that crosses a tenant boundary.
//   * `findCredential`'s total order. Without it `findFirst` answers with
//     whichever row the planner reached, and two calls over one unchanged table
//     can differ.
//   * `listPurgeCandidates`' `readableUntil` clause. `readableUntil` is a
//     purge-DEFERRAL window and `domain/secret-version.ts` says so in as many
//     words; without the clause an envelope an operator deliberately retained is
//     destroyed on the next sweep.
//   * `listPurgeCandidates`' `retiredAt <= cutoff`. Without it a version retired
//     SECONDS ago is swept by a sweep whose cutoff is a day old.
//   * `purgeSecretVersion`'s own copy of both clauses, re-checked INSIDE the
//     delete, which is the only place they can be checked without a race.
//   * `FOR UPDATE OF version`. Without it two concurrent sweeps hand the same
//     candidate to two callers, and the second one's delete finds nothing.
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
  credentialDraft,
  credentialIdOf,
  revisionOf,
  rootKeyOf,
  startSecretsHarness,
  versionDraft,
  versionIdOf,
} from "./secrets-harness.js";

/** Well after `CUTOFF`. A retention window reaching here defers a purge. */
const RETAINED_UNTIL = new Date("2026-06-01T09:00:00.000Z");

/** Also after `CUTOFF`. A version retired here is younger than the sweep. */
const RETIRED_LATE = new Date("2026-05-03T09:00:00.000Z");

let harness: SecretsHarness;
let environmentId: EnvironmentId;
let otherEnvironmentId: EnvironmentId;
let sequence = 0;

function fresh(): string {
  sequence += 1;
  return `5ec08888-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function inTransaction<Value>(
  work: (transaction: TransactionScope) => Promise<Value>,
): Promise<Value> {
  return harness.base.adapter.unitOfWork.run(work);
}

const settle = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

function gate(): { readonly wait: Promise<void>; open(): void } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/**
 * A credential with ONE retired envelope and no active one.
 *
 * `retiredAt` and `readableUntil` are the two clauses under test, so both are
 * parameters rather than fixed.
 */
async function retiredEnvelope(
  where: EnvironmentId,
  name: string,
  retiredAt: Date,
  readableUntil: Date | null,
): Promise<{ readonly credentialId: string; readonly versionId: string }> {
  const credentialId = fresh();
  const versionId = fresh();
  await inTransaction(async (transaction) => {
    await harness.repository.insertCredential(
      credentialDraft({ id: credentialId, environmentId: where, kind: "ENTITY_SECRET", name }),
      transaction,
    );
    await harness.repository.insertSecretVersion(
      versionDraft({ id: versionId, credentialId, secretRevision: 1, rootKeyVersion: 1, fill: 0xa1 }),
      transaction,
    );
    await harness.repository.retireSecretVersion(
      versionIdOf(versionId),
      retiredAt,
      readableUntil,
      transaction,
    );
  });
  return { credentialId, versionId };
}

async function candidateIds(): Promise<readonly string[]> {
  const found = await inTransaction((transaction) =>
    harness.repository.listPurgeCandidates(CUTOFF, 50, transaction),
  );
  return found.ok ? found.value.map((candidate) => candidate.secretVersionId as string) : [];
}

beforeAll(async () => {
  harness = await startSecretsHarness();
  environmentId = await harness.freshEnvironment();
  otherEnvironmentId = await harness.freshEnvironment();
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

describe("the clauses that decide which credential a call reaches", () => {
  test("loadForUpdate refuses a credential that belongs to another environment", async () => {
    const credentialId = fresh();
    await inTransaction((transaction) =>
      harness.repository.insertCredential(
        credentialDraft({
          id: credentialId,
          environmentId: otherEnvironmentId,
          kind: "ENTITY_SECRET",
          name: "FOREIGN",
        }),
        transaction,
      ),
    );
    // THE ROW EXISTS. Answering it here would lock and hand back a credential
    // from a tenant the caller was never authorized for, which is the one
    // failure in this store that crosses a tenant boundary.
    const foreign = await inTransaction((transaction) =>
      harness.repository.loadForUpdate(environmentId, credentialIdOf(credentialId), transaction),
    );
    expect(foreign).toEqual({ ok: true, value: null });
    const own = await inTransaction((transaction) =>
      harness.repository.loadForUpdate(
        otherEnvironmentId,
        credentialIdOf(credentialId),
        transaction,
      ),
    );
    expect(own).toMatchObject({ ok: true, value: { credential: { name: "FOREIGN" } } });
  });

  test("findCredential answers the OLDEST match when a query names several", async () => {
    // `CredentialQuery` admits a `provider` with no name and no id, and two
    // service credentials may share one provider. Without a total order
    // `findFirst` answers with whichever row the planner reached — for a
    // two-row heap with no index on `provider` that is the row inserted LAST,
    // which is the opposite of what this asserts.
    const older = fresh();
    const newer = fresh();
    await inTransaction(async (transaction) => {
      await harness.repository.insertCredential(
        credentialDraft({
          id: newer,
          environmentId,
          kind: "SERVICE_CREDENTIAL",
          name: "SHARED_NEWER",
          provider: "clickhouse",
          at: LATER,
        }),
        transaction,
      );
      await harness.repository.insertCredential(
        credentialDraft({
          id: older,
          environmentId,
          kind: "SERVICE_CREDENTIAL",
          name: "SHARED_OLDER",
          provider: "clickhouse",
          at: AT,
        }),
        transaction,
      );
    });
    const found = await harness.repository.findCredential({
      environmentId,
      provider: "clickhouse",
    });
    expect(found).toMatchObject({ ok: true, value: { credential: { name: "SHARED_OLDER" } } });
  });
});

describe("the purge sweep's eligibility clauses", () => {
  test("an envelope inside its retention window is not a candidate and is not purgeable", async () => {
    const retained = await retiredEnvelope(
      environmentId,
      "RETAINED",
      LATER,
      RETAINED_UNTIL,
    );
    const eligible = await retiredEnvelope(environmentId, "ELIGIBLE", LATER, null);
    const candidates = await candidateIds();
    expect(candidates).toContain(eligible.versionId);
    expect(candidates).not.toContain(retained.versionId);
    // AND THE DELETE RE-CHECKS IT. The two calls are separate, so an operator
    // holding a candidate list from before the retention was set must still be
    // refused — which is why the clause is inside the statement rather than in
    // front of it.
    const purged = await inTransaction((transaction) =>
      harness.repository.purgeSecretVersion(
        {
          secretVersionId: versionIdOf(retained.versionId),
          credentialId: credentialIdOf(retained.credentialId),
          environmentId,
          secretRevision: revisionOf(1),
          rootKeyVersion: rootKeyOf(1),
        },
        CUTOFF,
        transaction,
      ),
    );
    expect(purged).toEqual({ ok: true, value: 0 });
  });

  test("an envelope retired AFTER the cutoff is not a candidate and is not purgeable", async () => {
    const young = await retiredEnvelope(environmentId, "RETIRED_LATE", RETIRED_LATE, null);
    expect(await candidateIds()).not.toContain(young.versionId);
    const purged = await inTransaction((transaction) =>
      harness.repository.purgeSecretVersion(
        {
          secretVersionId: versionIdOf(young.versionId),
          credentialId: credentialIdOf(young.credentialId),
          environmentId,
          secretRevision: revisionOf(1),
          rootKeyVersion: rootKeyOf(1),
        },
        CUTOFF,
        transaction,
      ),
    );
    expect(purged).toEqual({ ok: true, value: 0 });
  });

  test("a RETIRED envelope that is still the credential's active one is untouchable", async () => {
    // THE STATE THE `activeSecretVersionId IS DISTINCT FROM` CLAUSE EXISTS FOR,
    // and the only way to reach it: a rotation that retired the old envelope and
    // did not live to repoint the credential. `retiredAt IS NOT NULL` alone lets
    // it through, which is why the first sweep of this store's ledger found BOTH
    // copies of the clause — the candidate list's and the delete's — surviving
    // against a fixture where the active envelope was simply never retired.
    const credentialId = fresh();
    const versionId = fresh();
    await inTransaction(async (transaction) => {
      await harness.repository.insertCredential(
        credentialDraft({
          id: credentialId,
          environmentId,
          kind: "ENTITY_SECRET",
          name: "RETIRED_AND_ACTIVE",
        }),
        transaction,
      );
      await harness.repository.insertSecretVersion(
        versionDraft({ id: versionId, credentialId, secretRevision: 1, rootKeyVersion: 1, fill: 0xa2 }),
        transaction,
      );
      await harness.repository.setActiveSecretVersion(
        credentialIdOf(credentialId),
        versionIdOf(versionId),
        AT,
        transaction,
      );
      await harness.repository.retireSecretVersion(versionIdOf(versionId), LATER, null, transaction);
    });
    // Old enough, retired, inside no retention window — and STILL not a
    // candidate, because the credential points at it.
    expect(await candidateIds()).not.toContain(versionId);
    // And the delete re-checks the same clause. Without it
    // `Credential_activeSecretVersionId_id_fkey` — ON DELETE RESTRICT — raises
    // 23503 mid-batch with the transaction already poisoned, instead of
    // reporting zero.
    const purged = await inTransaction((transaction) =>
      harness.repository.purgeSecretVersion(
        {
          secretVersionId: versionIdOf(versionId),
          credentialId: credentialIdOf(credentialId),
          environmentId,
          secretRevision: revisionOf(1),
          rootKeyVersion: rootKeyOf(1),
        },
        CUTOFF,
        transaction,
      ),
    );
    expect(purged).toEqual({ ok: true, value: 0 });
  });

  test("the sweep holds its candidates against a second sweep", async () => {
    await retiredEnvelope(environmentId, "LOCKED_CANDIDATE", LATER, null);
    const trace: string[] = [];
    const held = gate();
    const swept = gate();

    const first = inTransaction(async (transaction) => {
      await harness.repository.listPurgeCandidates(CUTOFF, 50, transaction);
      trace.push("first-swept");
      swept.open();
      await held.wait;
      trace.push("first-committed");
    });

    await swept.wait;
    const second = inTransaction(async (transaction) => {
      trace.push("second-queued");
      await harness.repository.listPurgeCandidates(CUTOFF, 50, transaction);
      trace.push("second-swept");
    });

    await settle(400);
    // THE LOAD-BEARING HALF. Without `FOR UPDATE OF version` both sweeps hand
    // the SAME candidate to two callers, `second-swept` appears here, and the
    // loser's delete finds nothing — which the use case reads as "the world
    // changed" and rolls a whole batch back on.
    expect([...trace]).toEqual(["first-swept", "second-queued"]);
    held.open();
    await Promise.all([first, second]);
    expect(trace).toEqual(["first-swept", "second-queued", "first-committed", "second-swept"]);
  }, 60_000);
});
