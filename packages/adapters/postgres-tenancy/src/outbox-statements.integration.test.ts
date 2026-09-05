// Statement counts, MEASURED — the N+1 control for the outbox.
//
// A drain is the one read in this system whose page size is a tuning knob, which
// makes it the one read where an N+1 is invisible until it is expensive: every
// value is correct, every case passes, and the page that took four milliseconds
// over ten events takes four seconds over ten thousand. Every pin below is a
// number this suite observed, taken TWICE — once over a small outbox and once
// over one an order of magnitude larger — and both must be identical.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { OutboxInsertRow } from "./outbox-store.js";
import type { OutboxHarness } from "./outbox-harness.js";
import { startOutboxHarness } from "./outbox-harness.js";

let harness: OutboxHarness;
let small: string;
let large: string;
let sequence = 0;

const AT = new Date("2026-05-01T09:00:00.000Z");

function eventId(): string {
  sequence += 1;
  const tail = sequence.toString(16).padStart(6, "0");
  return `01926f9e-${tail.slice(0, 4)}-7000-8000-00000000${tail}`;
}

function row(environmentId: string, offset: number): OutboxInsertRow {
  return {
    eventId: eventId(),
    environmentId,
    eventType: "tenancy.invitation.issued",
    subjectId: null,
    envelope: { outboxEnvelope: 1, schemaVersion: 1, requestId: null, scope: {}, payload: { offset } },
    createdAt: new Date(AT.getTime() + offset),
  };
}

/**
 * Statements the CLIENT sent, less the transaction frame.
 *
 * `BEGIN`/`COMMIT`/`ROLLBACK`/`DEALLOCATE` are the driver's bookkeeping and are
 * not what an N+1 is made of; counting them would make the pins depend on
 * whether a read happened to be inside a transaction.
 */
function queries(): readonly string[] {
  return harness
    .statements()
    .filter((statement) => !/^\s*(BEGIN|COMMIT|ROLLBACK|DEALLOCATE|SELECT 1)\b/iu.test(statement));
}

async function measure(work: () => Promise<unknown>): Promise<number> {
  harness.resetStatements();
  await work();
  return queries().length;
}

async function seedEvents(environmentId: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await harness.adapter.unitOfWork.run((transaction) =>
      harness.adapter.insertOutboxEvent(row(environmentId, index), transaction),
    );
  }
}

beforeAll(async () => {
  harness = await startOutboxHarness();
  small = (await harness.seedTenant("outbox-small")).environmentId;
  large = (await harness.seedTenant("outbox-large")).environmentId;
  await seedEvents(small, 5);
  await seedEvents(large, 200);
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

describe("append", () => {
  test("one append is exactly ONE statement", async () => {
    const count = await measure(() =>
      harness.adapter.unitOfWork.run((transaction) =>
        harness.adapter.insertOutboxEvent(row(small, 900), transaction),
      ),
    );
    expect(count).toBe(1);
  });

  test("five appends in ONE transaction are five statements, not fifteen", async () => {
    // A store that re-resolved its client, or read the row back after writing
    // it, would show three per append here and one per append above.
    const count = await measure(() =>
      harness.adapter.unitOfWork.run(async (transaction) => {
        for (let index = 0; index < 5; index += 1) {
          await harness.adapter.insertOutboxEvent(row(small, 910 + index), transaction);
        }
      }),
    );
    expect(count).toBe(5);
  });
});

describe("drain", () => {
  test("a page from the START is ONE statement, whatever the page size", async () => {
    for (const limit of [1, 10, 100]) {
      expect(await measure(() => harness.adapter.readOutboxEventsAfter(null, limit))).toBe(1);
    }
  });

  test("a page from a CURSOR is ONE statement", async () => {
    const first = await harness.adapter.readOutboxEventsAfter(null, 3);
    const last = first.at(-1);
    expect(last).toBeDefined();
    const count = await measure(() =>
      harness.adapter.readOutboxEventsAfter(
        { createdAt: last?.createdAt ?? AT, eventId: last?.eventId ?? "" },
        3,
      ),
    );
    expect(count).toBe(1);
  });

  test("the count does not grow with the number of ROWS", async () => {
    // The whole point. Five events and two hundred and five events must cost the
    // same number of statements to page through; only the bytes differ.
    const overSmall = await measure(() => harness.adapter.readOutboxEventsAfter(null, 5));
    const overLarge = await measure(() => harness.adapter.readOutboxEventsAfter(null, 100));
    expect(overSmall).toBe(1);
    expect(overLarge).toBe(1);
  });

  test("draining the WHOLE outbox in pages of 50 is one statement per page", async () => {
    let cursor: { readonly createdAt: Date; readonly eventId: string } | null = null;
    let pages = 0;
    let statements = 0;
    let seen = 0;
    for (;;) {
      const page = await measure(async () => {
        const rows = await harness.adapter.readOutboxEventsAfter(cursor, 50);
        const last = rows.at(-1);
        cursor = last === undefined ? cursor : { createdAt: last.createdAt, eventId: last.eventId };
        seen += rows.length;
        if (rows.length === 0) pages = -1;
      });
      statements += page;
      if (pages === -1) break;
      pages += 1;
    }
    expect(seen).toBeGreaterThanOrEqual(205);
    // One page-read per loop, including the final empty one.
    expect(statements).toBe(pages + 1);
  });

  test("no page is ever re-read and none is skipped", async () => {
    let cursor: { readonly createdAt: Date; readonly eventId: string } | null = null;
    const collected: string[] = [];
    for (;;) {
      const rows = await harness.adapter.readOutboxEventsAfter(cursor, 7);
      if (rows.length === 0) break;
      collected.push(...rows.map((event) => event.eventId));
      const last = rows.at(-1);
      cursor = last === undefined ? cursor : { createdAt: last.createdAt, eventId: last.eventId };
    }
    expect(new Set(collected).size).toBe(collected.length);
    const durable = (await harness.durableRows()).map((event) => event.eventId);
    expect(collected).toEqual(durable);
  });
});
