// A verified Telegram update becomes a `VerifiedDelivery` — this context's shape,
// holding not one Telegram field it did not ask for.
//
// WHAT ARRIVES HERE AT ALL. One `Update` object per webhook POST, carrying
// `update_id` and EXACTLY ONE of the optional fields the Bot API lists —
// `message`, `edited_message`, `channel_post`, `callback_query`,
// `my_chat_member` and the rest. This build answers a text `message`; everything
// else is verified, real, and has no behaviour here.
//
// THERE IS NO HANDSHAKE, AND THAT IS A DIFFERENCE WORTH STATING. Slack echoes a
// `challenge`, Discord answers a PING with `{"type":1}`, Meta answers a GET with
// `hub.challenge`. Telegram has none: the integrator calls `setWebhook` and
// Telegram simply begins delivering. So `kind` is never `"handshake"` here and
// `handshakeEcho` is always null — `normalize.test.ts` pins that, because a
// future reader looking for the handshake arm should find an assertion rather
// than an absence.
//
// TWO OUTCOMES, AND THE RULES LIVE IN THE ONE THAT IS NOT "MESSAGE".
//
// A BOT IS IGNORED BEFORE ANYTHING ELSE IS READ, the same guard `channel-slack`
// and `channel-discord` state for their own self-originated deliveries, and here
// it is not theoretical: two Platos bots in one Telegram group, or a bot replying
// in a topic this bot watches, is an unbounded loop that costs a model call per
// turn. `User.is_bot` is a documented field and is checked first.
//
// A FORUM TOPIC IS RECOGNISED BY `is_topic_message`, NOT BY THE PRESENCE OF
// `message_thread_id`. The Bot API sets `message_thread_id` on a message in a
// forum topic AND on a reply inside a thread of a group with topics disabled, and
// only `is_topic_message: true` says "this is a topic". Keying on the field's
// presence alone would split one ordinary group conversation into a thread per
// reply chain, and a `channel` rule naming the group would still match — so the
// damage would be silent: a new Platos thread, with no history, per reply.
//
// AN UPDATE WITH NO `update_id`, NO CHAT OR NO TEXT IS REFUSED, NOT IGNORED. The
// update id is the admission idempotency key, the chat is the conversation, and a
// `message` with no `text` is a photo, a sticker or a service message — which is
// IGNORABLE rather than refused, because it is a normal thing for a person to
// send and not a malformed delivery.

import {
  admitChannelThreadKey,
  err,
  eventPayloadInvalid,
  ok,
  type ProviderEventId,
  type Result,
  type VerifiedDelivery,
} from "@platos/context-channels/application/ports/index.js";

import {
  isChatId,
  isThreadId,
  TELEGRAM_PROVIDER,
  telegramThreadKey,
  type TelegramAddress,
} from "./provider.js";
import { TELEGRAM_UPDATE_FIELD } from "./vendor.js";

type Json = Readonly<Record<string, unknown>>;

function record(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

/** Telegram ids arrive as JSON NUMBERS; keys and bodies want them as strings. */
function idOf(value: unknown): string | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : null;
}

function ignorable(verifiedBody: string): VerifiedDelivery {
  return Object.freeze({
    provider: TELEGRAM_PROVIDER,
    kind: "ignorable" as const,
    providerEventId: null,
    handshakeEcho: null,
    message: null,
    verifiedBody,
  });
}

/**
 * Where the message was sent, as a conversation address.
 *
 * A topic is keyed UNDER its chat; any other message — a private chat, a group, a
 * supergroup with topics off — is keyed on the chat alone. See the header for
 * why `is_topic_message` and not `message_thread_id` is the discriminator.
 */
export function addressOf(message: Json): TelegramAddress | null {
  const chatId = idOf(record(message["chat"])?.["id"]);
  if (chatId === null || !isChatId(chatId)) return null;
  const threadId = idOf(message["message_thread_id"]);
  if (message["is_topic_message"] === true && threadId !== null && isThreadId(threadId)) {
    return { chatId, threadId };
  }
  return { chatId, threadId: null };
}

export function normalizeTelegramUpdate(verifiedBody: string, receivedAt: Date): Result<VerifiedDelivery> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(verifiedBody);
  } catch {
    // It carried the token, so Telegram sent it: an input defect, never a
    // signature one.
    return err(eventPayloadInvalid("verified Telegram body did not parse"));
  }
  const update = record(parsed);
  if (update === null) return err(eventPayloadInvalid("verified Telegram body is not an update"));

  // THE UPDATE ID IS READ BEFORE THE KIND, because every update has one and it is
  // the only thing that makes a redelivery recognisable. An update without it is
  // not something to ignore quietly: it is a payload this process cannot
  // deduplicate, whatever it turns out to contain.
  const updateId = idOf(update["update_id"]);
  if (updateId === null) {
    return err(eventPayloadInvalid("verified Telegram update carries no update_id to deduplicate on"));
  }

  const message = record(update[TELEGRAM_UPDATE_FIELD.message]);
  if (message === null) return ok(ignorable(verifiedBody));

  if (record(message["from"])?.["is_bot"] === true) return ok(ignorable(verifiedBody));

  const text = message["text"];
  // A photo, a sticker, a pinned-message service event. Real, and not a turn.
  if (typeof text !== "string" || text === "") return ok(ignorable(verifiedBody));

  const address = addressOf(message);
  if (address === null) {
    return err(eventPayloadInvalid("verified Telegram message carries no chat to answer in"));
  }
  const key = admitChannelThreadKey(telegramThreadKey(address));
  if (!key.ok) return err(key.error);

  return ok(
    Object.freeze({
      provider: TELEGRAM_PROVIDER,
      kind: "message" as const,
      // TELEGRAM'S OWN IDENTITY FOR THE DELIVERY, and not the message id. An
      // `update_id` is what Telegram repeats until this endpoint answers 2xx, so
      // it is exactly the key that collapses a redelivery onto one row.
      providerEventId: updateId as ProviderEventId,
      handshakeEcho: null,
      message: Object.freeze({
        channelThreadKey: key.value,
        platformChannelId: address.chatId,
        text,
        // `identity-access` owns the link from a Telegram user to an end user,
        // and this adapter must not guess at it.
        endUserId: null,
        receivedAt,
      }),
      verifiedBody,
    }),
  );
}
