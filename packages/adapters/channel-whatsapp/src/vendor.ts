// THE ONE FILE IN THIS DIRECTORY THAT NAMES META'S WIRE VOCABULARY.
//
// `channel-slack/src/vendor.ts` funnels a vendor SDK; `channel-discord/src/vendor.ts`
// keeps the funnel with different content because Discord's integration needs no
// SDK. THIS DIRECTORY IS THE SECOND OF THAT KIND, and for the same reason:
// WhatsApp Cloud API's inbound half is an HMAC-SHA256 `node:crypto` computes
// natively, and its outbound half is three JSON-over-HTTPS Graph routes. A client
// library for that would be a dependency, an SBOM row and an advisory stream
// bought to save a `fetch`.
//
// So the funnel is kept: every header name, field name, route and number Meta
// defines is spelled HERE, once, with where it is written down, and nothing else
// in this directory writes one.
//
// PROVENANCE. Transcribed from Meta's developer documentation for the WhatsApp
// Business Platform Cloud API and for Graph API webhooks:
//   Webhooks / Getting Started — `hub.mode`, `hub.challenge`, `hub.verify_token`,
//                                and the requirement to answer the GET with the
//                                challenge value and nothing else
//   Webhooks / Payload validation — `X-Hub-Signature-256`, "sha256=" + the
//                                HMAC-SHA256 of the RAW payload keyed by the app
//                                secret, compared against the header
//   Cloud API / Webhooks components — the `entry[].changes[].value` envelope,
//                                `messaging_product`, `metadata.phone_number_id`,
//                                `messages[]`, `statuses[]`, the `field` name
//   Cloud API / Messages — `POST /<version>/<phone number id>/messages`, the
//                                text message body, the `messages[0].id` answer
//   Cloud API / Error codes — the numeric `error.code` values named below
//
// THERE IS NO PUBLISHED META VECTOR FOR THIS SIGNATURE, AND THAT IS WHY THE JOIN
// IS ELSEWHERE. Slack publishes a complete worked example — a secret, a
// timestamp, a body and the signature they produce — which
// `channel-slack/src/published-vector.ts` transcribes. Meta publishes the
// CONSTRUCTION and code samples, and no worked example with concrete bytes. So
// this adapter's signature suite joins to the standard instead: `hmac.ts` is
// driven by RFC 4231's own HMAC-SHA-256 test vectors AND compared against a
// second, independent HMAC written from `node:crypto`'s raw SHA-256 per
// RFC 2104. `rfc4231.test.ts` says so at length; this paragraph exists so the
// difference from `channel-slack` cannot be mistaken for an omission.

/**
 * The Graph API base. The trailing slash is load-bearing for the reason
 * `channel-slack/src/send.ts` gives: a route is resolved with
 * `new URL(route, base)`, and a base with no trailing slash drops its last path
 * segment — here, the API version, which would send every call to an unversioned
 * endpoint.
 *
 * v21.0 is a pinned, dated Graph version rather than a floating alias, because
 * an unversioned Graph call follows Meta's default and changes shape under a
 * running process.
 */
export const WHATSAPP_GRAPH_URL = "https://graph.facebook.com/v21.0/";

/** The one header an inbound webhook POST is signed with. Lower-cased; see the port. */
export const WHATSAPP_SIGNATURE_HEADER = "x-hub-signature-256";

/**
 * The prefix Meta writes in front of the hex digest: `sha256=<64 hex digits>`.
 *
 * It is not decoration. `X-Hub-Signature` (no suffix) carries `sha1=` under the
 * SAME header family, and an adapter that ignored the prefix would accept a
 * SHA-1 digest presented in the SHA-256 header the day a proxy downgraded it.
 */
export const WHATSAPP_SIGNATURE_PREFIX = "sha256=";

/** `Authorization: Bearer <system user access token>`. */
export const WHATSAPP_AUTHORIZATION_SCHEME = "Bearer";

/** Every message this adapter sends names the product it is for. */
export const WHATSAPP_MESSAGING_PRODUCT = "whatsapp";

/** The webhook subscription handshake's query fields, and the one mode Meta sends. */
export const WHATSAPP_HUB_FIELD = Object.freeze({
  mode: "hub.mode",
  challenge: "hub.challenge",
  verifyToken: "hub.verify_token",
} as const);

export const WHATSAPP_HUB_SUBSCRIBE_MODE = "subscribe";

/**
 * The webhook `object` a WhatsApp Business Account delivery carries. A page or an
 * Instagram delivery arriving on this endpoint is somebody else's subscription
 * and is not normalized as a WhatsApp message.
 */
export const WHATSAPP_WEBHOOK_OBJECT = "whatsapp_business_account";

/** The `changes[].field` that carries messages and statuses. */
export const WHATSAPP_MESSAGES_FIELD = "messages";

/**
 * The inbound message `type` values. Only `text` carries typed text; the rest are
 * verified, real, and have no behaviour in this build.
 */
export const WHATSAPP_TEXT_MESSAGE_TYPE = "text";

/**
 * Meta's numeric `error.code` values this adapter acts on, transcribed from the
 * Cloud API error-codes reference.
 *
 * `190` IS THE ONE THAT MATTERS AND THE ONE A STATUS ALONE GETS WRONG. Graph
 * answers an expired or revoked access token with HTTP **400** and
 * `error.code = 190`, not with 401 — so a classifier that read only the status
 * would report a dead credential as a rejected message, the refresh fence would
 * never fire, and every send for that connection would fail forever with nothing
 * asking for a new token.
 *
 * The four rate-limit codes are grouped because they mean one thing to a caller:
 * this request was NOT processed, wait and resend.
 */
export const WHATSAPP_ERROR_CODE = Object.freeze({
  /** "Error validating access token" — the credential, not the message. */
  accessToken: 190,
  /** Cloud API throughput limit reached. */
  rateLimitHit: 130429,
  /** Too many messages to this ONE recipient. */
  pairRateLimit: 131056,
  /** The business account's own spend/throughput limit. */
  accountRateLimit: 80007,
  /** The app's Graph call volume limit. */
  appRateLimit: 4,
} as const);

/** Every code above that means "refused, not processed". */
export const WHATSAPP_RATE_LIMIT_CODES: ReadonlySet<number> = new Set([
  WHATSAPP_ERROR_CODE.rateLimitHit,
  WHATSAPP_ERROR_CODE.pairRateLimit,
  WHATSAPP_ERROR_CODE.accountRateLimit,
  WHATSAPP_ERROR_CODE.appRateLimit,
]);

/**
 * `preview_url: false` on every text message this adapter writes.
 *
 * THE ASSISTANT'S TEXT IS PARTLY THE USER'S TEXT. With previews on, a URL a
 * customer pasted and the model echoed back is FETCHED by Meta and rendered as a
 * card in the customer's chat on the business's authority. Off is the only
 * setting that makes the outbound body inert.
 */
export const WHATSAPP_PREVIEW_URL = false;

/**
 * The largest text body the Cloud API accepts, in UTF-16 code units as
 * `String.length` counts them: 4096 characters.
 *
 * Enforced here rather than discovered as a 400, because a turn whose answer is
 * long is a NORMAL outcome and losing it to a vendor refusal is not.
 */
export const WHATSAPP_MAX_TEXT_LENGTH = 4096;
