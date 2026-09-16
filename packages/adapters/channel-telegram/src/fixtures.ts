// PROVIDER FIXTURES: Telegram `Update` bodies, TRANSCRIBED FROM THE PUBLISHED BOT
// API REFERENCE — and a delivery builder for them.
//
// THESE FIXTURES ARE THE JOINED HALF OF THIS DIRECTORY'S INBOUND TESTING, and
// `adapter.ts` says at length why they have to carry that weight alone: the
// secret-token check cannot be joined to anything outside this repository,
// because the secret is one the integrator chose. What CAN be checked by a reader
// is whether these objects are the shapes core.telegram.org/bots/api documents,
// so every field below is one the reference lists and the provenance is per
// fixture rather than per file:
//
//   Update    `update_id`, and exactly one of `message`, `edited_message`,
//             `channel_post`, `callback_query`, `my_chat_member`
//   Message   `message_id`, `from`, `chat`, `date`, `text`, `message_thread_id`,
//             `is_topic_message`, `reply_to_message`, `photo`, `sticker`,
//             `new_chat_members`
//   Chat      `id`, `type` (private | group | supergroup | channel), `title`,
//             `username`, `is_forum`
//   User      `id`, `is_bot`, `first_name`, `last_name`, `username`,
//             `language_code`
//
// IDS ARE JSON NUMBERS AND NOT STRINGS, which is the reference's own shape and a
// real hazard: `chat.id` for a supergroup is negative and beyond 32 bits, so a
// fixture that quoted it would let a normalizer pass while doing the wrong thing
// with the real wire format.
//
// THE SECRET TOKEN BELOW AUTHENTICATES NOTHING. It is a fixture string this
// repository invented, in `setWebhook`'s documented alphabet; no bot has ever
// been registered with it.

import type { SignedDelivery } from "@platos/context-channels/application/ports/index.js";

import { TELEGRAM_SECRET_TOKEN_HEADER } from "./vendor.js";

/** The secret token every fixture delivery presents. A fixture, never a credential. */
export const FIXTURE_SECRET_TOKEN = "platos-fixture-secret-token-0123456789";

/** A second, equally inert token — the same length, so a refusal is about VALUE. */
export const OTHER_SECRET_TOKEN = "platos-fixture-secret-token-9876543210";

/** A bot token in the documented shape. It authorizes nothing anywhere. */
export const FIXTURE_BOT_TOKEN = "7654321:AAF-fixture-token-that-authorizes-nothing";

export const FIXTURE_INSTANT = new Date("2026-06-01T08:00:00.000Z");

/** A private chat with one person; a supergroup with forum topics on. */
export const PRIVATE_CHAT_ID = 194354349;
export const SUPERGROUP_CHAT_ID = -1002034567890;
export const TOPIC_THREAD_ID = 47;
export const OTHER_TOPIC_THREAD_ID = 63;
export const USER_ID = 194354349;

/** Present a raw update body as a delivery carrying the secret token. */
export function telegramDelivery(
  rawBody: string,
  options: { readonly secretToken?: string; readonly receivedAt?: Date } = {},
): SignedDelivery {
  return {
    rawBody,
    headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: options.secretToken ?? FIXTURE_SECRET_TOKEN },
    receivedAt: options.receivedAt ?? FIXTURE_INSTANT,
  };
}

const SENT_AT = Math.floor(FIXTURE_INSTANT.getTime() / 1000);

const user = {
  id: USER_ID,
  is_bot: false,
  first_name: "River",
  last_name: "Watcher",
  username: "riverwatcher",
  language_code: "en",
};

function update(updateId: number, fields: Record<string, unknown>): string {
  return JSON.stringify({ update_id: updateId, ...fields });
}

function message(fields: Record<string, unknown>): Record<string, unknown> {
  return { message_id: 100, from: user, date: SENT_AT, ...fields };
}

/** A private one-to-one message. */
export const PRIVATE_MESSAGE_BODY = update(870123001, {
  message: message({
    message_id: 101,
    chat: { id: PRIVATE_CHAT_ID, type: "private", first_name: "River", username: "riverwatcher" },
    text: "is it everything a river should be?",
  }),
});

/** A SECOND message in the same private chat. Same conversation, new update id. */
export const SECOND_PRIVATE_MESSAGE_BODY = update(870123002, {
  message: message({
    message_id: 102,
    chat: { id: PRIVATE_CHAT_ID, type: "private", first_name: "River", username: "riverwatcher" },
    text: "and the second half?",
  }),
});

/** A message in a supergroup with no topic. Keyed on the group. */
export const SUPERGROUP_MESSAGE_BODY = update(870123010, {
  message: message({
    message_id: 201,
    chat: { id: SUPERGROUP_CHAT_ID, type: "supergroup", title: "Support", is_forum: true },
    text: "in the main group",
  }),
});

/** A message inside a forum TOPIC of that supergroup. Keyed under the group. */
export const TOPIC_MESSAGE_BODY = update(870123011, {
  message: message({
    message_id: 202,
    chat: { id: SUPERGROUP_CHAT_ID, type: "supergroup", title: "Support", is_forum: true },
    message_thread_id: TOPIC_THREAD_ID,
    is_topic_message: true,
    text: "in a topic",
  }),
});

/** A later message in the SAME topic. Different update, same conversation. */
export const SECOND_TOPIC_MESSAGE_BODY = update(870123012, {
  message: message({
    message_id: 203,
    chat: { id: SUPERGROUP_CHAT_ID, type: "supergroup", title: "Support", is_forum: true },
    message_thread_id: TOPIC_THREAD_ID,
    is_topic_message: true,
    text: "still in that topic",
  }),
});

/** A message in a DIFFERENT topic of the same supergroup. */
export const OTHER_TOPIC_MESSAGE_BODY = update(870123013, {
  message: message({
    message_id: 204,
    chat: { id: SUPERGROUP_CHAT_ID, type: "supergroup", title: "Support", is_forum: true },
    message_thread_id: OTHER_TOPIC_THREAD_ID,
    is_topic_message: true,
    text: "a different topic",
  }),
});

/**
 * A REPLY in a group with topics OFF. It carries `message_thread_id` and NOT
 * `is_topic_message`, which is the pair that decides the rule in `normalize.ts`:
 * this is the main conversation, not a topic.
 */
export const REPLY_IN_THREAD_BODY = update(870123014, {
  message: message({
    message_id: 205,
    chat: { id: SUPERGROUP_CHAT_ID, type: "supergroup", title: "Support", is_forum: true },
    message_thread_id: 199,
    reply_to_message: { message_id: 199, chat: { id: SUPERGROUP_CHAT_ID, type: "supergroup" }, date: SENT_AT },
    text: "replying in the main group",
  }),
});

/** A message sent by another bot. The loop guard's case. */
export const BOT_MESSAGE_BODY = update(870123020, {
  message: message({
    message_id: 301,
    from: { ...user, is_bot: true },
    chat: { id: SUPERGROUP_CHAT_ID, type: "supergroup", title: "Support" },
    text: "loop?",
  }),
});

/** An edited message. Verified, real, no behaviour in this build. */
export const EDITED_MESSAGE_BODY = update(870123021, {
  edited_message: message({
    message_id: 101,
    chat: { id: PRIVATE_CHAT_ID, type: "private", first_name: "River" },
    edit_date: SENT_AT + 5,
    text: "is it everything a river should be, really?",
  }),
});

/** A post in a broadcast channel. Also no behaviour here. */
export const CHANNEL_POST_BODY = update(870123022, {
  channel_post: {
    message_id: 401,
    chat: { id: -1002034567891, type: "channel", title: "Announcements" },
    date: SENT_AT,
    text: "an announcement",
  },
});

/** An inline button press. */
export const CALLBACK_QUERY_BODY = update(870123023, {
  callback_query: {
    id: "4382bfdwdsb323b2d9",
    from: user,
    chat_instance: "1",
    data: "retry",
  },
});

/** The bot being added to a group. */
export const MY_CHAT_MEMBER_BODY = update(870123024, {
  my_chat_member: {
    chat: { id: SUPERGROUP_CHAT_ID, type: "supergroup", title: "Support" },
    from: user,
    date: SENT_AT,
    old_chat_member: { status: "left", user: { id: 7654321, is_bot: true, first_name: "Platos" } },
    new_chat_member: { status: "member", user: { id: 7654321, is_bot: true, first_name: "Platos" } },
  },
});

/** A photo with no caption. A normal thing to send, and not a turn. */
export const PHOTO_MESSAGE_BODY = update(870123025, {
  message: message({
    message_id: 501,
    chat: { id: PRIVATE_CHAT_ID, type: "private", first_name: "River" },
    photo: [{ file_id: "AgACAgQAA", file_unique_id: "AQADB", width: 90, height: 51, file_size: 1101 }],
  }),
});

/** A service message: somebody joined. */
export const SERVICE_MESSAGE_BODY = update(870123026, {
  message: message({
    message_id: 502,
    chat: { id: SUPERGROUP_CHAT_ID, type: "supergroup", title: "Support" },
    new_chat_members: [{ id: 5, is_bot: false, first_name: "New" }],
  }),
});

/** An update with no `update_id`. Cannot be deduplicated. */
export const NO_UPDATE_ID_BODY = JSON.stringify({
  message: message({
    message_id: 601,
    chat: { id: PRIVATE_CHAT_ID, type: "private", first_name: "River" },
    text: "anyone?",
  }),
});

/** A text message whose chat has no id. Nowhere to answer. */
export const NO_CHAT_ID_BODY = update(870123030, {
  message: message({ message_id: 602, chat: { type: "private", first_name: "River" }, text: "where?" }),
});

/** A chat id that is not a safe integer. Refused rather than rounded. */
export const UNSAFE_CHAT_ID_BODY = update(870123031, {
  message: message({
    message_id: 603,
    chat: { id: 9007199254740993, type: "supergroup", title: "Too big" },
    text: "too big",
  }),
});

/** Every fixture, for the suites that walk all of them. */
export const ALL_FIXTURE_BODIES: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["private_message", PRIVATE_MESSAGE_BODY],
  ["second_private_message", SECOND_PRIVATE_MESSAGE_BODY],
  ["supergroup_message", SUPERGROUP_MESSAGE_BODY],
  ["topic_message", TOPIC_MESSAGE_BODY],
  ["second_topic_message", SECOND_TOPIC_MESSAGE_BODY],
  ["other_topic_message", OTHER_TOPIC_MESSAGE_BODY],
  ["reply_in_thread", REPLY_IN_THREAD_BODY],
  ["bot_message", BOT_MESSAGE_BODY],
  ["edited_message", EDITED_MESSAGE_BODY],
  ["channel_post", CHANNEL_POST_BODY],
  ["callback_query", CALLBACK_QUERY_BODY],
  ["my_chat_member", MY_CHAT_MEMBER_BODY],
  ["photo_message", PHOTO_MESSAGE_BODY],
  ["service_message", SERVICE_MESSAGE_BODY],
  ["no_update_id", NO_UPDATE_ID_BODY],
  ["no_chat_id", NO_CHAT_ID_BODY],
  ["unsafe_chat_id", UNSAFE_CHAT_ID_BODY],
]);
