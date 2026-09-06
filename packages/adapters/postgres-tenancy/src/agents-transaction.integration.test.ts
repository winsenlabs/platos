// The transaction boundary of the `agents` stores, proved by FAILURE INJECTION
// against a real PostgreSQL — and the one finding that changed how every write
// in this tranche is written.
//
// THE FINDING. A statement that violates a constraint inside an interactive
// transaction ABORTS that transaction. The client still sends `COMMIT` when the
// callback resolves, and PostgreSQL executes that `COMMIT` as a `ROLLBACK`
// WITHOUT AN ERROR. So a repository method that catches a unique violation and
// returns `err(agentAlreadyExists(...))` — which is exactly what the in-memory
// double does, and therefore what the conformance differential requires — would
// hand the caller a business outcome while silently discarding every write the
// caller had already made. `SAVEPOINT` / `ROLLBACK TO SAVEPOINT` around the
// refusable statement is what removes that outcome, and the two cases below
// measure BOTH halves: with the mechanism the earlier write survives, and
// without it — issued straight through the client, in this file, so the claim is
// not taken on trust — it does not.
//
// DURABILITY IS READ FROM A SECOND CONNECTION. "The row is there when the writer
// looks again" is not durability: a writer sees its own uncommitted rows. Every
// assertion about what survived opens its own client over the same container.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { Agent, AgentVersion } from "@platos/context-agents/application/ports/index.js";
import { runResult } from "@platos/kernel";

import { agentIdOf, agentSlugOf, HOME_PROJECT, scopeOf, HOME_ENVIRONMENT, startAgentsHarness, versionIdOf, type AgentsHarness, type SeededAgent } from "./agents-harness.js";
import { TRANSACTION_NOT_OPEN, TRANSACTION_SCOPE_FOREIGN, TRANSACTION_SCOPE_UNKNOWN } from "./transaction.js";

let harness: AgentsHarness;
let host: SeededAgent;

const HOME = scopeOf(HOME_ENVIRONMENT);
const AT = new Date("2026-05-01T09:00:00.000Z");

function agentNamed(harnessRef: AgentsHarness, slug: string): Agent {
  return {
    agentId: agentIdOf(harnessRef.freshId("0401")),
    projectId: HOME_PROJECT as never,
    name: slug,
    slug: agentSlugOf(slug),
    description: null,
    isActive: true,
    createdAt: AT,
    updatedAt: AT,
  };
}

/** A second connection over the same container. Nothing this pool wrote is visible early. */
async function elsewhere<Value>(work: (client: never) => Promise<Value>): Promise<Value> {
  const { PrismaClient } = (await import("@platos/tenancy-database")) as never as {
    PrismaClient: new (options: unknown) => { $disconnect(): Promise<void> };
  };
  const client = new PrismaClient({ datasources: { db: { url: harness.databaseUrl } } });
  try {
    return await work(client as never);
  } finally {
    await client.$disconnect();
  }
}

async function agentCount(slug: string): Promise<number> {
  return elsewhere(async (client) =>
    (client as never as { agent: { count(args: unknown): Promise<number> } }).agent.count({
      where: { slug },
    }),
  );
}

beforeAll(async () => {
  harness = await startAgentsHarness();
  host = await harness.seedAgent({ slug: "transaction-host" });
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

describe("the transaction boundary", () => {
  test("a THROWN refusal rolls the whole transaction back", async () => {
    const survivor = agentNamed(harness, "rolled-back");
    // The second write names an agent that does not exist, so the foreign key
    // refuses — a refusal `insertVersion` does NOT recognise as an outcome, so it
    // is rethrown and the transaction is rolled back by `UnitOfWork.run`.
    const orphan: AgentVersion = { ...host.version, agentVersionId: versionIdOf(harness.freshId("0402")), agentId: agentIdOf("aa000000-0000-4000-8000-0000000000fe"), versionNumber: 7 };
    await expect(
      runResult(harness.adapter.unitOfWork, async (transaction) => {
        const first = await harness.repository.insertAgent(survivor, transaction);
        expect(first.ok).toBe(true);
        return harness.repository.insertVersion(orphan, transaction);
      }),
    ).rejects.toThrow();
    expect(await agentCount("rolled-back")).toBe(0);
  });

  test("a RETURNED refusal commits what came before it, and the savepoint is why", async () => {
    const survivor = agentNamed(harness, "survives-the-refusal");
    const outcome = await runResult(harness.adapter.unitOfWork, async (transaction) => {
      const first = await harness.repository.insertAgent(survivor, transaction);
      expect(first.ok).toBe(true);
      // A slug already taken. The store answers `err`, the callback RESOLVES,
      // and `UnitOfWork.run` therefore COMMITS — which is the caller's decision
      // to make and not this adapter's. What the savepoint guarantees is that
      // the commit is honest: the first row really is there.
      return harness.repository.insertAgent(
        { ...agentNamed(harness, "transaction-host") },
        transaction,
      );
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error.code).toBe("AGENTS_AGENT_ALREADY_EXISTS");
    expect(await agentCount("survives-the-refusal")).toBe(1);
  });

  test("WITHOUT the savepoint the same shape commits nothing and says nothing", async () => {
    // Issued straight through the client, deliberately: this is the behaviour
    // the guard exists to remove, and a claim about it is worth only as much as
    // the measurement beside it. Note that `$transaction` RESOLVES.
    const client = harness.client as never as {
      $transaction<Value>(work: (tx: never) => Promise<Value>): Promise<Value>;
    };
    const doomed = agentNamed(harness, "silently-discarded");
    let caught: string | null = null;
    await client.$transaction(async (tx) => {
      const delegate = tx as never as {
        agent: { create(args: unknown): Promise<unknown> };
      };
      await delegate.agent.create({
        data: {
          id: doomed.agentId,
          projectId: doomed.projectId,
          name: doomed.name,
          slug: doomed.slug,
          isActive: true,
        },
      });
      try {
        await delegate.agent.create({
          data: {
            id: harness.freshId("0403"),
            projectId: HOME_PROJECT,
            name: "clash",
            slug: "transaction-host",
            isActive: true,
          },
        });
      } catch (error) {
        caught = (error as { code?: string }).code ?? "unknown";
      }
    });
    expect(caught).toBe("P2002");
    expect(await agentCount("silently-discarded")).toBe(0);
  });

  test("a write with no open transaction is refused, with its own code", async () => {
    await expect(
      harness.repository.insertAgent(agentNamed(harness, "no-transaction"), {
        transactionId: "pg-txn-does-not-exist" as never,
      }),
    ).rejects.toMatchObject({ code: TRANSACTION_NOT_OPEN });
  });

  test("a token whose transaction has finished is refused, with its own code", async () => {
    let stale = { transactionId: "" as never };
    await harness.adapter.unitOfWork.run(async (transaction) => {
      stale = transaction as never;
    });
    await expect(
      runResult(harness.adapter.unitOfWork, async () =>
        harness.repository.insertAgent(agentNamed(harness, "stale-token"), stale),
      ),
    ).rejects.toMatchObject({ code: TRANSACTION_SCOPE_UNKNOWN });
    expect(await agentCount("stale-token")).toBe(0);
  });

  test("another live transaction's token is refused, with its own code", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let foreign = { transactionId: "" as never };
    let seen: unknown = null;
    const outer = harness.adapter.unitOfWork.run(async (transaction) => {
      foreign = transaction as never;
      await held;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const inner = harness.adapter.unitOfWork.run(async () => {
      try {
        await harness.repository.insertAgent(agentNamed(harness, "foreign-token"), foreign);
      } catch (error) {
        seen = error;
      }
    });
    await inner;
    release();
    await outer;
    expect(seen).toMatchObject({ code: TRANSACTION_SCOPE_FOREIGN });
    expect(await agentCount("foreign-token")).toBe(0);
  });

  test("a READ that takes a scope validates it too", async () => {
    // `countBindings` is the one READ on this port that takes a transaction,
    // because the caller counts AFTER its own delete and inside the same
    // transaction. Resolving it through `reader()` would answer correctly —
    // `reader()` prefers the ambient frame — and would accept a token from a
    // transaction that has already finished, which is the difference this case
    // exists for. The count is not the guard; the refusal is.
    let stale = { transactionId: "" as never };
    await harness.adapter.unitOfWork.run(async (transaction) => {
      stale = transaction as never;
    });
    await expect(
      runResult(harness.adapter.unitOfWork, async () =>
        harness.repository.countBindings(host.agent.agentId, stale),
      ),
    ).rejects.toMatchObject({ code: TRANSACTION_SCOPE_UNKNOWN });
  });

  test("a nested run JOINS the outer transaction rather than opening a second", async () => {
    const inner = agentNamed(harness, "nested");
    await expect(
      harness.adapter.unitOfWork.run(async (outer) => {
        await harness.adapter.unitOfWork.run(async (nested) => {
          expect(nested.transactionId).toBe(outer.transactionId);
          const written = await harness.repository.insertAgent(inner, nested);
          expect(written.ok).toBe(true);
        });
        // The outer work then fails, so the nested write must go with it.
        throw new Error("the outer unit of work failed");
      }),
    ).rejects.toThrow("the outer unit of work failed");
    expect(await agentCount("nested")).toBe(0);
  });

  test("two saves against one agent serialise on the parent row lock", async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstHolds = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = harness.adapter.unitOfWork.run(async (transaction) => {
      const numbers = await harness.repository.observedVersionNumbers(
        host.agent.agentId,
        transaction,
      );
      expect(numbers.ok).toBe(true);
      order.push("first took the lock");
      await firstHolds;
      order.push("first releases");
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = harness.adapter.unitOfWork.run(async (transaction) => {
      await harness.repository.observedVersionNumbers(host.agent.agentId, transaction);
      order.push("second took the lock");
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    // The second has NOT got past its read while the first still holds.
    expect(order).toEqual(["first took the lock"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first took the lock", "first releases", "second took the lock"]);
  });

  test("the lock is taken for an agent that has NO versions yet", async () => {
    // THE CASE THE INNER JOIN WOULD HAVE MISSED, and the one that matters most:
    // the first save is where two callers race hardest, and it is the only save
    // where the agent has no versions at all. `FOR UPDATE OF` locks the rows the
    // statement RETURNS, so a join that returned none would have taken no lock —
    // on every save except this one, with every other case in this file still
    // green.
    const bare = agentNamed(harness, "no-versions-yet");
    await runResult(harness.adapter.unitOfWork, (transaction) =>
      harness.repository.insertAgent(bare, transaction),
    );

    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstHolds = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = harness.adapter.unitOfWork.run(async (transaction) => {
      const numbers = await harness.repository.observedVersionNumbers(bare.agentId, transaction);
      expect(numbers.ok && numbers.value).toEqual([]);
      order.push("first took the lock");
      await firstHolds;
      order.push("first releases");
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = harness.adapter.unitOfWork.run(async (transaction) => {
      await harness.repository.observedVersionNumbers(bare.agentId, transaction);
      order.push("second took the lock");
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(order).toEqual(["first took the lock"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first took the lock", "first releases", "second took the lock"]);
  });

  test("a binding that is no longer there is REFUSED, not re-created", async () => {
    // The half of `updateBinding`'s compare-and-move this port CAN honour: the
    // row's identity. A binding whose row has gone matches nothing, and the
    // store answers `binding_moved_underneath` rather than inserting it again.
    const removed = await harness.seedAgent({ slug: "binding-gone" });
    await runResult(harness.adapter.unitOfWork, (transaction) =>
      harness.repository.deleteBinding(HOME, removed.binding, transaction),
    );
    const moved = await runResult(harness.adapter.unitOfWork, (transaction) =>
      harness.repository.updateBinding({ ...removed.binding, canaryPercent: 5 }, transaction),
    );
    expect(moved.ok).toBe(false);
    expect(moved.ok === false && moved.error.details["reason"]).toBe("binding_moved_underneath");
  });

  test("a committed agent is visible from a connection this pool never touched", async () => {
    const durable = agentNamed(harness, "durable");
    await runResult(harness.adapter.unitOfWork, (transaction) =>
      harness.repository.insertAgent(durable, transaction),
    );
    expect(await agentCount("durable")).toBe(1);
  });
});
