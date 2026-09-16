// A VERIFIED UPDATE BECOMES THIS CONTEXT'S SHAPE — and a thread key the DOMAIN
// can read back.
//
// THIS SUITE CARRIES MORE OF THIS DIRECTORY'S EVIDENCE THAN THE INBOUND ONE DOES,
// and `adapter.ts` says why: the secret-token check cannot be joined to anything
// outside this repository, so what CAN be checked by a reader is whether these
// fixtures are the shapes core.telegram.org/bots/api documents and whether the
// rules below read them correctly. `fixtures.ts` records the provenance of every
// field.
//
// THE CONVERSATION CASES ARE ASSERTED THROUGH THE DOMAIN'S OWN READER.
// `extractPlatformChannelId` is published from the context's port entry point
// precisely so an adapter's suite can prove its keys against the function a
// `channel` routing rule actually runs, rather than against a copy of the format.

import { extractPlatformChannelId } from "@platos/context-channels/application/ports/index.js";
import { describe, expect, it } from "vitest";

import { createChannelTelegramAdapter } from "./adapter.js";
import {
  ALL_FIXTURE_BODIES,
  BOT_MESSAGE_BODY,
  CALLBACK_QUERY_BODY,
  CHANNEL_POST_BODY,
  EDITED_MESSAGE_BODY,
  FIXTURE_INSTANT,
  FIXTURE_SECRET_TOKEN,
  MY_CHAT_MEMBER_BODY,
  NO_CHAT_ID_BODY,
  NO_UPDATE_ID_BODY,
  OTHER_TOPIC_MESSAGE_BODY,
  OTHER_TOPIC_THREAD_ID,
  PHOTO_MESSAGE_BODY,
  PRIVATE_CHAT_ID,
  PRIVATE_MESSAGE_BODY,
  REPLY_IN_THREAD_BODY,
  SECOND_PRIVATE_MESSAGE_BODY,
  SECOND_TOPIC_MESSAGE_BODY,
  SERVICE_MESSAGE_BODY,
  SUPERGROUP_CHAT_ID,
  SUPERGROUP_MESSAGE_BODY,
  telegramDelivery,
  TOPIC_MESSAGE_BODY,
  TOPIC_THREAD_ID,
  UNSAFE_CHAT_ID_BODY,
} from "./fixtures.js";

const adapter = createChannelTelegramAdapter();
const secret = { secret: FIXTURE_SECRET_TOKEN };

async function verify(body: string) {
  const outcome = await adapter.verifyInbound(secret, telegramDelivery(body));
  if (!outcome.ok) throw new Error(`expected acceptance, got ${outcome.error.code}`);
  return outcome.value;
}

describe("every fixture is a shape the Bot API documents", () => {
  it("carries an update_id and exactly one update field, or is a deliberate defect", () => {
    // One case walking every fixture rather than a generated table: the test-case
    // census counts rows statically, and the fixture list is a module value.
    expect(ALL_FIXTURE_BODIES.length).toBeGreaterThanOrEqual(17);
    const optional = [
      "message",
      "edited_message",
      "channel_post",
      "edited_channel_post",
      "callback_query",
      "my_chat_member",
      "chat_member",
    ];
    for (const [name, body] of ALL_FIXTURE_BODIES) {
      const update = JSON.parse(body) as Record<string, unknown>;
      const present = optional.filter((field) => update[field] !== undefined);
      expect(present.length, name).toBe(1);
      // `no_update_id` is the ONE fixture that deliberately lacks it.
      expect(typeof update["update_id"] === "number" || name === "no_update_id", name).toBe(true);
    }
  });

  it("keeps chat ids as JSON NUMBERS, negative and beyond 32 bits where Telegram's are", () => {
    // A fixture that quoted the id would let a normalizer pass while doing the
    // wrong thing with the real wire format.
    const topic = JSON.parse(TOPIC_MESSAGE_BODY) as { message: { chat: { id: unknown } } };
    expect(typeof topic.message.chat.id).toBe("number");
    expect(topic.message.chat.id).toBe(SUPERGROUP_CHAT_ID);
    expect(SUPERGROUP_CHAT_ID).toBeLessThan(-(2 ** 31));
  });
});

describe("a text message becomes an InboundMessage", () => {
  it("carries the UPDATE id as the admission key and the text as the text", async () => {
    const delivery = await verify(PRIVATE_MESSAGE_BODY);
    expect(delivery.kind).toBe("message");
    // THE UPDATE ID AND NOT THE MESSAGE ID. Telegram repeats an `update_id` until
    // the endpoint answers 2xx, so it is exactly the key that collapses a
    // redelivery onto one row.
    expect(delivery.providerEventId).toBe("870123001");
    expect(delivery.message?.text).toBe("is it everything a river should be?");
    expect(delivery.message?.endUserId).toBeNull();
    expect(delivery.message?.receivedAt).toEqual(FIXTURE_INSTANT);
    expect(delivery.verifiedBody).toBe(PRIVATE_MESSAGE_BODY);
    // There is no handshake in the Bot API at all — see `normalize.ts`.
    expect(delivery.handshakeEcho).toBeNull();
  });

  it("keys a private chat on the chat, and the domain reads the chat back", async () => {
    const key = (await verify(PRIVATE_MESSAGE_BODY)).message?.channelThreadKey ?? "";
    expect(key).toBe(`telegram:${PRIVATE_CHAT_ID}`);
    expect(extractPlatformChannelId(key)).toBe(String(PRIVATE_CHAT_ID));
  });

  it("keys a supergroup on its NEGATIVE id without losing the sign", async () => {
    const key = (await verify(SUPERGROUP_MESSAGE_BODY)).message?.channelThreadKey ?? "";
    expect(key).toBe(`telegram:${SUPERGROUP_CHAT_ID}`);
    expect(extractPlatformChannelId(key)).toBe(String(SUPERGROUP_CHAT_ID));
  });

  it("keys a forum TOPIC under its supergroup, so a channel rule for the group still matches", async () => {
    // THE JOIN THAT MATTERS FOR ROUTING. An operator who routes a support group to
    // an agent means the group and its topics. The domain's reader must recover
    // the GROUP from a topic's key; keying the topic on itself would make the rule
    // silently stop firing inside every topic.
    const delivery = await verify(TOPIC_MESSAGE_BODY);
    const key = delivery.message?.channelThreadKey ?? "";
    expect(key).toBe(`telegram:${SUPERGROUP_CHAT_ID}:${TOPIC_THREAD_ID}`);
    expect(extractPlatformChannelId(key)).toBe(String(SUPERGROUP_CHAT_ID));
    expect(delivery.message?.platformChannelId).toBe(String(SUPERGROUP_CHAT_ID));
  });

  it("gives two messages in one topic the SAME key and different event ids", async () => {
    const first = await verify(TOPIC_MESSAGE_BODY);
    const second = await verify(SECOND_TOPIC_MESSAGE_BODY);
    expect(second.message?.channelThreadKey).toBe(first.message?.channelThreadKey);
    expect(second.providerEventId).not.toBe(first.providerEventId);
  });

  it("keeps two topics, and the group itself, as THREE conversations", async () => {
    const group = await verify(SUPERGROUP_MESSAGE_BODY);
    const topic = await verify(TOPIC_MESSAGE_BODY);
    const other = await verify(OTHER_TOPIC_MESSAGE_BODY);
    expect(other.message?.channelThreadKey).toBe(`telegram:${SUPERGROUP_CHAT_ID}:${OTHER_TOPIC_THREAD_ID}`);
    const keys = [group, topic, other].map((delivery) => delivery.message?.channelThreadKey);
    expect(new Set(keys).size).toBe(3);
  });

  it("does NOT treat a reply's message_thread_id as a topic", async () => {
    // THE RULE `normalize.ts` SPELLS OUT. Telegram sets `message_thread_id` on a
    // reply chain as well as on a topic, and only `is_topic_message: true` says
    // which. Keying on the field's presence would split one ordinary group
    // conversation into a new Platos thread, with no history, per reply chain —
    // and a `channel` rule would still match, so the damage would be silent.
    const reply = await verify(REPLY_IN_THREAD_BODY);
    expect(reply.message?.channelThreadKey).toBe(`telegram:${SUPERGROUP_CHAT_ID}`);
    const group = await verify(SUPERGROUP_MESSAGE_BODY);
    expect(reply.message?.channelThreadKey).toBe(group.message?.channelThreadKey);
  });

  it("gives two messages in one private chat the same key and consecutive update ids", async () => {
    const first = await verify(PRIVATE_MESSAGE_BODY);
    const second = await verify(SECOND_PRIVATE_MESSAGE_BODY);
    expect(second.message?.channelThreadKey).toBe(first.message?.channelThreadKey);
    expect(second.providerEventId).toBe("870123002");
    // ...and a private chat is NOT the supergroup, however similar the shapes.
    const group = await verify(SUPERGROUP_MESSAGE_BODY);
    expect(group.message?.channelThreadKey).not.toBe(first.message?.channelThreadKey);
  });
});

describe("verified updates with no behaviour are acknowledged, not admitted", () => {
  it.each([
    ["a message from another bot", BOT_MESSAGE_BODY],
    ["an edited message", EDITED_MESSAGE_BODY],
    ["a channel post", CHANNEL_POST_BODY],
    ["an inline button press", CALLBACK_QUERY_BODY],
    ["the bot being added to a group", MY_CHAT_MEMBER_BODY],
    ["a photo with no caption", PHOTO_MESSAGE_BODY],
    ["a service message", SERVICE_MESSAGE_BODY],
  ])("%s is IGNORABLE with no event id", async (_name, body) => {
    const delivery = await verify(body);
    expect(delivery.kind).toBe("ignorable");
    expect(delivery.providerEventId).toBeNull();
    expect(delivery.message).toBeNull();
  });

  it("treats an update field this build has never heard of as ignorable", async () => {
    const delivery = await verify(JSON.stringify({ update_id: 1, poll_answer: { poll_id: "1" } }));
    expect(delivery.kind).toBe("ignorable");
  });
});

describe("a verified update that cannot be admitted is REFUSED as an input defect", () => {
  it.each([
    ["no update_id", NO_UPDATE_ID_BODY],
    ["no chat id", NO_CHAT_ID_BODY],
    // Refused rather than rounded: `Number` would silently move the id and key
    // the conversation on a chat that is not the one that wrote.
    ["a chat id past the safe integer range", UNSAFE_CHAT_ID_BODY],
    ["a body that is not JSON", "{not json"],
    ["JSON that is not an update", "[1,2,3]"],
  ])("%s is CHANNELS_EVENT_PAYLOAD_INVALID, never a signature code", async (_name, body) => {
    const outcome = await adapter.verifyInbound(secret, telegramDelivery(body));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.error.code).toBe("CHANNELS_EVENT_PAYLOAD_INVALID");
    expect(outcome.ok ? null : outcome.error.category).toBe("invalid_input");
  });
});

describe("no Telegram field crosses the port", () => {
  it("returns only the fields the port declares", async () => {
    const delivery = await verify(TOPIC_MESSAGE_BODY);
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
    // The sender's NAME and HANDLE are personal data on every message and the
    // port has no slot for them. They stay inside the verified body, which the
    // inbox seals; they are not lifted into any field.
    expect(JSON.stringify(delivery.message)).not.toContain("riverwatcher");
    expect(JSON.stringify(delivery.message)).not.toContain("Watcher");
  });
});
