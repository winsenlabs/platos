// A VERIFIED SLACK BODY BECOMES THIS CONTEXT'S SHAPE — and the three kinds are
// three, not two.
//
// Every case here goes through `verifyInbound`, so a real HMAC over real bytes
// runs first. That is deliberate: normalization is only ever reached by a
// delivery that authenticated, and a suite that called the normalizer directly
// would be able to assert behaviour on bodies the adapter would never see.

import { extractPlatformChannelId } from "@platos/context-channels/application/ports/index.js";
import { describe, expect, it } from "vitest";

import { createChannelSlackAdapter } from "./adapter.js";
import {
  APP_MENTION_BODY,
  BOT_ECHO_BODY,
  DIRECT_MESSAGE_BODY,
  FIXTURE_SIGNING_SECRET,
  MESSAGE_CHANGED_BODY,
  NO_EVENT_ID_BODY,
  REACTION_BODY,
  THREAD_REPLY_BODY,
  URL_VERIFICATION_BODY,
  signSlackDelivery,
} from "./fixtures.js";

const adapter = createChannelSlackAdapter();
const secret = { secret: FIXTURE_SIGNING_SECRET };

async function verify(body: string) {
  const outcome = await adapter.verifyInbound(secret, signSlackDelivery(body));
  if (!outcome.ok) throw new Error(`expected acceptance, got ${outcome.error.code}`);
  return outcome.value;
}

describe("an endpoint challenge is answered, never admitted", () => {
  it("is a handshake carrying the exact challenge and no event id", async () => {
    const delivery = await verify(URL_VERIFICATION_BODY);
    expect(delivery.kind).toBe("handshake");
    expect(delivery.handshakeEcho).toBe(
      (JSON.parse(URL_VERIFICATION_BODY) as { challenge: string }).challenge,
    );
    // Admitting a handshake would need an invented idempotency key, and there
    // is no honest one to invent.
    expect(delivery.providerEventId).toBeNull();
    expect(delivery.message).toBeNull();
  });
});

describe("a message becomes an InboundMessage", () => {
  it("carries the provider's own event id as the admission key", async () => {
    const delivery = await verify(APP_MENTION_BODY);
    expect(delivery.kind).toBe("message");
    expect(delivery.providerEventId).toBe("Ev0MDYGDK4");
  });

  it("renders a thread key the DOMAIN can read the channel back out of", async () => {
    // THE JOIN THAT MATTERS. `domain/inbound.ts::extractPlatformChannelId` is
    // what a `channel` routing rule matches on, and it takes the SECOND
    // colon-separated segment. A key rendered in any other shape makes every
    // channel-scoped routing rule silently stop matching — with no error
    // anywhere, because the rule simply never fires. So the assertion is not
    // "the key looks like this"; it is that the domain's own reader recovers the
    // channel id this adapter put in.
    const delivery = await verify(APP_MENTION_BODY);
    const key = delivery.message?.channelThreadKey ?? "";
    expect(extractPlatformChannelId(key)).toBe("C0LAN2Q65");
    expect(delivery.message?.platformChannelId).toBe("C0LAN2Q65");
  });

  it("gives a thread reply the SAME key as the message that opened the thread", async () => {
    // One channel conversation maps to exactly one Platos thread, forever. If a
    // reply produced a different key it would open a second thread and split the
    // transcript, which is the failure `threadLinkConflict` exists to name.
    const opener = await verify(APP_MENTION_BODY);
    const reply = await verify(THREAD_REPLY_BODY);
    expect(reply.message?.channelThreadKey).toBe(opener.message?.channelThreadKey);
    expect(reply.providerEventId).not.toBe(opener.providerEventId);
  });

  it("keys a direct message on the DM conversation", async () => {
    const delivery = await verify(DIRECT_MESSAGE_BODY);
    expect(delivery.kind).toBe("message");
    expect(extractPlatformChannelId(delivery.message?.channelThreadKey ?? "")).toBe("D024BE91L");
  });

  it("leaves the end user unlinked, because channels never writes an identity row", async () => {
    const delivery = await verify(DIRECT_MESSAGE_BODY);
    expect(delivery.message?.endUserId).toBeNull();
  });

  it("stores the bytes that were VERIFIED, unchanged", async () => {
    const delivery = await verify(APP_MENTION_BODY);
    expect(delivery.verifiedBody).toBe(APP_MENTION_BODY);
  });
});

describe("the delivery that would loop forever", () => {
  it("ignores the app's OWN message coming back", async () => {
    // Slack delivers what the app just posted back to the app. Admitting it
    // starts a turn, whose reply is posted, which is delivered, which starts a
    // turn — a model call each time round, visible to the customer as the
    // assistant talking to itself.
    const delivery = await verify(BOT_ECHO_BODY);
    expect(delivery.kind).toBe("ignorable");
    expect(delivery.providerEventId).toBeNull();
  });

  it("ignores an edit of a message already answered", async () => {
    const delivery = await verify(MESSAGE_CHANGED_BODY);
    expect(delivery.kind).toBe("ignorable");
  });

  it("ignores an event type this build has no behaviour for", async () => {
    const delivery = await verify(REACTION_BODY);
    expect(delivery.kind).toBe("ignorable");
  });
});

describe("a message with nothing to deduplicate on is REFUSED, not ignored", () => {
  it("refuses rather than admitting a row a redelivery could not collide with", async () => {
    const outcome = await adapter.verifyInbound(secret, signSlackDelivery(NO_EVENT_ID_BODY));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.error.code).toBe("CHANNELS_EVENT_PAYLOAD_INVALID");
  });

  it("refuses a verified body that is not JSON at all, as an INPUT defect", async () => {
    // It verified, so Slack really sent it — that is not an authentication
    // problem and must not be reported as one, or an operator goes looking for a
    // forged request that never happened.
    const outcome = await adapter.verifyInbound(secret, signSlackDelivery("{not json"));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.error.code).toBe("CHANNELS_EVENT_PAYLOAD_INVALID");
    expect(outcome.ok ? null : outcome.error.category).toBe("invalid_input");
  });
});

describe("no vendor type crosses the port", () => {
  it("returns only the fields the port declares", async () => {
    // The SDK's payload carries `raw`, `continuation`, `teamId`, `apiAppId`,
    // `files` and a dozen more. A `VerifiedDelivery` that leaked any of them
    // would put a vendor shape on a surface `channels` reads, which is the whole
    // thing this port exists to prevent.
    const delivery = await verify(APP_MENTION_BODY);
    expect(Object.keys(delivery).sort()).toEqual([
      "handshakeEcho",
      "kind",
      "message",
      "provider",
      "providerEventId",
      "verifiedBody",
    ]);
    expect(Object.keys(delivery.message ?? {}).sort()).toEqual([
      "channelThreadKey",
      "endUserId",
      "platformChannelId",
      "receivedAt",
      "text",
    ]);
  });
});
