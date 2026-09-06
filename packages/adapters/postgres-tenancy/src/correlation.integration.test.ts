// WIN-260 (M2.5) — the request identifier, read back OUT OF POSTGRESQL.
//
// The claim this suite has to earn is "correlation reaches the store", and
// almost every way of testing that is a way of testing this process's own
// memory. A case that asserted `source.current()` inside the unit of work would
// prove the AsyncLocalStorage frame survives an await, which
// `apps/core-api/src/runtime/correlation.test.ts` already proves and which says
// nothing about the database. So every assertion below reads
// `current_setting('platos.request_id', true)` — PostgreSQL answering for its
// own session state, ON THE TRANSACTION'S OWN CONNECTION — or reads a committed
// row through a SECOND connection this adapter's pool never touched.
//
// WHY THE PROOF IS IN TWO SUITES. Rule (j) forbids `apps/core-api` from naming
// an adapter outside its one composition module, so no single suite can hold
// both ends. The seam is the kernel `CorrelationSource` port: the edge suite
// proves the app's implementation reports what the edge adopted, and this one
// proves that whatever a `CorrelationSource` reports arrives in PostgreSQL. The
// port is what makes the two halves compose, and it is the same port the
// composition root will bind.

import { AsyncLocalStorage } from "node:async_hooks";

import { asIdentifier, type CorrelationSource, type RequestId } from "@platos/kernel";
import { afterAll, beforeAll, expect, test } from "vitest";

import type { OutboxHarness } from "./outbox-harness.js";
import { startOutboxHarness } from "./outbox-harness.js";
import type { OutboxEventStorePort } from "./outbox-store.js";
import { createOutboxEventStore } from "./outbox-store.js";
import type { TenancyTransactions } from "./transaction.js";
import { createTenancyTransactions, REQUEST_ID_SETTING } from "./transaction.js";

/**
 * A `CorrelationSource` built the way the process edge builds its own.
 *
 * Deliberately the SAME mechanism as `apps/core-api/src/runtime/correlation.ts`
 * — an `AsyncLocalStorage` frame read through the kernel port — rather than a
 * mutable field. A source that could not be entered and left concurrently could
 * not exercise the property the concurrency case below is about.
 */
function edgeCorrelation(): CorrelationSource & {
  within<Value>(requestId: string, work: () => Promise<Value>): Promise<Value>;
} {
  const storage = new AsyncLocalStorage<string>();
  return {
    current() {
      const requestId = storage.getStore();
      return requestId === undefined ? null : { requestId: asIdentifier<RequestId>(requestId) };
    },
    within<Value>(requestId: string, work: () => Promise<Value>): Promise<Value> {
      return storage.run(requestId, work);
    },
  };
}

let harness: OutboxHarness;
const correlation = edgeCorrelation();
let correlated: TenancyTransactions;
let uncorrelated: TenancyTransactions;
let events: OutboxEventStorePort;

/**
 * What PostgreSQL says the request identifier is, inside this unit of work.
 *
 * `reader()` and not the pooled client. The pool would answer from a DIFFERENT
 * connection, where a transaction-local setting is not visible and never was —
 * a query written that way would return the empty string for every case in this
 * file and the suite would look like a clean refutation of its own subject.
 */
async function settingInside(transactions: TenancyTransactions, option = "platos.request_id"): Promise<string> {
  return await transactions.unitOfWork.run(async () => {
    const rows = await transactions
      .reader()
      .$queryRawUnsafe<{ value: string }[]>(`SELECT current_setting('${option}', true) AS value`);
    return rows[0]?.value ?? "";
  });
}

beforeAll(async () => {
  harness = await startOutboxHarness();
  // TWO transaction runners over ONE client, on purpose. The correlated one is
  // the subject; the other is the control, and sharing the pool is what makes
  // the leak case meaningful — a setting that outlived its transaction would be
  // visible to whichever runner borrowed the connection next.
  correlated = createTenancyTransactions(harness.client, {}, correlation);
  uncorrelated = createTenancyTransactions(harness.client, {});
  events = createOutboxEventStore(correlated);
}, 180_000);

afterAll(async () => {
  await harness.stop();
});

test("POSTGRESQL reports the identifier the edge decided on, inside the transaction", async () => {
  const seen = await correlation.within("req-alpha-01", () => settingInside(correlated));
  expect(seen).toBe("req-alpha-01");
});

test("the option PostgreSQL answers for is the one the exported constant names", async () => {
  // The adapter writes the option name as a literal because `sole-writer.mjs`
  // refuses a raw statement it cannot read as one, so the constant and the SQL
  // are two spellings of a single fact. This is the join that stops them
  // drifting: the value is read back through a statement built from the
  // CONSTANT, so a rename of either alone fails here.
  const seen = await correlation.within("req-alpha-02", () =>
    settingInside(correlated, REQUEST_ID_SETTING),
  );
  expect(seen).toBe("req-alpha-02");
});

test("work outside any request stamps NOTHING rather than inventing an identifier", async () => {
  // `current_setting(..., true)` answers the empty string for an option never
  // set in this transaction. A fabricated correlation would be
  // indistinguishable from a real one in every log it reached.
  expect(await settingInside(correlated)).toBe("");
});

test("a runner with NO correlation source stamps nothing either", async () => {
  // The negative control for every case above. If the stamp were unconditional,
  // they would all pass on a runner that had never been given a source.
  const seen = await correlation.within("req-alpha-03", () => settingInside(uncorrelated));
  expect(seen).toBe("");
});

test("the identifier is TRANSACTION-local, so it cannot leak onto the next request", async () => {
  // The reason this is `set_config(..., true)` and not `application_name`. A
  // pooled connection is reused, and a per-SESSION value would still be attached
  // while an unrelated request used it — one request's work labelled with
  // another request's identifier, which is worse than no label at all.
  await correlation.within("req-leaky", () => settingInside(correlated));
  expect(await settingInside(correlated)).toBe("");
  expect(await settingInside(uncorrelated)).toBe("");
});

test("a row written under a correlation is DURABLE, and the setting is not", async () => {
  // Two facts in one case because they are one guarantee: the stamp and the
  // write are the same transaction. The row survives the commit and is visible
  // to a connection this pool never touched; the setting does not survive it,
  // because it belongs to the transaction rather than to the row.
  const eventId = harness.freshId("00c0");
  await correlation.within("req-durable", () =>
    correlated.unitOfWork.run(async (transaction) => {
      const rows = await correlated
        .reader()
        .$queryRawUnsafe<{ value: string }[]>(
          "SELECT current_setting('platos.request_id', true) AS value",
        );
      expect(rows[0]?.value).toBe("req-durable");
      await events.insertOutboxEvent(
        {
          eventId,
          environmentId: harness.first.environmentId,
          eventType: "tenancy.correlation.probe",
          subjectId: null,
          envelope: { requestId: "req-durable" },
          createdAt: new Date("2026-05-02T10:00:00.000Z"),
        },
        transaction,
      );
    }),
  );

  const written = (await harness.durableRows()).find((row) => row.eventId === eventId);
  expect(written, "the row a second connection can see").toBeDefined();
  expect((written?.payload as Record<string, unknown>).requestId).toBe("req-durable");
  expect(await settingInside(correlated)).toBe("");
});

test("a ROLLED-BACK transaction leaves neither the row nor the setting", async () => {
  // The stamp runs as the FIRST statement of the unit of work, before any
  // business write, so a failing transaction still ran under its request's
  // correlation — those are the transactions anybody goes looking for. What must
  // not survive is the row.
  const eventId = harness.freshId("00c1");
  await expect(
    correlation.within("req-rolled-back", () =>
      correlated.unitOfWork.run(async (transaction) => {
        await events.insertOutboxEvent(
          {
            eventId,
            environmentId: harness.first.environmentId,
            eventType: "tenancy.correlation.probe",
            subjectId: null,
            envelope: { requestId: "req-rolled-back" },
            createdAt: new Date("2026-05-02T10:05:00.000Z"),
          },
          transaction,
        );
        throw new Error("deliberate rollback");
      }),
    ),
  ).rejects.toThrow("deliberate rollback");

  expect((await harness.durableRows()).some((row) => row.eventId === eventId)).toBe(false);
  expect(await settingInside(correlated)).toBe("");
});

test("concurrent requests do not borrow each other's identifier", async () => {
  // The property that makes correlation worth having at all. Two units of work
  // interleaved over one pool, each asking PostgreSQL what its own request is.
  const seen = await Promise.all([
    correlation.within("req-concurrent-a", () => settingInside(correlated)),
    correlation.within("req-concurrent-b", () => settingInside(correlated)),
  ]);
  expect(seen).toEqual(["req-concurrent-a", "req-concurrent-b"]);
});

test("a NESTED unit of work joins the outer one and keeps its identifier", async () => {
  // Nesting JOINS rather than opening a second transaction — the kernel port's
  // stated contract — so the inner run issues no stamp of its own. This pins
  // that it inherits the outer one rather than clearing it.
  const seen = await correlation.within("req-nested", () =>
    correlated.unitOfWork.run(async () =>
      correlated.unitOfWork.run(async () => {
        const rows = await correlated
          .reader()
          .$queryRawUnsafe<{ value: string }[]>(
            "SELECT current_setting('platos.request_id', true) AS value",
          );
        return rows[0]?.value ?? "";
      }),
    ),
  );
  expect(seen).toBe("req-nested");
});
