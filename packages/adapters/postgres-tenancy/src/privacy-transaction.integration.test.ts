// The transaction boundary, proved by FAILURE INJECTION against a real database,
// and the three scope refusals.
//
// WHY INJECTION AND NOT A ROLLBACK COUNT. A store that counted rollbacks would
// pass a suite that asserted rollbacks. Every case below forces the SECOND write
// of a multi-statement operation to fail and then LOOKS FOR THE FIRST ROW — over
// a SECOND client, on a connection this adapter's pool never touched, because
// durability is not "the row is there when the writer looks again" but "the row
// is there when somebody else looks".
//
// *** AND IT IS THIS CONTEXT'S OWN TRAP, IN ITS SHARPEST FORM. *** The barrier is
// TWO writes in two tables. `seal-subject.ts` seals the alias set and
// `record-pass.ts` writes the operation's progress, and `run-erasure-pass.ts`
// composes the destructive half with the progress write inside ONE
// `unitOfWork.run` — alongside the deletes every OTHER context's `ErasureTarget`
// issues on that same scope. If a progress write survived a failed destruction,
// the tree would hold a receipt certifying an erasure whose deletes rolled back:
// a false legal statement, durably, about a person.
//
// THE `Result` HALF IS MEASURED TOO, and it is the trap `cost-monitoring`
// shipped. `refusePrivacy` turns a driver error into an error `Result`, and an
// error `Result` RESOLVES — so the callback returns normally and the unit of work
// issues COMMIT. Whether that COMMIT is a commit or a rollback is a fact about
// PostgreSQL and not about this package, and the only honest way to know is to
// look for the row from outside. That is what these cases do.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  ErasureOperationId,
  ErasureTombstoneId,
  TombstoneDraft,
  TransactionScope,
} from "@platos/context-privacy/application/ports/index.js";
import { runResult } from "@platos/kernel";

import type { TenancyDatabaseClient } from "./client.js";
import type { PrivacyHarness, PrivacyTenant } from "./privacy-harness.js";
import { operationDraft, REQUESTED_AT, startPrivacyHarness } from "./privacy-harness.js";
import {
  TRANSACTION_NOT_OPEN,
  TRANSACTION_SCOPE_FOREIGN,
  TRANSACTION_SCOPE_UNKNOWN,
} from "./transaction.js";

let harness: PrivacyHarness;
let tenant: PrivacyTenant;
/** A SECOND client over the same database. Nothing this adapter's pool touched. */
let observer: TenancyDatabaseClient;

const EXPIRES_AT = new Date("2026-06-01T09:00:00.000Z");

beforeAll(async () => {
  harness = await startPrivacyHarness();
  tenant = await harness.freshTenant();
  const { PrismaClient } = await import("@platos/tenancy-database");
  observer = new PrismaClient({
    datasources: { db: { url: harness.base.databaseUrl } },
  }) as TenancyDatabaseClient;
}, 300_000);

afterAll(async () => {
  await observer?.$disconnect();
  await harness?.stop();
});

function id<Brand>(value: string): Brand {
  return value as Brand;
}

function sealDraft(aliasHash: string, operationId: string): TombstoneDraft {
  return {
    organizationId: tenant.organizationId,
    aliasHash: id(aliasHash),
    operationId: id<ErasureOperationId>(operationId),
    policyVersion: "privacy/1",
    sealedAt: REQUESTED_AT,
    expiresAt: EXPIRES_AT,
  };
}

/** What a SECOND connection can see. The only honest definition of durable. */
async function operationExists(operationId: string): Promise<boolean> {
  return (await observer.erasureOperation.count({ where: { id: operationId } })) > 0;
}

async function tombstoneExists(aliasHash: string): Promise<boolean> {
  return (
    (await observer.erasureTombstone.count({
      where: { organizationId: tenant.organizationId, aliasHash },
    })) > 0
  );
}

function codeOf(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return `<uncoded:${String(error)}>`;
}

describe("a seal and a receipt commit together, or neither does", () => {
  test("the receipt fails and the seal written beside it does not survive", async () => {
    const operationId = harness.base.freshId("0070");
    const alias = `a-rollback-${operationId.slice(-12)}`;

    // THE FAILURE IS THE ADAPTER'S OWN SECOND STATEMENT, not a third one this
    // suite adds. `updateProgress` on an operation that does not exist returns
    // `PRIVACY_OPERATION_NOT_FOUND` — an error `Result`, which RESOLVES — so the
    // callback below returns normally and the unit of work issues COMMIT. That is
    // exactly the shape `cost-monitoring` shipped: an error reported correctly,
    // and the first write of the pair committed anyway.
    await expect(
      harness.run(async (transaction) => {
        const sealed = await harness.repository.sealTombstones(
          [sealDraft(alias, operationId)],
          [id<ErasureTombstoneId>(harness.base.freshId("0071"))],
          transaction,
        );
        expect(sealed.ok).toBe(true);
        // Inside the same transaction the writer sees its own row.
        const own = await harness.repository.findActiveTombstones(
          tenant.organizationId,
          [id(alias)],
          REQUESTED_AT,
        );
        expect(own.ok && own.value).toHaveLength(1);

        const progress = await harness.repository.updateProgress(
          tenant.organizationId,
          id<ErasureOperationId>(operationId),
          {
            workStatus: "SUCCEEDED",
            outcomes: [],
            legalHoldPolicyId: null,
            retryCount: 0,
            startedAt: REQUESTED_AT,
            completedAt: REQUESTED_AT,
            nextRetryAt: null,
            leaseToken: null,
            leaseExpiresAt: null,
          },
          transaction,
        );
        expect(progress.ok).toBe(false);
        if (progress.ok) return;
        expect(progress.error.code).toBe("PRIVACY_OPERATION_NOT_FOUND");
        // The store reported the failure as a VALUE. The unit of work must still
        // discard the seal, so this throws to make the rollback the caller's
        // decision rather than the driver's.
        throw new Error("pass failed; discard the seal");
      }),
    ).rejects.toThrow(/discard the seal/u);

    expect(await tombstoneExists(alias)).toBe(false);
  });

  test("the SAME pair, allowed to finish, IS durable on a second connection", async () => {
    // The control. Without it the case above could be passing because nothing was
    // ever written rather than because the rollback works.
    const operationId = harness.base.freshId("0072");
    const alias = `a-durable-${operationId.slice(-12)}`;
    await harness.run(async (transaction) => {
      const inserted = await harness.repository.insertOperation(
        operationDraft(tenant, operationId),
        transaction,
      );
      expect(inserted.ok).toBe(true);
      const sealed = await harness.repository.sealTombstones(
        [sealDraft(alias, operationId)],
        [id<ErasureTombstoneId>(harness.base.freshId("0073"))],
        transaction,
      );
      expect(sealed.ok && sealed.value).toEqual({ sealed: 1, extended: 0 });
    });
    expect(await operationExists(operationId)).toBe(true);
    expect(await tombstoneExists(alias)).toBe(true);
  });

  test("an operation inserted beside a doomed seal does not survive either", async () => {
    // The pair the OTHER way round, because the two tables fail in different
    // places. A seal whose retention window is inverted is refused by
    // `guardSealBatch` BEFORE any statement — so the transaction is still healthy
    // and the insert before it is a live, uncommitted row. If it survived, the
    // tree would hold a receipt for an erasure whose barrier was never written.
    const operationId = harness.base.freshId("0074");
    await expect(
      harness.run(async (transaction) => {
        const inserted = await harness.repository.insertOperation(
          operationDraft(tenant, operationId),
          transaction,
        );
        expect(inserted.ok).toBe(true);
        const sealed = await harness.repository.sealTombstones(
          [
            {
              ...sealDraft(`a-inverted-${operationId.slice(-12)}`, operationId),
              expiresAt: new Date(REQUESTED_AT.getTime() - 1),
            },
          ],
          [id<ErasureTombstoneId>(harness.base.freshId("0075"))],
          transaction,
        );
        expect(sealed.ok).toBe(false);
        if (sealed.ok) return;
        expect(sealed.error.code).toBe("PRIVACY_ERASURE_REGISTER_UNAVAILABLE");
        throw new Error("seal refused; discard the receipt");
      }),
    ).rejects.toThrow(/discard the receipt/u);
    expect(await operationExists(operationId)).toBe(false);
  });

  test("a lease taken inside a discarded transaction is not held afterwards", async () => {
    // The lease is the one write on this port whose SURVIVAL would be silent
    // damage rather than a wrong answer: a lease that outlived its rolled-back
    // pass would keep every retry out until it expired, and the operation would
    // sit unswept with nothing failing anywhere.
    const operationId = harness.base.freshId("0076");
    await runResult(harness, (transaction) =>
      harness.repository.insertOperation(operationDraft(tenant, operationId), transaction),
    );
    await expect(
      harness.run(async (transaction) => {
        const claimed = await harness.repository.claimLease(
          tenant.organizationId,
          id<ErasureOperationId>(operationId),
          { token: id("lease-doomed"), expiresAt: EXPIRES_AT },
          REQUESTED_AT,
          transaction,
        );
        expect(claimed.ok && claimed.value).toBe(true);
        throw new Error("pass died after taking the lease");
      }),
    ).rejects.toThrow(/pass died/u);

    const row = await observer.erasureOperation.findUnique({
      where: { id: operationId },
      select: { leaseToken: true, leaseExpiresAt: true },
    });
    expect(row?.leaseToken).toBeNull();
    expect(row?.leaseExpiresAt).toBeNull();
  });

  test("a purge inside a discarded transaction does not remove the barrier", async () => {
    // `purgeExpiredTombstones` is the only DELETE on this port, and its port
    // comment says correctness does not depend on it running. It DOES depend on
    // it not running twice — a purge that committed inside a transaction the
    // caller then discarded would have deleted rows the caller's own rollback
    // could not restore.
    const operationId = harness.base.freshId("0077");
    const alias = `a-purge-${operationId.slice(-12)}`;
    await runResult(harness, (transaction) =>
      harness.repository.sealTombstones(
        [{ ...sealDraft(alias, operationId), expiresAt: new Date(REQUESTED_AT.getTime() + 1) }],
        [id<ErasureTombstoneId>(harness.base.freshId("0078"))],
        transaction,
      ),
    );
    expect(await tombstoneExists(alias)).toBe(true);

    await expect(
      harness.run(async (transaction) => {
        const purged = await harness.repository.purgeExpiredTombstones(EXPIRES_AT, transaction);
        expect(purged.ok && purged.value).toBeGreaterThan(0);
        throw new Error("sweep aborted");
      }),
    ).rejects.toThrow(/sweep aborted/u);

    expect(await tombstoneExists(alias)).toBe(true);
  });
});

describe("the three scope refusals, each with its own code", () => {
  test("a write with NO transaction open is refused `not_open`", async () => {
    // The store never reaches a statement: `writer(scope)` throws before the
    // delegate is touched, and `refusePrivacy` RETHROWS it rather than folding it
    // into `PRIVACY_OPERATION_STORE_UNAVAILABLE`. A use case that lost its
    // transaction must not be able to carry on as though a row had merely failed
    // to write — which in this context means carrying on with a destruction whose
    // barrier is not committed.
    await expect(
      harness.repository.insertOperation(
        operationDraft(tenant, harness.base.freshId("0079")),
        { transactionId: "pg-txn-never" } as unknown as TransactionScope,
      ),
    ).rejects.toMatchObject({ code: TRANSACTION_NOT_OPEN });
  });

  test("a write carrying a FINISHED transaction's token is refused `scope_unknown`", async () => {
    let stale: TransactionScope | null = null;
    await harness.run(async (transaction) => {
      stale = transaction;
    });
    expect(stale).not.toBeNull();
    // Re-used from INSIDE a new transaction, so a frame is open and the token is
    // the thing that is wrong. Without the new transaction this would be
    // `not_open` and the two refusals would be indistinguishable.
    const raised = await runResult(
      harness.base.adapter.unitOfWork,
      async () =>
        harness.repository.sealTombstones(
          [sealDraft(`a-stale-${harness.base.freshId("0080").slice(-12)}`, harness.base.freshId("0081"))],
          [id<ErasureTombstoneId>(harness.base.freshId("0082"))],
          stale as unknown as TransactionScope,
        ),
      )
      .then(
        () => "<nothing was refused>",
        (error: unknown) => codeOf(error),
      );
    expect(raised).toBe(TRANSACTION_SCOPE_UNKNOWN);
  });

  test("a write carrying ANOTHER LIVE transaction's token is refused `scope_foreign`", async () => {
    // The concurrent unit of work is opened from OUTSIDE any frame, deliberately.
    // `UnitOfWork.run` JOINS an open transaction rather than opening a second one,
    // so a NESTED call carries the SAME id and could never be foreign; the foreign
    // token has to come from a genuinely separate async context.
    //
    // This is also the refusal a SHARED `TenancyTransactions` exists to make
    // possible at all. A thirteenth adapter package holding only this repository
    // would have had an ambient frame of its own, and a scope minted by the other
    // would have come back `scope_unknown` — the right fact under the wrong name,
    // which is precisely the collapse tranche 1 minted three codes to prevent.
    let openConcurrent: (scope: TransactionScope) => void = () => undefined;
    let releaseConcurrent: () => void = () => undefined;
    const opened = new Promise<TransactionScope>((resolve) => {
      openConcurrent = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseConcurrent = resolve;
    });
    const held = harness.base.adapter.unitOfWork.run(async (concurrent) => {
      openConcurrent(concurrent as unknown as TransactionScope);
      await release;
    });

    const other = await opened;
    const thrown = await harness.run((live) => {
      expect(live.transactionId).not.toBe(other.transactionId);
      return harness.repository
        .purgeExpiredTombstones(EXPIRES_AT, other)
        .then(() => null)
        .catch((error: unknown) => error);
    });
    releaseConcurrent();
    await held;
    expect(codeOf(thrown)).toBe(TRANSACTION_SCOPE_FOREIGN);
  });

  test("the three codes are distinct strings", () => {
    // The acceptance condition stated directly: two guards sharing one code
    // cannot be told apart, whatever else a suite proves about them.
    expect(
      new Set([TRANSACTION_NOT_OPEN, TRANSACTION_SCOPE_UNKNOWN, TRANSACTION_SCOPE_FOREIGN]).size,
    ).toBe(3);
  });
});
