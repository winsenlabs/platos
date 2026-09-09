// SLACK'S OWN PUBLISHED REQUEST-VERIFICATION EXAMPLE, TRANSCRIBED.
//
// Source: Slack's "Verifying requests from Slack" documentation, which walks
// through one complete example — a signing secret, an `X-Slack-Request-Timestamp`,
// a request body, and the `X-Slack-Signature` those three produce. All four
// values below are that example.
//
// WHY A FILE RATHER THAN CONSTANTS IN THE SUITE. Two suites need it — the
// signature cases and the 4.34/4.40 differential — and a vector duplicated in
// two places is a vector that can be "fixed" in one of them to make a failure go
// away. There is exactly one copy, and `recomputePublishedSignature()` proves it
// is the real one on every run.
//
// THE SECRET IS NOT A SECRET. It is a documentation example, published by the
// vendor, and it has never authenticated anything. The secret-scanning gates
// treat a fixture named as one differently from a credential; naming it here,
// loudly, is the reason it is safe to hold.

import { createHmac } from "node:crypto";

import type { SignedDelivery } from "@platos/context-channels/application/ports/index.js";

export const PUBLISHED_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";

export const PUBLISHED_TIMESTAMP = "1531420618";

export const PUBLISHED_BODY =
  "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow" +
  "&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner" +
  "&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2F" +
  "commands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN" +
  "&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";

export const PUBLISHED_SIGNATURE =
  "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503";

/**
 * Re-derive the published signature from the published inputs, independently.
 *
 * `node:crypto` and the documented construction — `v0:` + timestamp + `:` +
 * body, HMAC-SHA256 under the signing secret, lower-case hex, `v0=` prefix. This
 * is NOT how the adapter verifies (the adapter delegates to the vendor SDK), so
 * agreement here is agreement between three independent things: Slack's
 * published digest, Node's HMAC, and the SDK.
 *
 * Its job is to catch a TRANSCRIPTION error. If a character of the body above
 * were mistyped, every case in the signature suite would still pass — they would
 * simply be testing a different, self-consistent vector — and this is the only
 * assertion that notices.
 */
export function recomputePublishedSignature(): string {
  const digest = createHmac("sha256", PUBLISHED_SECRET)
    .update(`v0:${PUBLISHED_TIMESTAMP}:${PUBLISHED_BODY}`, "utf8")
    .digest("hex");
  return `v0=${digest}`;
}

/** The instant the published request was signed at. */
export function publishedReceivedAt(): Date {
  return new Date(Number(PUBLISHED_TIMESTAMP) * 1000);
}

/**
 * The published request as a `SignedDelivery`, with any part overridden.
 *
 * Overrides are how every negative case is built: the vector with ONE thing
 * changed, so the refusal is produced by real cryptography over real bytes
 * rather than by a double that was told to refuse.
 */
export function publishedDelivery(overrides: Partial<SignedDelivery> = {}): SignedDelivery {
  return {
    rawBody: PUBLISHED_BODY,
    headers: {
      "x-slack-request-timestamp": PUBLISHED_TIMESTAMP,
      "x-slack-signature": PUBLISHED_SIGNATURE,
    },
    receivedAt: publishedReceivedAt(),
    ...overrides,
  };
}
