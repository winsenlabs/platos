// Inbound verification: did Discord sign these exact bytes, and recently?
//
// DISCORD'S CONSTRUCTION, as `developers/interactions/overview.mdx` writes it in
// all three of its examples: the message is the `X-Signature-Timestamp` value
// followed IMMEDIATELY by the raw body — `Buffer.from(timestamp + body)` in the
// JavaScript one, `f'{timestamp}{body}'.encode()` in the Python one — and the
// `X-Signature-Ed25519` header is the Ed25519 signature of that message under the
// application's PUBLIC key, hex-encoded. No separator, no version prefix, and the
// order matters: `body + timestamp` is a different message.
//
// FOUR REFUSALS AND THREE CODES, THE SAME TAXONOMY `channel-slack` REFUSES IN,
// because `domain/errors.ts` mints them and says each is a different operator
// action:
//
//   ABSENT   decided here — a header is missing or blank.
//   STALE    decided here — the timestamp is not a whole number of seconds, or it
//            is further than the window from `receivedAt`, in EITHER direction.
//   INVALID  decided by the cryptography — the signature is malformed, or does
//            not verify over `timestamp + body` under the configured key. A
//            configured key that is not a key lands here too: nothing can verify
//            against it, and `config/channels.ts` refuses it at boot so this arm
//            is the second line and not the first.
//
// DISCORD DOCUMENTS NO REPLAY WINDOW, AND THIS ADAPTER ENFORCES ONE ANYWAY. The
// overview says only that a failed validation must be answered 401, and
// `discord-interactions`' `verifyKey` does not look at the timestamp's value at
// all. But the timestamp is INSIDE the signed message, so a captured request
// replays perfectly forever unless somebody compares it to a clock; the replay
// window is the thing that makes the signed timestamp mean anything. Five
// minutes, the same default and the same two-sided rule as Slack's, and widened
// only by `PLATOS_CHANNELS_DISCORD_REQUEST_MAX_AGE_S`.
//
// NOTHING IT RETURNS SAYS WHICH. All three carry `unauthenticated` and details of
// `{ provider }` alone — no computed message, no key, no clock delta.

import type { KeyObject } from "node:crypto";

import {
  err,
  ok,
  signatureAbsent,
  signatureInvalid,
  signatureStale,
  type Result,
  type SignedDelivery,
} from "@platos/context-channels/application/ports/index.js";

import { importEd25519PublicKey, verifyEd25519 } from "./ed25519.js";
import { DISCORD_PROVIDER } from "./provider.js";
import { DISCORD_SIGNATURE_HEADER, DISCORD_TIMESTAMP_HEADER } from "./vendor.js";

/** Five minutes; see the header. Matches the configuration default. */
export const DEFAULT_REQUEST_MAX_AGE_SECONDS = 300;

function header(delivery: SignedDelivery, name: string): string | null {
  const value = delivery.headers[name];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * The exact octets Discord signs: UTF-8 of the timestamp, then UTF-8 of the body.
 *
 * Exported because it IS the construction, and `discord-signature.test.ts` needs
 * to sign fixtures with the same bytes it asks Discord's library to verify.
 */
export function discordSignedMessage(timestamp: string, rawBody: string): Buffer {
  return Buffer.concat([Buffer.from(timestamp, "utf8"), Buffer.from(rawBody, "utf8")]);
}

/**
 * Parsing a key is not free and an app's key does not change between deliveries,
 * so the last one parsed is kept — PER RUNTIME, never in module state, so two
 * adapters in one process cannot see each other's key. ONE entry, keyed on the
 * exact string: a rotated key is a different string and is parsed on first use,
 * and a process serving several apps pays one parse per switch rather than
 * holding an unbounded map of every key it was ever handed.
 */
export class DiscordPublicKeyCache {
  private last: { readonly hex: string; readonly key: KeyObject | null } | null = null;

  keyFor(publicKeyHex: string): KeyObject | null {
    if (this.last?.hex !== publicKeyHex) {
      this.last = { hex: publicKeyHex, key: importEd25519PublicKey(publicKeyHex) };
    }
    return this.last.key;
  }
}

export async function verifyDiscordDelivery(
  keys: DiscordPublicKeyCache,
  publicKeyHex: string,
  delivery: SignedDelivery,
  maxAgeSeconds: number,
): Promise<Result<void>> {
  const timestamp = header(delivery, DISCORD_TIMESTAMP_HEADER);
  const signature = header(delivery, DISCORD_SIGNATURE_HEADER);
  if (timestamp === null || signature === null) return err(signatureAbsent(DISCORD_PROVIDER));

  // Whole seconds, digits only. Something signed this request and what is wrong
  // is the instant it claims, so an unparseable one is STALE and not ABSENT.
  if (!/^\d{1,15}$/u.test(timestamp)) return err(signatureStale(DISCORD_PROVIDER));
  const receivedSeconds = Math.floor(delivery.receivedAt.getTime() / 1000);
  if (Math.abs(receivedSeconds - Number(timestamp)) > maxAgeSeconds) {
    return err(signatureStale(DISCORD_PROVIDER));
  }

  const key = keys.keyFor(publicKeyHex);
  if (key === null) return err(signatureInvalid(DISCORD_PROVIDER));

  // THE TIMESTAMP THAT WAS CHECKED IS THE TIMESTAMP THAT IS VERIFIED — the same
  // string, read once. Re-reading the header for the signature would be a second
  // chance for the window check and the cryptography to disagree about which
  // instant the request claims.
  const verified = verifyEd25519(key, signature, discordSignedMessage(timestamp, delivery.rawBody));
  return verified ? ok(undefined) : err(signatureInvalid(DISCORD_PROVIDER));
}
