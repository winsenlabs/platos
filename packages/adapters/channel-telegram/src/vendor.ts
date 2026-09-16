// THE ONE FILE IN THIS DIRECTORY THAT NAMES TELEGRAM'S WIRE VOCABULARY.
//
// The funnel is `channel-slack/src/vendor.ts`'s, with the content
// `channel-discord/src/vendor.ts` and `channel-whatsapp/src/vendor.ts` have:
// THIS DIRECTORY HOLDS NO SDK. Telegram's inbound check is a string comparison
// `node:crypto` makes constant-time, and its outbound half is four
// JSON-over-HTTPS methods. A client library for that would be a dependency, an
// SBOM row and an advisory stream bought to save a `fetch`.
//
// So the funnel is kept for the same reason with different content: every header
// name, method name, field name and number Telegram defines is spelled HERE,
// once, with where it is written down, and nothing else in this directory writes
// one.
//
// PROVENANCE. Transcribed from Telegram's published Bot API reference
// (core.telegram.org/bots/api) and its webhook guide (core.telegram.org/bots/webhooks):
//   Update                 — `update_id`, and which optional field each update
//                            kind arrives in
//   Message                — `message_id`, `from`, `chat`, `date`, `text`,
//                            `message_thread_id`, `is_topic_message`
//   Chat                   — the four `type` values, and that an id may carry up
//                            to 52 significant bits and may be negative
//   User                   — `is_bot`, `first_name`, `last_name`, `username`
//   setWebhook             — `secret_token`, and the header it is echoed in
//   sendMessage /
//   editMessageText /
//   getMe / getChat        — the four methods this adapter calls
//   Making requests        — the `{ ok, result }` / `{ ok, error_code,
//                            description, parameters }` envelope and
//                            `ResponseParameters.retry_after`
//
// AND THE INBOUND HALF IS NOT JOINED TO ANY OF IT, WHICH `adapter.ts` SAYS AT
// LENGTH. There is no vendor library to ask and no published vector to
// transcribe, because the secret is one the integrator itself chose. What IS
// joined is here: the update SHAPES below and the fixtures built from them, and
// the request/response contract a recording server reads back.

/**
 * The Bot API base. The trailing slash is load-bearing for the reason
 * `channel-slack/src/send.ts` gives: a route is resolved with
 * `new URL(route, base)`, and a base with no trailing slash drops its last path
 * segment — here, the whole `bot<token>` prefix.
 */
export const TELEGRAM_API_URL = "https://api.telegram.org/";

/**
 * The header Telegram echoes the integrator's own `secret_token` in.
 *
 * `setWebhook`: "A secret token to be sent in a header
 * `X-Telegram-Bot-Api-Secret-Token` in every webhook request, 1-256 characters.
 * Only characters A-Z, a-z, 0-9, _ and - are allowed." Lower-cased; see the port.
 */
export const TELEGRAM_SECRET_TOKEN_HEADER = "x-telegram-bot-api-secret-token";

/**
 * The grammar `setWebhook` documents for the secret token, checked on the
 * CONFIGURED value rather than only on the presented one.
 *
 * A configured token outside this grammar is one `setWebhook` would have
 * REFUSED, so no genuine delivery could ever carry it: every request would be
 * refused as a forgery and the endpoint would look broken rather than
 * misconfigured. It is checked here so the refusal says which.
 */
export const TELEGRAM_SECRET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,256}$/u;

/** `bot<token>` — the path prefix every method call is made under. */
export const TELEGRAM_BOT_PATH_PREFIX = "bot";

/**
 * The bot token's documented shape: the bot's numeric id, a colon, then the
 * authorization half.
 *
 * IT IS VALIDATED BECAUSE IT BECOMES A PATH. `bot<token>/sendMessage` puts the
 * token in the URL; a token carrying `/` or `..` would address a different
 * method, or a different host's path, on this process's own egress. A credential
 * read from a store is still input.
 */
export const TELEGRAM_BOT_TOKEN_PATTERN = /^\d{1,20}:[A-Za-z0-9_-]{1,200}$/u;

/** The four methods this adapter calls. */
export const TELEGRAM_METHOD = Object.freeze({
  sendMessage: "sendMessage",
  editMessageText: "editMessageText",
  getMe: "getMe",
  getChat: "getChat",
} as const);

/**
 * The `Update` fields this adapter looks at.
 *
 * `message` is the only one it acts on. The rest are named so the ignorable arm
 * can be read against the documentation rather than guessed: an update carrying
 * any of them is real, verified, and has no behaviour in this build.
 */
export const TELEGRAM_UPDATE_FIELD = Object.freeze({
  message: "message",
  editedMessage: "edited_message",
  channelPost: "channel_post",
  editedChannelPost: "edited_channel_post",
  callbackQuery: "callback_query",
  myChatMember: "my_chat_member",
  chatMember: "chat_member",
} as const);

/** `Chat.type`. A topic lives only in a supergroup. */
export const TELEGRAM_CHAT_TYPE = Object.freeze({
  private: "private",
  group: "group",
  supergroup: "supergroup",
  channel: "channel",
} as const);

/**
 * The longest `text` `sendMessage` accepts: 4096 characters (Bot API,
 * `sendMessage` — "Text of the message to be sent, 1-4096 characters after
 * entities parsing").
 *
 * Enforced here rather than discovered as a 400, because a turn whose answer is
 * long is a NORMAL outcome and losing it to a vendor refusal is not.
 */
export const TELEGRAM_MAX_TEXT_LENGTH = 4096;

/**
 * NO PARSE MODE, ON EVERY MESSAGE THIS ADAPTER WRITES.
 *
 * THE ASSISTANT'S TEXT IS PARTLY THE USER'S TEXT. With `parse_mode` set,
 * Telegram interprets `*`, `_`, `[` and `<` in the body — so a stray bracket in a
 * quoted customer message makes the whole send fail with "can't parse entities",
 * and a crafted one renders a link the assistant did not write. Omitting
 * `parse_mode` sends the text as typed, which is the only setting under which
 * the outbound body is inert.
 */
export const TELEGRAM_PARSE_MODE: null = null;

/**
 * `ResponseParameters.retry_after` is where Telegram puts the wait on a 429 —
 * inside the BODY, not in a header. A client reading only `Retry-After` finds
 * nothing and hammers the API.
 */
export const TELEGRAM_RETRY_AFTER_FIELD = "retry_after";

/** Telegram's own default wait when a 429 named none. This adapter's number. */
export const DEFAULT_RETRY_AFTER_SECONDS = 1;
