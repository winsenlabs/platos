import { asIdentifier, type DomainEvent } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { ChannelThreadKey } from "../domain/index.js";
import {
  deliverOutboundMessage,
  OUTBOUND_EVENT_NAMES,
  parseOutboundEvent,
  subscribeOutboundMessages,
} from "./deliver-outbound-message.js";
import { buildChannelsTestContext, buildConnection, testEnvironmentScope } from "./testing/index.js";

const scope = testEnvironmentScope();

function event(payload: unknown, name: string = OUTBOUND_EVENT_NAMES[0]): DomainEvent {
  return {
    eventId: asIdentifier("evt-1"),
    name,
    schemaVersion: 1,
    occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    scope,
    requestId: null,
    payload: payload as never,
  };
}

const validPayload = {
  connectionId: "conn-1",
  channelThreadKey: "channel:C1:1",
  text: "hello",
};

describe("parseOutboundEvent", () => {
  it("reads a well-formed payload", () => {
    expect(parseOutboundEvent(event(validPayload))).toEqual({
      connectionId: "conn-1",
      channelThreadKey: "channel:C1:1",
      text: "hello",
      replacesProviderMessageId: null,
    });
  });

  it("reads the edit target when the provider supports editing", () => {
    const parsed = parseOutboundEvent(event({ ...validPayload, replacesProviderMessageId: "m-1" }));
    expect(parsed?.replacesProviderMessageId).toBe("m-1");
  });

  it("ignores unknown fields, as M0.4 §1.1 requires of a reader", () => {
    const parsed = parseOutboundEvent(event({ ...validPayload, somethingNewer: 42 }));
    expect(parsed?.text).toBe("hello");
  });

  it("accepts empty text — a turn may legitimately emit nothing yet", () => {
    expect(parseOutboundEvent(event({ ...validPayload, text: "" }))?.text).toBe("");
  });

  it.each([
    ["a null payload", null],
    ["an array payload", []],
    ["a string payload", "nope"],
    ["a missing connectionId", { channelThreadKey: "k", text: "t" }],
    ["a blank connectionId", { ...validPayload, connectionId: "" }],
    ["a missing channelThreadKey", { connectionId: "c", text: "t" }],
    ["a blank channelThreadKey", { ...validPayload, channelThreadKey: "   " }],
    ["a non-string text", { ...validPayload, text: 42 }],
    ["a missing text", { connectionId: "c", channelThreadKey: "k" }],
  ])("returns null for %s rather than throwing", (_label, payload) => {
    // An unreadable event is dropped, not fatal: throwing inside a bus handler
    // poisons the subscription for every other tenant's messages.
    expect(parseOutboundEvent(event(payload))).toBeNull();
  });
});

describe("deliverOutboundMessage", () => {
  it("sends through the adapter for the connection's provider", async () => {
    const context = buildChannelsTestContext();
    context.repository.seedConnection(buildConnection());

    const result = await deliverOutboundMessage(context.dependencies, scope, {
      connectionId: "conn-1",
      channelThreadKey: asIdentifier<ChannelThreadKey>("channel:C1:1"),
      text: "hello",
      replacesProviderMessageId: null,
    });

    expect(result.ok).toBe(true);
    expect(context.adapter.sent).toEqual([
      { channelThreadKey: "channel:C1:1", text: "hello", replacesProviderMessageId: null },
    ]);
  });

  it("reads the credential rather than caching one, so a rotation takes effect", async () => {
    const context = buildChannelsTestContext();
    context.repository.seedConnection(buildConnection());

    await deliverOutboundMessage(context.dependencies, scope, {
      connectionId: "conn-1",
      channelThreadKey: asIdentifier<ChannelThreadKey>("channel:C1:1"),
      text: "hello",
      replacesProviderMessageId: null,
    });

    expect(context.credentials.reads).toEqual([{ credentialId: "cred-1", tokenGeneration: 0 }]);
  });

  it("fails for a connection that is not visible", async () => {
    const context = buildChannelsTestContext();
    const result = await deliverOutboundMessage(context.dependencies, scope, {
      connectionId: "missing",
      channelThreadKey: asIdentifier<ChannelThreadKey>("k"),
      text: "hello",
      replacesProviderMessageId: null,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_CONNECTION_NOT_FOUND");
  });

  it("fails for a connection with no credential attached", async () => {
    const context = buildChannelsTestContext();
    context.repository.seedConnection(buildConnection({ credentialId: null }));

    const result = await deliverOutboundMessage(context.dependencies, scope, {
      connectionId: "conn-1",
      channelThreadKey: asIdentifier<ChannelThreadKey>("k"),
      text: "hello",
      replacesProviderMessageId: null,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_ADAPTER_REJECTED");
  });

  it.each([
    ["unauthorized", "CHANNELS_ADAPTER_UNAUTHORIZED"],
    ["unavailable", "CHANNELS_ADAPTER_UNAVAILABLE"],
  ] as const)("surfaces a %s provider failure as its own code", async (mode, code) => {
    // The three adapter codes must stay distinguishable: one is terminal, the
    // other is retried. Collapsing them turns a revoked install into a loop.
    const context = buildChannelsTestContext();
    context.repository.seedConnection(buildConnection());
    context.adapter.failWith(mode);

    const result = await deliverOutboundMessage(context.dependencies, scope, {
      connectionId: "conn-1",
      channelThreadKey: asIdentifier<ChannelThreadKey>("k"),
      text: "hello",
      replacesProviderMessageId: null,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(code);
  });

  it("fails when no adapter is registered for the provider", async () => {
    const context = buildChannelsTestContext();
    context.repository.seedConnection(buildConnection({ provider: "telegram" }));

    const result = await deliverOutboundMessage(context.dependencies, scope, {
      connectionId: "conn-1",
      channelThreadKey: asIdentifier<ChannelThreadKey>("k"),
      text: "hello",
      replacesProviderMessageId: null,
    });
    expect(result.ok).toBe(false);
  });
});

describe("subscribeOutboundMessages", () => {
  it("subscribes to BOTH the streaming and the settled event names", async () => {
    const context = buildChannelsTestContext();
    context.repository.seedConnection(buildConnection());
    subscribeOutboundMessages(context.dependencies, scope);

    for (const name of OUTBOUND_EVENT_NAMES) {
      await context.eventBus.publish(event(validPayload, name));
    }
    expect(context.adapter.sent).toHaveLength(OUTBOUND_EVENT_NAMES.length);
  });

  it("delivers a published message through to the adapter", async () => {
    const context = buildChannelsTestContext();
    context.repository.seedConnection(buildConnection());
    subscribeOutboundMessages(context.dependencies, scope);

    await context.eventBus.publish(event(validPayload));
    expect(context.adapter.sent[0]).toMatchObject({ text: "hello" });
  });

  it("logs and swallows an unreadable event rather than rejecting", async () => {
    const context = buildChannelsTestContext();
    subscribeOutboundMessages(context.dependencies, scope);

    await expect(context.eventBus.publish(event({ nonsense: true }))).resolves.toBeUndefined();
    expect(context.logger.lines.some((line) => line.message.includes("unreadable"))).toBe(true);
  });

  it("logs and swallows a delivery failure, so one bad channel cannot stall the bus", async () => {
    const context = buildChannelsTestContext();
    context.repository.seedConnection(buildConnection());
    context.adapter.failWith("unavailable");
    subscribeOutboundMessages(context.dependencies, scope);

    await expect(context.eventBus.publish(event(validPayload))).resolves.toBeUndefined();
    expect(
      context.logger.lines.some((line) => line.fields["code"] === "CHANNELS_ADAPTER_UNAVAILABLE"),
    ).toBe(true);
  });

  it("stops delivering once unsubscribed", async () => {
    const context = buildChannelsTestContext();
    context.repository.seedConnection(buildConnection());
    const unsubscribe = subscribeOutboundMessages(context.dependencies, scope);

    unsubscribe();
    await context.eventBus.publish(event(validPayload));
    expect(context.adapter.sent).toHaveLength(0);
  });
});
