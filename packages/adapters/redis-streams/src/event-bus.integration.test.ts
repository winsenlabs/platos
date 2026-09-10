// THE BUS, AGAINST A REAL REDIS AND ACROSS SEPARATE CONNECTIONS.
//
// WHAT IT PROVES THAT THE PORT'S OWN WORDS DEMAND AND NOTHING ELSE CHECKS:
//
//   "delivery is at-least-once, so a redelivery after a partial failure is normal
//   operation" — a handler that rejects must see the SAME event again, which means
//   the subscriber's position did not advance. Provable only where the position is
//   held outside the handler.
//
//   ADR M0.3 §3's reverse-edge inversion — one publisher, several subscribers, in
//   different processes. Here they are different CONNECTIONS, which is the closest
//   a single test process can come and is the axis that matters: the ordering is
//   the server's.
//
//   the port's own line that this is "the transient fan-out seam, distinct from
//   the durable outbox" — an event published before anybody subscribed is NOT
//   delivered later. A bus that quietly caught up would be a second canonical
//   store beside the outbox, and it is the failure that would never be noticed
//   until two systems disagreed.
//
// IT FAILS WHEN DOCKER IS ABSENT RATHER THAN SKIPPING.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { asIdentifier, environmentScope } from "@platos/kernel";
import type { DomainEvent, EnvironmentId, EventId, OrganizationId, ProjectId } from "@platos/kernel";

import { createRedisEventBus, DEFAULT_BUS_OPTIONS, type BusDeliveryFault, type RedisEventBus } from "./event-bus.js";
import { startRedisStreamsHarness, type RedisStreamsHarness } from "./harness.js";

const SCOPE = environmentScope(
  asIdentifier<OrganizationId>("aaaaaaaa-0001-4000-8000-000000000001"),
  asIdentifier<ProjectId>("aaaaaaaa-0002-4000-8000-000000000002"),
  asIdentifier<EnvironmentId>("aaaaaaaa-0003-4000-8000-000000000003"),
);

let nameCounter = 0;
function nextName(): string {
  nameCounter += 1;
  return `win272.probe.${nameCounter}`;
}

function event(name: string, ordinal: number): DomainEvent {
  return {
    eventId: asIdentifier<EventId>(`evt_${name}_${ordinal}`),
    name,
    schemaVersion: 1,
    occurredAt: new Date(1_760_000_000_000 + ordinal),
    scope: SCOPE,
    requestId: null,
    payload: { ordinal },
  };
}

/** Wait until `condition` holds or the budget runs out. Never a bare sleep. */
async function until(condition: () => boolean, budgetMs = 5_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let harness: RedisStreamsHarness;
const started: RedisEventBus[] = [];

function bus(options: Partial<Parameters<typeof createRedisEventBus>[1]> = {}): RedisEventBus {
  const made = createRedisEventBus(harness.connect(), {
    ...DEFAULT_BUS_OPTIONS,
    pollIntervalMs: 10,
    ...options,
  });
  started.push(made);
  return made;
}

beforeAll(async () => {
  harness = await startRedisStreamsHarness();
}, 300_000);

afterAll(async () => {
  for (const made of started) made.stop();
  await harness?.stop();
});

beforeEach(async () => {
  await harness.reset();
});

describe("fan-out", () => {
  it("delivers one publisher's events to two subscribers on separate connections, in order", async () => {
    const name = nextName();
    const publisher = bus();
    const first = bus();
    const second = bus();
    const seenFirst: number[] = [];
    const seenSecond: number[] = [];

    const stopFirst = first.subscribe(name, async (delivered) => {
      seenFirst.push((delivered.payload as { ordinal: number }).ordinal);
    });
    const stopSecond = second.subscribe(name, async (delivered) => {
      seenSecond.push((delivered.payload as { ordinal: number }).ordinal);
    });
    // Both subscribers start at the live end, so nothing may be published until
    // both have read the tip. One poll interval is the wait the loop itself needs.
    await new Promise((resolve) => setTimeout(resolve, 100));

    for (let ordinal = 1; ordinal <= 20; ordinal += 1) await publisher.publish(event(name, ordinal));
    await until(() => seenFirst.length === 20 && seenSecond.length === 20);

    const expected = Array.from({ length: 20 }, (_, index) => index + 1);
    expect(seenFirst).toEqual(expected);
    expect(seenSecond).toEqual(expected);
    stopFirst();
    stopSecond();
  });

  it("keeps two event names apart", async () => {
    const mine = nextName();
    const other = nextName();
    const publisher = bus();
    const listener = bus();
    const seen: string[] = [];
    const stop = listener.subscribe(mine, async (delivered) => {
      seen.push(delivered.name);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await publisher.publish(event(other, 1));
    await publisher.publish(event(mine, 1));
    await until(() => seen.length === 1);
    expect(seen).toEqual([mine]);
    stop();
  });

  it("carries the whole envelope to the subscriber, not just the payload", async () => {
    const name = nextName();
    const publisher = bus();
    const listener = bus();
    const received: DomainEvent[] = [];
    const stop = listener.subscribe(name, async (delivered) => {
      received.push(delivered);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const sent = event(name, 7);
    await publisher.publish(sent);
    await until(() => received.length === 1);
    expect(received[0]).toEqual(sent);
    stop();
  });
});

describe("this is a fan-out seam and not a queue", () => {
  it("does NOT deliver an event published before the subscriber existed", async () => {
    // The port's own words: transient coordination, never unacknowledged canonical
    // truth. A bus that caught up would be a second store beside the outbox.
    const name = nextName();
    const publisher = bus();
    await publisher.publish(event(name, 1));
    const listener = bus();
    const seen: number[] = [];
    const stop = listener.subscribe(name, async (delivered) => {
      seen.push((delivered.payload as { ordinal: number }).ordinal);
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await publisher.publish(event(name, 2));
    await until(() => seen.length === 1);
    expect(seen).toEqual([2]);
    stop();
  });
});

describe("at-least-once", () => {
  it("redelivers the same event after a handler rejects, and does not skip ahead", async () => {
    const name = nextName();
    const publisher = bus();
    const listener = bus();
    const deliveries: number[] = [];
    let failuresLeft = 2;
    const stop = listener.subscribe(name, async (delivered) => {
      const ordinal = (delivered.payload as { ordinal: number }).ordinal;
      deliveries.push(ordinal);
      if (ordinal === 1 && failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error("handler refused");
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await publisher.publish(event(name, 1));
    await publisher.publish(event(name, 2));
    await until(() => deliveries.includes(2));

    // Event 1 was delivered three times (two rejections plus the success) and
    // event 2 exactly once, AFTER it. Ordering within one name survives a retry.
    expect(deliveries.filter((ordinal) => ordinal === 1).length).toBe(3);
    expect(deliveries.filter((ordinal) => ordinal === 2).length).toBe(1);
    expect(deliveries.indexOf(2)).toBe(deliveries.length - 1);
    stop();
  });

  it("moves past a poison event rather than stopping the subscription forever", async () => {
    // THE BOUND. Without it, one handler that can never succeed means every later
    // event for that name is delivered to nobody — a far worse outcome than losing
    // the one event, and one nothing would report.
    const name = nextName();
    const publisher = bus();
    const faults: BusDeliveryFault[] = [];
    const listener = bus({ maxRedeliveries: 2, onFault: (fault) => faults.push(fault) });
    const succeeded: number[] = [];
    const stop = listener.subscribe(name, async (delivered) => {
      const ordinal = (delivered.payload as { ordinal: number }).ordinal;
      if (ordinal === 1) throw new Error("always refuses");
      succeeded.push(ordinal);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await publisher.publish(event(name, 1));
    await publisher.publish(event(name, 2));
    await until(() => succeeded.includes(2));

    expect(succeeded).toEqual([2]);
    const abandoned = faults.filter((fault) => fault.disposition === "abandoned");
    expect(abandoned.length).toBe(1);
    expect(abandoned[0]?.eventId).toBe(`evt_${name}_1`);
    expect(abandoned[0]?.rejections).toBe(3);
    // AND THE RETRIES WERE REPORTED TOO, so an operator sees pressure before loss.
    expect(faults.filter((fault) => fault.disposition === "retrying").length).toBe(2);
    stop();
  });

  it("skips an entry it cannot decode and says so, rather than stopping", async () => {
    const name = nextName();
    const listener = bus();
    const faults: BusDeliveryFault[] = [];
    const listenerWithFaults = bus({ onFault: (fault) => faults.push(fault) });
    const seen: number[] = [];
    const stop = listenerWithFaults.subscribe(name, async (delivered) => {
      seen.push((delivered.payload as { ordinal: number }).ordinal);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Written straight onto the bus stream, past the codec — which is what a key
    // collision or an older binary's encoding would look like.
    const raw = harness.connect();
    await raw.publishAssigned(`platos:bus:v1:${name}`, "{not json", 1_000, 60);
    await listener.publish(event(name, 5));
    await until(() => seen.length === 1);

    expect(seen).toEqual([5]);
    expect(faults.some((fault) => fault.disposition === "abandoned")).toBe(true);
    stop();
  });
});

describe("unsubscribing", () => {
  it("stops delivery and is idempotent, as the port requires", async () => {
    const name = nextName();
    const publisher = bus();
    const listener = bus();
    const seen: number[] = [];
    const stop = listener.subscribe(name, async (delivered) => {
      seen.push((delivered.payload as { ordinal: number }).ordinal);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await publisher.publish(event(name, 1));
    await until(() => seen.length === 1);

    stop();
    // "Calling it twice is not an error" — the port's own sentence.
    expect(() => stop()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await publisher.publish(event(name, 2));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(seen).toEqual([1]);
  });
});
