// THE WHOLE INBOUND USE CASE, WITH WHATSAPP'S REAL RUNTIME BEHIND THE PORT.
//
// `admitSignedDelivery` is `channels`' own use case — raw bytes in, an inbox row
// or a refusal out — reached through the harness the context publishes from its
// testing entry point for exactly this purpose. The store is the context's
// in-memory one; the verification, the parse and the normalization are this
// adapter's production code over bytes signed the way Meta signs them.
//
// THIS SUITE CARRIES THE DEFENCE `verify.ts` DECLINED TO BUILD. There is no
// replay window for WhatsApp — Meta signs no timestamp, and a window over the
// customer's send time would throw away the redeliveries an outage caused. What
// replaces it is here: admission keys on the provider's own `wamid`, so a
// captured body replayed a thousand times, a week later, is ONE row and ONE turn.
// That is the property a window would only have approximated.
//
// WHAT THIS SUITE CANNOT SHOW, STATED AS AN ASSERTION RATHER THAN A FOOTNOTE.
// The use case resolves a `ChannelApp` and asks the registry for `app.provider`.
// `APP_PROVIDERS` in `domain/provider.ts` is `["slack"]`, and
// `postgres-tenancy`'s `requireAppProvider` refuses to READ an app row naming any
// other provider. So the app below — `provider: "whatsapp"` — is a state the
// in-memory store holds and the production store will not return: this suite
// proves that the USE CASE is correct with a WhatsApp runtime behind the port,
// and it does NOT prove a WhatsApp delivery can be admitted in production. That
// needs a decision inside `channels` (admit `whatsapp` as an app provider, or an
// inbox keyed on a direct connection), which this lane does not make. The last
// case fails the day that decision lands, so this cast cannot outlive the gap it
// papers over.

import { APP_PROVIDERS, type ChannelApp } from "@platos/context-channels/application/ports/index.js";
import {
  buildApp,
  buildChannelsTestContext,
  inboundHarness,
  type ChannelsTestContext,
} from "@platos/context-channels/application/testing/index.js";
import { beforeEach, describe, expect, it } from "vitest";

import { createChannelWhatsAppAdapter } from "./adapter.js";
import {
  FIXTURE_APP_SECRET,
  FIXTURE_INSTANT,
  OTHER_CUSTOMER_BODY,
  SECOND_TEXT_MESSAGE_BODY,
  signWhatsAppDelivery,
  STATUS_BODY,
  TEXT_MESSAGE_BODY,
} from "./fixtures.js";

const secret = { secret: FIXTURE_APP_SECRET };
/** See the header: a state the production store refuses to read. */
const WHATSAPP_APP_PROVIDER = "whatsapp" as unknown as ChannelApp["provider"];

let context: ChannelsTestContext;
let harness: ReturnType<typeof inboundHarness>;

beforeEach(() => {
  context = buildChannelsTestContext();
  const app = buildApp({ provider: WHATSAPP_APP_PROVIDER });
  context.repository.seedApp(app);
  context.runtimes.register(createChannelWhatsAppAdapter());
  harness = inboundHarness({ dependencies: context.dependencies, appId: app.appId, secret });
});

function deliver(body: string, receivedAt = FIXTURE_INSTANT) {
  return harness.admit(signWhatsAppDelivery(body, { receivedAt }));
}

describe("a webhook delivered twice", () => {
  it("is admitted ONCE and acknowledged BOTH times, as the same row", async () => {
    // Meta retries any delivery it did not get a 2xx for, with backoff, for days
    // — and a proxy, a load balancer or this process's own transport can deliver
    // the same signed bytes twice as well. The `wamid` is Meta's identity for the
    // message, so the second is the first.
    const first = await deliver(TEXT_MESSAGE_BODY);
    const second = await deliver(TEXT_MESSAGE_BODY);
    expect([first.outcome, second.outcome]).toEqual(["admitted", "admitted"]);
    expect([first.duplicate, second.duplicate]).toEqual([false, true]);
    expect(second.inboxId).toBe(first.inboxId);
    expect(context.repository.events.size).toBe(1);
  });

  it("is still one row when the redelivery arrives A WEEK LATER", async () => {
    // THE CASE THAT REPLACES A REPLAY WINDOW. With no window there is nothing to
    // expire, so a captured body stays verifiable forever — and that is safe
    // precisely because admission is keyed on the provider's id and not on the
    // bytes' freshness. A window would have refused this delivery; the inbox
    // absorbs it instead, which is also the right answer for Meta's own retries.
    await deliver(TEXT_MESSAGE_BODY);
    const week = new Date(FIXTURE_INSTANT.getTime() + 7 * 24 * 3_600_000);
    const again = await deliver(TEXT_MESSAGE_BODY, week);
    expect(again.duplicate).toBe(true);
    expect(context.repository.events.size).toBe(1);
  });

  it("keys on the wamid, so two messages in one conversation are two events", async () => {
    await deliver(TEXT_MESSAGE_BODY);
    await deliver(SECOND_TEXT_MESSAGE_BODY);
    expect(context.repository.events.size).toBe(2);
  });

  it("keeps two customers on one line as two events", async () => {
    await deliver(TEXT_MESSAGE_BODY);
    await deliver(OTHER_CUSTOMER_BODY);
    expect(context.repository.events.size).toBe(2);
  });

  it("stores the exact verified bytes, sealed", async () => {
    const admitted = await deliver(TEXT_MESSAGE_BODY);
    const stored = context.repository.events.get(admitted.inboxId ?? "");
    expect(stored?.payload.ciphertext).not.toBe(TEXT_MESSAGE_BODY);
    const opened = await context.cipher.open(stored!.payload);
    expect(opened.ok && opened.value).toBe(TEXT_MESSAGE_BODY);
  });
});

describe("a delivery that does not verify never reaches the store", () => {
  it("refuses a forged body", async () => {
    const genuine = signWhatsAppDelivery(TEXT_MESSAGE_BODY);
    const outcome = await harness.admit({
      ...genuine,
      rawBody: TEXT_MESSAGE_BODY.replace("river", "sewer"),
    });
    expect(outcome.refusedWith).toBe("CHANNELS_SIGNATURE_INVALID");
    expect(context.repository.events.size).toBe(0);
  });

  it("refuses an unsigned body that would parse perfectly, before anything reads it", async () => {
    const outcome = await harness.admit({ rawBody: TEXT_MESSAGE_BODY, headers: {}, receivedAt: FIXTURE_INSTANT });
    expect(outcome.refusedWith).toBe("CHANNELS_SIGNATURE_ABSENT");
    expect(context.repository.events.size).toBe(0);
  });
});

describe("a status callback is acknowledged, not admitted", () => {
  it("drops a delivery receipt rather than queueing a turn for it", async () => {
    const outcome = await deliver(STATUS_BODY);
    expect(outcome.outcome).toBe("ignored");
    expect(context.repository.events.size).toBe(0);
  });
});

describe("a WhatsApp app with no WhatsApp runtime composed", () => {
  it("is refused UNSUPPORTED, a composition gap and not an authentication failure", async () => {
    const bare = buildChannelsTestContext();
    const app = buildApp({ provider: WHATSAPP_APP_PROVIDER });
    bare.repository.seedApp(app);
    const outcome = await inboundHarness({ dependencies: bare.dependencies, appId: app.appId, secret }).admit(
      signWhatsAppDelivery(TEXT_MESSAGE_BODY),
    );
    expect(outcome.refusedWith).toBe("CHANNELS_PROVIDER_UNSUPPORTED");
  });
});

describe("the Core gap this suite papers over", () => {
  it("is still open: channels admits no WhatsApp app, so production cannot reach the cases above", () => {
    // WHEN THIS FAILS, a change inside `channels` has admitted more app
    // providers. Delete `WHATSAPP_APP_PROVIDER`'s cast and seed a real app.
    expect(APP_PROVIDERS).toEqual(["slack"]);
  });
});
