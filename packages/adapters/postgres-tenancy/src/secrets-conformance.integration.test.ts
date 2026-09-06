// The `secrets` conformance differential: `inMemorySecretsStore` and this
// adapter, asked the SAME questions against a REAL PostgreSQL, compared
// verbatim.
//
// WHY THE COMPARISON IS THE TEST. A suite written against the adapter alone
// asserts what its author believed; a suite written against the fake alone
// asserts nothing about the database. Running one scenario twice and comparing
// the observation maps makes a divergence a named step with a value on each
// side.
//
// IT EARNED THAT ON THIS TRANCHE TOO. The first run established that
// `inMemorySecretsStore.upsert` keys an environment variable on the ROW ID while
// the database is unique on `[environmentId, key]` — the same class of defect
// tranche 2 found in `operatorIdentities.upsert`, and one no use-case suite in
// the tree could see, because `setEnvironmentVariable` reads the row first and
// reuses its id. The divergence is pinned as its own case in
// `secrets-constraints.integration.test.ts`; the scenario here stays on the
// ground both stores share, so a difference in THIS transcript is a store
// defect rather than a known asymmetry.
//
// Excluded from `vitest run` by the package's `test` script and run by
// `pnpm test:postgres-tenancy:integration` in its own CI job. It FAILS when
// Docker is absent rather than skipping.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  inMemorySecretsStore,
  inMemoryUnitOfWork,
} from "@platos/context-secrets/application/index.js";
import type {
  EnvironmentId,
  TransactionScope,
} from "@platos/context-secrets/application/ports/index.js";
import { runResult } from "@platos/context-secrets/application/ports/index.js";
import type { NotResult } from "@platos/context-secrets/application/ports/index.js";

import type {
  SecretsConformanceEnvironment,
  SecretsConformanceIds,
  SecretsObservation,
} from "./secrets-conformance.js";
import { runSecretsConformance } from "./secrets-conformance.js";
import type { SecretsHarness } from "./secrets-harness.js";
import { startSecretsHarness } from "./secrets-harness.js";

let harness: SecretsHarness;
let environmentId: EnvironmentId;
let ids: SecretsConformanceIds;

/** A uuid per role, so no two rows in the scenario can collide on a key. */
function uuid(slot: string): string {
  return `5ec00000-${slot}-4000-8000-000000000000`;
}

beforeAll(async () => {
  harness = await startSecretsHarness();
  environmentId = await harness.freshEnvironment();
  ids = {
    // THE IDENTIFIER ORDER IS DELIBERATELY THE REVERSE OF THE NAME ORDER.
    // `listCredentials` answers name-ascending, which is the extraction source's
    // order and the double's; numbered the obvious way the two orderings would
    // AGREE and a store that sorted on the identifier alone would match the
    // double anyway. WIN-258 T5's mutation sweep proved that: replacing the name
    // sort with the identifier left every observation identical.
    alphaCredentialId: uuid("0003"),
    bravoCredentialId: uuid("0002"),
    charlieCredentialId: uuid("0001"),
    missingCredentialId: uuid("0004"),
    // THE ENVELOPE IDENTIFIERS ARE DELIBERATELY IN THE ORDER THE TWO SORTS
    // DISAGREE ON. `purgeOrder` is oldest `createdAt` first with the id as the
    // tie-break; the FIRST version is stamped an hour LATER than the SECOND, so
    // a store that ordered on the id alone would hand the two candidates back
    // the other way round.
    alphaFirstVersionId: uuid("0101"),
    alphaSecondVersionId: uuid("0102"),
    alphaRewrappedVersionId: uuid("0103"),
    bravoVersionId: uuid("0104"),
    charlieVersionId: uuid("0105"),
    missingVersionId: uuid("0106"),
    alphaVariableId: uuid("0201"),
    bravoVariableId: uuid("0202"),
    charlieVariableId: uuid("0203"),
    deltaVariableId: uuid("0204"),
    auditIds: [uuid("0301"), uuid("0302"), uuid("0303"), uuid("0304")],
  };
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

function fakeEnvironment(): SecretsConformanceEnvironment {
  const store = inMemorySecretsStore();
  const unitOfWork = inMemoryUnitOfWork([store]);
  return {
    repository: store,
    variables: store,
    environmentId,
    ids,
    run: <Value>(work: (transaction: TransactionScope) => Promise<NotResult<Value>>) => unitOfWork.run<Value>(work),
  };
}

function adapterEnvironment(): SecretsConformanceEnvironment {
  return {
    repository: harness.repository,
    variables: harness.variables,
    environmentId,
    ids,
    run: <Value>(work: (transaction: TransactionScope) => Promise<NotResult<Value>>) =>
      harness.base.adapter.unitOfWork.run<Value>(work),
  };
}

describe("the PostgreSQL secrets store against the in-memory double", () => {
  let fake: SecretsObservation;
  let real: SecretsObservation;

  beforeAll(async () => {
    fake = await runSecretsConformance(fakeEnvironment());
    real = await runSecretsConformance(adapterEnvironment());
  }, 300_000);

  test("both stores answered every step of the scenario", () => {
    expect(Object.keys(real)).toEqual(Object.keys(fake));
    expect(Object.keys(real).length).toBeGreaterThan(40);
  });

  test("the steps that could agree by being empty did not", () => {
    // NON-VACUITY, asserted rather than assumed. Two stores that both returned
    // nothing would match transcript for transcript and prove nothing, and the
    // steps below are the ones where "nothing" is a legal answer: three
    // listings, the installation-wide root-key sweep and the purge candidates.
    expect((real.listAfterCreate as { readonly value: readonly unknown[] }).value).toHaveLength(3);
    expect((real.listAfterRevoke as { readonly value: readonly unknown[] }).value).toHaveLength(3);
    expect((real.listVariables as { readonly value: readonly unknown[] }).value).toHaveLength(3);
    expect(
      (real.listVariablesAfterRemove as { readonly value: readonly unknown[] }).value,
    ).toHaveLength(2);
    expect((real.purgeCandidates as { readonly value: readonly unknown[] }).value).toHaveLength(2);
    expect(real.usageAfterCreate).toEqual({
      ok: true,
      value: [{ rootKeyVersion: 1, unpurgedVersionCount: 3 }],
    });
  });

  test("their transcripts match, observation for observation", () => {
    // ONE assertion over the whole map rather than one per step: a divergence
    // then names the step AND shows both values, and a step somebody forgot to
    // assert cannot exist.
    expect(real).toEqual(fake);
  });

  test("the purge sweep ordered on the envelope's age, not on its identifier", () => {
    // Read off the SHARED transcript, so this is a claim about both stores. The
    // second version was created an hour EARLIER than the first, so oldest-first
    // hands it back first while its identifier sorts second.
    const candidates = (
      real.purgeCandidates as { readonly value: readonly { readonly secretVersionId: string }[] }
    ).value;
    expect(candidates.map((candidate) => candidate.secretVersionId)).toEqual([
      ids.alphaSecondVersionId,
      ids.alphaFirstVersionId,
    ]);
  });

  test("a rewrap wrote the SAME revision under a new key, and a duplicate did not", () => {
    expect(real.rewrapAlphaSecondVersion).toMatchObject({
      ok: true,
      value: { secretRevision: 2, rootKeyVersion: 2 },
    });
    expect(real.insertDuplicateVersion).toMatchObject({
      ok: false,
      error: { code: "SECRET_VERSION_ALREADY_EXISTS" },
    });
    expect(real.insertAlphaAgain).toMatchObject({
      ok: false,
      error: { code: "CREDENTIAL_NAME_TAKEN" },
    });
  });

  test("the purge destroyed one envelope and refused the active one", () => {
    expect(real.purgeSecondVersion).toEqual({ ok: true, value: 1 });
    expect(real.purgeSecondVersionAgain).toEqual({ ok: true, value: 0 });
    expect(real.purgeActiveVersion).toEqual({ ok: true, value: 0 });
    expect(real.usageAfterPurge).toEqual({
      ok: true,
      value: [
        { rootKeyVersion: 1, unpurgedVersionCount: 3 },
        { rootKeyVersion: 2, unpurgedVersionCount: 1 },
      ],
    });
  });

  test("a revoked credential left the find path and stayed in the inventory", () => {
    expect(real.findAlphaAfterRevoke).toEqual({ ok: true, value: null });
    const listed = (
      real.listAfterRevoke as { readonly value: readonly { readonly credential: { readonly name: string } }[] }
    ).value;
    expect(listed.map((entry) => entry.credential.name)).toEqual([
      "ALPHA_KEY",
      "BRAVO_KEY",
      "CHARLIE_KEY",
    ]);
  });

  test("the variable's version advanced and its creation instant did not", () => {
    expect(real.upsertAlphaPlain).toMatchObject({ ok: true, value: { version: 1, value: "one" } });
    expect(real.upsertAlphaAgain).toMatchObject({ ok: true, value: { version: 2, value: "two" } });
    const first = (real.upsertAlphaPlain as { readonly value: { readonly createdAt: Date } }).value;
    const second = (real.upsertAlphaAgain as { readonly value: { readonly createdAt: Date } }).value;
    expect(second.createdAt).toEqual(first.createdAt);
    expect(real.removeBravo).toEqual({ ok: true, value: true });
    expect(real.removeBravoAgain).toEqual({ ok: true, value: false });
    expect(real.referencesToCharlieCredential).toEqual({ ok: true, value: 1 });
    expect(real.referencesToAlphaCredential).toEqual({ ok: true, value: 0 });
  });
});
