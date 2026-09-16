// The provider name this directory speaks for, the shape of a thread key, and
// the one identifier grammar every path segment this adapter writes must pass.
//
// THE KEY FORMAT IS THE DOMAIN'S. `domain/inbound.ts` fixes it —
// "`<kind>:<channel>[:<thread>]`" — and `extractPlatformChannelId` reads the
// SECOND segment back out to match `channel` routing rules. So a WhatsApp key is
//
//     whatsapp:<phone number id>:<wa id>
//
// ALWAYS THREE SEGMENTS, AND THE REASON IS WHAT A `channel` RULE MEANS.
// WhatsApp has no rooms: every conversation is one customer talking to one
// business phone number, and the Cloud API addresses it by the pair. If the key
// were `whatsapp:<wa id>` then the second segment — the one a `channel` routing
// rule matches — would be A CUSTOMER'S PHONE NUMBER, and an operator could only
// write rules naming individual people. The thing an operator actually routes is
// THE LINE ("our support number"), so the line is the channel and the customer is
// the thread under it. That is the same shape `channel-discord` renders for a
// thread under a text channel, and it makes a rule naming the support line match
// every conversation on it.
//
// DIGITS ONLY, AND THE REASON IS A PATH. The phone number id becomes a segment
// of a Graph route — `<phone number id>/messages` — and the wa id becomes the
// `to` field of the body. A phone-number-id half reading `..%2Fme%2Faccounts`
// would be a request to a different endpoint on the business's own token. Meta
// renders both as decimal strings (a phone number id is a numeric node id; a
// wa id is the customer's number in international format with no `+`, per
// `Cloud API / Webhooks / components`), so anything that is not one to twenty
// digits is refused before it can become a URL or a recipient.

/** Matches `CONNECTION_PROVIDERS[2]` in the context's `domain/provider.ts`. */
export const WHATSAPP_PROVIDER = "whatsapp";

const META_ID = /^\d{1,20}$/u;

export function isMetaId(value: unknown): value is string {
  return typeof value === "string" && META_ID.test(value);
}

export interface WhatsAppAddress {
  /** The BUSINESS phone number id — the line, and therefore the channel. */
  readonly phoneNumberId: string;
  /** The CUSTOMER's wa id — the conversation under that line. */
  readonly waId: string;
}

/** Render an address as a `ChannelThreadKey`. See the header for the shape. */
export function whatsappThreadKey(address: WhatsAppAddress): string {
  return `${WHATSAPP_PROVIDER}:${address.phoneNumberId}:${address.waId}`;
}

/**
 * The address a key this adapter rendered names, or null.
 *
 * Null for another provider's key, a key with the wrong number of segments, and
 * any segment that is not a Meta id — which is how an outbound message carrying
 * somebody else's key, or a hostile one, is refused before a socket is opened.
 */
export function parseWhatsAppThreadKey(key: string): WhatsAppAddress | null {
  const parts = key.split(":");
  if (parts.length !== 3) return null;
  if (parts[0] !== WHATSAPP_PROVIDER) return null;
  if (!isMetaId(parts[1]) || !isMetaId(parts[2])) return null;
  return { phoneNumberId: parts[1], waId: parts[2] };
}
