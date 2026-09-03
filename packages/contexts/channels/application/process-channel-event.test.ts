import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_CHANNELS_POLICY,
  type ChannelAppId,
  type ChannelEventInboxId,
  type LeaseOwner,
  type ProviderEventId,
} from "../domain/index.js";
import {
  claimNextChannelEvent,
  completeChannelEvent,
  discardChannelEvent,
  failChannelEvent,
  renewChannelEventLease,
} from "./process-channel-event.js";
import { buildChannelsTestContext, buildEvent } from "./testing/index.js";

const appId = asIdentifier<ChannelAppId>("app-1");
const worker = (value = "worker-1"): LeaseOwner => asIdentifier<LeaseOwner>(value);

function contextWithEvents(count: number) {
  const context = buildChannelsTestContext();
  for (let index = 0; index < count; index += 1) {
    context.repository.seedEvent(
      buildEvent({
        inboxId: asIdentifier<ChannelEventInboxId>(`inbox-${index + 1}`),
        eventId: asIdentifier<ProviderEventId>(`Ev${index + 1}`),
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
      }),
    );
  }
  return context;
}

describe("claimNextChannelEvent", () => {
  it("claims the only claimable event", async () => {
    const context = contextWithEvents(1);
    const result = await claimNextChannelEvent(context.dependencies, appId, worker());

    expect(result.ok).toBe(true);
    if (!result.ok || result.value === null) return;
    expect(result.value.event.status).toBe("PROCESSING");
    expect(result.value.hold).toEqual({ leaseOwner: "worker-1", leaseGeneration: 1 });
  });

  it("reports null rather than failing when there is nothing to claim", async () => {
    const context = buildChannelsTestContext();
    const result = await claimNextChannelEvent(context.dependencies, appId, worker());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it("hands two workers DIFFERENT events rather than the same one twice", async () => {
    const context = contextWithEvents(2);
    const first = await claimNextChannelEvent(context.dependencies, appId, worker("w1"));
    const second = await claimNextChannelEvent(context.dependencies, appId, worker("w2"));

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok || first.value === null || second.value === null) return;
    expect(first.value.event.inboxId).not.toBe(second.value.event.inboxId);
  });

  it("claims in order: oldest available, then oldest created", async () => {
    const context = contextWithEvents(3);
    const result = await claimNextChannelEvent(context.dependencies, appId, worker());
    expect(result.ok).toBe(true);
    if (!result.ok || result.value === null) return;
    expect(result.value.event.inboxId).toBe("inbox-1");
  });

  it("ignores events belonging to another app", async () => {
    const context = buildChannelsTestContext();
    context.repository.seedEvent(buildEvent({ appId: asIdentifier<ChannelAppId>("other-app") }));

    const result = await claimNextChannelEvent(context.dependencies, appId, worker());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it("does not reclaim a held lease before it expires", async () => {
    const context = contextWithEvents(1);
    await claimNextChannelEvent(context.dependencies, appId, worker("w1"));

    context.clock.advanceSeconds(DEFAULT_CHANNELS_POLICY.event.leaseMilliseconds / 1000 - 1);
    const second = await claimNextChannelEvent(context.dependencies, appId, worker("w2"));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value).toBeNull();
  });

  it("recovers an expired lease and FENCES the original holder out", async () => {
    const context = contextWithEvents(1);
    const first = await claimNextChannelEvent(context.dependencies, appId, worker("w1"));
    expect(first.ok).toBe(true);
    if (!first.ok || first.value === null) return;

    context.clock.advanceSeconds(DEFAULT_CHANNELS_POLICY.event.leaseMilliseconds / 1000 + 1);
    const second = await claimNextChannelEvent(context.dependencies, appId, worker("w2"));
    expect(second.ok).toBe(true);
    if (!second.ok || second.value === null) return;
    expect(second.value.hold.leaseGeneration).toBe(2);

    // The dead worker comes back and tries to finish. It must write nothing.
    const stale = await completeChannelEvent(
      context.dependencies,
      first.value.event.inboxId,
      first.value.hold,
    );
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error.code).toBe("CHANNELS_EVENT_LEASE_LOST");
  });

  it("respects the claim batch size", async () => {
    const context = buildChannelsTestContext({
      ...DEFAULT_CHANNELS_POLICY,
      event: { ...DEFAULT_CHANNELS_POLICY.event, claimBatchSize: 1 },
    });
    context.repository.seedEvent(buildEvent({ inboxId: asIdentifier<ChannelEventInboxId>("inbox-1"), eventId: asIdentifier<ProviderEventId>("Ev1") }));
    const result = await claimNextChannelEvent(context.dependencies, appId, worker());
    expect(result.ok).toBe(true);
  });
});

describe("renewChannelEventLease", () => {
  it("extends a held lease so a long turn is not stolen", async () => {
    const context = contextWithEvents(1);
    const claimed = await claimNextChannelEvent(context.dependencies, appId, worker());
    expect(claimed.ok).toBe(true);
    if (!claimed.ok || claimed.value === null) return;

    context.clock.advanceSeconds(240);
    const renewed = await renewChannelEventLease(
      context.dependencies,
      claimed.value.event.inboxId,
      claimed.value.hold,
    );
    expect(renewed.ok).toBe(true);

    // Another worker still cannot take it.
    const stealer = await claimNextChannelEvent(context.dependencies, appId, worker("w2"));
    expect(stealer.ok).toBe(true);
    if (!stealer.ok) return;
    expect(stealer.value).toBeNull();
  });

  it("refuses to renew a lease that was lost", async () => {
    const context = contextWithEvents(1);
    const claimed = await claimNextChannelEvent(context.dependencies, appId, worker("w1"));
    expect(claimed.ok).toBe(true);
    if (!claimed.ok || claimed.value === null) return;

    context.clock.advanceSeconds(DEFAULT_CHANNELS_POLICY.event.leaseMilliseconds / 1000 + 1);
    await claimNextChannelEvent(context.dependencies, appId, worker("w2"));

    const renewed = await renewChannelEventLease(
      context.dependencies,
      claimed.value.event.inboxId,
      claimed.value.hold,
    );
    expect(renewed.ok).toBe(false);
  });
});

describe("completeChannelEvent", () => {
  it("completes and makes the row permanently unclaimable", async () => {
    const context = contextWithEvents(1);
    const claimed = await claimNextChannelEvent(context.dependencies, appId, worker());
    expect(claimed.ok).toBe(true);
    if (!claimed.ok || claimed.value === null) return;

    const completed = await completeChannelEvent(
      context.dependencies,
      claimed.value.event.inboxId,
      claimed.value.hold,
    );
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.value.status).toBe("COMPLETED");

    context.clock.advanceSeconds(999_999);
    const again = await claimNextChannelEvent(context.dependencies, appId, worker("w2"));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value).toBeNull();
  });

  it("fails for an event that does not exist", async () => {
    const context = buildChannelsTestContext();
    const result = await completeChannelEvent(context.dependencies, asIdentifier<ChannelEventInboxId>("nope"), {
      leaseOwner: worker(),
      leaseGeneration: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_EVENT_NOT_FOUND");
  });
});

describe("failChannelEvent", () => {
  it("returns the event to the queue behind a backoff while retries remain", async () => {
    const context = contextWithEvents(1);
    const claimed = await claimNextChannelEvent(context.dependencies, appId, worker());
    expect(claimed.ok).toBe(true);
    if (!claimed.ok || claimed.value === null) return;

    const failed = await failChannelEvent(
      context.dependencies,
      claimed.value.event.inboxId,
      claimed.value.hold,
      "BOOM",
    );
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.value.status).toBe("FAILED");
    expect(failed.value.lastErrorCode).toBe("BOOM");

    // Not claimable until the backoff elapses; claimable after.
    const tooSoon = await claimNextChannelEvent(context.dependencies, appId, worker());
    expect(tooSoon.ok && tooSoon.value === null).toBe(true);

    context.clock.advanceSeconds(DEFAULT_CHANNELS_POLICY.event.retryDelayMilliseconds / 1000);
    const retried = await claimNextChannelEvent(context.dependencies, appId, worker());
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.value).not.toBeNull();
  });

  it("DISCARDS once the retry cap is exhausted, so a poison event stops costing turns", async () => {
    const policy = {
      ...DEFAULT_CHANNELS_POLICY,
      event: { ...DEFAULT_CHANNELS_POLICY.event, maxRetries: 2, retryDelayMilliseconds: 1000 },
    };
    const context = buildChannelsTestContext(policy);
    context.repository.seedEvent(buildEvent({ inboxId: asIdentifier<ChannelEventInboxId>("inbox-1"), eventId: asIdentifier<ProviderEventId>("Ev1") }));

    for (let retry = 1; retry <= 2; retry += 1) {
      const claimed = await claimNextChannelEvent(context.dependencies, appId, worker());
      expect(claimed.ok).toBe(true);
      if (!claimed.ok || claimed.value === null) return;

      const failed = await failChannelEvent(
        context.dependencies,
        claimed.value.event.inboxId,
        claimed.value.hold,
        "BOOM",
      );
      expect(failed.ok).toBe(true);
      if (!failed.ok) return;
      expect(failed.value.status).toBe(retry < 2 ? "FAILED" : "DISCARDED");
      context.clock.advanceSeconds(2);
    }

    const afterCap = await claimNextChannelEvent(context.dependencies, appId, worker());
    expect(afterCap.ok).toBe(true);
    if (!afterCap.ok) return;
    expect(afterCap.value).toBeNull();
  });
});

describe("discardChannelEvent", () => {
  it("discards on demand, before the cap is reached", async () => {
    const context = contextWithEvents(1);
    const claimed = await claimNextChannelEvent(context.dependencies, appId, worker());
    expect(claimed.ok).toBe(true);
    if (!claimed.ok || claimed.value === null) return;

    const discarded = await discardChannelEvent(
      context.dependencies,
      claimed.value.event.inboxId,
      claimed.value.hold,
      "UNPARSEABLE",
    );
    expect(discarded.ok).toBe(true);
    if (!discarded.ok) return;
    expect(discarded.value.status).toBe("DISCARDED");
    expect(discarded.value.retryCount).toBe(1);
  });
});
