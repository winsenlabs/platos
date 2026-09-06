// The transaction boundary, proved by FAILURE INJECTION against a real
// PostgreSQL, and the three scope refusals proved by violating input.
//
// FOUR CLAIMS, AND THE THIRD IS THE ONE THAT SHIPPED BROKEN ONE TRANCHE OVER.
//
//   1. A THROWN failure rolls the whole unit of work back. The second write is
//      forced to fail against the database — a foreign key into a credential
//      that does not exist — and NEITHER row survives. Durability is checked
//      from a SECOND client over the same database, because a writer can see its
//      own uncommitted rows and "the row is gone when I look again" is not the
//      claim.
//
//   2. A RETURNED refusal COMMITS. `setActiveSecretVersion` on a credential that
//      is not there answers `err(CREDENTIAL_UNAVAILABLE)` and raises nothing, so
//      the write beside it in the same transaction lands. That is the
//      `cost-monitoring` trap named in this issue's own acceptance, and it is
//      not a defect in this store — it is the contract: `Result` is a value, and
//      only the use case that reads it can decide the unit of work is over.
//      `inTransaction` in `packages/contexts/secrets/application/transaction.ts`
//      is what turns the value into a rollback, and the case below pins the
//      boundary exactly where it is rather than where it would be nicer.
//
//   3. THREE REFUSALS, THREE CODES. A write with no transaction open, a write
//      carrying a token whose transaction has finished, and a write carrying
//      another live transaction's token are three different mistakes.
//
//   4. THE ROW LOCK REALLY BLOCKS. `loadForUpdate`'s port comment says two
//      concurrent rotations "must serialise here or one plaintext is lost". The
//      case takes a snapshot of the trace WHILE the first transaction still
//      holds the lock, because a suite that only looked afterwards would pass
//      against a lock that never blocked.
//
// Excluded from `vitest run` by the package's `test` script and run by
// `pnpm test:postgres-tenancy:integration` in its own CI job. It FAILS when
// Docker is absent rather than skipping.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  EnvironmentId,
  TransactionScope,
} from "@platos/context-secrets/application/ports/index.js";

import {
  TRANSACTION_NOT_OPEN,
  TRANSACTION_SCOPE_FOREIGN,
  TRANSACTION_SCOPE_UNKNOWN,
} from "./transaction.js";
import type { SecretsHarness } from "./secrets-harness.js";
import {
  AT,
  LATER,
  auditDraft,
  credentialDraft,
  credentialIdOf,
  startSecretsHarness,
  variableIdOf,
  versionDraft,
  versionIdOf,
} from "./secrets-harness.js";

let harness: SecretsHarness;
let environmentId: EnvironmentId;
let observer: { credentialCount(id: string): Promise<number>; close(): Promise<void> };
let sequence = 0;

function fresh(): string {
  sequence += 1;
  return `5ec04444-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

/** Long enough that a lock which does not block would certainly have acquired. */
const GRACE_MS = 400;

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

beforeAll(async () => {
  harness = await startSecretsHarness();
  environmentId = await harness.freshEnvironment();
  // A SECOND CLIENT over the same database, on a connection this adapter's pool
  // never touches. Durability is "the row is there when somebody else looks".
  const { PrismaClient } = await import("@platos/tenancy-database");
  const second = new PrismaClient({ datasources: { db: { url: harness.base.databaseUrl } } });
  observer = {
    credentialCount: (id: string) => second.credential.count({ where: { id } }),
    close: () => second.$disconnect(),
  };
}, 300_000);

afterAll(async () => {
  await observer?.close();
  await harness?.stop();
});

describe("failure injection over a real transaction", () => {
  test("a thrown failure leaves NEITHER row behind", async () => {
    const credentialId = fresh();
    await expect(
      harness.base.adapter.unitOfWork.run(async (transaction) => {
        const created = await harness.repository.insertCredential(
          credentialDraft({
            id: credentialId,
            environmentId,
            kind: "ENTITY_SECRET",
            name: "ROLLED_BACK",
          }),
          transaction,
        );
        expect(created).toMatchObject({ ok: true });
        // FORCED TO FAIL AGAINST THE DATABASE, not against a guard: the envelope
        // is well formed and names a credential that does not exist, so
        // `CredentialSecretVersion_credentialId_fkey` refuses it with SQLSTATE
        // 23503. A guard refusal would have proved the guard, not the boundary.
        return harness.repository.insertSecretVersion(
          versionDraft({
            id: fresh(),
            credentialId: fresh(),
            secretRevision: 1,
            rootKeyVersion: 1,
            fill: 0x71,
          }),
          transaction,
        );
      }),
    ).rejects.toThrow();
    // FROM THE OTHER CONNECTION. The credential was committed nowhere.
    expect(await observer.credentialCount(credentialId)).toBe(0);
  });

  test("a RETURNED refusal commits the write beside it", async () => {
    // THE `cost-monitoring` TRAP, pinned rather than assumed away. Nothing in
    // this store rolls a transaction back on a `Result` — a `Result` is a value
    // — so a use case that ignored one would commit half its work. The vault's
    // own `inTransaction` is what makes that unreachable, and it is a different
    // file in a different package.
    const credentialId = fresh();
    const refused = await harness.base.adapter.unitOfWork.run(async (transaction) => {
      await harness.repository.insertCredential(
        credentialDraft({
          id: credentialId,
          environmentId,
          kind: "ENTITY_SECRET",
          name: "COMMITTED_ANYWAY",
        }),
        transaction,
      );
      return harness.repository.setActiveSecretVersion(
        credentialIdOf(fresh()),
        null,
        LATER,
        transaction,
      );
    });
    expect(refused).toMatchObject({ ok: false, error: { code: "CREDENTIAL_UNAVAILABLE" } });
    expect(await observer.credentialCount(credentialId)).toBe(1);
  });
});

describe("the three transaction-scope refusals, told apart", () => {
  test("a write with no transaction open is not_open", async () => {
    await expect(
      harness.repository.insertCredential(
        credentialDraft({
          id: fresh(),
          environmentId,
          kind: "ENTITY_SECRET",
          name: "NO_TRANSACTION",
        }),
        { transactionId: "pg-txn-nonexistent" } as unknown as TransactionScope,
      ),
    ).rejects.toMatchObject({ code: TRANSACTION_NOT_OPEN });
  });

  test("the ROW LOCK is refused outside a transaction, not taken on the pool", async () => {
    // `loadForUpdate` is a READ that resolves through `writer(scope)`, and this
    // is the case that says why. `FOR UPDATE` is TRANSACTION-scoped: taken on a
    // pooled connection it is released the instant the statement returns, the
    // call succeeds, and the race the lock exists to close is wide open.
    // WIN-258 T5's first mutation sweep proved the point the hard way — swapping
    // `writer(transaction)` for `reader()` left the serialisation case GREEN,
    // because inside a transaction `reader()` resolves to the same ambient
    // client. Only a call from OUTSIDE one can tell the two apart.
    await expect(
      harness.repository.loadForUpdate(
        environmentId,
        credentialIdOf(fresh()),
        { transactionId: "pg-txn-nonexistent" } as unknown as TransactionScope,
      ),
    ).rejects.toMatchObject({ code: TRANSACTION_NOT_OPEN });
  });

  test("a write carrying a finished transaction's token is scope_unknown", async () => {
    let stale: TransactionScope | null = null;
    await harness.base.adapter.unitOfWork.run(async (transaction) => {
      stale = transaction;
    });
    await expect(
      harness.base.adapter.unitOfWork.run((transaction) => {
        expect(transaction).not.toEqual(stale);
        return harness.variables.upsert(
          {
            id: variableIdOf(fresh()),
            environmentId,
            key: "STALE",
            kind: "PLAIN",
            value: "x",
            credentialId: null,
            lastUpdatedBy: null,
            at: AT,
          },
          stale as unknown as TransactionScope,
        );
      }),
    ).rejects.toMatchObject({ code: TRANSACTION_SCOPE_UNKNOWN });
  });

  test("a write carrying ANOTHER live transaction's token is scope_foreign", async () => {
    const held = gate();
    const opened = gate();
    let foreign: TransactionScope | null = null;
    const holder = harness.base.adapter.unitOfWork.run(async (transaction) => {
      foreign = transaction;
      opened.open();
      await held.wait;
    });
    await opened.wait;
    const refusal = harness.base.adapter.unitOfWork.run(() =>
      harness.repository.appendAudit(
        auditDraft({
          id: fresh(),
          environmentId,
          credentialId: fresh(),
          action: "READ",
        }),
        foreign as unknown as TransactionScope,
      ),
    );
    await expect(refusal).rejects.toMatchObject({ code: TRANSACTION_SCOPE_FOREIGN });
    held.open();
    await holder;
  });
});

describe("a read joins the open transaction rather than the pool", () => {
  test("findByKey sees a row the same transaction has not committed", async () => {
    const variableId = fresh();
    await harness.base.adapter.unitOfWork.run(async (transaction) => {
      await harness.variables.upsert(
        {
          id: variableIdOf(variableId),
          environmentId,
          key: "AMBIENT",
          kind: "PLAIN",
          value: "uncommitted",
          credentialId: null,
          lastUpdatedBy: null,
          at: AT,
        },
        transaction,
      );
      // THE READ TAKES NO `TransactionScope` — the port's signature has none —
      // so without the ambient frame it would run on the pool and answer null.
      // `revokeIfUnreferenced` makes exactly this shape of read and revokes a
      // credential when the answer is zero.
      const seen = await harness.variables.findByKey(environmentId, "AMBIENT");
      expect(seen).toMatchObject({ ok: true, value: { id: variableId, value: "uncommitted" } });
      const counted = await harness.variables.countReferences(credentialIdOf(fresh()));
      expect(counted).toEqual({ ok: true, value: 0 });
    });
  });
});

describe("loadForUpdate takes a lock a second transaction has to wait for", () => {
  test("two rotations of one credential serialise", async () => {
    const credentialId = fresh();
    const versionId = fresh();
    await harness.base.adapter.unitOfWork.run(async (transaction) => {
      await harness.repository.insertCredential(
        credentialDraft({ id: credentialId, environmentId, kind: "ENTITY_SECRET", name: "LOCKED" }),
        transaction,
      );
      await harness.repository.insertSecretVersion(
        versionDraft({ id: versionId, credentialId, secretRevision: 1, rootKeyVersion: 1, fill: 0x81 }),
        transaction,
      );
      await harness.repository.setActiveSecretVersion(
        credentialIdOf(credentialId),
        versionIdOf(versionId),
        AT,
        transaction,
      );
    });

    const trace: string[] = [];
    const held = gate();
    const acquired = gate();
    const first = harness.base.adapter.unitOfWork.run(async (transaction) => {
      await harness.repository.loadForUpdate(environmentId, credentialIdOf(credentialId), transaction);
      trace.push("first-locked");
      acquired.open();
      await held.wait;
      await harness.repository.revokeCredential(credentialIdOf(credentialId), LATER, transaction);
      trace.push("first-committed");
    });

    await acquired.wait;
    let secondSaw: Date | null | undefined;
    const second = harness.base.adapter.unitOfWork.run(async (transaction) => {
      trace.push("second-queued");
      const loaded = await harness.repository.loadForUpdate(
        environmentId,
        credentialIdOf(credentialId),
        transaction,
      );
      trace.push("second-locked");
      secondSaw = loaded.ok && loaded.value !== null ? loaded.value.credential.revokedAt : undefined;
    });

    await settle(GRACE_MS);
    // THE LOAD-BEARING HALF. A lock that did not block would have put
    // `second-locked` here, and the case would still be green afterwards.
    expect([...trace]).toEqual(["first-locked", "second-queued"]);
    held.open();
    await Promise.all([first, second]);
    expect(trace).toEqual(["first-locked", "second-queued", "first-committed", "second-locked"]);
    // And it read the row the FIRST transaction wrote, which is what "serialise"
    // has to mean: a second rotation that read the pre-lock snapshot would
    // overwrite the plaintext the first one stored.
    expect(secondSaw).toEqual(LATER);
  }, 60_000);
});
