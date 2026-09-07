// The transaction boundary, proved by FAILURE INJECTION against a real database,
// and the three scope refusals.
//
// WHY INJECTION AND NOT A ROLLBACK COUNT. A store that counted rollbacks would
// pass a suite that asserted rollbacks. Every case below forces the SECOND write
// of a multi-statement operation to fail and then LOOKS FOR THE FIRST ROW — over
// a second client, on a connection this adapter's pool never touched, because
// durability is not "the row is there when the writer looks again" but "the row
// is there when somebody else looks".
//
// AND IT IS THIS CONTEXT'S OWN TRAP. `cost-monitoring`'s in-memory double used
// to record the transaction scope and drop it, on the argument that "there is
// nothing to roll back in a map" — and the argument certified a bug:
// `detect-crossings.ts` returned an error `Result` from inside the callback on a
// fan-out failure, which RESOLVES, which COMMITS, leaving exactly the stranded
// crossing the file was written to prevent. The double was repaired; this is the
// same property measured against the store that actually has to hold it.
//
// TWO OPERATIONS HERE ARE TWO STATEMENTS EACH, and both are proved:
// `insertAlertChannel` writes a channel and then its configuration, and
// `finaliseDelivery` settles a row and then appends its send record.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  EnvironmentScope,
  ThresholdEventId,
} from "@platos/context-cost-monitoring/application/ports/index.js";
import { asCostIdentifier } from "@platos/context-cost-monitoring/application/ports/index.js";
import type { TransactionId } from "@platos/context-tenancy/application/ports/index.js";
import { asIdentifier } from "@platos/context-tenancy/application/ports/index.js";
import { runResult } from "@platos/context-cost-monitoring/application/ports/index.js";

import type { TenancyDatabaseClient } from "./client.js";
import { AT, LATER, conformanceBudget, conformanceChannel } from "./cost-conformance.js";
import type { CostHarness } from "./cost-harness.js";
import { startCostHarness } from "./cost-harness.js";
import {
  TRANSACTION_NOT_OPEN,
  TRANSACTION_SCOPE_FOREIGN,
  TRANSACTION_SCOPE_UNKNOWN,
} from "./transaction.js";

let harness: CostHarness;
let scope: EnvironmentScope;
/** A SECOND client over the same database. Nothing this adapter's pool touched. */
let observer: TenancyDatabaseClient;

beforeAll(async () => {
  harness = await startCostHarness();
  scope = await harness.freshScope();
  const { PrismaClient } = await import("@platos/tenancy-database");
  observer = new PrismaClient({
    datasources: { db: { url: harness.base.databaseUrl } },
  }) as TenancyDatabaseClient;
}, 300_000);

afterAll(async () => {
  await observer?.$disconnect();
  await harness?.stop();
});

function codeOf(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return `<uncoded:${String(error)}>`;
}

describe("a channel and its configuration are one transaction or neither", () => {
  test("the configuration write fails and the channel row does not survive it", async () => {
    const channelId = "ee000000-0001-4000-8000-000000000001";
    const revoked = await harness.seedCredential(scope, { revoked: true });
    const channel = conformanceChannel(scope, channelId, {
      kind: "WEBHOOK",
      configuration: {
        kind: "WEBHOOK",
        url: "https://ops.example.test/hook",
        credential: asCostIdentifier(revoked),
      },
    });

    // THE FAILURE IS THE ADAPTER'S OWN SECOND STATEMENT, not a third one this
    // suite adds. A webhook channel whose credential has been REVOKED passes the
    // channel INSERT and is refused by the configuration INSERT, because
    // `enforce_win124_credential_kind` demands a live `CHANNEL_SECRET` with an
    // active secret version. Nothing about the failure is simulated.
    await expect(
      runResult(harness.base.adapter.unitOfWork, (transaction) =>
        harness.repository.insertAlertChannel(channel, transaction),
      ),
    ).rejects.toThrow();

    // OVER THE SECOND CLIENT. The channel row is gone, and so is the
    // configuration the first half wrote.
    expect(await observer.alertChannel.count({ where: { id: channelId } })).toBe(0);
    expect(
      await observer.alertChannelConfiguration.count({ where: { channelId } }),
    ).toBe(0);
  });

  test("and the same two writes COMMIT together when nothing fails", async () => {
    // The negative control. Without it the case above would pass against a store
    // that never wrote anything at all.
    const channelId = "ee000000-0002-4000-8000-000000000001";
    await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      harness.repository.insertAlertChannel(conformanceChannel(scope, channelId), transaction),
    );
    expect(await observer.alertChannel.count({ where: { id: channelId } })).toBe(1);
    expect(await observer.alertChannelConfiguration.count({ where: { channelId } })).toBe(1);
  });
});

describe("a finalisation and its send record are one transaction or neither", () => {
  const capId = "ee000000-0003-4000-8000-000000000001";
  const crossingId = "ee000000-0004-4000-8000-000000000001";
  const channelId = "ee000000-0005-4000-8000-000000000001";
  const deliveryId = "ee000000-0006-4000-8000-000000000001";
  const claimToken = "ee000000-0007-4000-8000-000000000001";

  beforeAll(async () => {
    await harness.base.adapter.unitOfWork.run(async (transaction) => {
      await harness.repository.insertBudget(conformanceBudget(scope, capId, "scope"), transaction);
      await harness.repository.insertThresholdEvent(
        {
          eventId: asCostIdentifier<ThresholdEventId>(crossingId),
          environmentId: asCostIdentifier(scope.environmentId),
          budgetId: asCostIdentifier(capId),
          windowKey: asCostIdentifier("2026-07-01"),
          threshold: 50,
          spent: { microCents: 500_000_000n, currency: asCostIdentifier("USD") },
          tasks: 3,
          createdAt: AT,
        },
        transaction,
      );
      await harness.repository.insertAlertChannel(
        conformanceChannel(scope, channelId),
        transaction,
      );
      await harness.repository.insertDeliveries(
        [
          {
            deliveryId: asCostIdentifier(deliveryId),
            environmentId: asCostIdentifier(scope.environmentId),
            channelId: asCostIdentifier(channelId),
            eventId: asCostIdentifier<ThresholdEventId>(crossingId),
            kind: "BUDGET",
            idempotencyKey: asCostIdentifier(`budget:${crossingId}:${channelId}`),
            status: "PENDING",
            retryCount: 0,
            claimGeneration: 0,
            claimToken: null,
            availableAt: AT,
            lastRetryAt: null,
            deliveredAt: null,
            lastStatusCode: null,
            lastErrorCode: null,
            lastErrorMessage: null,
            createdAt: AT,
            updatedAt: AT,
          },
        ],
        transaction,
      );
    });
  }, 120_000);

  test("the send record fails and the delivery stays claimable", async () => {
    const claimed = await harness.repository.claimDelivery(
      scope,
      asCostIdentifier(deliveryId),
      asCostIdentifier(claimToken),
      new Date("2026-05-01T10:05:00.000Z"),
      LATER,
    );
    expect(claimed.ok && claimed.value !== null).toBe(true);
    if (!claimed.ok || claimed.value === null) return;
    const holder = claimed.value;

    // THE SECOND WRITE IS MADE TO FAIL by putting the send record it is about to
    // append into the table first, OUTSIDE the transaction under test.
    // `@@unique([deliveryId, retryNumber])` then refuses the adapter's OWN
    // insert — the second of the two statements `finaliseDelivery` issues — so
    // the failure belongs to the operation rather than to an extra statement
    // this suite bolted on.
    await observer.alertDeliveryRetry.create({
      data: {
        environmentId: scope.environmentId,
        deliveryId,
        retryNumber: holder.retryCount,
        status: "SUCCEEDED",
        responseStatus: 200,
        startedAt: LATER,
        finishedAt: LATER,
      },
    });

    await expect(
      harness.base.adapter.unitOfWork.run(async (transaction) => {
        const settled = await harness.repository.finaliseDelivery(
          { ...holder, status: "SUCCEEDED", claimToken: null, deliveredAt: LATER, availableAt: LATER },
          {
            deliveryId: asCostIdentifier(deliveryId),
            environmentId: asCostIdentifier(scope.environmentId),
            retryNumber: holder.retryCount,
            status: "SUCCEEDED",
            responseStatus: 200,
            errorCode: null,
            errorMessage: null,
            startedAt: LATER,
            finishedAt: LATER,
          },
          {
            token: asCostIdentifier(claimToken),
            generation: holder.claimGeneration,
            retryNumber: holder.retryCount,
          },
          transaction,
        );
        expect(settled.ok).toBe(true);
      }),
    ).rejects.toThrow();

    // The delivery was NOT settled — it is still PROCESSING and its lease will
    // expire — and no send record survives. A store that had committed the
    // finalisation would leave a delivery nobody will ever re-send and no record
    // of why.
    const row = await observer.alertDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(row.status).toBe("PROCESSING");
    expect(row.deliveredAt).toBeNull();
    // ONE send record: the one this suite planted. The adapter's own append
    // rolled back with the settlement it belonged to, so an operator reading
    // this row sees a delivery still owed rather than one recorded as sent.
    expect(await observer.alertDeliveryRetry.count({ where: { deliveryId } })).toBe(1);
  });

  test("and a finalisation that is not interfered with COMMITS both rows", async () => {
    // THE NEGATIVE CONTROL. Without it the case above would pass against a store
    // that never wrote anything at all. The row is re-claimed first, once its
    // lease has expired — which is also the recovery path a dead dispatcher
    // leaves behind — so this finalisation carries a retry number the planted
    // record does not already hold.
    const reclaimed = await harness.repository.claimDelivery(
      scope,
      asCostIdentifier(deliveryId),
      asCostIdentifier("ee000000-0007-4000-8000-000000000002"),
      new Date("2026-05-01T10:20:00.000Z"),
      new Date("2026-05-01T10:10:00.000Z"),
    );
    expect(reclaimed.ok && reclaimed.value !== null).toBe(true);
    const current = await observer.alertDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(current.retryCount).toBe(2);
    const settled = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      harness.repository.finaliseDelivery(
        {
          deliveryId: asCostIdentifier(deliveryId),
          environmentId: asCostIdentifier(scope.environmentId),
          channelId: asCostIdentifier(channelId),
          eventId: asCostIdentifier<ThresholdEventId>(crossingId),
          kind: "BUDGET",
          idempotencyKey: asCostIdentifier(`budget:${crossingId}:${channelId}`),
          status: "SUCCEEDED",
          retryCount: current.retryCount,
          claimGeneration: current.claimGeneration,
          claimToken: null,
          availableAt: LATER,
          lastRetryAt: LATER,
          deliveredAt: LATER,
          lastStatusCode: 200,
          lastErrorCode: null,
          lastErrorMessage: null,
          createdAt: AT,
          updatedAt: LATER,
        },
        {
          deliveryId: asCostIdentifier(deliveryId),
          environmentId: asCostIdentifier(scope.environmentId),
          retryNumber: current.retryCount,
          status: "SUCCEEDED",
          responseStatus: 200,
          errorCode: null,
          errorMessage: null,
          startedAt: LATER,
          finishedAt: LATER,
        },
        {
          token: asCostIdentifier(current.claimToken ?? ""),
          generation: current.claimGeneration,
          retryNumber: current.retryCount,
        },
        transaction,
      ),
    );
    expect(settled.ok && settled.value !== null).toBe(true);
    const row = await observer.alertDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(row.status).toBe("SUCCEEDED");
    // TWO now: the planted record from the case above, and the one this
    // finalisation appended under a retry number of its own.
    expect(await observer.alertDeliveryRetry.count({ where: { deliveryId } })).toBe(2);
  });
});

describe("the three transaction-scope refusals, on this context's writes", () => {
  test("a write with NO open transaction is refused with not_open", async () => {
    const cap = conformanceBudget(scope, "ee000000-0008-4000-8000-000000000001", "scope");
    let refusal = "<no refusal>";
    try {
      await harness.repository.insertBudget(cap, {
        transactionId: asIdentifier<TransactionId>("pg-txn-999"),
      });
    } catch (error) {
      refusal = codeOf(error);
    }
    expect(refusal).toBe(TRANSACTION_NOT_OPEN);
  });

  test("a write carrying a FINISHED transaction's token is refused with scope_unknown", async () => {
    let stale = { transactionId: asIdentifier<TransactionId>("pg-txn-0") };
    await harness.base.adapter.unitOfWork.run(async (transaction) => {
      stale = transaction as typeof stale;
    });
    let refusal = "<no refusal>";
    try {
      await runResult(harness.base.adapter.unitOfWork, () =>
        harness.repository.insertBudget(
          conformanceBudget(scope, "ee000000-0009-4000-8000-000000000001", "scope"),
          stale,
        ),
      );
    } catch (error) {
      refusal = codeOf(error);
    }
    // THREE DISTINCT CODES, AND THIS IS THE ONE THAT SEPARATES A CLOSED
    // TRANSACTION FROM ANOTHER LIVE ONE. A single shared code would make the two
    // indistinguishable in a log, which is how two defects hid behind one code
    // in `privacy` and in `identity-access`.
    expect(refusal).toBe(TRANSACTION_SCOPE_UNKNOWN);
  });

  test("a write carrying ANOTHER live transaction's token is refused with scope_foreign", async () => {
    // The second transaction is opened OUTSIDE any ambient frame and held on a
    // gate, so it is genuinely CONCURRENT rather than a nested join —
    // `UnitOfWork.run` joins an open transaction, which is its contract, so a
    // run started inside the outer callback would hand back the outer's own
    // token and this case would measure nothing. Its token IS in the registry,
    // so only the identity check can refuse the write; that is exactly what
    // separates `scope_foreign` from `scope_unknown`.
    let release = (): void => undefined;
    const gate = new Promise<void>((settle) => {
      release = settle;
    });
    let concurrent: { readonly transactionId: TransactionId } | undefined;
    const held = new Promise<void>((ready) => {
      void harness.base.adapter.unitOfWork.run(async (transaction) => {
        concurrent = transaction;
        ready();
        await gate;
      });
    });
    await held;
    const foreign = concurrent as { readonly transactionId: TransactionId };

    let refusal = "<no refusal>";
    await harness.base.adapter.unitOfWork.run(async (live) => {
      expect(foreign.transactionId).not.toBe(live.transactionId);
      try {
        await harness.repository.insertBudget(
          conformanceBudget(scope, "ee000000-000a-4000-8000-000000000001", "scope"),
          foreign,
        );
      } catch (error) {
        refusal = codeOf(error);
      }
    });
    release();
    expect(refusal).toBe(TRANSACTION_SCOPE_FOREIGN);
  });
});
