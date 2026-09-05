// The adapter over the in-memory store: what `append` writes, and what `drain`
// gives back.
//
// This suite is about the DECISIONS — the identifier, the instant, the row the
// store is handed, the order a drain reads in. It runs against the double
// because those decisions are made above the store and are the same code
// whichever store is underneath; the questions a double could answer WRONGLY
// are in `conformance.test.ts`, which asks them of both stores and compares.

import { describe, expect, test } from "vitest";

import type {
  Clock,
  DomainEventDraft,
  EnvironmentId,
  JsonValue,
  OrganizationId,
  ProjectId,
  RequestId,
} from "@platos/kernel";
import { asIdentifier, environmentScope, organizationScope } from "@platos/kernel";

import { buildOutboxAdapter, DRAIN_LIMIT_INVALID } from "./adapter.js";
import { ENVELOPE_MARKER, SCOPE_NOT_ENVIRONMENT } from "./envelope.js";
import { createInMemoryOutbox } from "./in-memory.js";
import type { OutboxCursor } from "./store.js";

const ORGANIZATION = asIdentifier<OrganizationId>("11111111-1111-4111-8111-111111111111");
const PROJECT = asIdentifier<ProjectId>("22222222-2222-4222-8222-222222222222");
const ENVIRONMENT = asIdentifier<EnvironmentId>("33333333-3333-4333-8333-333333333333");
const scope = environmentScope(ORGANIZATION, PROJECT, ENVIRONMENT);
const AT = new Date("2026-05-01T09:00:00.000Z");

/** A clock that stands still unless a case moves it. */
function fixedClock(): Clock & { set(at: Date): void } {
  let at = AT;
  return { now: () => at, set: (next: Date) => { at = next; } };
}

const fixedTail = (length: number): Uint8Array => new Uint8Array(length).fill(0xab);

function draft(name: string, payload: JsonValue): DomainEventDraft<JsonValue> {
  return { name, schemaVersion: 1, scope, requestId: null, payload };
}

function harness() {
  const memory = createInMemoryOutbox();
  const clock = fixedClock();
  const adapter = buildOutboxAdapter({ store: memory.store, clock, randomBytes: fixedTail });
  return { memory, clock, adapter };
}

describe("append", () => {
  test("writes ONE row carrying the event name, the environment and the envelope", async () => {
    const { memory, adapter } = harness();
    const eventId = await memory.unitOfWork.run((transaction) =>
      adapter.append(draft("tenancy.invitation.issued", { invitationId: "inv-1" }), transaction),
    );
    const rows = memory.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventId).toBe(eventId);
    expect(rows[0]?.eventType).toBe("tenancy.invitation.issued");
    expect(rows[0]?.environmentId).toBe(ENVIRONMENT);
    expect(rows[0]?.createdAt.toISOString()).toBe(AT.toISOString());
    expect((rows[0]?.payload as Record<string, unknown>)[ENVELOPE_MARKER]).toBe(1);
  });

  test("subjectId is written NULL, because the kernel envelope has no subject", async () => {
    const { memory, adapter } = harness();
    await memory.unitOfWork.run((transaction) =>
      adapter.append(draft("tenancy.invitation.issued", {}), transaction),
    );
    expect(memory.rows()[0]?.subjectId).toBeNull();
  });

  test("a refused draft writes nothing AND consumes no ordering slot", async () => {
    // The counter is the ordering: an identifier minted for a draft that was
    // then refused would leave a gap that reads, to anyone walking ordered
    // identifiers, exactly like a lost event.
    const { memory, adapter } = harness();
    const refused = await memory.unitOfWork
      .run((transaction) =>
        adapter.append(
          { name: "privacy.erasure.requested", schemaVersion: 1, scope: organizationScope(ORGANIZATION), requestId: null, payload: {} },
          transaction,
        ),
      )
      .catch((error: unknown) => (error as { readonly code?: string }).code);
    expect(refused).toBe(SCOPE_NOT_ENVIRONMENT);
    expect(memory.rows()).toHaveLength(0);

    const first = await memory.unitOfWork.run((transaction) =>
      adapter.append(draft("tenancy.invitation.issued", {}), transaction),
    );
    // Counter 0 for the first identifier this minter ever produced: the refused
    // draft did not move it.
    expect(first.slice(14, 18)).toBe("7000");
  });

  test("the row is stamped with the MINTED instant, not with the raw clock", async () => {
    // A clock that steps backwards is clamped by the minter, and the row has to
    // carry the clamped value: the drain orders by `createdAt` FIRST, so a row
    // stamped from the raw reading would sort before the event that preceded it
    // however ordered its identifier was. Every other case in this file uses a
    // clock that stands still, where the two values coincide — the mutation
    // sweep found `createdAt: clock.now()` surviving until this case existed.
    const { memory, clock, adapter } = harness();
    await memory.unitOfWork.run((transaction) =>
      adapter.append(draft("tenancy.invitation.issued", { n: 1 }), transaction),
    );
    clock.set(new Date(AT.getTime() - 5));
    await memory.unitOfWork.run((transaction) =>
      adapter.append(draft("tenancy.invitation.accepted", { n: 2 }), transaction),
    );
    const rows = memory.rows();
    expect(rows.map((row) => row.createdAt.getTime())).toEqual([AT.getTime(), AT.getTime()]);
    const page = await adapter.drain(null, 10);
    expect(page.events.map((event) => event.payload)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  test("an append outside a transaction is refused by the store, and nothing is written", async () => {
    const { memory, adapter } = harness();
    const stale = await memory.unitOfWork.run((transaction) => Promise.resolve(transaction));
    const refused = await adapter
      .append(draft("tenancy.invitation.issued", {}), stale)
      .catch((error: unknown) => (error as { readonly code?: string }).code);
    expect(refused).toBe("tenancy.transaction.not_open");
    expect(memory.rows()).toHaveLength(0);
  });
});

describe("drain", () => {
  async function seed(): Promise<ReturnType<typeof harness>> {
    const context = harness();
    await context.memory.unitOfWork.run(async (transaction) => {
      await context.adapter.append(draft("tenancy.invitation.issued", { n: 1 }), transaction);
      await context.adapter.append(draft("tenancy.invitation.accepted", { n: 2 }), transaction);
    });
    context.clock.set(new Date(AT.getTime() + 1));
    await context.memory.unitOfWork.run((transaction) =>
      context.adapter.append(draft("tenancy.project.archived", { n: 3 }), transaction),
    );
    return context;
  }

  test("events come back oldest first, INCLUDING two written in one millisecond", async () => {
    const { adapter } = await seed();
    const page = await adapter.drain(null, 10);
    expect(page.events.map((event) => event.payload)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(page.events.map((event) => event.occurredAt.getTime())).toEqual([
      AT.getTime(),
      AT.getTime(),
      AT.getTime() + 1,
    ]);
  });

  test("a cursor resumes strictly after the last event of the previous page", async () => {
    const { adapter } = await seed();
    const first = await adapter.drain(null, 2);
    expect(first.events.map((event) => event.payload)).toEqual([{ n: 1 }, { n: 2 }]);
    const second = await adapter.drain(first.cursor, 2);
    expect(second.events.map((event) => event.payload)).toEqual([{ n: 3 }]);
    const third = await adapter.drain(second.cursor, 2);
    expect(third.events).toEqual([]);
    expect(third.cursor).toBeNull();
  });

  test("the SECOND event of a shared millisecond is neither repeated nor skipped", async () => {
    // The pair cursor is the whole reason this passes: `Event.createdAt` is
    // TIMESTAMP(3) and both events carry the same value, so a cursor made of the
    // instant alone would either hand back the first event again or step over
    // the second.
    const { adapter } = await seed();
    const first = await adapter.drain(null, 1);
    expect(first.events.map((event) => event.payload)).toEqual([{ n: 1 }]);
    const second = await adapter.drain(first.cursor, 1);
    expect(second.events.map((event) => event.payload)).toEqual([{ n: 2 }]);
  });

  test("the drained event carries the whole envelope back", async () => {
    const { memory, adapter } = harness();
    await memory.unitOfWork.run((transaction) =>
      adapter.append(
        {
          name: "tenancy.invitation.issued",
          schemaVersion: 4,
          scope,
          requestId: asIdentifier<RequestId>("req-9"),
          payload: { invitationId: "inv-1" },
        },
        transaction,
      ),
    );
    const [event] = (await adapter.drain(null, 10)).events;
    expect(event?.schemaVersion).toBe(4);
    expect(event?.requestId).toBe("req-9");
    expect(event?.scope).toEqual(scope);
    expect(event?.environmentId).toBe(ENVIRONMENT);
  });

  test("a page size that is not a positive whole number is refused", async () => {
    const { adapter } = harness();
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      const refused = await adapter
        .drain(null, limit)
        .catch((error: unknown) => (error as { readonly code?: string }).code);
      expect(refused).toBe(DRAIN_LIMIT_INVALID);
    }
  });

  test("a cursor beyond every row yields an empty page rather than the first one", async () => {
    const { adapter } = await seed();
    const beyond: OutboxCursor = {
      createdAt: new Date(AT.getTime() + 60_000),
      eventId: "ffffffff-ffff-7fff-8fff-ffffffffffff",
    };
    expect((await adapter.drain(beyond, 10)).events).toEqual([]);
  });
});
