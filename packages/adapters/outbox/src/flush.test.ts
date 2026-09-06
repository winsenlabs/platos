// The outbox shutdown flush.
//
// THE LAST BLOCK IS THE ONE THAT MATTERS MOST. Everything above it drives a
// hand-written source, which proves the loop and proves nothing about whether
// the seam `flush.ts` declares actually fits the adapter it is meant to drain.
// So the last block builds the REAL `buildOutboxAdapter` over the REAL
// `createInMemoryOutbox`, appends events through the real `OutboxWriter` port,
// and flushes them. Neither the adapter nor the in-memory store was written for
// the flush: if the adapter's `drain` signature, its cursor shape, its ordering
// or its empty-page behaviour moves, that block goes red here — which is exactly
// the join a compile-time `Satisfies` cannot give, since a `Satisfies` compares
// two declarations and this compares a loop against a running adapter.

import { describe, expect, it } from "vitest";

import {
  asIdentifier,
  environmentScope,
  type DomainEventDraft,
  type EnvironmentId,
  type EventId,
  type JsonValue,
  type OrganizationId,
  type ProjectId,
} from "@platos/kernel";

import { buildOutboxAdapter } from "./adapter.js";
import type { OutboxDrainPage } from "./adapter.js";
import type { DrainedEvent } from "./envelope.js";
import { createInMemoryOutbox } from "./in-memory.js";
import type { OutboxCursor } from "./store.js";
import {
  createOutboxFlush,
  DEFAULT_MAX_PAGES,
  OutboxFlushError,
  FLUSH_BUDGET_SPENT,
  FLUSH_PAGE_INVALID,
  FLUSH_SOURCE_FAULTED,
  OUTBOX_FLUSH_SOURCE_SATISFACTION,
  type OutboxFlushSource,
} from "./flush.js";

function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let value = 5_000_000;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

function cursorAt(index: number): OutboxCursor {
  return { createdAt: new Date(1_700_000_000_000 + index), eventId: `event-${String(index)}` };
}

/** One drained event, filled in only where a case reads it. */
function drainedEvent(index: number): DrainedEvent {
  return {
    eventId: asIdentifier<EventId>(`0192-${String(index).padStart(4, "0")}`),
    name: "tenancy.invitation.issued",
    occurredAt: new Date(1_700_000_000_000 + index),
    environmentId: asIdentifier<EnvironmentId>("00000000-0000-4000-8000-000000000000"),
    schemaVersion: 1,
    requestId: null,
    scope: null,
    payload: { index },
  };
}

/** A source that answers a scripted list of pages, then empties. */
function scripted(pages: readonly number[]): OutboxFlushSource & { readonly calls: number[] } {
  const calls: number[] = [];
  let page = 0;
  return {
    calls,
    drain: (_cursor, limit) => {
      calls.push(limit);
      const size = pages[page] ?? 0;
      page += 1;
      const read: OutboxDrainPage = {
        events: Array.from({ length: size }, (_unused, index) => drainedEvent(index)),
        cursor: size === 0 ? null : cursorAt(page),
      };
      return Promise.resolve(read);
    },
  };
}

describe("the flush drains to quiescence", () => {
  it("keeps reading until a page comes back empty", async () => {
    const clock = fakeClock();
    const source = scripted([3, 3, 2]);
    const handed: number[] = [];
    const drainable = createOutboxFlush({
      source,
      handler: (page) => {
        handed.push(page.events.length);
        return Promise.resolve();
      },
      pageSize: 3,
    });

    const outcome = await drainable.drain(1000, clock.now);

    expect(handed).toEqual([3, 3, 2]);
    expect(outcome).toEqual({ drained: true, handled: 8, remaining: 0, stoppedBecause: null });
  });

  it("treats an EMPTY page as quiescence and a short one as merely a page", async () => {
    // A page shorter than the limit is not the end. The adapter pages by cursor,
    // so a short page means "everything up to here", and stopping on it would
    // leave the tail of the outbox behind on every uneven flush.
    const clock = fakeClock();
    const source = scripted([1, 1]);
    const drainable = createOutboxFlush({ source, handler: () => Promise.resolve(), pageSize: 50 });
    const outcome = await drainable.drain(1000, clock.now);
    expect(outcome.handled).toBe(2);
    expect(source.calls).toEqual([50, 50, 50]);
  });

  it("drains an already-empty outbox in one read", async () => {
    const clock = fakeClock();
    const source = scripted([]);
    const drainable = createOutboxFlush({ source, handler: () => Promise.resolve(), pageSize: 10 });
    expect(await drainable.drain(1000, clock.now)).toMatchObject({ drained: true, handled: 0 });
    expect(source.calls).toHaveLength(1);
  });

  it("answers to the name the shutdown report prints", () => {
    const drainable = createOutboxFlush({
      source: scripted([]),
      handler: () => Promise.resolve(),
      pageSize: 1,
    });
    expect(drainable.name).toBe("outbox");
  });
});

describe("the flush is bounded", () => {
  it("stops at the budget and reports what it did hand on", async () => {
    const clock = fakeClock();
    const source = scripted([2, 2, 2, 2, 2]);
    const outcome = await createOutboxFlush({
      source,
      handler: () => {
        clock.advance(40);
        return Promise.resolve();
      },
      pageSize: 2,
    }).drain(100, clock.now);

    expect(outcome.drained).toBe(false);
    expect(outcome.stoppedBecause).toBe(FLUSH_BUDGET_SPENT);
    expect(outcome.handled).toBe(6);
  });

  it("checks the budget BEFORE reading a page, so no event is read and dropped", async () => {
    // THE ONE WAY A FLUSH CAN LOSE AN EVENT. If the budget were checked after
    // the read, the last page would be pulled out of the table, never handed to
    // the handler, and lost with the cursor when this call returned. The read
    // count is what proves the order.
    const clock = fakeClock();
    const source = scripted([1, 1, 1, 1, 1]);
    const outcome = await createOutboxFlush({
      source,
      handler: () => {
        clock.advance(60);
        return Promise.resolve();
      },
      pageSize: 1,
    }).drain(100, clock.now);

    // Two reads, two pages handed on, then the budget check refuses a third read.
    expect(source.calls).toHaveLength(2);
    expect(outcome.handled).toBe(2);
  });

  it("stops at the page cap rather than following a table that is still growing", async () => {
    const clock = fakeClock();
    const source = scripted(Array.from({ length: 100 }, () => 1));
    const outcome = await createOutboxFlush({
      source,
      handler: () => Promise.resolve(),
      pageSize: 1,
      maxPages: 4,
    }).drain(10_000, clock.now);

    expect(source.calls).toHaveLength(4);
    expect(outcome).toMatchObject({ drained: false, handled: 4, stoppedBecause: FLUSH_BUDGET_SPENT });
  });

  it("caps at twenty pages when nobody says otherwise", async () => {
    const clock = fakeClock();
    const source = scripted(Array.from({ length: 100 }, () => 1));
    await createOutboxFlush({ source, handler: () => Promise.resolve(), pageSize: 1 }).drain(
      10_000,
      clock.now,
    );
    expect(source.calls).toHaveLength(DEFAULT_MAX_PAGES);
  });
});

describe("the flush refuses and reports rather than guessing", () => {
  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["not a number", Number.NaN],
  ])("refuses a %s page size at construction, not during shutdown", (_label, pageSize) => {
    // AT CONSTRUCTION, because the alternative is a rejection raised during
    // shutdown — the one moment there is no budget to spend on a programming
    // error, and the moment it is most likely to be read as "the outbox could
    // not be drained" rather than "this process was mis-wired".
    expect(() =>
      createOutboxFlush({ source: scripted([]), handler: () => Promise.resolve(), pageSize }),
    ).toThrow(OutboxFlushError);
  });

  it("names the page-size code", () => {
    try {
      createOutboxFlush({ source: scripted([]), handler: () => Promise.resolve(), pageSize: 0 });
      expect.unreachable("a zero page size must be refused");
    } catch (cause) {
      expect((cause as OutboxFlushError).code).toBe(FLUSH_PAGE_INVALID);
    }
  });

  it("refuses a page cap that is not a positive whole number", () => {
    expect(() =>
      createOutboxFlush({
        source: scripted([]),
        handler: () => Promise.resolve(),
        pageSize: 5,
        maxPages: 0,
      }),
    ).toThrow(OutboxFlushError);
  });

  it("reports a faulting source with its reason instead of rejecting", async () => {
    // A REJECTION HERE WOULD BE CAUGHT BY `drainAll` AND REPORTED ANYWAY, but as
    // a generic drain fault. Reporting it here keeps the code specific to the
    // outbox, which is what an operator greps for.
    const clock = fakeClock();
    const outcome = await createOutboxFlush({
      source: { drain: () => Promise.reject(new Error("the store is gone")) },
      handler: () => Promise.resolve(),
      pageSize: 5,
    }).drain(1000, clock.now);

    expect(outcome.drained).toBe(false);
    expect(outcome.stoppedBecause).toBe(`${FLUSH_SOURCE_FAULTED}: the store is gone`);
  });

  it("keeps the count of what it had already handed on when the source faults", async () => {
    const clock = fakeClock();
    let call = 0;
    const outcome = await createOutboxFlush({
      source: {
        drain: () => {
          call += 1;
          if (call === 1) {
            return Promise.resolve({ events: [drainedEvent(1), drainedEvent(2)], cursor: cursorAt(1) });
          }
          return Promise.reject(new Error("gone"));
        },
      },
      handler: () => Promise.resolve(),
      pageSize: 2,
    }).drain(1000, clock.now);

    expect(outcome.handled).toBe(2);
  });

  it("refuses to loop on a source that answers rows and no cursor", async () => {
    // Unreachable through the real adapter, which returns a null cursor only for
    // an empty page. The seam is STRUCTURAL, so a source that did this would
    // otherwise re-read the same page twenty times and hand the same events on
    // twenty times.
    const clock = fakeClock();
    const outcome = await createOutboxFlush({
      source: { drain: () => Promise.resolve({ events: [drainedEvent(1)], cursor: null }) },
      handler: () => Promise.resolve(),
      pageSize: 1,
    }).drain(1000, clock.now);

    expect(outcome).toMatchObject({ drained: false, handled: 1, stoppedBecause: FLUSH_SOURCE_FAULTED });
  });

  it("lets a handler failure reject, because a lost page is not a clean stop", async () => {
    const clock = fakeClock();
    await expect(
      createOutboxFlush({
        source: scripted([1]),
        handler: () => Promise.reject(new Error("sink refused")),
        pageSize: 1,
      }).drain(1000, clock.now),
    ).rejects.toThrow("sink refused");
  });
});

describe("the seam fits the adapter that ships", () => {
  it("resolves the compile-time obligation to true", () => {
    expect(OUTBOX_FLUSH_SOURCE_SATISFACTION).toBe(true);
  });

  it("drains events appended through the REAL OutboxWriter port", async () => {
    const memory = createInMemoryOutbox();
    const at = new Date("2026-05-01T09:00:00.000Z");
    const adapter = buildOutboxAdapter({
      store: memory.store,
      clock: { now: () => at },
      randomBytes: (length) => new Uint8Array(length).fill(7),
    });

    const scope = environmentScope(
      asIdentifier<OrganizationId>("11111111-1111-4111-8111-111111111111"),
      asIdentifier<ProjectId>("11111111-1111-4111-8111-111111111112"),
      asIdentifier<EnvironmentId>("11111111-1111-4111-8111-111111111113"),
    );
    await memory.unitOfWork.run(async (transaction) => {
      for (let index = 0; index < 5; index += 1) {
        const draft: DomainEventDraft<JsonValue> = {
          name: "tenancy.invitation.issued",
          schemaVersion: 1,
          scope,
          requestId: null,
          payload: { index },
        };
        await adapter.append(draft, transaction);
      }
    });

    const handed: DrainedEvent[] = [];
    const clock = fakeClock();
    const outcome = await createOutboxFlush({
      // The adapter itself, unadapted. If this stops type-checking or stops
      // behaving, the seam declared in outbox-drainable.ts is wrong.
      source: adapter,
      handler: (page) => {
        handed.push(...page.events);
        return Promise.resolve();
      },
      pageSize: 2,
    }).drain(10_000, clock.now);

    expect(outcome).toMatchObject({ drained: true, handled: 5, remaining: 0 });
    expect(handed).toHaveLength(5);
  });

  it("hands the real adapter's events on in append order", async () => {
    const memory = createInMemoryOutbox();
    const at = new Date("2026-05-01T09:00:00.000Z");
    const adapter = buildOutboxAdapter({
      store: memory.store,
      clock: { now: () => at },
      randomBytes: (length) => new Uint8Array(length).fill(3),
    });
    const scope = environmentScope(
      asIdentifier<OrganizationId>("22222222-2222-4222-8222-222222222222"),
      asIdentifier<ProjectId>("22222222-2222-4222-8222-222222222223"),
      asIdentifier<EnvironmentId>("22222222-2222-4222-8222-222222222224"),
    );
    await memory.unitOfWork.run(async (transaction) => {
      for (const index of [0, 1, 2, 3]) {
        await adapter.append(
          { name: "cost.threshold.crossed", schemaVersion: 1, scope, requestId: null, payload: { index } },
          transaction,
        );
      }
    });

    const seen: number[] = [];
    const clock = fakeClock();
    await createOutboxFlush({
      source: adapter,
      handler: (page) => {
        for (const event of page.events) {
          const payload = event.payload as { index?: number };
          if (payload.index !== undefined) seen.push(payload.index);
        }
        return Promise.resolve();
      },
      pageSize: 3,
    }).drain(10_000, clock.now);

    // Ordering is the adapter's UUIDv7 counter, not this module's. Reading it
    // back here is what makes "one page then the next" a real claim.
    expect(seen).toEqual([0, 1, 2, 3]);
  });

  it("hands on NOTHING for events that never committed", async () => {
    // THE PROPERTY THE WHOLE OUTBOX EXISTS FOR, read through the shutdown flush:
    // an append inside a rolled-back transaction must not be flushed. It is the
    // defect `conversations` shipped, and the flush is the last place it could
    // still leak out of the process.
    const memory = createInMemoryOutbox();
    const at = new Date("2026-05-01T09:00:00.000Z");
    const adapter = buildOutboxAdapter({
      store: memory.store,
      clock: { now: () => at },
      randomBytes: (length) => new Uint8Array(length).fill(5),
    });
    const scope = environmentScope(
      asIdentifier<OrganizationId>("33333333-3333-4333-8333-333333333333"),
      asIdentifier<ProjectId>("33333333-3333-4333-8333-333333333334"),
      asIdentifier<EnvironmentId>("33333333-3333-4333-8333-333333333335"),
    );

    await expect(
      memory.unitOfWork.run(async (transaction) => {
        await adapter.append(
          { name: "conversations.turn.settled", schemaVersion: 1, scope, requestId: null, payload: {} },
          transaction,
        );
        throw new Error("the settlement did not land");
      }),
    ).rejects.toThrow("the settlement did not land");

    const handed: DrainedEvent[] = [];
    const clock = fakeClock();
    const outcome = await createOutboxFlush({
      source: adapter,
      handler: (page) => {
        handed.push(...page.events);
        return Promise.resolve();
      },
      pageSize: 10,
    }).drain(10_000, clock.now);

    expect(handed).toEqual([]);
    expect(outcome).toMatchObject({ drained: true, handled: 0 });
  });
});
