import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { AgentId, ChannelEventInboxId, ChannelThreadKey, EndUserId, ThreadId } from "./identifiers.js";
import {
  buildInboundTurnPayload,
  extractPlatformChannelId,
  inboundTurnIdempotencyKey,
  INBOUND_TURN_JOB_NAME,
  INBOUND_TURN_PAYLOAD_VERSION,
} from "./inbound.js";

const EPOCH = new Date("2026-01-01T00:00:00.000Z");

function payload(agentId: AgentId | null) {
  return buildInboundTurnPayload({
    inboxId: asIdentifier<ChannelEventInboxId>("inbox-1"),
    threadId: asIdentifier<ThreadId>("thread-1"),
    agentId,
    message: {
      channelThreadKey: asIdentifier<ChannelThreadKey>("channel:C1:1"),
      platformChannelId: "C1",
      text: "hello",
      endUserId: asIdentifier<EndUserId>("eu-1"),
      receivedAt: EPOCH,
    },
  });
}

describe("the job name and payload version", () => {
  it("names a Platos-owned job, never a vendor task", () => {
    expect(INBOUND_TURN_JOB_NAME).toBe("channels.inbound-turn");
  });

  it("is version 1, frozen for the life of this job name", () => {
    expect(INBOUND_TURN_PAYLOAD_VERSION).toBe(1);
  });
});

describe("buildInboundTurnPayload", () => {
  it("carries the routing decision on first contact", () => {
    expect(payload(asIdentifier<AgentId>("agent-1")).agentId).toBe("agent-1");
  });

  it("carries a null agent for an existing conversation", () => {
    // Null means "run on the thread's pinned agent". conversations owns that
    // column and this context may not read it, so absence is expressed, not
    // guessed.
    expect(payload(null).agentId).toBeNull();
  });

  it("names the inbox row rather than embedding the encrypted body", () => {
    const built = payload(null);
    expect(built.inboxId).toBe("inbox-1");
    expect(built).not.toHaveProperty("payload");
    expect(built).not.toHaveProperty("ciphertext");
  });

  it("is JSON-safe: every value is a string or null", () => {
    // It crosses a durable boundary and may be decoded by a later binary, so
    // nothing on it may be a Date, a branded object, or undefined.
    for (const value of Object.values(payload(asIdentifier<AgentId>("agent-1")))) {
      expect(value === null || typeof value === "string").toBe(true);
    }
    expect(JSON.parse(JSON.stringify(payload(null)))).toEqual(payload(null));
  });
});

describe("inboundTurnIdempotencyKey", () => {
  it("is derived from the inbox row alone, so a redelivery yields one job", () => {
    const first = inboundTurnIdempotencyKey(asIdentifier<ChannelEventInboxId>("inbox-1"));
    const second = inboundTurnIdempotencyKey(asIdentifier<ChannelEventInboxId>("inbox-1"));
    expect(first).toBe(second);
  });

  it("differs for a different inbox row", () => {
    const left = inboundTurnIdempotencyKey(asIdentifier<ChannelEventInboxId>("inbox-1"));
    const right = inboundTurnIdempotencyKey(asIdentifier<ChannelEventInboxId>("inbox-2"));
    expect(left).not.toBe(right);
  });

  it("is namespaced by the job name, so it cannot collide with another job's key", () => {
    expect(inboundTurnIdempotencyKey(asIdentifier<ChannelEventInboxId>("inbox-1"))).toContain(
      INBOUND_TURN_JOB_NAME,
    );
  });
});

describe("extractPlatformChannelId", () => {
  it("reads the channel from the second segment", () => {
    expect(extractPlatformChannelId("channel:C123:1700.1")).toBe("C123");
  });

  it("works for a two-segment key", () => {
    expect(extractPlatformChannelId("dm:D999")).toBe("D999");
  });

  it.each([
    ["a key with no separator", "C123"],
    ["an empty second segment", "channel::1"],
    ["an empty string", ""],
  ])("returns null for %s, so a channel rule simply does not match", (_label, value) => {
    expect(extractPlatformChannelId(value)).toBeNull();
  });
});
