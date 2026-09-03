import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { ChannelAppId, ProviderEventId } from "../domain/index.js";
import { admitChannelEvent } from "./admit-channel-event.js";
import { buildChannelsTestContext, buildEvent } from "./testing/index.js";

const appId = asIdentifier<ChannelAppId>("app-1");
const eventId = asIdentifier<ProviderEventId>("Ev123");

function command(overrides: { eventId?: ProviderEventId; body?: string } = {}) {
  return { appId, eventId: overrides.eventId ?? eventId, body: overrides.body ?? '{"text":"hi"}' };
}

describe("admitChannelEvent", () => {
  it("admits a first delivery and reports it as newly admitted", async () => {
    const context = buildChannelsTestContext();
    const result = await admitChannelEvent(context.dependencies, command());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.admitted).toBe(true);
    expect(result.value.event.status).toBe("PENDING");
    expect(result.value.event.eventId).toBe(eventId);
  });

  it("seals the body before storing it, and never stores the cleartext", async () => {
    const context = buildChannelsTestContext();
    const result = await admitChannelEvent(context.dependencies, command({ body: "secret-text" }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event.payload.ciphertext).not.toBe("secret-text");
    expect(result.value.event.payload.keyVersion).toBe(7);

    const reopened = await context.cipher.open(result.value.event.payload);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.value).toBe("secret-text");
  });

  it("is IDEMPOTENT: a redelivery succeeds and returns the original row", async () => {
    // The provider retries anything it did not see acknowledged. Failing here
    // would keep that retry loop alive forever on an event already handled.
    const context = buildChannelsTestContext();
    const first = await admitChannelEvent(context.dependencies, command());
    const second = await admitChannelEvent(context.dependencies, command());

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.admitted).toBe(false);
    expect(second.value.event.inboxId).toBe(first.value.event.inboxId);
    expect(context.repository.events.size).toBe(1);
  });

  it("does not re-seal a duplicate — the fast probe runs before the cipher", async () => {
    const context = buildChannelsTestContext();
    await admitChannelEvent(context.dependencies, command());

    // The cipher is armed to fail; a duplicate must never reach it.
    context.cipher.failNext();
    const duplicate = await admitChannelEvent(context.dependencies, command());
    expect(duplicate.ok).toBe(true);
  });

  it("admits the same provider event id under a DIFFERENT app", async () => {
    // The unique is [appId, eventId]: two Slack apps can legitimately see the
    // same event id, and they are different deliveries.
    const context = buildChannelsTestContext();
    await admitChannelEvent(context.dependencies, command());
    const other = await admitChannelEvent(context.dependencies, {
      appId: asIdentifier<ChannelAppId>("app-2"),
      eventId,
      body: "{}",
    });

    expect(other.ok).toBe(true);
    if (!other.ok) return;
    expect(other.value.admitted).toBe(true);
    expect(context.repository.events.size).toBe(2);
  });

  it("treats a LOST INSERT RACE as a duplicate, not as an error", async () => {
    // Two concurrent first-deliveries both pass the probe; the unique rejects
    // the loser, which must then resolve to the winner's row.
    const context = buildChannelsTestContext();
    context.repository.seedEvent(buildEvent({ appId, eventId }));

    const result = await admitChannelEvent(context.dependencies, command());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.admitted).toBe(false);
  });

  it("writes inside a unit of work", async () => {
    const context = buildChannelsTestContext();
    await admitChannelEvent(context.dependencies, command());
    expect(context.unitOfWork.transactions).toHaveLength(1);
    expect(context.repository.writes).toHaveLength(1);
  });

  it("propagates a cipher failure instead of storing an unsealed row", async () => {
    const context = buildChannelsTestContext();
    context.cipher.failNext();

    const result = await admitChannelEvent(context.dependencies, command());
    expect(result.ok).toBe(false);
    expect(context.repository.events.size).toBe(0);
  });

  it("propagates a repository failure on the probe", async () => {
    const context = buildChannelsTestContext();
    context.repository.failNext("probe down");

    const result = await admitChannelEvent(context.dependencies, command());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_REPOSITORY_UNAVAILABLE");
  });
});
