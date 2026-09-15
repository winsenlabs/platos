// A VERIFIED INTERACTION BECOMES THIS CONTEXT'S SHAPE — and a thread key the
// DOMAIN can read back.
//
// Every case goes through `verifyInbound`, so real Ed25519 over real bytes runs
// first: normalization is only ever reached by a delivery that authenticated.
//
// THE THREAD CASES ARE ASSERTED THROUGH THE DOMAIN'S OWN READER.
// `extractPlatformChannelId` is published from the context's port entry point
// precisely so an adapter's suite can prove its keys against the function a
// `channel` routing rule actually runs, rather than against a copy of the format.

import { extractPlatformChannelId } from "@platos/context-channels/application/ports/index.js";
import { describe, expect, it } from "vitest";

import { createChannelDiscordAdapter } from "./adapter.js";
import {
  AUTOCOMPLETE_BODY,
  BOT_COMMAND_BODY,
  COMMAND_IN_ANNOUNCEMENT_THREAD_BODY,
  COMMAND_IN_CHANNEL_BODY,
  COMMAND_IN_ORPHAN_THREAD_BODY,
  COMMAND_IN_THREAD_BODY,
  COMPONENT_BODY,
  DM_CHANNEL_ID,
  FIXTURE_PUBLIC_KEY,
  MESSAGE_COMMAND_BODY,
  NO_CHANNEL_COMMAND_BODY,
  NO_ID_COMMAND_BODY,
  ORPHAN_THREAD_ID,
  PING_BODY,
  SECOND_COMMAND_IN_THREAD_BODY,
  signDiscordDelivery,
  SUBCOMMAND_IN_DM_BODY,
  TEXT_CHANNEL_ID,
  THREAD_ID,
} from "./fixtures.js";

const adapter = createChannelDiscordAdapter();
const secret = { secret: FIXTURE_PUBLIC_KEY };

async function verify(body: string) {
  const outcome = await adapter.verifyInbound(secret, signDiscordDelivery(body));
  if (!outcome.ok) throw new Error(`expected acceptance, got ${outcome.error.code}`);
  return outcome.value;
}

describe("the PING is the handshake, answered with PONG and never admitted", () => {
  it("echoes exactly {\"type\":1} and carries no event id", async () => {
    const delivery = await verify(PING_BODY);
    expect(delivery.kind).toBe("handshake");
    // The WHOLE response body Discord requires — `overview.mdx`: "a 200 response
    // with a PONG payload (which has the same type: 1)". Parsed as well as
    // compared, so a formatting change cannot pass for a different payload.
    expect(delivery.handshakeEcho).toBe('{"type":1}');
    expect(JSON.parse(delivery.handshakeEcho ?? "null")).toEqual({ type: 1 });
    // A PING has an `id`. It is still not an event, and must not key a row.
    expect(delivery.providerEventId).toBeNull();
    expect(delivery.message).toBeNull();
  });
});

describe("a chat-input command becomes an InboundMessage", () => {
  it("carries the interaction id as the admission key and the option values as text", async () => {
    const delivery = await verify(COMMAND_IN_CHANNEL_BODY);
    expect(delivery.kind).toBe("message");
    expect(delivery.providerEventId).toBe("1181999000000000010");
    expect(delivery.message?.text).toBe("is it everything a river should be?");
    expect(delivery.message?.endUserId).toBeNull();
    expect(delivery.verifiedBody).toBe(COMMAND_IN_CHANNEL_BODY);
  });

  it("keys a top-level channel on the channel, and the domain reads the channel back", async () => {
    const key = (await verify(COMMAND_IN_CHANNEL_BODY)).message?.channelThreadKey ?? "";
    expect(key).toBe(`discord:${TEXT_CHANNEL_ID}`);
    expect(extractPlatformChannelId(key)).toBe(TEXT_CHANNEL_ID);
  });

  it("keys a thread UNDER its parent, so a channel rule for the parent still matches", async () => {
    // THE JOIN THAT MATTERS FOR ROUTING. An operator who routes `#support` to an
    // agent means the channel and its threads. The domain's reader must recover
    // the PARENT from a thread's key; keying the thread on itself would make the
    // rule silently stop firing inside every thread.
    const delivery = await verify(COMMAND_IN_THREAD_BODY);
    const key = delivery.message?.channelThreadKey ?? "";
    expect(key).toBe(`discord:${TEXT_CHANNEL_ID}:${THREAD_ID}`);
    expect(extractPlatformChannelId(key)).toBe(TEXT_CHANNEL_ID);
    expect(delivery.message?.platformChannelId).toBe(TEXT_CHANNEL_ID);
  });

  it("gives two commands in one thread the SAME key and different event ids", async () => {
    const first = await verify(COMMAND_IN_THREAD_BODY);
    const second = await verify(SECOND_COMMAND_IN_THREAD_BODY);
    expect(second.message?.channelThreadKey).toBe(first.message?.channelThreadKey);
    expect(second.providerEventId).not.toBe(first.providerEventId);
  });

  it("keeps the channel and a thread under it as TWO conversations", async () => {
    // One Discord conversation is one Platos thread. The main channel and a thread
    // under it are different places; one key for both would merge two transcripts.
    const channel = await verify(COMMAND_IN_CHANNEL_BODY);
    const thread = await verify(COMMAND_IN_THREAD_BODY);
    expect(thread.message?.channelThreadKey).not.toBe(channel.message?.channelThreadKey);
  });

  it("recognises an ANNOUNCEMENT thread (type 10) as a thread, which the legacy SDK does not", async () => {
    const key = (await verify(COMMAND_IN_ANNOUNCEMENT_THREAD_BODY)).message?.channelThreadKey ?? "";
    expect(key).toBe("discord:1181000000000000110:1181000000000000210");
    expect(extractPlatformChannelId(key)).toBe("1181000000000000110");
  });

  it("keys a thread whose partial channel names NO parent on ITSELF, never under an invented one", async () => {
    // The type alone says "thread"; the parent is what the key is built from. A
    // key with an absent parent would carry the text `undefined` as a channel id,
    // and a routing rule would be matched against it.
    const delivery = await verify(COMMAND_IN_ORPHAN_THREAD_BODY);
    const key = delivery.message?.channelThreadKey ?? "";
    expect(key).toBe(`discord:${ORPHAN_THREAD_ID}`);
    expect(extractPlatformChannelId(key)).toBe(ORPHAN_THREAD_ID);
    expect(delivery.message?.platformChannelId).toBe(ORPHAN_THREAD_ID);
  });

  it("keys a DM on the DM channel and descends into sub-command options for the text", async () => {
    const delivery = await verify(SUBCOMMAND_IN_DM_BODY);
    expect(delivery.message?.channelThreadKey).toBe(`discord:${DM_CHANNEL_ID}`);
    // `/agent ask topic:rivers depth:3` — the sub-command NAME is not text; its
    // option values are, in order, and a number is rendered as its digits.
    expect(delivery.message?.text).toBe("rivers 3");
  });
});

describe("verified interactions with no behaviour are acknowledged, not admitted", () => {
  it.each([
    ["a button click", COMPONENT_BODY],
    ["an autocomplete request", AUTOCOMPLETE_BODY],
    ["a message context-menu command", MESSAGE_COMMAND_BODY],
    ["a command invoked by a bot", BOT_COMMAND_BODY],
  ])("%s is IGNORABLE with no event id", async (_name, body) => {
    const delivery = await verify(body);
    expect(delivery.kind).toBe("ignorable");
    expect(delivery.providerEventId).toBeNull();
    expect(delivery.message).toBeNull();
  });

  it("treats an interaction type this build has never heard of as ignorable", async () => {
    const delivery = await verify(JSON.stringify({ id: "1181999000000000099", type: 42, application_id: "1" }));
    expect(delivery.kind).toBe("ignorable");
  });
});

describe("a verified command that cannot be admitted is REFUSED as an input defect", () => {
  it.each([
    ["no interaction id", NO_ID_COMMAND_BODY],
    ["no channel", NO_CHANNEL_COMMAND_BODY],
    ["a body that is not JSON", "{not json"],
    ["JSON that is not an interaction", "[1,2,3]"],
    ["an interaction with no numeric type", JSON.stringify({ id: "1", type: "2" })],
  ])("%s is CHANNELS_EVENT_PAYLOAD_INVALID, never a signature code", async (_name, body) => {
    const outcome = await adapter.verifyInbound(secret, signDiscordDelivery(body));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.error.code).toBe("CHANNELS_EVENT_PAYLOAD_INVALID");
    expect(outcome.ok ? null : outcome.error.category).toBe("invalid_input");
  });

  it("refuses a channel id that is not a snowflake rather than keying on it", async () => {
    // A key segment ends up in a REST path on the outbound side. `../users/@me`
    // must never become a conversation address in the first place.
    const hostile = COMMAND_IN_CHANNEL_BODY.replaceAll(TEXT_CHANNEL_ID, "../users/@me");
    const outcome = await adapter.verifyInbound(secret, signDiscordDelivery(hostile));
    expect(outcome.ok ? null : outcome.error.code).toBe("CHANNELS_EVENT_PAYLOAD_INVALID");
  });
});

describe("no Discord field crosses the port", () => {
  it("returns only the fields the port declares", async () => {
    const delivery = await verify(COMMAND_IN_THREAD_BODY);
    expect(Object.keys(delivery).sort()).toEqual([
      "handshakeEcho",
      "kind",
      "message",
      "provider",
      "providerEventId",
      "verifiedBody",
    ]);
    expect(Object.keys(delivery.message ?? {}).sort()).toEqual([
      "channelThreadKey",
      "endUserId",
      "platformChannelId",
      "receivedAt",
      "text",
    ]);
    // The interaction TOKEN is a fifteen-minute credential. It stays inside the
    // verified body, which the inbox seals; it is not lifted into any field.
    expect(JSON.stringify(delivery.message)).not.toContain("aW50ZXJhY3Rpb24tdG9rZW4tZml4dHVyZQ");
  });
});
