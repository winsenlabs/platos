import { asIdentifier, environmentScope, type EventId } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import {
  asEventName,
  parseDestination,
  severityOf,
  type NotificationRequested,
  type NotificationRuleId,
  type RuleName,
} from "../domain/index.js";
import { recordDeliveryFailure } from "./record-delivery-failure.js";
import { buildEventingTestContext, type EventingTestContext } from "./testing/index.js";

function request(attempt: number): NotificationRequested {
  const destination = parseDestination({ type: "webhook", url: "https://example.test/hook" });
  if (!destination.ok) throw new Error(destination.error.code);
  const eventName = asEventName("run.failed");
  return {
    ruleId: asIdentifier<NotificationRuleId>("rule-1"),
    ruleName: asIdentifier<RuleName>("failures"),
    scope: environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier("env-1")),
    eventId: asIdentifier<EventId>("evt-1"),
    eventName,
    subjectId: null,
    payload: { ok: true },
    destination: destination.value,
    severity: severityOf(eventName),
    attempt,
    requestedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

describe("recordDeliveryFailure", () => {
  let context: EventingTestContext;

  beforeEach(() => {
    context = buildEventingTestContext();
  });

  it("re-enqueues the first failure two seconds out", async () => {
    const outcome = await recordDeliveryFailure(context.dependencies, request(0));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.value.decision).toEqual({ kind: "retry", attempt: 1, delayMs: 2_000 });

    const [queued] = context.queue.all();
    expect(queued?.request.attempt).toBe(1);
    expect(queued?.availableAt.toISOString()).toBe("2026-01-01T00:00:02.000Z");
  });

  it("re-enqueues the second failure four seconds out", async () => {
    await recordDeliveryFailure(context.dependencies, request(1));
    const [queued] = context.queue.all();
    expect(queued?.request.attempt).toBe(2);
    expect(queued?.availableAt.toISOString()).toBe("2026-01-01T00:00:04.000Z");
  });

  // Giving up is a terminal SUCCESS. A caller must be able to tell "this
  // notification is finished, unsuccessfully" from "the queue is broken".
  it("gives up after the third attempt and enqueues NOTHING", async () => {
    const outcome = await recordDeliveryFailure(context.dependencies, request(2));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.value.decision).toEqual({ kind: "give-up", attempts: 3 });
    expect(outcome.value.rescheduled).toBeNull();
    expect(context.queue.all()).toHaveLength(0);
  });

  it("carries the destination and payload through unchanged onto the retry", async () => {
    const original = request(0);
    await recordDeliveryFailure(context.dependencies, original);
    const [queued] = context.queue.all();
    expect(queued?.request.destination).toEqual(original.destination);
    expect(queued?.request.payload).toEqual(original.payload);
    expect(queued?.request.eventId).toBe(original.eventId);
  });

  it("re-stamps requestedAt from the injected clock", async () => {
    context.clock.set(new Date("2030-01-01T00:00:00.000Z"));
    await recordDeliveryFailure(context.dependencies, request(0));
    const [queued] = context.queue.all();
    expect(queued?.request.requestedAt.toISOString()).toBe("2030-01-01T00:00:00.000Z");
    expect(queued?.availableAt.toISOString()).toBe("2030-01-01T00:00:02.000Z");
  });

  it("fails when the retry could not be enqueued", async () => {
    context.queue.failNext("redis down");
    const outcome = await recordDeliveryFailure(context.dependencies, request(0));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("EVENTING_QUEUE_UNAVAILABLE");
  });

  it("walks the whole schedule to exhaustion in three attempts", async () => {
    let current = request(0);
    const delays: number[] = [];
    for (let round = 0; round < 5; round += 1) {
      const outcome = await recordDeliveryFailure(context.dependencies, current);
      if (!outcome.ok) throw new Error("unreachable");
      if (outcome.value.decision.kind === "give-up") break;
      delays.push(outcome.value.decision.delayMs);
      if (outcome.value.rescheduled === null) throw new Error("unreachable");
      current = outcome.value.rescheduled;
    }
    expect(delays).toEqual([2_000, 4_000]);
  });
});
