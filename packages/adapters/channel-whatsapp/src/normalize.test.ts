// A VERIFIED WEBHOOK BECOMES THIS CONTEXT'S SHAPE — and a thread key the DOMAIN
// can read back.
//
// Every case goes through `verifyInbound`, so a real HMAC over real bytes runs
// first: normalization is only ever reached by a delivery that authenticated.
//
// THE CONVERSATION CASES ARE ASSERTED THROUGH THE DOMAIN'S OWN READER.
// `extractPlatformChannelId` is published from the context's port entry point
// precisely so an adapter's suite can prove its keys against the function a
// `channel` routing rule actually runs, rather than against a copy of the format.
// For WhatsApp that function must return THE BUSINESS LINE and never a customer's
// number — see `provider.ts` for why the line is the channel.

import { extractPlatformChannelId } from "@platos/context-channels/application/ports/index.js";
import { describe, expect, it } from "vitest";

import { createChannelWhatsAppAdapter } from "./adapter.js";
import {
  BATCHED_CHANGES_BODY,
  BATCHED_ENTRIES_BODY,
  BATCHED_MESSAGES_BODY,
  CUSTOMER_WA_ID,
  FIXTURE_APP_SECRET,
  FIXTURE_INSTANT,
  HOSTILE_PHONE_NUMBER_ID_BODY,
  IMAGE_MESSAGE_BODY,
  INTERACTIVE_MESSAGE_BODY,
  NO_FROM_BODY,
  NO_ID_BODY,
  NO_PHONE_NUMBER_ID_BODY,
  OTHER_CUSTOMER_BODY,
  OTHER_CUSTOMER_WA_ID,
  OTHER_FIELD_BODY,
  OTHER_LINE_BODY,
  OTHER_OBJECT_BODY,
  OTHER_PHONE_NUMBER_ID,
  PHONE_NUMBER_ID,
  SECOND_TEXT_MESSAGE_BODY,
  SELF_MESSAGE_BODY,
  signWhatsAppDelivery,
  STATUS_BODY,
  TEXT_MESSAGE_BODY,
} from "./fixtures.js";

const adapter = createChannelWhatsAppAdapter();
const secret = { secret: FIXTURE_APP_SECRET };

async function verify(body: string) {
  const outcome = await adapter.verifyInbound(secret, signWhatsAppDelivery(body));
  if (!outcome.ok) throw new Error(`expected acceptance, got ${outcome.error.code}`);
  return outcome.value;
}

describe("a customer's text becomes an InboundMessage", () => {
  it("carries the wamid as the admission key and the text as the text", async () => {
    const delivery = await verify(TEXT_MESSAGE_BODY);
    expect(delivery.kind).toBe("message");
    expect(delivery.providerEventId).toBe(
      "wamid.HBgLMTU1NTEyMzQ1NjcVAgASGBQzQTAwMDAwMDAwMDAwMDAwMDEwMQA=",
    );
    expect(delivery.message?.text).toBe("is it everything a river should be?");
    expect(delivery.message?.endUserId).toBeNull();
    expect(delivery.message?.receivedAt).toEqual(FIXTURE_INSTANT);
    expect(delivery.verifiedBody).toBe(TEXT_MESSAGE_BODY);
  });

  it("keys the conversation on the LINE and the customer, and the domain reads the LINE back", async () => {
    // THE JOIN THAT MATTERS FOR ROUTING. An operator who routes "our support
    // number" means every conversation on that line. If the key put the customer
    // second, `extractPlatformChannelId` would return a phone number and an
    // operator could only ever write rules naming individual people.
    const delivery = await verify(TEXT_MESSAGE_BODY);
    const key = delivery.message?.channelThreadKey ?? "";
    expect(key).toBe(`whatsapp:${PHONE_NUMBER_ID}:${CUSTOMER_WA_ID}`);
    expect(extractPlatformChannelId(key)).toBe(PHONE_NUMBER_ID);
    expect(delivery.message?.platformChannelId).toBe(PHONE_NUMBER_ID);
  });

  it("gives two messages from one customer the SAME key and different event ids", async () => {
    const first = await verify(TEXT_MESSAGE_BODY);
    const second = await verify(SECOND_TEXT_MESSAGE_BODY);
    expect(second.message?.channelThreadKey).toBe(first.message?.channelThreadKey);
    expect(second.providerEventId).not.toBe(first.providerEventId);
  });

  it("keeps two customers on ONE line as two conversations in one channel", async () => {
    const mine = await verify(TEXT_MESSAGE_BODY);
    const theirs = await verify(OTHER_CUSTOMER_BODY);
    expect(theirs.message?.channelThreadKey).toBe(`whatsapp:${PHONE_NUMBER_ID}:${OTHER_CUSTOMER_WA_ID}`);
    expect(theirs.message?.channelThreadKey).not.toBe(mine.message?.channelThreadKey);
    // ...and a `channel` rule naming the line matches BOTH.
    expect(extractPlatformChannelId(theirs.message?.channelThreadKey ?? "")).toBe(
      extractPlatformChannelId(mine.message?.channelThreadKey ?? ""),
    );
  });

  it("keeps one customer on TWO lines as two conversations in two channels", async () => {
    const here = await verify(TEXT_MESSAGE_BODY);
    const there = await verify(OTHER_LINE_BODY);
    expect(there.message?.channelThreadKey).toBe(`whatsapp:${OTHER_PHONE_NUMBER_ID}:${CUSTOMER_WA_ID}`);
    expect(extractPlatformChannelId(there.message?.channelThreadKey ?? "")).not.toBe(
      extractPlatformChannelId(here.message?.channelThreadKey ?? ""),
    );
  });
});

describe("verified deliveries with no behaviour are acknowledged, not admitted", () => {
  it.each([
    ["a delivery status for a message the business sent", STATUS_BODY],
    ["an image", IMAGE_MESSAGE_BODY],
    ["an interactive button reply", INTERACTIVE_MESSAGE_BODY],
    ["a Page delivery on the same endpoint", OTHER_OBJECT_BODY],
    ["a template-status change", OTHER_FIELD_BODY],
    ["a message claiming to come from the business's own line", SELF_MESSAGE_BODY],
  ])("%s is IGNORABLE with no event id", async (_name, body) => {
    const delivery = await verify(body);
    expect(delivery.kind).toBe("ignorable");
    expect(delivery.providerEventId).toBeNull();
    expect(delivery.message).toBeNull();
  });

  it("treats an empty envelope and an unknown message type as ignorable", async () => {
    const empty = await verify(JSON.stringify({ object: "whatsapp_business_account", entry: [] }));
    expect(empty.kind).toBe("ignorable");
    const noChanges = await verify(
      JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [] }] }),
    );
    expect(noChanges.kind).toBe("ignorable");
  });
});

describe("a batched delivery is REFUSED, because VerifiedDelivery holds one message", () => {
  it.each([
    ["two messages under one change", BATCHED_MESSAGES_BODY],
    ["two entries", BATCHED_ENTRIES_BODY],
    ["two changes under one entry", BATCHED_CHANGES_BODY],
  ])("%s is CHANNELS_EVENT_PAYLOAD_INVALID and names the batch", async (_name, body) => {
    // WHEN THIS FAILS, `channels` has grown a multi-message delivery shape.
    // Normalizing the first and dropping the rest would lose a customer's message
    // with no error anywhere, which is the one outcome worse than refusing: Meta
    // redelivers a non-2xx, so nothing is lost by saying no.
    const outcome = await adapter.verifyInbound(secret, signWhatsAppDelivery(body));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("CHANNELS_EVENT_PAYLOAD_INVALID");
    expect(outcome.error.category).toBe("invalid_input");
    expect(outcome.error.message).toContain("batches more than one");
  });
});

describe("a verified message that cannot be admitted is REFUSED as an input defect", () => {
  it.each([
    ["no message id", NO_ID_BODY],
    ["no business phone number id", NO_PHONE_NUMBER_ID_BODY],
    ["no sender", NO_FROM_BODY],
    // A key segment ends up in a Graph path on the outbound side.
    // `../me/accounts` must never become a conversation address in the first place.
    ["a phone number id that is not a Meta id", HOSTILE_PHONE_NUMBER_ID_BODY],
    ["a body that is not JSON", "{not json"],
    ["JSON that is not an envelope", "[1,2,3]"],
  ])("%s is CHANNELS_EVENT_PAYLOAD_INVALID, never a signature code", async (_name, body) => {
    const outcome = await adapter.verifyInbound(secret, signWhatsAppDelivery(body));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.error.code).toBe("CHANNELS_EVENT_PAYLOAD_INVALID");
    expect(outcome.ok ? null : outcome.error.category).toBe("invalid_input");
  });
});

describe("no Meta field crosses the port", () => {
  it("returns only the fields the port declares", async () => {
    const delivery = await verify(TEXT_MESSAGE_BODY);
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
    // The contact's PROFILE NAME is personal data Meta sends on every inbound
    // message and the port has no slot for. It stays inside the verified body,
    // which the inbox seals; it is not lifted into any field.
    expect(JSON.stringify(delivery.message)).not.toContain("River Watcher");
  });
});
