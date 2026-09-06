// Transaction boundaries for `observability`'s store, proved by FAILURE
// INJECTION against a real PostgreSQL.
//
// AN ASSERTION THAT A WRITE "IS TRANSACTIONAL" IS NOT EVIDENCE. Every case here
// forces a SECOND write to fail after a first has already succeeded, and then
// asks a SEPARATE CLIENT — one this adapter's pool has never touched — whether
// the first survived. Durability is not "the row is there when the writer looks
// again": a writer sees its own uncommitted rows, so a check on the same
// connection would pass against a store with no transaction at all.
//
// IT MATTERS MORE ON THIS TABLE THAN ON ANY OTHER IN THIS DIRECTORY. Every other
// owner's rollback loses a row that can be written again. This one loses the
// record of what an operator changed — and `domain/admin-audit.ts` rule 4 states
// the converse hazard: an audit write must not be the reason an admin action
// fails. Both directions have a case below.
//
// THE `cost-monitoring` TRAP HAS ITS OWN CASE, and this store is the cleanest
// place in the tree to state it, because it has BOTH halves. A guard refusal
// sends no statement and the session stays writable, so everything written
// before it COMMITS — the trap exactly as reported. A refusal that came from
// inside a statement aborts the session, and the same shape of code commits
// nothing. Two cases, side by side.
//
// THE THREE REFUSALS ARE THREE CODES. A write outside any transaction, a write
// carrying a token whose transaction has finished, and a write carrying another
// live transaction's token are three different mistakes, and
// `observability-refusal.ts` deliberately RETHROWS all three rather than folding
// them into `OBSERVABILITY_REPOSITORY_UNAVAILABLE`.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  PrincipalId,
  TransactionScope,
} from "@platos/context-observability/application/ports/index.js";
import { asIdentifier } from "@platos/context-observability/application/ports/index.js";
import type { PrismaClient } from "@platos/tenancy-database";

import type { AuditScope, ObservabilityHarness } from "./observability-harness.js";
import { auditRecord, startObservabilityHarness } from "./observability-harness.js";
import {
  TRANSACTION_NOT_OPEN,
  TRANSACTION_SCOPE_FOREIGN,
  TRANSACTION_SCOPE_UNKNOWN,
  TransactionScopeError,
} from "./transaction.js";

let harness: ObservabilityHarness;
let home: AuditScope;
/** A connection this adapter's pool has never touched. Durability is asked HERE. */
let observer: PrismaClient;

beforeAll(async () => {
  harness = await startObservabilityHarness();
  home = await harness.freshScope();
  const { PrismaClient: Client } = await import("@platos/tenancy-database");
  observer = new Client({ datasources: { db: { url: harness.base.databaseUrl } } });
}, 300_000);

afterAll(async () => {
  await observer?.$disconnect();
  await harness?.stop();
});

function id(kind: string): string {
  return harness.base.freshId(kind);
}

async function survives(auditId: string): Promise<boolean> {
  return (await observer.adminAudit.count({ where: { id: auditId } })) === 1;
}

function write<Value>(work: (transaction: TransactionScope) => Promise<Value>): Promise<Value> {
  return harness.base.adapter.unitOfWork.run(work);
}

describe("failure injection", () => {
  test("a THROWN failure after a successful write leaves NEITHER row, seen from another connection", async () => {
    const first = id("0060");
    const second = id("0061");
    await expect(
      write(async (transaction) => {
        const one = await harness.stores.observability.recordAdminAudit(
          auditRecord(home.scope, first),
          transaction,
        );
        expect(one.ok).toBe(true);
        const two = await harness.stores.observability.recordAdminAudit(
          auditRecord(home.scope, second, { action: "agent.update" }),
          transaction,
        );
        expect(two.ok).toBe(true);
        throw new Error("the admin action refused after both audit rows");
      }),
    ).rejects.toThrow("the admin action refused after both audit rows");

    expect(await survives(first)).toBe(false);
    expect(await survives(second)).toBe(false);
  });

  test("an audit row and the ACTION it records roll back together — the whole reason they share a directory", async () => {
    // `record-admin-action.ts` puts the append inside the admin action's own unit
    // of work. Here the action is a `tenancy` write — an environment rename —
    // through the SAME adapter, and the pair is abandoned. A fourteenth adapter
    // package holding only this repository would have had its own pool, and the
    // audit row would have survived an action that did not happen.
    const auditId = id("0062");
    const renamed = `renamed-${auditId.slice(-6)}`;
    const before = await observer.environment.findUnique({
      where: { id: home.environmentId },
      select: { name: true, slug: true, projectId: true, createdAt: true, updatedAt: true },
    });
    await expect(
      write(async (transaction) => {
        await harness.base.adapter.saveEnvironment(
          {
            id: home.scope.environmentId,
            projectId: home.scope.projectId,
            slug: asIdentifier(before?.slug ?? "prod"),
            name: renamed,
            archivedAt: null,
            accessKeyRevocationVersion: 0,
            memoryFeedbackBackfillCursor: null,
            memoryFeedbackBackfillCompletedAt: null,
            createdAt: before?.createdAt ?? new Date("2026-05-01T09:00:00.000Z"),
            updatedAt: new Date("2026-05-01T10:00:00.000Z"),
          },
          transaction,
        );
        await harness.stores.observability.recordAdminAudit(
          auditRecord(home.scope, auditId, {
            action: "environment.rename",
            subjectType: "Environment",
            after: { name: renamed },
          }),
          transaction,
        );
        throw new Error("abandoned");
      }),
    ).rejects.toThrow("abandoned");

    expect(await survives(auditId)).toBe(false);
    const after = await observer.environment.findUnique({
      where: { id: home.environmentId },
      select: { name: true },
    });
    expect(after?.name).toBe(before?.name);
  });

  test("a DATABASE failure rolls the earlier write back, and the transaction is the only thing that could", async () => {
    // The second write is refused by `AdminAudit_pkey` INSIDE PostgreSQL, not by
    // a guard in this package — so the rollback is the database's own and the
    // earlier row is what proves it happened.
    const survivor = id("0063");
    const clashing = id("0064");
    await write((transaction) =>
      harness.stores.observability.recordAdminAudit(auditRecord(home.scope, clashing), transaction),
    );

    const rolled = await write(async (transaction) => {
      const written = await harness.stores.observability.recordAdminAudit(
        auditRecord(home.scope, survivor),
        transaction,
      );
      const clash = await harness.stores.observability.recordAdminAudit(
        auditRecord(home.scope, clashing, { action: "agent.update" }),
        transaction,
      );
      return { written, clash };
    });
    expect(rolled.written.ok).toBe(true);
    expect(rolled.clash.ok).toBe(false);
    if (!rolled.clash.ok) {
      expect(rolled.clash.error.code).toBe("OBSERVABILITY_REPOSITORY_UNAVAILABLE");
    }

    // The row written BEFORE the clash did not survive, because PostgreSQL had
    // already aborted the session when the driver sent its COMMIT.
    expect(await survives(survivor)).toBe(false);
  });

  test("*** A RETURNED ERROR `Result` COMMITS WHEN A GUARD RAISED IT *** — the cost-monitoring trap, measured", async () => {
    // THE TRAP, AND THE HALF OF IT THAT IS REAL. A store method that RETURNS an
    // error `Result` does not throw, so `unitOfWork.run` sees a resolved promise
    // and COMMITS — including everything written before the refusal. That is
    // true precisely when the refusal was a GUARD's, because a guard sends no
    // statement and PostgreSQL never learns anything went wrong.
    //
    // The case above is the other half: when the DATABASE raised, the session is
    // already in 25P02 and the driver's COMMIT is executed as a ROLLBACK. The
    // two together say exactly where the responsibility sits, and neither could
    // have been written from the port's signatures.
    const committed = id("0065");
    const outcome = await write(async (transaction) => {
      const written = await harness.stores.observability.recordAdminAudit(
        auditRecord(home.scope, committed),
        transaction,
      );
      const refused = await harness.stores.observability.recordAdminAudit(
        auditRecord(home.scope, "not-a-uuid"),
        transaction,
      );
      return { written, refused };
    });
    expect(outcome.written.ok).toBe(true);
    expect(outcome.refused.ok).toBe(false);

    // AND IT IS THERE. A caller that treats a returned refusal as "nothing
    // happened" has already committed the row before it.
    expect(await survives(committed)).toBe(true);
  });
});

describe("the three scope refusals, from the store the ports declare", () => {
  test("a write with NO open transaction is refused with not_open", async () => {
    const orphan: TransactionScope = { transactionId: asIdentifier("pg-txn-never-opened") };
    await expect(
      harness.stores.observability.recordAdminAudit(auditRecord(home.scope, id("0066")), orphan),
    ).rejects.toMatchObject({ code: TRANSACTION_NOT_OPEN });
  });

  test("a write with a FINISHED transaction's token is refused with scope_unknown", async () => {
    let stale: TransactionScope | null = null;
    await write(async (transaction) => {
      stale = transaction;
    });
    const finished = stale as unknown as TransactionScope;
    await write(async () => {
      await expect(
        harness.stores.observability.recordAdminAudit(auditRecord(home.scope, id("0067")), finished),
      ).rejects.toMatchObject({ code: TRANSACTION_SCOPE_UNKNOWN });
    });
  });

  test("a write with ANOTHER LIVE transaction's token is refused with scope_foreign", async () => {
    // TWO transactions open AT THE SAME TIME, started independently rather than
    // nested — `unitOfWork.run` inside an open frame JOINS it, which is the
    // kernel port's stated contract, so a nested call could never produce this
    // refusal at all.
    let openA: (() => void) | null = null;
    let announceA: (() => void) | null = null;
    const holdA = new Promise<void>((resolve) => {
      openA = resolve;
    });
    const readyA = new Promise<void>((resolve) => {
      announceA = resolve;
    });
    let scopeA: TransactionScope | null = null;

    const transactionA = write(async (scope) => {
      scopeA = scope;
      if (announceA !== null) announceA();
      await holdA;
    });
    await readyA;
    const foreignToken = scopeA as unknown as TransactionScope;

    let refusal: unknown = null;
    await write(async () => {
      try {
        await harness.stores.observability.recordAdminAudit(
          auditRecord(home.scope, id("0068")),
          foreignToken,
        );
      } catch (error) {
        refusal = error;
      }
    });
    if (openA !== null) (openA as () => void)();
    await transactionA;

    expect(refusal).toBeInstanceOf(TransactionScopeError);
    expect((refusal as TransactionScopeError).code).toBe(TRANSACTION_SCOPE_FOREIGN);
  });

  test("the three codes are distinct, so two of them cannot be told apart only by luck", () => {
    expect(
      new Set([TRANSACTION_NOT_OPEN, TRANSACTION_SCOPE_UNKNOWN, TRANSACTION_SCOPE_FOREIGN]).size,
    ).toBe(3);
  });
});

describe("the ambient frame", () => {
  test("a READ joins the open transaction and sees its uncommitted rows", async () => {
    // `listAdminAudit` and `countAdminAuditForActor` take no `TransactionScope` —
    // only the two writes do — so a read issued between two writes of one
    // transaction has no token to correlate on. Without the ambient frame it
    // would go to the pool and answer from OUTSIDE the transaction, and a use
    // case reading back what it just appended would see nothing.
    const auditId = id("0069");
    const seen = await write(async (transaction) => {
      await harness.stores.observability.recordAdminAudit(
        auditRecord(home.scope, auditId, { action: "agent.create" }),
        transaction,
      );
      return harness.stores.observability.listAdminAudit({
        scope: home.scope,
        action: "agent.create",
        limit: 10,
      });
    });
    expect(seen.ok).toBe(true);
    if (seen.ok) expect(seen.value.map((row) => row.adminAuditId)).toContain(auditId);
  });
});

describe("the unlink, and what a rollback means for a table that cannot be changed", () => {
  test("the refusal is NOT a rollback of the audit row — the row was never at risk", async () => {
    // A reader could take "the unlink aborted the transaction" to mean the audit
    // trail is fragile. It is the opposite: the rows the unlink could not change
    // are exactly the rows the append-only rule protects, and they are committed
    // and untouched. What rolls back is whatever the CALLER did in the same unit
    // of work — which is why `observability-erasure-target.ts` refusing on the
    // `err` is the correct outcome and not a workaround.
    const auditId = id("006a");
    const actor = asIdentifier<PrincipalId>("88888888-8888-4888-8888-888888888888");
    await write((transaction) =>
      harness.stores.observability.recordAdminAudit(
        auditRecord(home.scope, auditId, { actorUserId: actor }),
        transaction,
      ),
    );
    await write((transaction) =>
      harness.stores.observability.clearAdminAuditActor(
        { organizationId: home.organizationId, actorUserId: actor },
        transaction,
      ),
    ).catch(() => undefined);

    const row = await observer.adminAudit.findUnique({
      where: { id: auditId },
      select: { actorUserId: true },
    });
    expect(row?.actorUserId).toBe(actor);
  });
});
