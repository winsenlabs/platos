// PROVIDER FIXTURES: WhatsApp Cloud API webhook bodies, and a signer for them.
//
// WHY THE SIGNER IS NOT A CIRCULAR ASSERTION. `signWhatsAppDelivery` signs with
// `whatsappSignatureHeader` — the construction under test — so on its own it
// would be two copies of one formula agreeing. It is not on its own:
//
//   RFC 4231's published vectors  ==  node:crypto's createHmac
//                                     (`rfc4231.test.ts`, all seven vectors)
//   RFC 4231's published vectors  ==  an HMAC built HERE from node:crypto's raw
//                                     SHA-256, exactly as RFC 2104 §2 writes it
//                                     (`rfc4231.test.ts`, the same seven)
//   that independent HMAC         ==  this construction
//                                     (`whatsapp-signature.test.ts`: every
//                                     fixture below is re-signed by the
//                                     INDEPENDENT implementation and the adapter
//                                     must accept it, and a body signed the wrong
//                                     way must be refused by both)
//
// so the agreement that matters is between an IETF standard, `node:crypto`, and a
// second HMAC written from a different primitive. `rfc4231-vectors.ts` states why
// that stands in for the published vendor vector `channel-slack` has and Meta
// does not publish.
//
// THE BODIES ARE META'S SHAPES — the fields `Cloud API / Webhooks / components`
// documents: `object`, `entry[].id`, `entry[].changes[].field`, and inside
// `value` the `messaging_product`, `metadata.display_phone_number`,
// `metadata.phone_number_id`, `contacts[].profile.name`, `contacts[].wa_id`,
// `messages[]` with `from`, `id`, `timestamp`, `type` and `text.body`, and
// `statuses[]` with `id`, `status`, `recipient_id` and `conversation`.
//
// NOTHING HERE AUTHENTICATES ANYTHING. The app secret and the verify token below
// are fixture strings this repository invented for these bytes; no Meta app has
// ever held either, and the phone numbers are in the +1 555 range reserved for
// fiction.

import type { SignedDelivery } from "@platos/context-channels/application/ports/index.js";

import { WHATSAPP_SIGNATURE_HEADER } from "./vendor.js";
import { whatsappSignatureHeader } from "./verify.js";

/** The app secret every fixture is signed with. A fixture, never a credential. */
export const FIXTURE_APP_SECRET = "platos-fixture-app-secret-0123456789abcdef";

/** A second, equally inert secret — a real secret that did NOT sign the fixtures. */
export const OTHER_APP_SECRET = "platos-fixture-app-secret-fedcba9876543210";

/** The verify token the subscription handshake is answered against. */
export const FIXTURE_VERIFY_TOKEN = "platos-fixture-verify-token-0123456789abcdef";

export const FIXTURE_INSTANT = new Date("2026-05-01T09:00:00.000Z");

/** The business line: its Graph node id and the number it displays. */
export const PHONE_NUMBER_ID = "106540352242922";
export const DISPLAY_PHONE_NUMBER = "15550783881";
/** A SECOND line on the same business account — a different channel entirely. */
export const OTHER_PHONE_NUMBER_ID = "106540352242999";

/** Two customers on that line. Both are +1 555 numbers reserved for fiction. */
export const CUSTOMER_WA_ID = "15551234567";
export const OTHER_CUSTOMER_WA_ID = "15557654321";

/** Sign a raw body the way Meta does and present it as a delivery. */
export function signWhatsAppDelivery(
  rawBody: string,
  options: { readonly appSecret?: string; readonly receivedAt?: Date } = {},
): SignedDelivery {
  return {
    rawBody,
    headers: {
      [WHATSAPP_SIGNATURE_HEADER]: whatsappSignatureHeader(options.appSecret ?? FIXTURE_APP_SECRET, rawBody),
    },
    receivedAt: options.receivedAt ?? FIXTURE_INSTANT,
  };
}

const SENT_AT = String(Math.floor(FIXTURE_INSTANT.getTime() / 1000));

function envelope(value: Record<string, unknown>, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "102290129340398",
        changes: [{ value, field: "messages" }],
      },
    ],
    ...overrides,
  });
}

function messagesValue(
  messages: readonly Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    metadata: { display_phone_number: DISPLAY_PHONE_NUMBER, phone_number_id: PHONE_NUMBER_ID },
    contacts: [{ profile: { name: "River Watcher" }, wa_id: CUSTOMER_WA_ID }],
    messages,
    ...overrides,
  };
}

function textMessage(id: string, body: string, from = CUSTOMER_WA_ID): Record<string, unknown> {
  return { from, id, timestamp: SENT_AT, type: "text", text: { body } };
}

/** A customer writes to the business line. */
export const TEXT_MESSAGE_BODY = envelope(
  messagesValue([textMessage("wamid.HBgLMTU1NTEyMzQ1NjcVAgASGBQzQTAwMDAwMDAwMDAwMDAwMDEwMQA=", "is it everything a river should be?")]),
);

/** A LATER message from the SAME customer on the SAME line. One conversation. */
export const SECOND_TEXT_MESSAGE_BODY = envelope(
  messagesValue([textMessage("wamid.HBgLMTU1NTEyMzQ1NjcVAgASGBQzQTAwMDAwMDAwMDAwMDAwMDEwMgA=", "and the second half?")]),
);

/** A DIFFERENT customer on the SAME line. A different conversation, same channel. */
export const OTHER_CUSTOMER_BODY = envelope(
  messagesValue(
    [textMessage("wamid.HBgLMTU1NTc2NTQzMjEVAgASGBQzQTAwMDAwMDAwMDAwMDAwMDIwMQA=", "different person", OTHER_CUSTOMER_WA_ID)],
    { contacts: [{ profile: { name: "Other Watcher" }, wa_id: OTHER_CUSTOMER_WA_ID }] },
  ),
);

/** The SAME customer on a DIFFERENT line. A different channel entirely. */
export const OTHER_LINE_BODY = envelope(
  messagesValue([textMessage("wamid.HBgLMTU1NTEyMzQ1NjcVAgASGBQzQTAwMDAwMDAwMDAwMDAwMDMwMQA=", "other line")], {
    metadata: { display_phone_number: "15550783899", phone_number_id: OTHER_PHONE_NUMBER_ID },
  }),
);

/** A delivery status for a message the BUSINESS sent. Verified, real, no behaviour. */
export const STATUS_BODY = envelope({
  messaging_product: "whatsapp",
  metadata: { display_phone_number: DISPLAY_PHONE_NUMBER, phone_number_id: PHONE_NUMBER_ID },
  statuses: [
    {
      id: "wamid.HBgLMTU1NTEyMzQ1NjcVAgARGBI5QTAwMDAwMDAwMDAwMDAwMDEA",
      status: "delivered",
      timestamp: SENT_AT,
      recipient_id: CUSTOMER_WA_ID,
      conversation: { id: "conv-1", origin: { type: "service" } },
    },
  ],
});

/** An image message. Verified, real, no behaviour in this build. */
export const IMAGE_MESSAGE_BODY = envelope(
  messagesValue([
    {
      from: CUSTOMER_WA_ID,
      id: "wamid.HBgLMTU1NTEyMzQ1NjcVAgASGBQzQTAwMDAwMDAwMDAwMDAwMDQwMQA=",
      timestamp: SENT_AT,
      type: "image",
      image: { id: "1079845772872675", mime_type: "image/jpeg", sha256: "0000" },
    },
  ]),
);

/** A button reply from an interactive template. Also no behaviour here. */
export const INTERACTIVE_MESSAGE_BODY = envelope(
  messagesValue([
    {
      from: CUSTOMER_WA_ID,
      id: "wamid.HBgLMTU1NTEyMzQ1NjcVAgASGBQzQTAwMDAwMDAwMDAwMDAwMDUwMQA=",
      timestamp: SENT_AT,
      type: "interactive",
      interactive: { type: "button_reply", button_reply: { id: "retry", title: "Retry" } },
    },
  ]),
);

/** A Page delivery on the same endpoint — somebody else's subscription. */
export const OTHER_OBJECT_BODY = JSON.stringify({
  object: "page",
  entry: [{ id: "1", time: 1, messaging: [{ sender: { id: "2" } }] }],
});

/** A `whatsapp_business_account` change for a field this build does not serve. */
export const OTHER_FIELD_BODY = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "102290129340398",
      changes: [{ value: { event: "APPROVED", message_template_id: 1 }, field: "message_template_status_update" }],
    },
  ],
});

/** A message claiming to come FROM the business's own line. The loop guard's case. */
export const SELF_MESSAGE_BODY = envelope(
  messagesValue([
    textMessage("wamid.HBgLMTU1NTA3ODM4ODEVAgASGBQzQTAwMDAwMDAwMDAwMDAwMDYwMQA=", "loop?", DISPLAY_PHONE_NUMBER),
  ]),
);

/** TWO messages in one delivery. `VerifiedDelivery` holds one; see `normalize.ts`. */
export const BATCHED_MESSAGES_BODY = envelope(
  messagesValue([
    textMessage("wamid.HBgLMTU1NTEyMzQ1NjcVAgASGBQzQTAwMDAwMDAwMDAwMDAwMDcwMQA=", "first"),
    textMessage("wamid.HBgLMTU1NTEyMzQ1NjcVAgASGBQzQTAwMDAwMDAwMDAwMDAwMDcwMgA=", "second"),
  ]),
);

/** TWO entries in one delivery. The same refusal, one level up. */
export const BATCHED_ENTRIES_BODY = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [
    { id: "102290129340398", changes: [{ value: messagesValue([textMessage("wamid.A", "one")]), field: "messages" }] },
    { id: "102290129340399", changes: [{ value: messagesValue([textMessage("wamid.B", "two")]), field: "messages" }] },
  ],
});

/** TWO changes under one entry. The same refusal, in the middle. */
export const BATCHED_CHANGES_BODY = envelope(messagesValue([textMessage("wamid.C", "one")]), {
  entry: [
    {
      id: "102290129340398",
      changes: [
        { value: messagesValue([textMessage("wamid.C", "one")]), field: "messages" },
        { value: messagesValue([textMessage("wamid.D", "two")]), field: "messages" },
      ],
    },
  ],
});

/** A text message with no id. Cannot be deduplicated. */
export const NO_ID_BODY = envelope(
  messagesValue([{ from: CUSTOMER_WA_ID, timestamp: SENT_AT, type: "text", text: { body: "anyone?" } }]),
);

/** A text message whose line has no phone number id. Nowhere to answer from. */
export const NO_PHONE_NUMBER_ID_BODY = envelope(
  messagesValue([textMessage("wamid.E", "where from?")], {
    metadata: { display_phone_number: DISPLAY_PHONE_NUMBER },
  }),
);

/** A text message with no sender. Nobody to answer. */
export const NO_FROM_BODY = envelope(
  messagesValue([{ id: "wamid.F", timestamp: SENT_AT, type: "text", text: { body: "who?" } }]),
);

/** A hostile phone number id that would traverse if it ever became a path. */
export const HOSTILE_PHONE_NUMBER_ID_BODY = envelope(
  messagesValue([textMessage("wamid.G", "hostile")], {
    metadata: { display_phone_number: DISPLAY_PHONE_NUMBER, phone_number_id: "../me/accounts" },
  }),
);

/** Every fixture, for the suites that walk all of them. */
export const ALL_FIXTURE_BODIES: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["text_message", TEXT_MESSAGE_BODY],
  ["second_text_message", SECOND_TEXT_MESSAGE_BODY],
  ["other_customer", OTHER_CUSTOMER_BODY],
  ["other_line", OTHER_LINE_BODY],
  ["status", STATUS_BODY],
  ["image_message", IMAGE_MESSAGE_BODY],
  ["interactive_message", INTERACTIVE_MESSAGE_BODY],
  ["other_object", OTHER_OBJECT_BODY],
  ["other_field", OTHER_FIELD_BODY],
  ["self_message", SELF_MESSAGE_BODY],
  ["batched_messages", BATCHED_MESSAGES_BODY],
  ["batched_entries", BATCHED_ENTRIES_BODY],
  ["batched_changes", BATCHED_CHANGES_BODY],
  ["no_id", NO_ID_BODY],
  ["no_phone_number_id", NO_PHONE_NUMBER_ID_BODY],
  ["no_from", NO_FROM_BODY],
  ["hostile_phone_number_id", HOSTILE_PHONE_NUMBER_ID_BODY],
]);
