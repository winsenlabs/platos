// Inbound verification: does this delivery carry the secret token this install
// gave `setWebhook`?
//
// TELEGRAM'S CONSTRUCTION, as `setWebhook` documents it: the integrator passes a
// `secret_token`, and Telegram sends it back verbatim in the
// `X-Telegram-Bot-Api-Secret-Token` header of every webhook request. There is no
// signature and no digest over the body — see `secret-token.ts` for what that
// costs and `adapter.ts` for what this directory can therefore prove.
//
// THREE REFUSALS AND TWO CODES, AND THE SPLIT IS THE SAME TAXONOMY
// `channel-slack` AND `channel-discord` REFUSE IN:
//
//   ABSENT   decided here — the header is missing or blank. Nothing presented a
//            credential at all, which is what an unconfigured webhook, a health
//            check or a stray internet scan looks like.
//   INVALID  decided by the comparison — a token that is present and wrong,
//            including one that is a PREFIX of the right one or longer than it.
//            A configured secret outside `setWebhook`'s own grammar lands here
//            too: `setWebhook` would have refused it, so no genuine delivery
//            could ever carry it, and every request being refused as a forgery is
//            a misconfiguration this code says out loud rather than a mystery.
//
// AND `CHANNELS_SIGNATURE_STALE` IS NEVER MINTED, for a reason that is NOT
// WhatsApp's. There, the body is signed and the signature covers no timestamp.
// Here nothing is signed at all, so a replay window would be a window over an
// UNAUTHENTICATED claim: the `date` inside the update is a value any caller
// holding the token can write. A window over it would refuse Telegram's own
// redeliveries — Telegram repeats an update until the endpoint answers 2xx —
// while stopping nothing an attacker could not simply re-stamp. What defends
// against a repeat is the inbox's idempotency on `update_id`, and
// `signed-admission.test.ts` proves that against `channels`' own use case.
//
// NOTHING IT RETURNS SAYS WHICH. Both codes carry `unauthenticated` and details
// of `{ provider }` alone — no expected value, no length, no clock delta.

import {
  err,
  ok,
  signatureAbsent,
  signatureInvalid,
  type Result,
  type SignedDelivery,
} from "@platos/context-channels/application/ports/index.js";

import { TELEGRAM_PROVIDER } from "./provider.js";
import { secretsMatch } from "./secret-token.js";
import { TELEGRAM_SECRET_TOKEN_HEADER, TELEGRAM_SECRET_TOKEN_PATTERN } from "./vendor.js";

function header(delivery: SignedDelivery, name: string): string | null {
  const value = delivery.headers[name];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function verifyTelegramDelivery(secretToken: string, delivery: SignedDelivery): Result<void> {
  const presented = header(delivery, TELEGRAM_SECRET_TOKEN_HEADER);
  if (presented === null) return err(signatureAbsent(TELEGRAM_PROVIDER));
  // The CONFIGURED value is checked against the vendor's own documented grammar.
  // See the header: a token `setWebhook` would have refused can never arrive, so
  // this arm is a misconfiguration and not a forgery — and it is refused with the
  // same opaque answer, because the caller must not learn which.
  if (!TELEGRAM_SECRET_TOKEN_PATTERN.test(secretToken)) return err(signatureInvalid(TELEGRAM_PROVIDER));
  // NOT TRIMMED. The header is compared exactly as received: a token with a
  // trailing space is a different token, and trimming would quietly widen the
  // set of strings that authenticate.
  return secretsMatch(secretToken, presented) ? ok(undefined) : err(signatureInvalid(TELEGRAM_PROVIDER));
}
