// The seven refusals whose ONLY witness was a crashed hook.
//
// WHY THIS FILE EXISTS, and it is the same finding `cost-idempotency.integration
// .test.ts` records one store over. Every method below answers a `Result` where
// a naive store would RAISE, and the conformance differential drives all of them
// — but it drives them inside a `beforeAll` that builds the whole transcript, so
// a store that raised instead crashed the hook, vitest reported every case in
// that file SKIPPED, and the mutation driver scored the edit VACUOUS rather than
// killed. Seven of the ledger's forty-seven entries came back that way on the
// first sweep. A guard whose only witness is a crashed hook is a guard nothing
// can see.
//
// EACH CASE IS ITS OWN TRANSACTION, and that is load-bearing rather than tidy.
// Four of the seven refusals are a unique or a check violation, and on PostgreSQL
// a violated constraint aborts the WHOLE transaction — so a case that carried on
// writing after one would measure 25P02 instead of the refusal it meant to.
//
// AND EACH ASSERTS THE `Result`, NOT THE ABSENCE OF A THROW. `expect(...).
// resolves` on a promise that rejects is a failure, so a store that raised would
// go red here whichever way the assertion was spelled; asserting the VALUE is
// what also catches a store that answered the wrong refusal.
//
// Excluded from `vitest run` by the package's `test` script and run by
// `pnpm test:postgres-tenancy:integration` in its own CI job. It FAILS when
// Docker is absent rather than skipping.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  EnvironmentId,
  TransactionScope,
} from "@platos/context-secrets/application/ports/index.js";
import { runResult } from "@platos/kernel";
import type { Result } from "@platos/kernel";

import type { SecretsHarness } from "./secrets-harness.js";
import {
  AT,
  LATER,
  credentialDraft,
  credentialIdOf,
  startSecretsHarness,
  variableIdOf,
  versionDraft,
  versionIdOf,
} from "./secrets-harness.js";

let harness: SecretsHarness;
let environmentId: EnvironmentId;
/** A credential that exists, so a duplicate has something to collide with. */
let takenCredentialId: string;
let takenVersionId: string;
let sequence = 0;

function fresh(): string {
  sequence += 1;
  return `5ec09999-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function inTransaction<Value>(
  work: (transaction: TransactionScope) => Promise<Result<Value>>,
): Promise<Result<Value>> {
  return runResult(harness.base.adapter.unitOfWork, work);
}

beforeAll(async () => {
  harness = await startSecretsHarness();
  environmentId = await harness.freshEnvironment();
  takenCredentialId = fresh();
  takenVersionId = fresh();
  await harness.base.adapter.unitOfWork.run(async (transaction) => {
    await harness.repository.insertCredential(
      credentialDraft({
        id: takenCredentialId,
        environmentId,
        kind: "SERVICE_CREDENTIAL",
        name: "TAKEN",
      }),
      transaction,
    );
    await harness.repository.insertSecretVersion(
      versionDraft({
        id: takenVersionId,
        credentialId: takenCredentialId,
        secretRevision: 1,
        rootKeyVersion: 1,
        fill: 0xb1,
      }),
      transaction,
    );
  });
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

describe("a row that is not there is an outcome, not an exception", () => {
  test("loadForUpdate answers null for a credential that does not exist", async () => {
    // `FOR UPDATE` over a row that is not there locks nothing and returns no
    // rows; PostgreSQL does not raise. A store reading 'no exception' as
    // 'locked' would index an empty result and throw where the port promises a
    // value.
    const loaded = await inTransaction((transaction) =>
      harness.repository.loadForUpdate(environmentId, credentialIdOf(fresh()), transaction),
    );
    expect(loaded).toEqual({ ok: true, value: null });
  });

  test("setActiveSecretVersion and revokeCredential refuse a credential that is not there", async () => {
    const missing = credentialIdOf(fresh());
    const pointed = await inTransaction((transaction) =>
      harness.repository.setActiveSecretVersion(missing, null, LATER, transaction),
    );
    expect(pointed).toMatchObject({
      ok: false,
      error: { code: "CREDENTIAL_UNAVAILABLE", details: { reason: "credential_not_found" } },
    });
    const revoked = await inTransaction((transaction) =>
      harness.repository.revokeCredential(missing, LATER, transaction),
    );
    expect(revoked).toMatchObject({
      ok: false,
      error: { code: "CREDENTIAL_UNAVAILABLE", details: { reason: "credential_not_found" } },
    });
  });

  test("retireSecretVersion refuses a version that is not there", async () => {
    const retired = await inTransaction((transaction) =>
      harness.repository.retireSecretVersion(versionIdOf(fresh()), LATER, null, transaction),
    );
    expect(retired).toMatchObject({
      ok: false,
      error: { code: "CREDENTIAL_UNAVAILABLE", details: { reason: "secret_version_retired" } },
    });
  });

  test("remove answers false for a variable that is not there, and the transaction survives", async () => {
    const removed = await inTransaction(async (transaction) => {
      const gone = await harness.variables.remove(
        environmentId,
        variableIdOf(fresh()),
        transaction,
      );
      // THE SECOND HALF IS THE POINT. `delete` would raise P2025 and poison the
      // transaction, so a write after it would fail with 25P02 rather than land.
      await harness.variables.upsert(
        {
          id: variableIdOf(fresh()),
          environmentId,
          key: "AFTER_ABSENT_DELETE",
          kind: "PLAIN",
          value: "landed",
          credentialId: null,
          lastUpdatedBy: null,
          at: AT,
          expectedVersion: null,
        },
        transaction,
      );
      return gone;
    });
    expect(removed).toEqual({ ok: true, value: false });
    const written = await harness.variables.findByKey(environmentId, "AFTER_ABSENT_DELETE");
    expect(written).toMatchObject({ ok: true, value: { value: "landed" } });
  });
});

describe("a uniqueness violation is a domain refusal, not a raised driver error", () => {
  test("a taken [environmentId, kind, name] answers CREDENTIAL_NAME_TAKEN", async () => {
    const refused = await inTransaction((transaction) =>
      harness.repository.insertCredential(
        credentialDraft({
          id: fresh(),
          environmentId,
          kind: "SERVICE_CREDENTIAL",
          name: "TAKEN",
        }),
        transaction,
      ),
    );
    expect(refused).toMatchObject({ ok: false, error: { code: "CREDENTIAL_NAME_TAKEN" } });
  });

  test("a taken [credentialId, secretRevision, rootKeyVersion] answers SECRET_VERSION_ALREADY_EXISTS", async () => {
    const refused = await inTransaction((transaction) =>
      harness.repository.insertSecretVersion(
        versionDraft({
          id: fresh(),
          credentialId: takenCredentialId,
          secretRevision: 1,
          rootKeyVersion: 1,
          fill: 0xb2,
        }),
        transaction,
      ),
    );
    expect(refused).toMatchObject({ ok: false, error: { code: "SECRET_VERSION_ALREADY_EXISTS" } });
    // AND THE SAME REVISION UNDER A NEW ROOT KEY IS NOT A DUPLICATE. The unique
    // key includes `rootKeyVersion` precisely so a rewrap can write it, and a
    // store that refused this would make re-encryption unrepresentable.
    const rewrapped = await inTransaction((transaction) =>
      harness.repository.insertSecretVersion(
        versionDraft({
          id: fresh(),
          credentialId: takenCredentialId,
          secretRevision: 1,
          rootKeyVersion: 2,
          fill: 0xb3,
        }),
        transaction,
      ),
    );
    expect(rewrapped).toMatchObject({ ok: true, value: { secretRevision: 1, rootKeyVersion: 2 } });
  });
});

describe("the first write of a variable carries the version the CHECK demands", () => {
  test("a brand-new row is version 1, which EnvironmentVariable_version_check admits", async () => {
    // `version` is `@default(1)` in the schema AND `> 0` in a migration, and the
    // double's first write produces 1. Writing it explicitly is what makes the
    // two agree by construction; a store that wrote 0 would be refused by the
    // CHECK and would take its whole transaction with it.
    const written = await inTransaction((transaction) =>
      harness.variables.upsert(
        {
          id: variableIdOf(fresh()),
          environmentId,
          key: "FIRST_WRITE",
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
    expect(written).toMatchObject({ ok: true, value: { version: 1, createdAt: AT, updatedAt: AT } });
  });
});
