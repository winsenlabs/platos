// The provider name this directory speaks for, and the shape of a thread key.
//
// ONE PLACE, because three different modules need the same two strings and a
// disagreement between them is invisible: a registry keyed on `"Slack"` and an
// adapter reporting `"slack"` produces "no adapter for provider slack" at
// runtime with both halves looking correct in review.
//
// The name is LOWER-CASE because `domain/provider.ts` normalizes every provider
// to lower case before it is compared, indexed or used as a routing
// discriminator, and says why: `"Slack"` and `"slack"` reaching the same store
// as different strings is how a connection becomes invisible to its own adapter.

/** Matches `CONNECTION_PROVIDERS[0]` and `APP_PROVIDERS[0]` in the context. */
export const SLACK_PROVIDER = "slack";

/**
 * Render a Slack conversation address as a `ChannelThreadKey`.
 *
 * THE FORMAT IS THE DOMAIN'S, NOT THIS ADAPTER'S. `domain/inbound.ts` documents
 * it — "Keys are rendered by the adapter as `<kind>:<channel>[:<thread>]`" —
 * and `extractPlatformChannelId` reads the SECOND colon-separated segment back
 * out to match `channel` routing rules. Putting the channel anywhere else here
 * would make every channel-scoped routing rule silently stop matching, with no
 * error anywhere: the rule would simply never fire.
 *
 * THE THREAD SEGMENT IS ALWAYS PRESENT for Slack, because Slack threads a
 * conversation under a parent message and `supportsNativeThreading` says so.
 * `threadTs` falls back to the message's own `ts` for a top-level message, which
 * is what makes the first message of a thread and its replies share one key.
 */
export function slackThreadKey(channelId: string, threadTs: string): string {
  return `${SLACK_PROVIDER}:${channelId}:${threadTs}`;
}

/**
 * The channel and thread halves of a key this adapter rendered.
 *
 * Needed on the OUTBOUND path: `chat.postMessage` takes a channel id and a
 * `thread_ts` as separate arguments, so a key has to come back apart. Returns
 * null for anything this adapter did not render, which is how an outbound event
 * carrying another provider's key is refused rather than posted to a channel
 * named by the wrong half of somebody else's string.
 */
export function parseSlackThreadKey(key: string): { channelId: string; threadTs: string } | null {
  const parts = key.split(":");
  if (parts.length !== 3) return null;
  const [prefix, channelId, threadTs] = parts;
  if (prefix !== SLACK_PROVIDER) return null;
  if (channelId === undefined || channelId === "" || threadTs === undefined || threadTs === "") {
    return null;
  }
  return { channelId, threadTs };
}
