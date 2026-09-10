// Inbound verification: is this really Slack, and is it recent enough to act on?
//
// THREE REFUSALS AND THREE CODES, AND THE SPLIT IS NOT COSMETIC. The vendor SDK
// signals all three by throwing ONE class, `SlackWebhookVerificationError`, and
// separates them only by an English message ("Slack signature headers are
// required" / "Slack timestamp is too old" / "Slack signature is invalid").
// Mapping codes by matching those strings would make this adapter's refusal
// taxonomy a hostage to a vendor's copy-editing, and the failure mode is silent:
// a reworded message downgrades a stale-clock problem to a forged-request
// problem, and an operator rotates a secret that was never wrong.
//
// So the STRUCTURAL half is decided here and the CRYPTOGRAPHIC half is delegated:
//
//   ABSENT   decided here — one or both headers are missing or empty.
//   STALE    decided here — the timestamp is unparseable, or its distance from
//            `receivedAt` exceeds the window.
//   INVALID  decided by the SDK — the only verdict that needs the signing secret
//            and constant-time HMAC, which is exactly the part worth delegating.
//
// THE WINDOW IS TWO-SIDED, AND THE FUTURE SIDE IS THE ONE PEOPLE FORGET. A
// timestamp far in the FUTURE is as much a replay tool as one far in the past:
// capture a signed request, hold it, and the "too old" check never fires. Slack's
// own guidance names five minutes; this checks |now - t| against the window
// rather than (now - t), so both directions are bounded.
//
// AND NOTHING IT RETURNS SAYS WHICH. `signatureAbsent`, `signatureStale` and
// `signatureInvalid` all carry `unauthenticated` and details of `{ provider }`
// alone — no expected value, no computed digest, no clock delta. The CODE is for
// the operator reading a log; the CALLER learns only that it is not Slack.

import {
  err,
  ok,
  signatureAbsent,
  signatureInvalid,
  signatureStale,
  type Result,
  type SignedDelivery,
} from "@platos/context-channels/application/ports/index.js";

import { SLACK_PROVIDER } from "./provider.js";
import { SlackWebhookVerificationError, verifySlackSignature } from "./vendor.js";

/** The two headers Slack signs a delivery with. Lower-cased; see the port. */
export const SLACK_TIMESTAMP_HEADER = "x-slack-request-timestamp";
export const SLACK_SIGNATURE_HEADER = "x-slack-signature";

/**
 * The default replay window, in seconds.
 *
 * Five minutes, matching `PLATOS_CHANNELS_SLACK_REQUEST_MAX_AGE_S`'s default in
 * `apps/core-api/src/config/channels.ts` and the vendor's own published
 * guidance. It is a CONSTRUCTION option and not a constant precisely because it
 * is a trade against clock skew, and an install with a badly synchronised fleet
 * has to be able to widen it deliberately rather than discover it as
 * intermittent rejections.
 */
export const DEFAULT_REQUEST_MAX_AGE_SECONDS = 300;

function header(delivery: SignedDelivery, name: string): string | null {
  const value = delivery.headers[name];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export interface VerifiedEnvelope {
  readonly timestamp: string;
  readonly signature: string;
}

/**
 * Refuse or accept ONE delivery's signature.
 *
 * Returns the two header values on success rather than `void` so a caller can
 * record what it verified without reaching back into the raw headers a second
 * time — the same reason `VerifiedDelivery` carries `verifiedBody`.
 */
export async function verifySlackDelivery(
  secret: string,
  delivery: SignedDelivery,
  maxAgeSeconds: number,
): Promise<Result<VerifiedEnvelope>> {
  const timestamp = header(delivery, SLACK_TIMESTAMP_HEADER);
  const signature = header(delivery, SLACK_SIGNATURE_HEADER);
  if (timestamp === null || signature === null) return err(signatureAbsent(SLACK_PROVIDER));

  // `Number.parseInt` would accept "1712000000abc" and a leading "+"; a
  // signature header is machine-written and there is no reason to be generous
  // with it. An unparseable timestamp is STALE rather than ABSENT: something
  // signed the request, and what is wrong is the instant it claims.
  if (!/^\d{1,15}$/u.test(timestamp)) return err(signatureStale(SLACK_PROVIDER));
  const claimedSeconds = Number(timestamp);
  const receivedSeconds = Math.floor(delivery.receivedAt.getTime() / 1000);
  if (Math.abs(receivedSeconds - claimedSeconds) > maxAgeSeconds) {
    return err(signatureStale(SLACK_PROVIDER));
  }

  try {
    await verifySlackSignature(
      delivery.rawBody,
      { [SLACK_TIMESTAMP_HEADER]: timestamp, [SLACK_SIGNATURE_HEADER]: signature },
      {
        signingSecret: secret,
        // THE CLOCK IS THE CALLER'S, and the window is deliberately WIDER here
        // than the one enforced above. The SDK checks the same staleness this
        // function already decided; handing it a narrower window would let the
        // vendor's verdict override ours and collapse STALE back into INVALID.
        // The check above is the one that runs.
        now: () => delivery.receivedAt.getTime(),
        maxSkewSeconds: Number.MAX_SAFE_INTEGER,
      },
    );
  } catch (error) {
    // A vendor exception is contained HERE and nowhere above. Any throw from
    // the SDK is a refusal to authenticate this request; `SlackWebhookVerificationError`
    // is named so a genuinely unexpected throw (a programming error inside the
    // SDK) is still refused rather than escaping into a public endpoint's
    // response, and is refused with the same opaque answer.
    void (error instanceof SlackWebhookVerificationError);
    return err(signatureInvalid(SLACK_PROVIDER));
  }

  return ok({ timestamp, signature });
}
