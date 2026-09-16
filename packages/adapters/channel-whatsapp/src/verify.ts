// Inbound verification: did Meta sign these exact bytes with this app's secret?
//
// META'S CONSTRUCTION, as the Webhooks "Payload validation" page writes it: the
// `X-Hub-Signature-256` header is the string `sha256=` followed by the
// HMAC-SHA256 of THE RAW REQUEST PAYLOAD, keyed by the app secret, in lower-case
// hex. The signed message is the body and NOTHING ELSE — no timestamp, no
// method, no path, no separator — which is the same shape as Slack's without
// Slack's `v0:<timestamp>:` prefix.
//
// THE RAW BYTES ARE THE WHOLE POINT, and the port's own header says why: Meta
// signs the body octet-for-octet, so `JSON.stringify(JSON.parse(body))` is a
// different message often enough that a check over it fails intermittently
// rather than never.
//
// TWO REFUSALS AND TWO CODES, from the taxonomy `domain/errors.ts` mints:
//
//   ABSENT   decided here — the header is missing or blank. Nothing signed this.
//   INVALID  decided by the cryptography, and by the grammar in front of it —
//            the header does not carry `sha256=` + 64 hex digits, or the digest
//            does not match the one this app's secret produces over these bytes.
//            A configured secret that is empty lands here too.
//
// AND `CHANNELS_SIGNATURE_STALE` IS NEVER MINTED BY THIS ADAPTER. That is a
// DECISION, not an omission, and `whatsapp-signature.test.ts` asserts it so the
// decision cannot quietly change:
//
//   THERE IS NOTHING TO CHECK IT AGAINST. Slack signs a timestamp header and
//   Discord signs a timestamp header; Meta signs the body alone. The only instant
//   inside the signed material is `messages[].timestamp`, and that is the moment
//   the CUSTOMER SENT the message, not the moment this delivery was made.
//
//   AND CHECKING IT WOULD REFUSE GENUINE TRAFFIC. Meta retries an undelivered
//   webhook with backoff for days. A window over the customer's send time would
//   throw away exactly the deliveries that most need to arrive — the ones a
//   deploy or an outage delayed — and it would do it silently, as an
//   authentication failure, which is the worst possible label for it.
//
//   WHAT DEFENDS AGAINST A REPLAY INSTEAD is the property the inbox already has:
//   admission is keyed on the provider's own message id (`wamid.*`), so a
//   captured body replayed a thousand times is ONE row and ONE turn. That is
//   stronger than a window, because it holds for a replay that arrives one second
//   later as well as one that arrives a week later. `signed-admission.test.ts`
//   is where that is proven, and it is proven against `channels`' own use case.
//
// NOTHING IT RETURNS SAYS WHICH. Both codes carry `unauthenticated` and details
// of `{ provider }` alone — no computed digest, no secret, no expected value.

import {
  err,
  ok,
  signatureAbsent,
  signatureInvalid,
  type Result,
  type SignedDelivery,
} from "@platos/context-channels/application/ports/index.js";

import { digestsMatch, hmacSha256Hex } from "./hmac.js";
import { WHATSAPP_PROVIDER } from "./provider.js";
import {
  WHATSAPP_HUB_FIELD,
  WHATSAPP_HUB_SUBSCRIBE_MODE,
  WHATSAPP_SIGNATURE_HEADER,
  WHATSAPP_SIGNATURE_PREFIX,
} from "./vendor.js";

function header(delivery: SignedDelivery, name: string): string | null {
  const value = delivery.headers[name];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * The exact octets Meta signs, and the digest it renders.
 *
 * Exported because it IS the construction, and the signature suite needs to
 * produce fixtures with the same bytes it asks an independent HMAC to verify.
 */
export function whatsappSignatureHeader(appSecret: string, rawBody: string): string {
  const digest = hmacSha256Hex(Buffer.from(appSecret, "utf8"), Buffer.from(rawBody, "utf8"));
  return `${WHATSAPP_SIGNATURE_PREFIX}${digest}`;
}

/** The hex half of a `sha256=<digest>` header, or null when it is not that shape. */
export function presentedDigest(headerValue: string): string | null {
  if (!headerValue.startsWith(WHATSAPP_SIGNATURE_PREFIX)) return null;
  return headerValue.slice(WHATSAPP_SIGNATURE_PREFIX.length);
}

export function verifyWhatsAppDelivery(appSecret: string, delivery: SignedDelivery): Result<void> {
  const presented = header(delivery, WHATSAPP_SIGNATURE_HEADER);
  if (presented === null) return err(signatureAbsent(WHATSAPP_PROVIDER));

  const digest = presentedDigest(presented.trim());
  if (digest === null) return err(signatureInvalid(WHATSAPP_PROVIDER));
  // An empty configured secret would HMAC to a perfectly valid digest under an
  // empty key, so a forger who guessed that the install left the variable blank
  // could sign anything. `config/channels.ts` refuses it at boot; this is the
  // second line, not the first.
  if (appSecret === "") return err(signatureInvalid(WHATSAPP_PROVIDER));

  const expected = hmacSha256Hex(Buffer.from(appSecret, "utf8"), Buffer.from(delivery.rawBody, "utf8"));
  return digestsMatch(expected, digest) ? ok(undefined) : err(signatureInvalid(WHATSAPP_PROVIDER));
}

/**
 * The VERIFY TOKEN, which is a different secret from the app secret.
 *
 * ITS OWN TYPE, AND THAT IS THE POINT. `InboundVerificationSecret` has one slot,
 * and an endpoint that served both the signed POST and the subscription GET from
 * that one slot would be one refactor away from HMACing bodies with the verify
 * token — which would refuse every real delivery — or, far worse, from comparing
 * the app secret against a query parameter an anonymous caller chose. Two
 * secrets, two types, no way to pass one where the other belongs.
 */
export interface WhatsAppSubscriptionSecret {
  readonly verifyToken: string;
}

/**
 * The subscription handshake, exactly as received.
 *
 * `rawQuery` is the request's query string — `hub.mode=subscribe&hub.challenge=…`
 * — as the transport received it, for the same reason `SignedDelivery.rawBody` is
 * the raw body: it is what is echoed and what is recorded, and re-rendering a
 * parsed object is a second chance to differ from what arrived.
 */
export interface WhatsAppSubscriptionRequest {
  readonly rawQuery: string;
}

/**
 * Verify the webhook subscription handshake and return the challenge to echo.
 *
 * META'S RULE, from Webhooks / Getting Started: when an endpoint is saved, Meta
 * sends a GET carrying `hub.mode=subscribe`, `hub.challenge` and
 * `hub.verify_token`. The endpoint must compare the token against the one the
 * integrator configured and answer 200 with THE CHALLENGE VALUE AS THE WHOLE
 * BODY — not JSON, not quoted. Anything else and the subscription is refused and
 * no webhook is ever delivered.
 *
 * THE COMPARISON IS CONSTANT-TIME, and a length mismatch is a refusal rather than
 * a throw — see `hmac.ts`. The token is chosen by the integrator, so unlike the
 * signature this is a comparison of a value we control against a value the caller
 * supplies; it is exactly the weak shape `channel-telegram`'s header names, and it
 * is confined HERE, to one GET that admits nothing to any store.
 */
export function verifyWhatsAppSubscription(
  secret: WhatsAppSubscriptionSecret,
  request: WhatsAppSubscriptionRequest,
): Result<string> {
  const query = new URLSearchParams(request.rawQuery);
  const mode = query.get(WHATSAPP_HUB_FIELD.mode);
  const challenge = query.get(WHATSAPP_HUB_FIELD.challenge);
  const presented = query.get(WHATSAPP_HUB_FIELD.verifyToken);
  // A GET with no hub fields is not a handshake at all: nothing presented a
  // credential, so the code is ABSENT and not INVALID.
  if (mode !== WHATSAPP_HUB_SUBSCRIBE_MODE || challenge === null || challenge === "" || presented === null) {
    return err(signatureAbsent(WHATSAPP_PROVIDER));
  }
  if (secret.verifyToken === "") return err(signatureInvalid(WHATSAPP_PROVIDER));
  const configured = Buffer.from(secret.verifyToken, "utf8");
  const offered = Buffer.from(presented, "utf8");
  // Both sides are digested first so the constant-time comparison runs over two
  // fixed-width values: comparing the raw tokens would refuse a length mismatch
  // BEFORE any comparison and hand a caller the configured token's length.
  const matches = digestsMatch(
    hmacSha256Hex(configured, configured),
    hmacSha256Hex(configured, offered),
  );
  return matches ? ok(challenge) : err(signatureInvalid(WHATSAPP_PROVIDER));
}
