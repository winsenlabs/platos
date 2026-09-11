// `ChannelRuntime` — the CANONICAL channel port (WIN-271, M4.5).
//
// WHAT WAS WRONG, AND WHY A SECOND PORT IS THE FIX RATHER THAN A BIGGER FIRST
// ONE. `ChannelAdapter` next door describes the OUTBOUND half of a provider
// integration: post a message, describe an author, check a credential. The
// INBOUND half — is this request really from the provider, and what does it
// say — had no port at all. `admit-channel-event.ts` states the consequence in
// its own header: "SIGNATURE VERIFICATION IS NOT HERE. It happens in the
// transport." So the one security decision on a PUBLIC endpoint sat outside the
// context that owns channels, and every transport that wanted to serve a
// channel had to re-implement it. It was re-implemented: `apps/agent` HMACs a
// Slack body in a controller, and delegates the other three providers to a
// vendor SDK from inside a Nest service.
//
// A verification that lives in a transport cannot be right for long. It has to
// see the EXACT RECEIVED BYTES — a body that has been parsed into an object can
// no longer be verified, because re-serializing it does not reproduce the bytes
// the signature covers — and a transport is exactly the layer that is supposed
// to parse bodies. So the seam has to be BELOW the parse, which is where this
// port is.
//
// `ChannelRuntime` therefore EXTENDS `ChannelAdapter` rather than replacing it.
// One provider, one directory, one object, both halves — which is also what
// makes "future adapters require no Core modification" true: adding Telegram is
// a new directory satisfying this interface and a row in the registry, and not
// one line inside `channels`.
//
// WHAT A SECOND RUNTIME WOULD ACTUALLY TAKE — MEASURED, BECAUSE "future adapters
// require no Core modification" IS STILL ASSERTED AND NOT EXERCISED.
//
// `channel-slack` is the only implementation. Until a second one exists the
// sentence above is a design intention, so this is what the second one needs,
// measured against this tree rather than estimated.
//
// WHAT IS ALREADY REACHABLE, AND CHEAPLY. `CONNECTION_PROVIDERS` in
// `../../domain/provider.ts` already admits `telegram`, `whatsapp` and `discord`,
// so a new runtime needs NO change here and no change in the domain — which is
// precisely the claim. `ChannelRuntime` extends `ChannelAdapter`, so a complete
// one owes FOUR methods, and the outbound three are testable with no credential
// and no live provider: `channel-slack/src/far-side.ts` is a real `node:http`
// server that records what it received and can be scripted to go silent, refuse,
// or answer slowly, and the adapter is pointed at it by base url. Nothing about
// that pattern is Slack-specific.
//
// WHAT NEEDS A DECISION, AND IT IS NOT A CODE ONE. WHICH PROVIDER IS SECOND is
// unchosen: four are admitted, nothing in the tree selects one, and the answer is
// a product decision about who Winsen's users are on. A PRODUCTION credential —
// a bot token, an app secret — follows from that choice and from a supplier, not
// from this file.
//
// AND ONE MEASURED TECHNICAL REASON THE OBVIOUS CANDIDATE IS THE WRONG ONE. The
// header above names Telegram as the example, and Telegram is the cheapest to
// write and the weakest to PROVE. Its inbound verification is a constant-time
// comparison against `X-Telegram-Bot-Api-Secret-Token`, a value the integrator
// itself chose when it called `setWebhook` — so there is no published vector to
// transcribe, and a suite for it would compare a secret the suite set against a
// header the suite wrote. `channel-slack` deliberately avoided exactly that:
// `published-vector.ts` transcribes Slack's OWN documented example and
// `recomputePublishedSignature()` re-derives it through `node:crypto`, so
// agreement there is agreement between three independent things. An adapter whose
// central assertion compares two values it controls cannot fail, and that is a
// worse outcome than no second adapter.
//
// DISCORD IS THE STRONGEST CANDIDATE ON THAT TEST. Its inbound half is an Ed25519
// signature over `timestamp + body` verified against the application's PUBLIC key
// — an IETF standard with published test vectors (RFC 8032), supported natively by
// `node:crypto`, so it adds no dependency and its verification joins to something
// outside this repository. WhatsApp is an HMAC-SHA256 over the raw body
// (`X-Hub-Signature-256`), the same shape as Slack's.
//
// WHAT A SECOND RUNTIME STILL COULD NOT BE EXERCISED THROUGH. `channels` IS NOT
// COMPOSED on this branch, and the reason is recorded and still current:
// `CHANNELS_UNCOMPOSABLE` in `apps/core-api/src/composition/context-ports.ts`
// names `DurableRuntime` as the missing half, and `durable-runtime` is the first
// entry of `UNIMPLEMENTED_ADAPTERS` in `adapter-bindings.ts`. So a second runtime
// could be proven against THIS PORT in its own package — which is where the "no
// Core modification" claim actually lives — but not end to end through a composed
// application, and closing that needs the external service ADR M0.3 section 7
// decision 10 names.
//
// NOTHING BELOW NAMES A VENDOR TYPE, AND THAT IS THE POINT. `SignedDelivery` is
// bytes and headers; `VerifiedDelivery` is this context's own vocabulary. An
// adapter may hold `SlackWebhookPayload`, `SlackApiError` and the whole of its
// SDK's taxonomy, and none of it crosses this line.

import type { Result } from "@platos/kernel";

import type { InboundMessage, ProviderEventId } from "../../domain/index.js";
import type { ChannelAdapter } from "./channel-adapter.js";

/**
 * One inbound HTTP delivery, exactly as it arrived, before anything trusted it.
 *
 * `rawBody` IS A STRING AND NOT A PARSED OBJECT, and it must be the bytes the
 * transport received decoded as UTF-8 and not re-encoded. Providers sign the
 * body octet-for-octet: key order, whitespace and Unicode escaping all matter,
 * and `JSON.stringify(JSON.parse(body))` is a different string often enough
 * that a signature check over it fails intermittently rather than never — which
 * is the worst way for this to be wrong.
 *
 * `headers` are LOWER-CASED by the transport. HTTP header names are
 * case-insensitive, Node lower-cases them on the way in, and an adapter that
 * looked for `X-Slack-Signature` on a map keyed by `x-slack-signature` would
 * find nothing and refuse every real delivery as unsigned.
 */
export interface SignedDelivery {
  readonly rawBody: string;
  readonly headers: Readonly<Record<string, string>>;
  /**
   * When this process received the delivery. Supplied rather than read from the
   * wall clock so the replay window is testable at an instant, and so a
   * verification is reproducible from a captured fixture.
   */
  readonly receivedAt: Date;
}

/**
 * The material that authenticates one delivery. Opaque, and never logged.
 *
 * ONE SLOT AND NOT A UNION, because the providers agree on the shape and differ
 * only in the algorithm: Slack and WhatsApp hold an HMAC signing secret,
 * Telegram a shared token compared in constant time, Discord an Ed25519 PUBLIC
 * key. All four are "a string this app was issued and the far side's signature
 * is checked against". Modelling that as a tagged union would put a per-provider
 * branch in every caller to serve a distinction only the adapter acts on.
 */
export interface InboundVerificationSecret {
  readonly secret: string;
}

/**
 * What a delivery turned out to be, once it verified.
 *
 * THREE KINDS AND NOT TWO. A handshake is not a message with no text: it
 * carries no event id, must never be admitted to the inbox, and requires an
 * exact echo in the response body or the provider marks the endpoint dead. An
 * `ignorable` delivery is a real, verified provider event this build has no
 * behaviour for — a reaction, a bot's own message, a membership change. It must
 * be ACKNOWLEDGED (2xx) and NOT admitted, and telling it apart from a message
 * is what stops the inbox filling with rows no turn will ever run.
 */
export const INBOUND_DELIVERY_KINDS = Object.freeze(["message", "handshake", "ignorable"] as const);

export type InboundDeliveryKind = (typeof INBOUND_DELIVERY_KINDS)[number];

export interface VerifiedDelivery {
  readonly provider: string;
  readonly kind: InboundDeliveryKind;
  /**
   * The PROVIDER's own event id, and therefore the admission idempotency key.
   *
   * Non-null exactly when `kind` is `"message"`. A handshake has no event and an
   * ignorable delivery is not admitted, so neither has an id to key on — and
   * inventing one (a hash of the body, say) would make a redelivery of an
   * ignorable event look like a new one forever.
   */
  readonly providerEventId: ProviderEventId | null;
  /**
   * What the provider demands echoed back verbatim. Non-null exactly when
   * `kind` is `"handshake"`.
   */
  readonly handshakeEcho: string | null;
  /** Non-null exactly when `kind` is `"message"`. */
  readonly message: InboundMessage | null;
  /**
   * The verified bytes, unchanged, for sealing into the inbox.
   *
   * Carried rather than re-read from `SignedDelivery` so that what is STORED is
   * provably the same string that was VERIFIED. Two reads of "the body" are two
   * chances for them to differ.
   */
  readonly verifiedBody: string;
}

/**
 * The whole provider-facing surface: verify what arrives, deliver what leaves.
 *
 * EVERY METHOD RETURNS `Result` AND NEVER THROWS — the rule
 * `channel-adapter.ts` states at length for the outbound half, extended to the
 * inbound one for the same reason. A vendor SDK signals a bad signature by
 * throwing, and letting that escape would put the SDK's error taxonomy on a
 * public endpoint's refusal path.
 *
 * AND `verifyInbound` MUST REFUSE WITH ONE OF FOUR DISTINCT CODES, never with a
 * single "invalid". `domain/errors.ts` mints `CHANNELS_SIGNATURE_ABSENT`,
 * `_STALE`, `_INVALID` and `CHANNELS_PROVIDER_UNSUPPORTED` and says why each
 * exists: they are four different operator actions. An adapter that mapped all
 * of them onto one would leave an operator staring at a clock-skew problem and
 * rotating a secret.
 */
export interface ChannelRuntime extends ChannelAdapter {
  verifyInbound(
    secret: InboundVerificationSecret,
    delivery: SignedDelivery,
  ): Promise<Result<VerifiedDelivery>>;
}

/**
 * The runtime for a provider, chosen at the composition root.
 *
 * A registry rather than a map, for the reason `ChannelAdapterRegistry` next
 * door is one: a use case's dependency list stays one entry as providers are
 * added, and an unknown provider is a `CHANNELS_PROVIDER_UNSUPPORTED` failure at
 * the call site rather than an `undefined` dereference. It is separate from
 * `ChannelAdapterRegistry` rather than replacing it because the two answer
 * different questions — "who can post for this connection" is asked by the
 * outbound subscriber and answered by any adapter; "who can authenticate this
 * endpoint" is asked by the inbound transport and only a full runtime can
 * answer it.
 */
export interface ChannelRuntimeRegistry {
  runtimeFor(provider: string): Result<ChannelRuntime>;
}
