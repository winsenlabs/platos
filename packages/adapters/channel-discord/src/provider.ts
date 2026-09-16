// The provider name this directory speaks for, the shape of a thread key, and
// the one identifier grammar every path segment this adapter writes must pass.
//
// THE KEY FORMAT IS THE DOMAIN'S. `domain/inbound.ts` fixes it —
// "`<kind>:<channel>[:<thread>]`" — and `extractPlatformChannelId` reads the
// SECOND segment back out to match `channel` routing rules. So a Discord key is
//
//     discord:<channel id>                a top-level channel or a DM
//     discord:<parent channel id>:<thread id>   a thread under that channel
//
// and a `channel` rule naming a text channel matches the channel AND every
// thread under it, which is what an operator who routed "#support" means.
//
// THIS IS NOT THE LEGACY KEY, AND THE DIFFERENCE IS RECORDED RATHER THAN HIDDEN.
// `apps/agent` keys Discord conversations with the chat SDK's
// `encodeThreadId`, which is `discord:<guild id>:<channel id>[:<thread id>]`
// (`@chat-adapter/discord@4.34.0`, `dist/index.js` `encodeThreadId`). Under
// that shape the second segment is the GUILD, so a legacy `channel` routing rule
// for Discord matches a whole server rather than a channel — the comment above
// `extractPlatformChannelId` in `channel-runtime.service.ts` says
// "discord:987654321:111.222 → 987654321" and calls it a channel id. A thread
// link written by the legacy monolith therefore does NOT collide with one written
// through this adapter, and a cutover must re-key those rows or accept a new
// Platos thread per existing Discord conversation. That is a migration decision,
// and `adapter.ts` names it among what this directory does not do.
//
// SNOWFLAKES ONLY, AND THE REASON IS A PATH. Every id in a key ends up as a
// segment of a REST route — `channels/<id>/messages`. A key whose channel half
// were `..%2Fusers%2F@me` would be a request to a different endpoint on the
// bot's authority. Discord ids are unsigned 64-bit integers rendered as decimal
// strings (`developers/reference.mdx` § Snowflakes), so anything that is not
// one to twenty digits is refused before it can become a URL.

/** Matches `CONNECTION_PROVIDERS[3]` in the context's `domain/provider.ts`. */
export const DISCORD_PROVIDER = "discord";

const SNOWFLAKE = /^\d{1,20}$/u;

export function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && SNOWFLAKE.test(value);
}

export interface DiscordAddress {
  readonly channelId: string;
  /** The thread's own channel id, or null for a top-level channel or DM. */
  readonly threadId: string | null;
}

/** Render an address as a `ChannelThreadKey`. See the header for the shape. */
export function discordThreadKey(address: DiscordAddress): string {
  return address.threadId === null
    ? `${DISCORD_PROVIDER}:${address.channelId}`
    : `${DISCORD_PROVIDER}:${address.channelId}:${address.threadId}`;
}

/**
 * The address a key this adapter rendered names, or null.
 *
 * Null for another provider's key, a key with the wrong number of segments, and
 * any segment that is not a snowflake — which is how an outbound message carrying
 * somebody else's key, or a hostile one, is refused before a socket is opened.
 */
export function parseDiscordThreadKey(key: string): DiscordAddress | null {
  const parts = key.split(":");
  if (parts[0] !== DISCORD_PROVIDER) return null;
  if (parts.length === 2 && isSnowflake(parts[1])) {
    return { channelId: parts[1], threadId: null };
  }
  if (parts.length === 3 && isSnowflake(parts[1]) && isSnowflake(parts[2])) {
    return { channelId: parts[1], threadId: parts[2] };
  }
  return null;
}

/**
 * The channel a message for this address is POSTED to.
 *
 * A Discord thread IS a channel, so a reply inside a thread is created on the
 * thread's id, not on the parent's. Posting to the parent would put the answer
 * in the main channel under a conversation that happened somewhere else.
 */
export function deliveryChannelId(address: DiscordAddress): string {
  return address.threadId ?? address.channelId;
}
