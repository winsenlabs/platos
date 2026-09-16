// The `ChannelRuntime` implementation for WhatsApp, and its constructor.
//
// THE THIRD RUNTIME (D10: Discord, then WhatsApp, then Telegram; none dropped).
// `channel-runtime.ts` says a new provider is "a new directory satisfying this
// interface and a row in the registry, and not one line inside `channels`".
// `channel-discord` exercised that once; this directory exercises it a second
// time AT THE PORT and NO FURTHER: it satisfies `ChannelRuntime` and
// `ChannelAdapter` through
// `@platos/context-channels/application/ports/index.js` alone, and
// `git diff <base> -- packages/contexts/channels` over the commits that added it
// is empty. That emptiness is not the clause closed. An empty diff is what any
// branch that never touched Core would show, whether or not the adapter is
// usable; and this one is NOT usable for production inbound without a change
// inside `channels` (2 below). The sentence is true of the port and of the
// outbound half, and false of inbound admission until `channels` decides how a
// WhatsApp delivery is owned.
//
// WEBHOOKS OVER HTTP, AND NOTHING HELD OPEN. This object owns no socket, no timer
// and no subscription between calls, so there is nothing to reconnect and nothing
// to close. What it holds is the process's transport policy — where Graph is, how
// long a call may take, which `fetch`, which clock — plus the one thing that is
// genuinely process-lifetime: the throughput windows Meta has already refused on.
//
// IT HOLDS NO CREDENTIAL. The app secret arrives per delivery on the command, and
// the business access token per call, as `ChannelAdapter` requires.
//
// WHAT THIS DIRECTORY DOES NOT DO, EACH FOR A REASON THAT IS NOT IN IT.
//
//   1. EDIT A SENT MESSAGE. THE CLOUD API HAS NO EDIT ROUTE — there is
//      `POST <phone>/messages` and there is marking a message read, and there is
//      nothing that replaces the text of a message already delivered. So
//      `send` with a non-null `replacesProviderMessageId` is REFUSED
//      (`CHANNELS_ADAPTER_REJECTED`) rather than quietly posting a second
//      message. That choice is the one that matters: `OutboundMessage`'s own
//      comment says "streaming a turn back into a channel is an edit loop, not a
//      message flood", and on a provider with no edit, honouring the field by
//      posting again would put one streamed answer into a customer's phone as N
//      separate notifications, and would turn a redelivered outbound event into a
//      duplicate that can never be taken back. A caller that wants WhatsApp must
//      send the finished text once; making `channels` aware of which providers
//      can edit is a change inside `channels`, and it is not made here.
//
//   2. PRODUCTION ADMISSION. `admitSignedDelivery` keys the inbox on a
//      `ChannelApp`, `APP_PROVIDERS` is `["slack"]`, and `postgres-tenancy`'s
//      `requireAppProvider` refuses to read an app row naming another provider.
//      So this runtime verifies and normalizes a WhatsApp webhook and no
//      production store can admit it until `channels` decides how a WhatsApp
//      delivery is owned. `signed-admission.test.ts` pins that gap and fails the
//      day it closes.
//
//   3. A BATCHED DELIVERY. Meta's envelope is an array at three levels and
//      `VerifiedDelivery` carries one message. `normalize.ts` states the rule and
//      why refusing beats silently dropping; a `channels` shape that admitted N
//      messages from one delivery would close it.
//
//   4. DESCRIBE A CUSTOMER. There is no Graph route that reads a WhatsApp user's
//      profile from a `wa_id`: the only place a display name ever appears is
//      `contacts[].profile.name` on an inbound webhook, and `VerifiedDelivery`
//      has no slot to carry it. So `describePrincipal` answers with the number
//      and two nulls and OPENS NO SOCKET — which is the port's own shape for
//      "as far as the provider will describe one", not an omission. Refusing
//      instead would make a normal state look like a failure to the identity
//      linking path.
//
//   5. THE 24-HOUR WINDOW. A business may send free-form text only within 24
//      hours of the customer's last message; outside it Meta requires an approved
//      TEMPLATE. `OutboundMessage` carries text and no template name, so this
//      adapter sends text and reports Meta's refusal (a 4xx, REJECTED) when the
//      window has closed. Templates are a `channels` shape, not a transport
//      detail, so they are named here rather than invented.

import {
  adapterRejected,
  err,
  ok,
  type ChannelCredential,
  type ChannelPrincipal,
  type ChannelRuntime,
  type DeliveredMessage,
  type InboundVerificationSecret,
  type OutboundMessage,
  type Result,
  type SignedDelivery,
  type VerifiedDelivery,
} from "@platos/context-channels/application/ports/index.js";

import { normalizeWhatsAppDelivery } from "./normalize.js";
import { isMetaId, parseWhatsAppThreadKey, WHATSAPP_PROVIDER } from "./provider.js";
import { credentialIdentity, WhatsAppRateLimits } from "./rate-limit.js";
import {
  DEFAULT_SEND_TIMEOUT_MS,
  deliveredFrom,
  textMessageBody,
  whatsappCall,
  type WhatsAppTransport,
} from "./send.js";
import { WHATSAPP_GRAPH_URL, WHATSAPP_MAX_TEXT_LENGTH } from "./vendor.js";
import {
  verifyWhatsAppDelivery,
  verifyWhatsAppSubscription,
  type WhatsAppSubscriptionRequest,
  type WhatsAppSubscriptionSecret,
} from "./verify.js";

export interface ChannelWhatsAppAdapter extends ChannelRuntime {
  readonly adapterName: "channel-whatsapp";
  readonly provider: typeof WHATSAPP_PROVIDER;
  /**
   * Answer Meta's subscription handshake. See below for why it is not on the port.
   *
   * The handshake is a GET with NO BODY and NO SIGNATURE, authenticated by a
   * verify token that is a DIFFERENT secret from the app secret
   * (`verify.ts` gives each its own type so they cannot be swapped).
   * `verifyInbound` takes `SignedDelivery` — raw body plus headers — and there is
   * no body to give it; and `InboundVerificationSecret` has one slot, which the
   * app secret already occupies. So this sits beside the port rather than on it,
   * exactly as `channel-discord`'s `sendFollowup` does, and for the same kind of
   * reason: the port models what every provider has, and this is not that.
   *
   * The `Result` carries the CHALLENGE, which the transport must return as the
   * ENTIRE response body — not JSON, not quoted — or Meta refuses the
   * subscription and delivers no webhook ever.
   */
  verifySubscription(
    secret: WhatsAppSubscriptionSecret,
    request: WhatsAppSubscriptionRequest,
  ): Result<VerifiedDelivery>;
}

export interface ChannelWhatsAppOptions {
  /** How long one outbound call may take before it is abandoned. */
  readonly timeoutMs?: number;
  /** Graph's base. In-process only; see `send.ts`. */
  readonly graphUrl?: string;
  /** The `fetch` every call is made with. In-process only. */
  readonly fetch?: typeof fetch;
  /** The clock rate-limit windows and `deliveredAt` are measured on. In-process only. */
  readonly now?: () => number;
}

class WhatsAppRuntime implements ChannelWhatsAppAdapter {
  readonly adapterName = "channel-whatsapp" as const;
  readonly provider = WHATSAPP_PROVIDER;

  constructor(private readonly transport: WhatsAppTransport) {}

  async verifyInbound(
    secret: InboundVerificationSecret,
    delivery: SignedDelivery,
  ): Promise<Result<VerifiedDelivery>> {
    const verified = verifyWhatsAppDelivery(secret.secret, delivery);
    if (!verified.ok) return err(verified.error);
    return normalizeWhatsAppDelivery(delivery.rawBody, delivery.receivedAt);
  }

  verifySubscription(
    secret: WhatsAppSubscriptionSecret,
    request: WhatsAppSubscriptionRequest,
  ): Result<VerifiedDelivery> {
    const challenge = verifyWhatsAppSubscription(secret, request);
    if (!challenge.ok) return err(challenge.error);
    return ok(
      Object.freeze({
        provider: WHATSAPP_PROVIDER,
        kind: "handshake" as const,
        providerEventId: null,
        handshakeEcho: challenge.value,
        message: null,
        // The exact query that was verified, for the same reason
        // `VerifiedDelivery.verifiedBody` carries the exact body: what is
        // recorded is provably what was checked.
        verifiedBody: request.rawQuery,
      }),
    );
  }

  async send(credential: ChannelCredential, message: OutboundMessage): Promise<Result<DeliveredMessage>> {
    const address = parseWhatsAppThreadKey(message.channelThreadKey);
    if (address === null) {
      return err(adapterRejected(WHATSAPP_PROVIDER, "channelThreadKey is not a WhatsApp thread key"));
    }
    if (message.replacesProviderMessageId !== null) {
      // See 1 in the header. The refusal is the point: there is no edit route.
      return err(adapterRejected(WHATSAPP_PROVIDER, "WhatsApp Cloud API cannot edit a sent message"));
    }
    if (message.text.length > WHATSAPP_MAX_TEXT_LENGTH) {
      return err(
        adapterRejected(WHATSAPP_PROVIDER, `text exceeds the ${WHATSAPP_MAX_TEXT_LENGTH} character limit`),
      );
    }
    const answer = await whatsappCall(this.transport, {
      method: "POST",
      path: `${address.phoneNumberId}/messages`,
      token: credential.token,
      body: textMessageBody(address.waId, message.text),
      operation: "write",
      route: {
        identity: credentialIdentity(credential.token),
        phoneNumberId: address.phoneNumberId,
        recipient: address.waId,
      },
    });
    return answer.ok ? deliveredFrom(answer.value, this.transport.now()) : err(answer.error);
  }

  async describePrincipal(
    _credential: ChannelCredential,
    providerUserId: string,
  ): Promise<Result<ChannelPrincipal>> {
    if (!isMetaId(providerUserId)) {
      return err(adapterRejected(WHATSAPP_PROVIDER, "providerUserId is not a WhatsApp id"));
    }
    // NO CALL IS MADE. See 4 in the header: Meta publishes no route that reads a
    // customer's profile from a `wa_id`, so the honest answer is the number and
    // two nulls, and inventing a request that would 400 would be worse.
    return ok({ providerUserId, displayName: null, email: null });
  }

  async verifyCredential(credential: ChannelCredential): Promise<Result<void>> {
    const answer = await whatsappCall(this.transport, {
      method: "GET",
      // The token's OWN node. It is the only read this adapter can make with a
      // `ChannelCredential` alone: every WhatsApp route needs a phone number id,
      // and the port hands `verifyCredential` no conversation to take one from.
      path: "me",
      token: credential.token,
      body: null,
      operation: "read",
      route: { identity: credentialIdentity(credential.token), phoneNumberId: "me", recipient: null },
    });
    if (!answer.ok) return err(answer.error);
    // A 200 whose body names no node is not Graph confirming the token.
    return typeof answer.value["id"] === "string"
      ? ok(undefined)
      : err(adapterRejected(WHATSAPP_PROVIDER, "token probe answered with no node id"));
  }
}

/** Build the adapter. Total over its options: nothing to parse, nothing to open. */
export function createChannelWhatsAppAdapter(options: ChannelWhatsAppOptions = {}): ChannelWhatsAppAdapter {
  const now = options.now ?? (() => Date.now());
  return new WhatsAppRuntime(
    Object.freeze({
      graphUrl: options.graphUrl ?? WHATSAPP_GRAPH_URL,
      timeoutMs: options.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS,
      // Bound to `globalThis` at construction; an unbound `fetch` throws
      // "Illegal invocation" when called through a property.
      fetch: options.fetch ??
        (((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
          globalThis.fetch(input, init)) as typeof fetch),
      limits: new WhatsAppRateLimits(now),
      now,
    }),
  );
}
