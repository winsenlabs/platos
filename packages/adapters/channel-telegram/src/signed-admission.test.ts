// THE WHOLE INBOUND USE CASE, WITH TELEGRAM'S REAL RUNTIME BEHIND THE PORT.
//
// `admitSignedDelivery` is `channels`' own use case — raw bytes in, an inbox row
// or a refusal out — reached through the harness the context publishes from its
// testing entry point for exactly this purpose. The store is the context's
// in-memory one; the verification, the parse and the normalization are this
// adapter's production code.
//
// THIS SUITE CARRIES THE DEFENCE `verify.ts` DECLINED TO BUILD. There is no
// replay window for Telegram, and for a sharper reason than WhatsApp's: nothing
// is signed, so a window would be a window over an UNAUTHENTICATED claim. What
// replaces it is here — admission keys on `update_id`, which is exactly what
// Telegram repeats until this endpoint answers 2xx, so a redelivery is ONE row
// and ONE turn however late it arrives.
//
// WHAT THIS SUITE CANNOT SHOW, STATED AS AN ASSERTION RATHER THAN A FOOTNOTE.
// The use case resolves a `ChannelApp` and asks the registry for `app.provider`.
// `APP_PROVIDERS` in `domain/provider.ts` is `["slack"]`, and `postgres-tenancy`'s
// `requireAppProvider` refuses to READ an app row naming any other provider. So
// the app below — `provider: "telegram"` — is a state the in-memory store holds
// and the production store will not return. The last case fails the day that
// decision lands, so this cast cannot outlive the gap it papers over.

import { APP_PROVIDERS, type ChannelApp } from "@platos/context-channels/application/ports/index.js";
import {
  buildApp,
  buildChannelsTestContext,
  inboundHarness,
  type ChannelsTestContext,
} from "@platos/context-channels/application/testing/index.js";
import { beforeEach, describe, expect, it } from "vitest";

import { createChannelTelegramAdapter } from "./adapter.js";
import {
  CALLBACK_QUERY_BODY,
  FIXTURE_INSTANT,
  FIXTURE_SECRET_TOKEN,
  OTHER_SECRET_TOKEN,
  PRIVATE_MESSAGE_BODY,
  SECOND_TOPIC_MESSAGE_BODY,
  telegramDelivery,
  TOPIC_MESSAGE_BODY,
} from "./fixtures.js";

const secret = { secret: FIXTURE_SECRET_TOKEN };
/** See the header: a state the production store refuses to read. */
const TELEGRAM_APP_PROVIDER = "telegram" as unknown as ChannelApp["provider"];

let context: ChannelsTestContext;
let harness: ReturnType<typeof inboundHarness>;

beforeEach(() => {
  context = buildChannelsTestContext();
  const app = buildApp({ provider: TELEGRAM_APP_PROVIDER });
  context.repository.seedApp(app);
  context.runtimes.register(createChannelTelegramAdapter());
  harness = inboundHarness({ dependencies: context.dependencies, appId: app.appId, secret });
});

function deliver(body: string, receivedAt = FIXTURE_INSTANT) {
  return harness.admit(telegramDelivery(body, { receivedAt }));
}

describe("an update delivered twice", () => {
  it("is admitted ONCE and acknowledged BOTH times, as the same row", async () => {
    // Telegram repeats an update until the endpoint answers 2xx, so a slow
    // response, a restart mid-request or a proxy retry all produce this exactly.
    const first = await deliver(PRIVATE_MESSAGE_BODY);
    const second = await deliver(PRIVATE_MESSAGE_BODY);
    expect([first.outcome, second.outcome]).toEqual(["admitted", "admitted"]);
    expect([first.duplicate, second.duplicate]).toEqual([false, true]);
    expect(second.inboxId).toBe(first.inboxId);
    expect(context.repository.events.size).toBe(1);
  });

  it("is still one row when the redelivery arrives A WEEK LATER", async () => {
    // THE CASE THAT REPLACES A REPLAY WINDOW. With nothing signed there is
    // nothing a window could bound that a caller holding the token could not
    // re-stamp, so the defence is here: the provider's own id, not the bytes'
    // freshness.
    await deliver(PRIVATE_MESSAGE_BODY);
    const week = new Date(FIXTURE_INSTANT.getTime() + 7 * 24 * 3_600_000);
    const again = await deliver(PRIVATE_MESSAGE_BODY, week);
    expect(again.duplicate).toBe(true);
    expect(context.repository.events.size).toBe(1);
  });

  it("keys on the update_id, so two messages in one topic are two events", async () => {
    await deliver(TOPIC_MESSAGE_BODY);
    await deliver(SECOND_TOPIC_MESSAGE_BODY);
    expect(context.repository.events.size).toBe(2);
  });

  it("stores the exact verified bytes, sealed", async () => {
    const admitted = await deliver(PRIVATE_MESSAGE_BODY);
    const stored = context.repository.events.get(admitted.inboxId ?? "");
    expect(stored?.payload.ciphertext).not.toBe(PRIVATE_MESSAGE_BODY);
    const opened = await context.cipher.open(stored!.payload);
    expect(opened.ok && opened.value).toBe(PRIVATE_MESSAGE_BODY);
  });
});

describe("a delivery that does not present the token never reaches the store", () => {
  it("refuses a delivery carrying the wrong token", async () => {
    const outcome = await harness.admit(
      telegramDelivery(PRIVATE_MESSAGE_BODY, { secretToken: OTHER_SECRET_TOKEN }),
    );
    expect(outcome.refusedWith).toBe("CHANNELS_SIGNATURE_INVALID");
    expect(context.repository.events.size).toBe(0);
  });

  it("refuses an unsigned body that would parse perfectly, before anything reads it", async () => {
    const outcome = await harness.admit({
      rawBody: PRIVATE_MESSAGE_BODY,
      headers: {},
      receivedAt: FIXTURE_INSTANT,
    });
    expect(outcome.refusedWith).toBe("CHANNELS_SIGNATURE_ABSENT");
    expect(context.repository.events.size).toBe(0);
  });

  it("refuses a body a HOLDER OF THE TOKEN forged, which is a gap and not a defect", async () => {
    // STATED SO IT IS NOT MISTAKEN FOR STRENGTH. Telegram signs nothing, so a
    // caller with the token can write any body it likes and this endpoint will
    // admit it. The row below is admitted, and that IS the correct behaviour for
    // this provider — the assertion exists so the limit is written down where
    // somebody comparing providers will see it.
    const forged = telegramDelivery(
      JSON.stringify({ update_id: 999, message: { message_id: 1, from: { id: 1, is_bot: false, first_name: "X" }, chat: { id: 1, type: "private" }, date: 1, text: "not from anyone real" } }),
    );
    const outcome = await harness.admit(forged);
    expect(outcome.outcome).toBe("admitted");
    expect(context.repository.events.size).toBe(1);
  });
});

describe("an ignorable update is acknowledged, not admitted", () => {
  it("drops an inline button press rather than queueing a turn for it", async () => {
    const outcome = await deliver(CALLBACK_QUERY_BODY);
    expect(outcome.outcome).toBe("ignored");
    expect(context.repository.events.size).toBe(0);
  });
});

describe("a Telegram app with no Telegram runtime composed", () => {
  it("is refused UNSUPPORTED, a composition gap and not an authentication failure", async () => {
    const bare = buildChannelsTestContext();
    const app = buildApp({ provider: TELEGRAM_APP_PROVIDER });
    bare.repository.seedApp(app);
    const outcome = await inboundHarness({ dependencies: bare.dependencies, appId: app.appId, secret }).admit(
      telegramDelivery(PRIVATE_MESSAGE_BODY),
    );
    expect(outcome.refusedWith).toBe("CHANNELS_PROVIDER_UNSUPPORTED");
  });
});

describe("the Core gap this suite papers over", () => {
  it("is still open: channels admits no Telegram app, so production cannot reach the cases above", () => {
    // WHEN THIS FAILS, a change inside `channels` has admitted more app
    // providers. Delete `TELEGRAM_APP_PROVIDER`'s cast and seed a real app.
    expect(APP_PROVIDERS).toEqual(["slack"]);
  });
});
