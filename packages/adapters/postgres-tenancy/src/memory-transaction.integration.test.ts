// Transaction boundaries for `memory`'s two stores, proved by FAILURE INJECTION
// against a real PostgreSQL.
//
// AN ASSERTION THAT A WRITE "IS TRANSACTIONAL" IS NOT EVIDENCE. Every case here
// forces a SECOND write to fail after a first has already succeeded, and then
// asks a SEPARATE CLIENT — one this adapter's pool has never touched — whether
// the first survived. Durability is not "the row is there when the writer looks
// again": a writer sees its own uncommitted rows, so a check on the same
// connection would pass against a store with no transaction at all.
//
// THE `cost-monitoring` TRAP HAS ITS OWN CASE, and it is a pin rather than a
// bug report. A store method that RETURNS an error `Result` does not throw, so
// `unitOfWork.run` sees a resolved promise and COMMITS — including everything
// written before the refusal. That is the correct behaviour of an interactive
// transaction and the wrong behaviour of most use cases, and the only way to
// keep it visible is to write it down: `returned-error commits` below stands
// beside `thrown-error rolls back`, and the two together say exactly where the
// responsibility sits.
//
// THE THREE REFUSALS ARE THREE CODES. A write outside any transaction, a write
// carrying a token whose transaction has finished, and a write carrying another
// live transaction's token are three different mistakes, and
// `memory-refusal.ts` deliberately RETHROWS all three rather than folding them
// into `MEMORY_REPOSITORY_UNAVAILABLE` — a use case that lost its transaction
// must not carry on as though a row had merely failed to write.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  AgentId,
  EntityKey,
  MemoryId,
  TransactionScope,
} from "@platos/context-memory/application/ports/index.js";
import { asMemoryIdentifier } from "@platos/context-memory/application/ports/index.js";
import type { PrismaClient } from "@platos/tenancy-database";

import type { MemoryChain, MemoryHarness } from "./memory-harness.js";
import { edgeDraft, entityDraft, memoryDraft, startMemoryHarness } from "./memory-harness.js";
import {
  TRANSACTION_NOT_OPEN,
  TRANSACTION_SCOPE_FOREIGN,
  TRANSACTION_SCOPE_UNKNOWN,
  TransactionScopeError,
} from "./transaction.js";

let harness: MemoryHarness;
let chain: MemoryChain;
/** A connection this adapter's pool has never touched. Durability is asked HERE. */
let observer: PrismaClient;

const AT = new Date("2026-05-01T09:00:00.000Z");

beforeAll(async () => {
  harness = await startMemoryHarness();
  chain = await harness.seedChain(await harness.freshScope());
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

async function survives(memoryId: string): Promise<boolean> {
  return (await observer.memory.count({ where: { id: memoryId } })) === 1;
}

async function entitySurvives(entityId: string): Promise<boolean> {
  return (await observer.memoryEntity.count({ where: { id: entityId } })) === 1;
}

describe("failure injection", () => {
  test("a THROWN failure after a successful write leaves NEITHER row, seen from another connection", async () => {
    const first = id("0050");
    const second = id("0051");
    await expect(
      harness.base.adapter.unitOfWork.run(async (transaction) => {
        const one = await harness.stores.memory.insertMemory(
          { memory: memoryDraft(chain, first, AT), embedding: { action: "keep" } },
          transaction,
        );
        expect(one.ok).toBe(true);
        const two = await harness.stores.memory.insertMemory(
          { memory: memoryDraft(chain, second, AT), embedding: { action: "keep" } },
          transaction,
        );
        expect(two.ok).toBe(true);
        throw new Error("the use case refused after both writes");
      }),
    ).rejects.toThrow("the use case refused after both writes");

    expect(await survives(first)).toBe(false);
    expect(await survives(second)).toBe(false);
  });

  test("a memory and an entity written together roll back TOGETHER — the whole reason they share a directory", async () => {
    // `extract-from-conversation.ts` writes a memory and the entities pulled out
    // of it in one unit of work. A thirteenth adapter package holding only
    // `memory`'s repositories would have had its own pool, and this pair would
    // have been two transactions with a window between them.
    const memoryId = id("0052");
    const entityId = id("0053");
    await expect(
      harness.base.adapter.unitOfWork.run(async (transaction) => {
        await harness.stores.memory.insertMemory(
          { memory: memoryDraft(chain, memoryId, AT), embedding: { action: "keep" } },
          transaction,
        );
        await harness.stores.memoryGraph.insertEntity(entityDraft(chain, entityId, AT), transaction);
        throw new Error("abandoned");
      }),
    ).rejects.toThrow("abandoned");

    expect(await survives(memoryId)).toBe(false);
    expect(await entitySurvives(entityId)).toBe(false);
  });

  test("a DATABASE failure rolls the earlier write back, and the transaction is the only thing that could", async () => {
    // The second statement is refused by `MemoryRelationship`'s unique on
    // `(from, to, type)` INSIDE PostgreSQL, not by a guard in this package — so
    // the rollback is the database's own and the earlier entity write is what
    // proves it happened.
    const nodeA = id("0054");
    const nodeB = id("0055");
    const survivor = id("0056");
    const doomed = id("0057");

    await harness.base.adapter.unitOfWork.run(async (transaction) => {
      await harness.stores.memoryGraph.insertEntity(entityDraft(chain, nodeA, AT), transaction);
      await harness.stores.memoryGraph.insertEntity(
        entityDraft(chain, nodeB, AT, { entityKey: asMemoryIdentifier<EntityKey>("berlin"), label: "Berlin" }),
        transaction,
      );
      await harness.stores.memoryGraph.insertRelationship(
        edgeDraft(chain, survivor, nodeA, nodeB, AT),
        transaction,
      );
    });

    const rolled = await harness.base.adapter.unitOfWork.run(async (transaction) => {
      const written = await harness.stores.memoryGraph.insertEntity(
        entityDraft(chain, id("0058"), AT, {
          entityKey: asMemoryIdentifier<EntityKey>("paris"),
          label: "Paris",
        }),
        transaction,
      );
      const clash = await harness.stores.memoryGraph.insertRelationship(
        edgeDraft(chain, doomed, nodeA, nodeB, AT),
        transaction,
      );
      return { written, clash };
    });
    expect(rolled.written.ok).toBe(true);
    expect(rolled.clash.ok).toBe(false);
    if (!rolled.clash.ok) expect(rolled.clash.error.code).toBe("MEMORY_REPOSITORY_UNAVAILABLE");

    // The duplicate edge is not there.
    expect(await observer.memoryRelationship.count({ where: { id: doomed } })).toBe(0);
  });

  test("*** A RETURNED ERROR `Result` COMMITS *** — the trap, pinned rather than assumed", async () => {
    // This is the `cost-monitoring` shape that shipped. `insertRelationship`
    // refuses by RETURNING `err(...)`; nothing throws; `unitOfWork.run` resolves
    // and PostgreSQL commits — INCLUDING the memory written before the refusal.
    // The store is behaving correctly and so is the transaction; the
    // responsibility is the caller's, and this case is where that is written
    // down rather than discovered.
    const committed = id("0059");
    const nodeA = id("005a");
    const nodeB = id("005b");
    const edgeId = id("005c");

    await harness.base.adapter.unitOfWork.run(async (transaction) => {
      await harness.stores.memoryGraph.insertEntity(
        entityDraft(chain, nodeA, AT, { entityKey: asMemoryIdentifier<EntityKey>("rome"), label: "Rome" }),
        transaction,
      );
      await harness.stores.memoryGraph.insertEntity(
        entityDraft(chain, nodeB, AT, { entityKey: asMemoryIdentifier<EntityKey>("milan"), label: "Milan" }),
        transaction,
      );
      await harness.stores.memoryGraph.insertRelationship(
        edgeDraft(chain, edgeId, nodeA, nodeB, AT),
        transaction,
      );
    });

    const outcome = await harness.base.adapter.unitOfWork.run(async (transaction) => {
      const written = await harness.stores.memory.insertMemory(
        { memory: memoryDraft(chain, committed, AT), embedding: { action: "keep" } },
        transaction,
      );
      const refused = await harness.stores.memoryGraph.insertRelationship(
        edgeDraft(chain, id("005d"), nodeA, nodeB, AT),
        transaction,
      );
      // The use case RETURNS the refusal instead of throwing it. This is the
      // whole trap in one line.
      return { written, refused };
    });

    expect(outcome.written.ok).toBe(true);
    expect(outcome.refused.ok).toBe(false);
    expect(await survives(committed)).toBe(true);
  });

  test("a GUARD refusal sends no statement at all, so the transaction survives it", async () => {
    // The converse of the case above, and the reason `memory-guards.ts` refuses
    // BEFORE sending: a constraint violation aborts the enclosing transaction
    // with 25P02 and every later statement fails. A guard refusal does not, so a
    // caller that handles it can carry on writing.
    const beforeGuard = id("005e");
    const afterGuard = id("005f");

    const outcome = await harness.base.adapter.unitOfWork.run(async (transaction) => {
      const first = await harness.stores.memory.insertMemory(
        { memory: memoryDraft(chain, beforeGuard, AT), embedding: { action: "keep" } },
        transaction,
      );
      const refused = await harness.stores.memory.insertMemory(
        {
          memory: memoryDraft(chain, id("0060"), AT),
          // Three components for a `vector(1536)` column — the shape
          // `InMemoryEmbeddingModel` can be asked for.
          embedding: { action: "set", vector: [0.1, 0.2, 0.3] },
        },
        transaction,
      );
      const third = await harness.stores.memory.insertMemory(
        { memory: memoryDraft(chain, afterGuard, AT), embedding: { action: "keep" } },
        transaction,
      );
      return { first, refused, third };
    });

    expect(outcome.first.ok).toBe(true);
    expect(outcome.refused.ok).toBe(false);
    expect(outcome.third.ok).toBe(true);
    expect(await survives(beforeGuard)).toBe(true);
    expect(await survives(afterGuard)).toBe(true);
  });
});

describe("the three refusals", () => {
  test("a write with NO open transaction is refused with not_open", async () => {
    const stray: TransactionScope = { transactionId: asMemoryIdentifier("pg-txn-1") };
    await expect(
      harness.stores.memory.insertMemory(
        { memory: memoryDraft(chain, id("0061"), AT), embedding: { action: "keep" } },
        stray,
      ),
    ).rejects.toMatchObject({ code: TRANSACTION_NOT_OPEN });
  });

  test("a write with a FINISHED transaction's token is refused with scope_unknown", async () => {
    let escaped: TransactionScope | null = null;
    await harness.base.adapter.unitOfWork.run(async (transaction) => {
      escaped = transaction;
    });
    expect(escaped).not.toBeNull();

    await expect(
      harness.base.adapter.unitOfWork.run(async () =>
        harness.stores.memoryGraph.insertEntity(
          entityDraft(chain, id("0062"), AT, { entityKey: asMemoryIdentifier<EntityKey>("oslo"), label: "Oslo" }),
          escaped as unknown as TransactionScope,
        ),
      ),
    ).rejects.toMatchObject({ code: TRANSACTION_SCOPE_UNKNOWN });
  });

  test("a write with ANOTHER LIVE transaction's token is refused with scope_foreign", async () => {
    // TWO transactions open AT THE SAME TIME, started independently rather than
    // nested — `unitOfWork.run` inside an open frame JOINS it, which is the
    // kernel port's stated contract, so a nested call could never produce this
    // refusal at all. The write runs inside B carrying A's token, and A is still
    // live: "the token names a transaction that has finished" and "the token
    // names a DIFFERENT live transaction" are different incidents, and one
    // shared code would make them one line in a log.
    let openA: (() => void) | null = null;
    let announceA: (() => void) | null = null;
    const holdA = new Promise<void>((resolve) => {
      openA = resolve;
    });
    const readyA = new Promise<void>((resolve) => {
      announceA = resolve;
    });
    let scopeA: TransactionScope | null = null;

    const transactionA = harness.base.adapter.unitOfWork.run(async (scope) => {
      scopeA = scope;
      if (announceA !== null) announceA();
      await holdA;
    });
    await readyA;
    const foreignToken = scopeA as unknown as TransactionScope;

    let refusal: unknown = null;
    await harness.base.adapter.unitOfWork.run(async () => {
      try {
        await harness.stores.memory.insertMemory(
          { memory: memoryDraft(chain, id("0063"), AT), embedding: { action: "keep" } },
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
    expect(new Set([TRANSACTION_NOT_OPEN, TRANSACTION_SCOPE_UNKNOWN, TRANSACTION_SCOPE_FOREIGN]).size).toBe(3);
  });
});

describe("the ambient frame", () => {
  test("a READ joins the open transaction and sees its uncommitted rows", async () => {
    // `MemoryRepository`'s reads take no `TransactionScope` — only its writes do
    // — so a read issued between two writes has no token to correlate on. The
    // `AsyncLocalStorage` frame in `transaction.ts` is what keeps it on the same
    // connection, and without it `remember.ts` could not read back the row it
    // had just written to decide whether to merge.
    const memoryId = id("0064");
    const seenInside = await harness.base.adapter.unitOfWork.run(async (transaction) => {
      await harness.stores.memory.insertMemory(
        { memory: memoryDraft(chain, memoryId, AT), embedding: { action: "keep" } },
        transaction,
      );
      return harness.stores.memory.findMemory(
        chain.subject,
        [asMemoryIdentifier<AgentId>(chain.agentId)],
        asMemoryIdentifier<MemoryId>(memoryId),
      );
    });

    expect(seenInside.ok).toBe(true);
    if (seenInside.ok) expect(seenInside.value?.memoryId).toBe(memoryId);
  });

  test("and a read from OUTSIDE the transaction does not, which is what makes the case above mean something", async () => {
    const memoryId = id("0065");
    let visibleOutside = true;
    await expect(
      harness.base.adapter.unitOfWork.run(async (transaction) => {
        await harness.stores.memory.insertMemory(
          { memory: memoryDraft(chain, memoryId, AT), embedding: { action: "keep" } },
          transaction,
        );
        visibleOutside = (await observer.memory.count({ where: { id: memoryId } })) === 1;
        throw new Error("abandoned before commit");
      }),
    ).rejects.toThrow("abandoned before commit");

    expect(visibleOutside).toBe(false);
    expect(await survives(memoryId)).toBe(false);
  });

  test("`touchAccessed` takes NO scope and still joins the caller's transaction", async () => {
    // It is the one write on this port with no `TransactionScope` parameter,
    // because a failed access stamp must not fail a recall that is already
    // correct. It resolves through `atomic()`, which JOINS an open transaction
    // rather than opening a second one — so a rollback takes the stamp with it.
    const memoryId = id("0066");
    await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.memory.insertMemory(
        { memory: memoryDraft(chain, memoryId, AT), embedding: { action: "keep" } },
        transaction,
      ),
    );

    await expect(
      harness.base.adapter.unitOfWork.run(async () => {
        const touched = await harness.stores.memory.touchAccessed(
          chain.scope,
          [asMemoryIdentifier<MemoryId>(memoryId)],
          new Date("2026-06-01T00:00:00.000Z"),
        );
        expect(touched.ok && touched.value).toBe(1);
        throw new Error("rolled back after the stamp");
      }),
    ).rejects.toThrow("rolled back after the stamp");

    const row = await observer.memory.findUnique({ where: { id: memoryId }, select: { lastAccessedAt: true } });
    expect(row?.lastAccessedAt).toBeNull();
  });
});
