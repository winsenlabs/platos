// The acceptance sentence, proved: an outbox row must NOT survive a rolled-back
// transaction.
//
// IT IS NOT HYPOTHETICAL. `conversations` shipped exactly this defect this week.
// Its `TestOutbox` was not in the unit of work's snapshot set, so an event
// appended inside a rolled-back transaction SURVIVED, and a turn emitted
// `conversations.turn.settled` for a settlement that never landed. Every test was
// green, because the only thing that can tell the difference is a real database
// asked by a connection that was not the writer.
//
// EVERY ROLLBACK CASE BELOW INJECTS A REAL FAILURE and then looks for the row
// through `harness.durableRows()`, which reads on a SECOND client. Reading back
// through the writer's own client would prove nothing at all inside a
// transaction — a session sees its own uncommitted rows — and would have passed
// against the defect this suite exists to close.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { TransactionId, TransactionScope } from "@platos/context-tenancy/application/ports/index.js";
import { asIdentifier } from "@platos/context-tenancy/application/ports/index.js";

import type { OutboxInsertRow } from "./outbox-store.js";
import { ENVIRONMENT_UNKNOWN, EVENT_ID_TAKEN } from "./outbox-store.js";
import type { OutboxHarness } from "./outbox-harness.js";
import { startOutboxHarness } from "./outbox-harness.js";
import {
  TRANSACTION_NOT_OPEN,
  TRANSACTION_SCOPE_FOREIGN,
  TRANSACTION_SCOPE_UNKNOWN,
} from "./transaction.js";

let harness: OutboxHarness;
let sequence = 0;

beforeAll(async () => {
  harness = await startOutboxHarness();
}, 180_000);

afterAll(async () => {
  await harness?.stop();
});

const AT = new Date("2026-05-01T09:00:00.000Z");

/** A fresh, ordered, valid UUIDv7 for each row a case writes. */
function eventId(): string {
  sequence += 1;
  return `01926f9c-${sequence.toString(16).padStart(4, "0")}-7000-8000-00000000${sequence
    .toString(16)
    .padStart(4, "0")}`;
}

function row(overrides: Partial<OutboxInsertRow> = {}): OutboxInsertRow {
  return {
    eventId: eventId(),
    environmentId: harness.first.environmentId,
    eventType: "tenancy.invitation.issued",
    subjectId: null,
    envelope: { outboxEnvelope: 1, schemaVersion: 1, requestId: null, scope: {}, payload: {} },
    createdAt: AT,
    ...overrides,
  };
}

async function durableIds(): Promise<readonly string[]> {
  return (await harness.durableRows()).map((event) => event.eventId);
}

function refusalOf(error: unknown): string {
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : `<uncoded:${String(error)}>`;
}

/** The code a call refused with, or `<accepted>` when it did not refuse. */
async function refusalFrom(work: Promise<unknown>): Promise<string> {
  return work.then(() => "<accepted>", refusalOf);
}

describe("the transaction boundary, proved by failure injection", () => {
  test("when a LATER write of the transaction fails, the appended event is gone", async () => {
    const event = row();
    const clash = row();

    await expect(
      harness.adapter.unitOfWork.run(async (transaction) => {
        await harness.adapter.insertOutboxEvent(event, transaction);
        // The injected failure. The environment does not exist, so the foreign
        // key refuses the row AFTER the event has been written.
        await harness.adapter.insertOutboxEvent(
          { ...clash, environmentId: "00000000-0000-4000-8000-000000000000" },
          transaction,
        );
      }),
    ).rejects.toMatchObject({ code: ENVIRONMENT_UNKNOWN });

    expect(await durableIds()).not.toContain(event.eventId);
    expect(await durableIds()).not.toContain(clash.eventId);
  });

  test("when the BUSINESS write fails after the event, neither survives", async () => {
    // The shape the defect actually took: an event appended beside a state
    // change, and the state change refused. Here the state change is an
    // organization whose slug is already taken.
    const event = row();
    await harness.adapter.unitOfWork.run(async (transaction) => {
      await harness.adapter.saveOrganization(
        {
          id: asIdentifier("cccccccc-0001-4000-8000-000000000001"),
          slug: asIdentifier("outbox-occupied"),
          name: "Occupied",
          archivedAt: null,
          createdAt: AT,
          updatedAt: AT,
        },
        transaction,
      );
    });

    await expect(
      harness.adapter.unitOfWork.run(async (transaction) => {
        await harness.adapter.insertOutboxEvent(event, transaction);
        await harness.adapter.saveOrganization(
          {
            id: asIdentifier("cccccccc-0002-4000-8000-000000000002"),
            slug: asIdentifier("outbox-occupied"),
            name: "Clash",
            archivedAt: null,
            createdAt: AT,
            updatedAt: AT,
          },
          transaction,
        );
      }),
    ).rejects.toBeDefined();

    expect(await durableIds()).not.toContain(event.eventId);
  });

  test("a THROWN refusal rolls back; a RETURNED error value COMMITS", async () => {
    const discarded = row();
    const kept = row();

    await expect(
      harness.adapter.unitOfWork.run(async (transaction) => {
        await harness.adapter.insertOutboxEvent(discarded, transaction);
        throw new Error("the use case refused after appending");
      }),
    ).rejects.toThrow("the use case refused after appending");
    expect(await durableIds()).not.toContain(discarded.eventId);

    const returned = await harness.adapter.unitOfWork.run(async (transaction) => {
      await harness.adapter.insertOutboxEvent(kept, transaction);
      return { ok: false as const, error: "refused" };
    });
    expect(returned.ok).toBe(false);
    // The `cost-monitoring` trap, recorded as evidence rather than as prose. A
    // resolved promise COMMITS, so a use case that must not emit its event has
    // to THROW. An outbox is where this costs the most: the event is the
    // certificate that the state change happened.
    expect(await durableIds()).toContain(kept.eventId);
  });

  test("nesting JOINS the outer transaction, so an inner append dies with the outer", async () => {
    const event = row();
    await expect(
      harness.adapter.unitOfWork.run(async (outer) => {
        await harness.adapter.unitOfWork.run(async (inner) => {
          expect(inner.transactionId).toBe(outer.transactionId);
          await harness.adapter.insertOutboxEvent(event, inner);
        });
        throw new Error("outer refused");
      }),
    ).rejects.toThrow("outer refused");
    expect(await durableIds()).not.toContain(event.eventId);
  });

  test("a COMMITTED append is durable on a connection the writer never used", async () => {
    const event = row({ eventType: "privacy.erasure.finished" });
    await harness.adapter.unitOfWork.run((transaction) =>
      harness.adapter.insertOutboxEvent(event, transaction),
    );
    const durable = await harness.durableRows();
    const stored = durable.find((candidate) => candidate.eventId === event.eventId);
    expect(stored?.eventType).toBe("privacy.erasure.finished");
    expect(stored?.createdAt.toISOString()).toBe(AT.toISOString());
  });

  test("an append is INVISIBLE to another connection until the transaction commits", async () => {
    const event = row();
    let seenMidFlight: readonly string[] = [];
    await harness.adapter.unitOfWork.run(async (transaction) => {
      await harness.adapter.insertOutboxEvent(event, transaction);
      seenMidFlight = await durableIds();
    });
    expect(seenMidFlight).not.toContain(event.eventId);
    expect(await durableIds()).toContain(event.eventId);
  });
});

describe("the three transaction-scope refusals, and the two store refusals", () => {
  test("an append with NO open transaction is refused with not_open", async () => {
    const event = row();
    const refusal = await refusalFrom(
      harness.adapter.insertOutboxEvent(event, {
        transactionId: asIdentifier<TransactionId>("pg-txn-1"),
      }),
    );
    expect(refusal).toBe(TRANSACTION_NOT_OPEN);
    expect(await durableIds()).not.toContain(event.eventId);
  });

  test("an append carrying a FINISHED transaction's token is refused with scope_unknown", async () => {
    let escaped: TransactionScope | undefined;
    await harness.adapter.unitOfWork.run(async (transaction) => {
      escaped = transaction;
    });
    const event = row();
    await harness.adapter.unitOfWork.run(async () => {
      const refusal = await refusalFrom(
        harness.adapter.insertOutboxEvent(event, escaped as TransactionScope),
      );
      expect(refusal).toBe(TRANSACTION_SCOPE_UNKNOWN);
    });
    expect(await durableIds()).not.toContain(event.eventId);
  });

  test("an append carrying ANOTHER LIVE transaction's token is refused with scope_foreign", async () => {
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

    const event = row();
    let refusal = "<none>";
    await harness.adapter.unitOfWork.run(async (live) => {
      expect(other.transactionId).not.toBe(live.transactionId);
      refusal = await refusalFrom(harness.adapter.insertOutboxEvent(event, other));
    });
    release();

    expect(refusal).toBe(TRANSACTION_SCOPE_FOREIGN);
    expect(await durableIds()).not.toContain(event.eventId);
  });

  test("a repeated event identifier is refused with its own code", async () => {
    const event = row();
    await harness.adapter.unitOfWork.run((transaction) =>
      harness.adapter.insertOutboxEvent(event, transaction),
    );
    const refusal = await refusalFrom(
      harness.adapter.unitOfWork.run((transaction) =>
        harness.adapter.insertOutboxEvent(event, transaction),
      ),
    );
    expect(refusal).toBe(EVENT_ID_TAKEN);
  });

  test("the five codes are pairwise distinct", () => {
    const codes = [
      TRANSACTION_NOT_OPEN,
      TRANSACTION_SCOPE_UNKNOWN,
      TRANSACTION_SCOPE_FOREIGN,
      EVENT_ID_TAKEN,
      ENVIRONMENT_UNKNOWN,
    ];
    expect(new Set(codes).size).toBe(5);
  });
});
