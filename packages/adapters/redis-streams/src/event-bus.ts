// THE kernel `EventBus`, over the same Redis Streams primitive.
//
// ADR M0.3 §3 uses this port for the reverse-edge inversions — "a channel adapter
// subscribes to an outbound-message event rather than importing `conversations`"
// — and the port's own banner draws the line this file has to stay on the right
// side of: "this is transient coordination and never unacknowledged canonical
// truth. Anything that must survive a crash is appended through `OutboxWriter`
// first and published from the drain."
//
// SO THIS IS NOT A QUEUE AND MUST NOT BECOME ONE. A subscriber joins at the LIVE
// END: `subscribe` starts from the stream's current tip, so an event published
// while nobody was listening is not delivered when somebody arrives. That is the
// documented contract of a fan-out seam, and building durable catch-up here would
// quietly turn the bus into a second canonical store beside the outbox — with no
// transaction, no ordering guarantee against the database, and no way for an
// operator to tell which of the two a missing effect came from.
//
// AT-LEAST-ONCE IS DELIVERED BY NOT ADVANCING. The port says "the handler must be
// idempotent: delivery is at-least-once, so a redelivery after a partial failure
// is normal operation", and this loop implements exactly that: a handler that
// rejects leaves the subscriber's position where it was, so the next pass sees the
// same event again.
//
// AND IT IS BOUNDED, WHICH THE PORT DOES NOT SAY AND A REAL BUS MUST. An unbounded
// retry on a handler that will never succeed stops the subscription forever: one
// poison event and every later event for that name is never delivered to anybody.
// After `maxRedeliveries` the subscriber advances past the event and reports the
// fault through `onFault`. Losing one event is worse than losing one event; losing
// every subsequent event is worse than that.

import type { DomainEvent, EventBus, JsonValue, TenantScope, Unsubscribe } from "@platos/kernel";

import type { RedisStreamConnection } from "./client.js";

/**
 * The bus namespace, versioned separately from the journal's.
 *
 * A DIFFERENT PREFIX AND NOT A DIFFERENT DATABASE. One vendor client is one
 * directory (ADR M0.3 §15) and both ports are behind it; keeping the keyspaces
 * disjoint by prefix is what makes "neither can read the other's records" a
 * property of the key rather than a promise in a comment.
 */
export const BUS_KEY_PREFIX = "platos:bus:v1";

export function busKey(eventName: string): string {
  return `${BUS_KEY_PREFIX}:${eventName}`;
}

/** Why one delivery did not happen, for an install that wants to see it. */
export interface BusDeliveryFault {
  readonly eventName: string;
  readonly eventId: string | null;
  /** How many times this event had already been delivered and rejected. */
  readonly rejections: number;
  /** `retrying` leaves the position; `abandoned` advances past the event. */
  readonly disposition: "retrying" | "abandoned";
  readonly reason: string;
}

export interface RedisEventBusOptions {
  /** Most events one name's stream retains before the oldest are trimmed. */
  readonly maxLength: number;
  /** How long an untouched bus stream survives, in seconds. */
  readonly ttlSeconds: number;
  /** How often a subscriber looks for new events, in milliseconds. */
  readonly pollIntervalMs: number;
  /** Most events one pass delivers, so one burst cannot monopolise a subscriber. */
  readonly batchSize: number;
  /**
   * How many rejections one event may cause before the subscriber moves past it.
   *
   * See the banner: unbounded is not an option, because it converts one bad event
   * into a permanently dead subscription.
   */
  readonly maxRedeliveries: number;
  /** Where an abandoned or retried delivery is reported. Optional by design. */
  readonly onFault?: (fault: BusDeliveryFault) => void;
}

export const DEFAULT_BUS_OPTIONS: RedisEventBusOptions = Object.freeze({
  maxLength: 10_000,
  ttlSeconds: 3_600,
  pollIntervalMs: 50,
  batchSize: 64,
  maxRedeliveries: 5,
});

/** The wire form of an event. Dates and branded ids become strings and back. */
interface EncodedEvent {
  readonly eventId: string;
  readonly name: string;
  readonly schemaVersion: number;
  readonly occurredAt: string;
  readonly scope: TenantScope;
  readonly requestId: string | null;
  readonly payload: JsonValue;
}

export function encodeEvent(event: DomainEvent): string {
  return JSON.stringify({
    eventId: String(event.eventId),
    name: event.name,
    schemaVersion: event.schemaVersion,
    // ISO 8601 WITH MILLISECONDS, NOT AN EPOCH NUMBER. A drain that logs or
    // routes on `occurredAt` reads it as an instant, and a number would be
    // ambiguous about its unit the first time somebody wrote one by hand.
    occurredAt: event.occurredAt.toISOString(),
    scope: event.scope,
    requestId: event.requestId === null ? null : String(event.requestId),
    payload: event.payload,
  });
}

/**
 * The event inside an entry, or null when the entry is not one of ours.
 *
 * NULL RATHER THAN A THROW, for the reason the journal's parser returns null: one
 * unreadable entry must not stop a subscription. It is reported through `onFault`
 * and the subscriber moves on.
 */
export function decodeEvent(body: string): DomainEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Partial<EncodedEvent>;
  if (typeof record.eventId !== "string" || typeof record.name !== "string") return null;
  if (typeof record.schemaVersion !== "number" || typeof record.occurredAt !== "string") return null;
  if (record.scope === undefined || record.scope === null) return null;
  const occurredAt = new Date(record.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) return null;
  return {
    eventId: record.eventId as DomainEvent["eventId"],
    name: record.name,
    schemaVersion: record.schemaVersion,
    occurredAt,
    scope: record.scope,
    requestId: (record.requestId ?? null) as DomainEvent["requestId"],
    payload: (record.payload ?? null) as JsonValue,
  };
}

export interface RedisEventBus extends EventBus {
  readonly busName: "redis-streams";
  /** Stop every subscription this bus started. The composition root owns it. */
  stop(): void;
}

export function createRedisEventBus(
  connection: RedisStreamConnection,
  options: RedisEventBusOptions = DEFAULT_BUS_OPTIONS,
): RedisEventBus {
  const running = new Set<{ stop: () => void }>();

  function report(fault: BusDeliveryFault): void {
    try {
      options.onFault?.(fault);
    } catch {
      // AN INSTALL'S REPORTER MUST NOT BE ABLE TO KILL A SUBSCRIBER. The whole
      // point of this callback is to surface a fault; a fault inside it that
      // propagated would take out the loop that found the first one.
    }
  }

  return {
    busName: "redis-streams",

    async publish(event) {
      // THE SERVER ASSIGNS THE ID, AND THAT IS WHY THE BUS AND THE JOURNAL DO NOT
      // SHARE AN APPEND VERB. A journal stream has ONE producer whose `seq` is
      // part of the contract; a bus stream has MANY, in different processes, and
      // no caller-chosen number could be monotonic across them.
      const key = busKey(event.name);
      await connection.publishAssigned(key, encodeEvent(event), options.maxLength, options.ttlSeconds);
    },

    subscribe(eventName, handler): Unsubscribe {
      const key = busKey(eventName);
      let stopped = false;
      let position: string | null = null;
      let rejections = 0;

      const subscription = {
        stop() {
          stopped = true;
        },
      };
      running.add(subscription);

      void (async () => {
        // START AT THE LIVE END. See the banner: this is a fan-out seam and not a
        // queue, so an event published before anybody subscribed is not this
        // subscriber's to deliver.
        try {
          position = await connection.tip(key);
        } catch {
          position = null;
        }
        while (!stopped) {
          let entries: readonly { readonly id: string; readonly body: string }[] = [];
          try {
            entries = await connection.readAfterId(key, position, options.batchSize);
          } catch (error) {
            report({
              eventName,
              eventId: null,
              rejections: 0,
              disposition: "retrying",
              reason: error instanceof Error ? error.name : "unreadable",
            });
            await pause(options.pollIntervalMs);
            continue;
          }
          if (entries.length === 0) {
            await pause(options.pollIntervalMs);
            continue;
          }
          for (const entry of entries) {
            if (stopped) break;
            const event = decodeEvent(entry.body);
            if (event === null) {
              report({
                eventName,
                eventId: null,
                rejections: 0,
                disposition: "abandoned",
                reason: "this entry is not an event this build can read",
              });
              position = entry.id;
              rejections = 0;
              continue;
            }
            try {
              await handler(event);
              position = entry.id;
              rejections = 0;
            } catch (error) {
              rejections += 1;
              const reason = error instanceof Error ? error.name : "the handler rejected";
              if (rejections > options.maxRedeliveries) {
                report({
                  eventName,
                  eventId: String(event.eventId),
                  rejections,
                  disposition: "abandoned",
                  reason,
                });
                position = entry.id;
                rejections = 0;
                continue;
              }
              report({ eventName, eventId: String(event.eventId), rejections, disposition: "retrying", reason });
              // THE POSITION IS NOT ADVANCED, which IS the redelivery. Break so
              // the next pass re-reads from here rather than skipping the rest of
              // the batch — ordering within one name is part of the contract.
              break;
            }
          }
          if (!stopped) await pause(0);
        }
        running.delete(subscription);
      })();

      // IDEMPOTENT, because the port says so: "calling it twice is not an error".
      return () => {
        subscription.stop();
        running.delete(subscription);
      };
    },

    stop() {
      for (const subscription of running) subscription.stop();
      running.clear();
    },
  };
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
