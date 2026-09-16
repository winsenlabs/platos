// The provider name this directory speaks for, the shape of a thread key, and
// the two identifier grammars this adapter writes.
//
// THE KEY FORMAT IS THE DOMAIN'S. `domain/inbound.ts` fixes it —
// "`<kind>:<channel>[:<thread>]`" — and `extractPlatformChannelId` reads the
// SECOND segment back out to match `channel` routing rules. So a Telegram key is
//
//     telegram:<chat id>                     a private chat, group, supergroup
//                                            or channel
//     telegram:<chat id>:<message thread id> a forum TOPIC inside a supergroup
//
// and a `channel` rule naming a supergroup matches the group AND every topic in
// it, which is what an operator who routed "#support" means. That is the same
// parent-and-thread shape `channel-discord` renders, and it is chosen for the
// same reason.
//
// A CHAT ID MAY BE NEGATIVE, AND THAT IS NOT A TYPO. Telegram gives private chats
// positive ids, basic groups negative ids, and supergroups and channels ids
// beginning `-100` (Bot API, "Chat" — the id "may have more than 32 significant
// bits ... up to 52 significant bits"). A grammar that admitted digits only would
// refuse every group this bot is in. A `:` never appears in one, so the key still
// splits cleanly.
//
// AND THE NUMBERS NEVER BECOME A PATH — the one place this adapter differs from
// `channel-discord`, and it shifts where the danger is. Telegram takes `chat_id`
// and `message_thread_id` in the JSON BODY, so a hostile id cannot traverse a
// URL. What DOES go in the path is the BOT TOKEN — `bot<token>/sendMessage` — so
// the token has a grammar of its own (`send.ts`), and it is checked on every call
// rather than trusted because it came from a store.

/** Matches `CONNECTION_PROVIDERS[1]` in the context's `domain/provider.ts`. */
export const TELEGRAM_PROVIDER = "telegram";

/** Up to 52 significant bits, signed. Sixteen decimal digits covers 2^52. */
const CHAT_ID = /^-?\d{1,19}$/u;

/** A message thread id is a message id: positive. */
const THREAD_ID = /^\d{1,19}$/u;

export function isChatId(value: unknown): value is string {
  return typeof value === "string" && CHAT_ID.test(value) && value !== "-" && value !== "-0";
}

export function isThreadId(value: unknown): value is string {
  return typeof value === "string" && THREAD_ID.test(value);
}

export interface TelegramAddress {
  readonly chatId: string;
  /** The forum topic's own thread id, or null for the chat itself. */
  readonly threadId: string | null;
}

/** Render an address as a `ChannelThreadKey`. See the header for the shape. */
export function telegramThreadKey(address: TelegramAddress): string {
  return address.threadId === null
    ? `${TELEGRAM_PROVIDER}:${address.chatId}`
    : `${TELEGRAM_PROVIDER}:${address.chatId}:${address.threadId}`;
}

/**
 * The address a key this adapter rendered names, or null.
 *
 * Null for another provider's key, a key with the wrong number of segments, and
 * any segment that is not an id — which is how an outbound message carrying
 * somebody else's key, or a hostile one, is refused before a socket is opened.
 */
export function parseTelegramThreadKey(key: string): TelegramAddress | null {
  const parts = key.split(":");
  if (parts[0] !== TELEGRAM_PROVIDER) return null;
  if (parts.length === 2 && isChatId(parts[1])) return { chatId: parts[1], threadId: null };
  if (parts.length === 3 && isChatId(parts[1]) && isThreadId(parts[2])) {
    return { chatId: parts[1], threadId: parts[2] };
  }
  return null;
}

/**
 * The `chat_id` a message for this address is SENT to.
 *
 * A Telegram forum topic is NOT a chat of its own — unlike a Discord thread,
 * which is a channel. A reply inside a topic is sent to the SUPERGROUP with
 * `message_thread_id` naming the topic, so the chat is always the parent and the
 * topic travels beside it. Sending to the topic id would be sending to a chat
 * that does not exist.
 */
export function deliveryChatId(address: TelegramAddress): string {
  return address.chatId;
}
