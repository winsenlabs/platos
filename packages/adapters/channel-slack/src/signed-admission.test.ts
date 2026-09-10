// THE WHOLE INBOUND PATH, END TO END, WITH REAL CRYPTOGRAPHY IN THE MIDDLE.
//
// `admitSignedDelivery` is the use case WIN-271 moved verification into: raw
// bytes in, an inbox row (or a refusal) out. Its interesting property is that it
// is only as good as the runtime behind the port, so testing it against an
// in-memory runtime told to accept would prove nothing at all — the exact
// vacuity this tranche was told to avoid.
//
// So this suite lives HERE, in the adapter package, and wires the REAL Slack
// runtime into the context's own in-memory test fixture. The store is in memory
// (it is not what is under test); the signature check, the parse and the
// normalization are the production ones, over bytes signed the way Slack signs
// them.
//
// THE HEADLINE CASE IS THE REDELIVERY. Slack retries anything it did not see
// acknowledged within three seconds, so a duplicate is ORDINARY TRAFFIC rather
// than an attack. Two identical signed deliveries must produce ONE inbox row,
// and the second must come back as a SUCCESS — because only a 2xx makes the
// provider stop retrying, and refusing a duplicate keeps the retry loop alive
// forever on an event that was handled correctly the first time.

import { asIdentifier, type ChannelAppId } from "@platos/context-channels/application/ports/index.js";
import {
  buildApp,
  buildChannelsTestContext,
  inboundHarness,
  type ChannelsTestContext,
} from "@platos/context-channels/application/testing/index.js";
import { beforeEach, describe, expect, it } from "vitest";

import { createChannelSlackAdapter } from "./adapter.js";
import {
  APP_MENTION_BODY,
  BOT_ECHO_BODY,
  FIXTURE_INSTANT,
  FIXTURE_SIGNING_SECRET,
  REACTION_BODY,
  THREAD_REPLY_BODY,
  URL_VERIFICATION_BODY,
  signSlackDelivery,
} from "./fixtures.js";

const secret = { secret: FIXTURE_SIGNING_SECRET };

let context: ChannelsTestContext;
let harness: ReturnType<typeof inboundHarness>;

function harnessFor(built: ChannelsTestContext) {
  return inboundHarness({ dependencies: built.dependencies, appId: buildApp().appId, secret });
}

beforeEach(() => {
  context = buildChannelsTestContext();
  context.repository.seedApp(buildApp());
  // THE REAL RUNTIME, wired into the context's registry. Everything below runs
  // production verification code.
  context.runtimes.register(createChannelSlackAdapter());
  harness = harnessFor(context);
});

function deliver(body: string, receivedAt = FIXTURE_INSTANT) {
  return harness.admit(signSlackDelivery(body, { receivedAt }));
}

describe("a webhook that arrives twice", () => {
  it("is admitted ONCE and acknowledged BOTH times", async () => {
    const first = await deliver(APP_MENTION_BODY);
    const second = await deliver(APP_MENTION_BODY);

    expect(first.outcome).toBe("admitted");
    expect(second.outcome).toBe("admitted");
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    // THE SAME ROW, not a second one with the same content.
    expect(second.inboxId).toBe(first.inboxId);
    expect(context.repository.events.size).toBe(1);
  });

  it("keys the collision on the PROVIDER's event id, so the same text twice is two events", async () => {
    // Deduplicating on the body would be wrong in the direction nobody notices:
    // a user who genuinely says the same thing twice would get one answer.
    // `event_id` is the provider's own identity for a delivery, and the two
    // fixtures below differ in it while sharing a channel and a thread.
    await deliver(APP_MENTION_BODY);
    await deliver(THREAD_REPLY_BODY);
    expect(context.repository.events.size).toBe(2);
  });

  it("stores the exact verified bytes, sealed", async () => {
    const admitted = await deliver(APP_MENTION_BODY);
    expect(admitted.outcome).toBe("admitted");

    const stored = context.repository.events.get(admitted.inboxId ?? "");
    expect(stored).toBeDefined();
    // Never in cleartext — the provider body carries message text.
    expect(stored?.payload.ciphertext).not.toBe(APP_MENTION_BODY);
    const opened = await context.cipher.open(stored!.payload);
    expect(opened.ok && opened.value).toBe(APP_MENTION_BODY);
  });
});

describe("a delivery that does not verify never reaches the store", () => {
  it("refuses a forged body and admits nothing", async () => {
    const genuine = signSlackDelivery(APP_MENTION_BODY);
    const forged = { ...genuine, rawBody: APP_MENTION_BODY.replace("river", "sewer") };

    const outcome = await harness.admit(forged);
    expect(outcome.refusedWith).toBe("CHANNELS_SIGNATURE_INVALID");
    expect(context.repository.events.size).toBe(0);
  });

  it("refuses a replayed delivery and admits nothing", async () => {
    const hourLate = new Date(FIXTURE_INSTANT.getTime() + 3600_000);
    const outcome = await deliver(APP_MENTION_BODY, hourLate);
    expect(outcome.refusedWith).toBe("CHANNELS_SIGNATURE_STALE");
    expect(context.repository.events.size).toBe(0);
  });

  it("refuses a delivery for an app that is not there, before any cryptography", async () => {
    const elsewhere = inboundHarness({
      dependencies: context.dependencies,
      appId: buildApp({ appId: asIdentifier<ChannelAppId>("app-does-not-exist") }).appId,
      secret,
    });
    const outcome = await elsewhere.admit(signSlackDelivery(APP_MENTION_BODY));
    expect(outcome.refusedWith).toBe("CHANNELS_APP_NOT_FOUND");
  });
});

describe("a handshake and an ignorable delivery are acknowledged, not admitted", () => {
  it("echoes the endpoint challenge and writes no row", async () => {
    const outcome = await deliver(URL_VERIFICATION_BODY);
    expect(outcome.outcome).toBe("handshake");
    expect(outcome.echo).toBe((JSON.parse(URL_VERIFICATION_BODY) as { challenge: string }).challenge);
    expect(context.repository.events.size).toBe(0);
  });

  it("drops the app's own message rather than filling the inbox with a loop", async () => {
    const outcome = await deliver(BOT_ECHO_BODY);
    expect(outcome.outcome).toBe("ignored");
    expect(context.repository.events.size).toBe(0);
  });

  it("drops an event type with no behaviour rather than queueing a turn for it", async () => {
    const outcome = await deliver(REACTION_BODY);
    expect(outcome.outcome).toBe("ignored");
    expect(context.repository.events.size).toBe(0);
  });
});

describe("a provider with no adapter in this build", () => {
  it("is refused as UNSUPPORTED, which is a composition gap and not an auth failure", async () => {
    // The registry here is EMPTY, and empty because nothing was wired — not
    // because a double was told to refuse. That absence IS the condition
    // `CHANNELS_PROVIDER_UNSUPPORTED` names.
    const bare = buildChannelsTestContext();
    bare.repository.seedApp(buildApp());
    const outcome = await harnessFor(bare).admit(signSlackDelivery(APP_MENTION_BODY));
    expect(outcome.refusedWith).toBe("CHANNELS_PROVIDER_UNSUPPORTED");
  });
});

describe("verification happens before anything reads the body", () => {
  it("a body that would parse fine is still refused when it is not signed", async () => {
    // The ordering claim, made falsifiable. If the use case parsed first and
    // verified second, this delivery — perfectly well-formed, entirely unsigned
    // — would have been admitted before the signature was consulted.
    const outcome = await harness.admit({
      rawBody: APP_MENTION_BODY,
      headers: {},
      receivedAt: FIXTURE_INSTANT,
    });
    expect(outcome.refusedWith).toBe("CHANNELS_SIGNATURE_ABSENT");
    expect(context.repository.events.size).toBe(0);
  });
});
