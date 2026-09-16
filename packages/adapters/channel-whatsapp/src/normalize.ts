// A verified WhatsApp webhook becomes a `VerifiedDelivery` — this context's
// shape, holding not one Meta field it did not ask for.
//
// WHAT ARRIVES HERE AT ALL. One signed POST from Meta's Graph webhook, carrying
// the envelope `Cloud API / Webhooks / components` documents:
//
//   { object, entry: [ { id, changes: [ { field, value } ] } ] }
//
// and, inside `value`, either `messages[]` (a customer wrote to the business) or
// `statuses[]` (a message this business sent was accepted, delivered, read or
// failed). The subscription handshake is NOT here: it is a GET with no body and
// no signature, and `adapter.ts` answers it beside the port.
//
// THREE OUTCOMES, AND THE RULES LIVE IN THE TWO THAT ARE NOT "MESSAGE".
//
// AN ENVELOPE THAT IS NOT THIS BUSINESS'S MESSAGES IS IGNORABLE, not an error.
// One Meta app can subscribe to several objects, and a `page` or `instagram`
// delivery, or a `messages` change carrying only `statuses`, is a real, verified,
// correctly signed event with no behaviour in this build. It must be ACKNOWLEDGED
// — Meta retries a non-2xx for days and eventually disables the subscription —
// and it must not be admitted, because admitting it would fill the inbox with
// rows no turn will ever run.
//
// A NON-TEXT MESSAGE IS IGNORABLE FOR THE SAME REASON. Images, audio, documents,
// locations, stickers, reactions, button and interactive replies all arrive on
// this endpoint. This build answers typed text; the rest are acknowledged and
// dropped rather than guessed into an empty prompt.
//
// THE BUSINESS'S OWN NUMBER IS IGNORED BEFORE ANYTHING ELSE IS READ, the same
// guard `channel-slack` and `channel-discord` state for their own self-originated
// deliveries and for the same cost: every other property of such a delivery looks
// ordinary, and the failure is an unbounded loop that costs a model call per turn.
//
// A DELIVERY CARRYING MORE THAN ONE MESSAGE IS REFUSED, AND THAT IS A CORE GAP
// RATHER THAN A DEFECT HERE. `VerifiedDelivery` holds ONE `providerEventId` and
// ONE `message`, because `admitSignedDelivery` writes one inbox row per delivery.
// Meta's schema is an ARRAY at three levels — `entry[]`, `changes[]`,
// `messages[]` — and it does batch under load. Normalizing the first and dropping
// the rest would lose a customer's message with no error anywhere, which is the
// one outcome worse than refusing. So a batched delivery is
// `CHANNELS_EVENT_PAYLOAD_INVALID` with a reason that names the batch, the
// transport answers non-2xx, and Meta redelivers — and `adapter.ts` records it
// among what this directory cannot do without a change inside `channels`.
// `normalize.test.ts` pins it, and that case fails the day the port gains a
// multi-message shape.
//
// A MESSAGE WITH NO ID, NO SENDER OR NO PHONE NUMBER ID IS REFUSED, NOT IGNORED.
// The id is the admission idempotency key, the sender and the line are the
// conversation; without any of them a redelivery cannot be recognised or the
// reply has nowhere to go.

import {
  admitChannelThreadKey,
  err,
  eventPayloadInvalid,
  ok,
  type ProviderEventId,
  type Result,
  type VerifiedDelivery,
} from "@platos/context-channels/application/ports/index.js";

import { isMetaId, WHATSAPP_PROVIDER, whatsappThreadKey } from "./provider.js";
import {
  WHATSAPP_MESSAGES_FIELD,
  WHATSAPP_TEXT_MESSAGE_TYPE,
  WHATSAPP_WEBHOOK_OBJECT,
} from "./vendor.js";

type Json = Readonly<Record<string, unknown>>;

function record(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function ignorable(verifiedBody: string): VerifiedDelivery {
  return Object.freeze({
    provider: WHATSAPP_PROVIDER,
    kind: "ignorable" as const,
    providerEventId: null,
    handshakeEcho: null,
    message: null,
    verifiedBody,
  });
}

/**
 * The grammar a `wamid` must pass to become an admission key.
 *
 * BOUNDED AND OPAQUE, AND DELIBERATELY NOT `^wamid\.`. Meta documents the prefix,
 * and this adapter does not depend on it: the id is never a path segment and
 * never a filename — it is an idempotency key and a stored column — so what
 * matters is that it is bounded, printable and has no room for a separator that
 * could collide two conversations. Requiring the documented prefix would make
 * every delivery fail the day Meta mints a second id shape, for no security gain.
 */
const PROVIDER_EVENT_ID = /^[A-Za-z0-9._\-=+/]{1,512}$/u;

/** Digits only, so `+1 555 078 3881` and `15550783881` compare equal. */
function digitsOf(value: unknown): string {
  return typeof value === "string" ? value.replace(/\D/gu, "") : "";
}

export function normalizeWhatsAppDelivery(verifiedBody: string, receivedAt: Date): Result<VerifiedDelivery> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(verifiedBody);
  } catch {
    // It VERIFIED, so Meta sent it: an input defect, never a signature one.
    return err(eventPayloadInvalid("verified WhatsApp body did not parse"));
  }
  const envelope = record(parsed);
  if (envelope === null) return err(eventPayloadInvalid("verified WhatsApp body is not a webhook envelope"));
  if (envelope["object"] !== WHATSAPP_WEBHOOK_OBJECT) return ok(ignorable(verifiedBody));

  const entries = list(envelope["entry"]);
  if (entries.length === 0) return ok(ignorable(verifiedBody));
  if (entries.length > 1) {
    return err(eventPayloadInvalid("verified WhatsApp delivery batches more than one entry"));
  }
  const entry = record(entries[0]);
  const changes = list(entry?.["changes"]);
  if (changes.length === 0) return ok(ignorable(verifiedBody));
  if (changes.length > 1) {
    return err(eventPayloadInvalid("verified WhatsApp delivery batches more than one change"));
  }
  const change = record(changes[0]);
  if (change?.["field"] !== WHATSAPP_MESSAGES_FIELD) return ok(ignorable(verifiedBody));

  const value = record(change["value"]);
  const messages = list(value?.["messages"]);
  // A `statuses` change, or a `messages` change with nothing in it. Real,
  // verified, and not something a turn runs for.
  if (messages.length === 0) return ok(ignorable(verifiedBody));
  if (messages.length > 1) {
    return err(eventPayloadInvalid("verified WhatsApp delivery batches more than one message"));
  }

  const metadata = record(value?.["metadata"]);
  const message = record(messages[0]);
  if (message === null) return err(eventPayloadInvalid("verified WhatsApp message is not an object"));

  const from = digitsOf(message["from"]);
  // THE LOOP GUARD, FIRST. `display_phone_number` is the business's own line; a
  // delivery claiming to come FROM it is either a misconfiguration or a loop, and
  // every other property of it looks ordinary.
  if (from !== "" && from === digitsOf(metadata?.["display_phone_number"])) {
    return ok(ignorable(verifiedBody));
  }

  if (message["type"] !== WHATSAPP_TEXT_MESSAGE_TYPE) return ok(ignorable(verifiedBody));

  const id = text(message["id"]);
  if (id === null || !PROVIDER_EVENT_ID.test(id)) {
    return err(eventPayloadInvalid("verified WhatsApp message carries no id to deduplicate on"));
  }
  const phoneNumberId = metadata?.["phone_number_id"];
  if (!isMetaId(phoneNumberId)) {
    return err(eventPayloadInvalid("verified WhatsApp message names no business phone number id"));
  }
  if (!isMetaId(from)) {
    return err(eventPayloadInvalid("verified WhatsApp message names no sender to answer"));
  }

  const key = admitChannelThreadKey(whatsappThreadKey({ phoneNumberId, waId: from }));
  if (!key.ok) return err(key.error);

  return ok(
    Object.freeze({
      provider: WHATSAPP_PROVIDER,
      kind: "message" as const,
      providerEventId: id as ProviderEventId,
      handshakeEcho: null,
      message: Object.freeze({
        channelThreadKey: key.value,
        // The LINE, not the customer — the thing a `channel` routing rule names.
        platformChannelId: phoneNumberId,
        text: text(record(message["text"])?.["body"]) ?? "",
        // `identity-access` owns the link from a WhatsApp number to an end user,
        // and this adapter must not guess at it.
        endUserId: null,
        receivedAt,
      }),
      verifiedBody,
    }),
  );
}
