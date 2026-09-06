// Transaction boundaries and scope guards, against a REAL PostgreSQL.
//
// EVERY GUARD HERE IS FALSIFIABLE, and the ledger in mutations.json records the
// deletion that turns each of these named cases red. The three refusals carry
// three codes because they are three different mistakes, and a shared code would
// make two of them indistinguishable in an operator's log — which is exactly how
// defects hid behind one code in `privacy` and in `identity-access`.
//
// THE ROLLBACK CASES INJECT A REAL FAILURE. `cost-monitoring` shipped a
// transaction that committed its first write when its second one failed, because
// its double had nothing to roll back. The only way to know this one does not is
// to make the second write fail against a real database and then look for the
// first row.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  OrganizationId,
  OrganizationRecord,
  TransactionId,
  TransactionScope,
} from "@platos/context-tenancy/application/ports/index.js";
import { asIdentifier } from "@platos/context-tenancy/application/ports/index.js";
import { domainError, err, runResult } from "@platos/context-tenancy/application/ports/index.js";

import type { TenancyHarness } from "./harness.js";
import { AT, orgId, slugOf, startTenancyHarness } from "./harness.js";
import {
  TRANSACTION_NOT_OPEN,
  TRANSACTION_SCOPE_FOREIGN,
  TRANSACTION_SCOPE_UNKNOWN,
} from "./transaction.js";

let harness: TenancyHarness;

beforeAll(async () => {
  harness = await startTenancyHarness();
}, 180_000);

afterAll(async () => {
  await harness?.stop();
});

function organization(id: OrganizationId, slug: string): OrganizationRecord {
  return { id, slug: slugOf(slug), name: slug, archivedAt: null, createdAt: AT, updatedAt: AT };
}

/** A token no transaction was ever given, for the cases that must be refused. */
const ABSENT_SCOPE: TransactionScope = { transactionId: asIdentifier<TransactionId>("pg-txn-1") };

describe("transaction scope guards", () => {
  test("a write outside any transaction is refused with not_open", async () => {
    const id = orgId(harness.freshId("0001"));
    await expect(
      harness.adapter.saveOrganization(organization(id, "no-transaction"), ABSENT_SCOPE),
    ).rejects.toMatchObject({ name: "TransactionScopeError", code: TRANSACTION_NOT_OPEN });
    expect(await harness.adapter.loadOrganization(id)).toBeNull();
  });

  test("a write carrying a FINISHED transaction's token is refused with scope_unknown", async () => {
    let escaped: TransactionScope | undefined;
    await harness.adapter.unitOfWork.run(async (transaction) => {
      escaped = transaction;
    });
    const stale = escaped;
    expect(stale).toBeDefined();
    const id = orgId(harness.freshId("0001"));
    await harness.adapter.unitOfWork.run(async () => {
      await expect(
        harness.adapter.saveOrganization(organization(id, "stale-token"), stale as TransactionScope),
      ).rejects.toMatchObject({ code: TRANSACTION_SCOPE_UNKNOWN });
    });
    expect(await harness.adapter.loadOrganization(id)).toBeNull();
  });

  test("a write carrying another LIVE transaction's token is refused with scope_foreign", async () => {
    const id = orgId(harness.freshId("0001"));

    // A second transaction opened OUTSIDE any ambient frame, so it is genuinely
    // concurrent rather than a nested join, and held open on a gate while the
    // write below runs inside a different one. Its token is in the registry, so
    // only the identity check can refuse this write.
    let release = (): void => undefined;
    const gate = new Promise<void>((settle) => {
      release = settle;
    });
    let concurrent: TransactionScope | undefined;
    const held = new Promise<void>((ready) => {
      void harness.adapter.unitOfWork.run(async (transaction) => {
        concurrent = transaction;
        ready();
        await gate;
      });
    });
    await held;
    const other = concurrent as TransactionScope;

    let refusal: unknown;
    await harness.adapter.unitOfWork.run(async (live) => {
      expect(other.transactionId).not.toBe(live.transactionId);
      try {
        await harness.adapter.saveOrganization(organization(id, "foreign-token"), other);
      } catch (error) {
        refusal = error;
      }
    });
    release();

    expect(refusal).toMatchObject({ code: TRANSACTION_SCOPE_FOREIGN });
    expect(await harness.adapter.loadOrganization(id)).toBeNull();
  });

  test("the three refusal codes are pairwise distinct", () => {
    const codes = [TRANSACTION_NOT_OPEN, TRANSACTION_SCOPE_UNKNOWN, TRANSACTION_SCOPE_FOREIGN];
    expect(new Set(codes).size).toBe(3);
  });
});

describe("transaction boundaries, proven by failure injection", () => {
  test("when the SECOND write of a transaction fails, NEITHER write committed", async () => {
    await harness.seedOrganization("occupied-slug");
    const first = orgId(harness.freshId("0001"));
    const second = orgId(harness.freshId("0001"));

    await expect(
      harness.adapter.unitOfWork.run(async (transaction) => {
        await harness.adapter.saveOrganization(organization(first, "rollback-first"), transaction);
        // The injected failure: this slug is already taken, so the unique index
        // refuses the row AFTER the first one has been written.
        await harness.adapter.saveOrganization(organization(second, "occupied-slug"), transaction);
      }),
    ).rejects.toBeDefined();

    expect(await harness.adapter.loadOrganization(first)).toBeNull();
    expect(await harness.adapter.loadOrganization(second)).toBeNull();
  });

  test("a REJECTION rolls back, and so does a RETURNED error Result — the kernel contract", async () => {
    const discarded = orgId(harness.freshId("0001"));
    const kept = orgId(harness.freshId("0001"));

    await expect(
      harness.adapter.unitOfWork.run(async (transaction) => {
        await harness.adapter.saveOrganization(organization(discarded, "thrown-away"), transaction);
        throw new Error("the use case refused after writing");
      }),
    ).rejects.toThrow("the use case refused after writing");
    expect(await harness.adapter.loadOrganization(discarded)).toBeNull();

    const returned = await runResult(harness.adapter.unitOfWork, async (transaction) => {
      await harness.adapter.saveOrganization(organization(kept, "returned-error"), transaction);
      return err(domainError("REFUSED_AFTER_WRITING", "conflict", "the use case refused after writing"));
    });
    expect(returned.ok).toBe(false);
    // The cost-monitoring trap, CLOSED, and recorded here as evidence rather
    // than as prose. This case used to assert the opposite against a real
    // database — a resolved promise committed, so a use case that must not
    // commit had to throw. WIN-260 (M2.5) made the returning shape unwritable at
    // the type level and `runResult` aborts on `err`, so the two halves of this
    // case now answer the same way for the same reason.
    expect(await harness.adapter.loadOrganization(kept)).toBeNull();
  });

  test("nesting JOINS the outer transaction rather than opening a second one", async () => {
    const id = orgId(harness.freshId("0001"));
    await expect(
      harness.adapter.unitOfWork.run(async (outer) => {
        await harness.adapter.unitOfWork.run(async (inner) => {
          expect(inner.transactionId).toBe(outer.transactionId);
          await harness.adapter.saveOrganization(organization(id, "nested-write"), inner);
        });
        throw new Error("outer refused");
      }),
    ).rejects.toThrow("outer refused");
    // The inner write is gone, which it would not be had nesting opened and
    // committed a transaction of its own.
    expect(await harness.adapter.loadOrganization(id)).toBeNull();
  });

  test("a read inside a transaction sees that transaction's own uncommitted rows", async () => {
    const id = orgId(harness.freshId("0001"));
    await expect(
      harness.adapter.unitOfWork.run(async (transaction) => {
        await harness.adapter.saveOrganization(organization(id, "read-your-writes"), transaction);
        const seen = await harness.adapter.loadOrganization(id);
        expect(seen?.name).toBe("read-your-writes");
        throw new Error("discard");
      }),
    ).rejects.toThrow("discard");
    expect(await harness.adapter.loadOrganization(id)).toBeNull();
  });

  test("the open-transaction registry does not outlive a commit or a rollback", async () => {
    await harness.adapter.unitOfWork.run(async () => undefined);
    await expect(
      harness.adapter.unitOfWork.run(async () => {
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    await expect(
      harness.adapter.saveOrganization(
        organization(orgId(harness.freshId("0001")), "after-registry"),
        ABSENT_SCOPE,
      ),
    ).rejects.toMatchObject({ code: TRANSACTION_NOT_OPEN });
  });
});
