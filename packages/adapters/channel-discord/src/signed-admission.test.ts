// THE WHOLE INBOUND USE CASE, WITH DISCORD'S REAL RUNTIME BEHIND THE PORT.
//
// `admitSignedDelivery` is `channels`' own use case — raw bytes in, an inbox row
// or a refusal out — reached through the harness the context publishes from its
// testing entry point for exactly this purpose. The store is the context's
// in-memory one; the verification, the parse and the normalization are this
// adapter's production code over bytes signed the way Discord signs them.
//
// WHAT THIS SUITE CANNOT SHOW, STATED AS AN ASSERTION RATHER THAN A FOOTNOTE.
// The use case resolves a `ChannelApp` and asks the registry for `app.provider`.
// `APP_PROVIDERS` in `domain/provider.ts` is `["slack"]`, and
// `postgres-tenancy`'s `requireAppProvider` refuses to READ an app row naming any
// other provider. So the app below — `provider: "discord"` — is a state the
// in-memory store holds and the production store will not return: this suite
// proves that the USE CASE is correct with a Discord runtime behind the port, and
// it does NOT prove a Discord delivery can be admitted in production. That needs
// a decision inside `channels` (admit Discord as an app provider, or an inbox
// keyed on a direct connection), which this lane does not make. The last case
// fails the day that decision lands, so this cast cannot outlive the gap it
// papers over.

import { APP_PROVIDERS, type ChannelApp } from "@platos/context-channels/application/ports/index.js";
import {
  buildApp,
  buildChannelsTestContext,
  inboundHarness,
  type ChannelsTestContext,
} from "@platos/context-channels/application/testing/index.js";
import { beforeEach, describe, expect, it } from "vitest";

import { createChannelDiscordAdapter } from "./adapter.js";
import {
  COMMAND_IN_CHANNEL_BODY,
  COMMAND_IN_THREAD_BODY,
  COMPONENT_BODY,
  FIXTURE_INSTANT,
  FIXTURE_PUBLIC_KEY,
  PING_BODY,
  SECOND_COMMAND_IN_THREAD_BODY,
  signDiscordDelivery,
} from "./fixtures.js";

const secret = { secret: FIXTURE_PUBLIC_KEY };
/** See the header: a state the production store refuses to read. */
const DISCORD_APP_PROVIDER = "discord" as unknown as ChannelApp["provider"];

let context: ChannelsTestContext;
let harness: ReturnType<typeof inboundHarness>;

beforeEach(() => {
  context = buildChannelsTestContext();
  const app = buildApp({ provider: DISCORD_APP_PROVIDER });
  context.repository.seedApp(app);
  context.runtimes.register(createChannelDiscordAdapter());
  harness = inboundHarness({ dependencies: context.dependencies, appId: app.appId, secret });
});

function deliver(body: string, receivedAt = FIXTURE_INSTANT) {
  return harness.admit(signDiscordDelivery(body, { receivedAt }));
}

describe("an interaction delivered twice", () => {
  it("is admitted ONCE and acknowledged BOTH times, as the same row", async () => {
    // Discord does not retry an interaction the way Slack retries an event, but a
    // proxy, a load balancer or this process's own transport can deliver the same
    // signed bytes twice. The interaction id is Discord's identity for the
    // delivery, so the second is the first.
    const first = await deliver(COMMAND_IN_CHANNEL_BODY);
    const second = await deliver(COMMAND_IN_CHANNEL_BODY);
    expect([first.outcome, second.outcome]).toEqual(["admitted", "admitted"]);
    expect([first.duplicate, second.duplicate]).toEqual([false, true]);
    expect(second.inboxId).toBe(first.inboxId);
    expect(context.repository.events.size).toBe(1);
  });

  it("is still one row when the duplicate arrives later, inside the window, with a fresh signature", async () => {
    // A re-signed replay of the same interaction id — a different timestamp and a
    // different signature, the same Discord event. Deduplication keys on the
    // provider's id and not on the bytes, so it collides.
    await deliver(COMMAND_IN_CHANNEL_BODY);
    const later = new Date(FIXTURE_INSTANT.getTime() + 120_000);
    const again = await harness.admit(signDiscordDelivery(COMMAND_IN_CHANNEL_BODY, { signedAt: later }));
    expect(again.duplicate).toBe(true);
    expect(context.repository.events.size).toBe(1);
  });

  it("keys on the interaction id, so two commands in one thread are two events", async () => {
    await deliver(COMMAND_IN_THREAD_BODY);
    await deliver(SECOND_COMMAND_IN_THREAD_BODY);
    expect(context.repository.events.size).toBe(2);
  });

  it("stores the exact verified bytes, sealed", async () => {
    const admitted = await deliver(COMMAND_IN_CHANNEL_BODY);
    const stored = context.repository.events.get(admitted.inboxId ?? "");
    expect(stored?.payload.ciphertext).not.toBe(COMMAND_IN_CHANNEL_BODY);
    const opened = await context.cipher.open(stored!.payload);
    expect(opened.ok && opened.value).toBe(COMMAND_IN_CHANNEL_BODY);
  });
});

describe("a delivery that does not verify never reaches the store", () => {
  it("refuses a forged body", async () => {
    const genuine = signDiscordDelivery(COMMAND_IN_CHANNEL_BODY);
    const outcome = await harness.admit({ ...genuine, rawBody: COMMAND_IN_CHANNEL_BODY.replace("river", "sewer") });
    expect(outcome.refusedWith).toBe("CHANNELS_SIGNATURE_INVALID");
    expect(context.repository.events.size).toBe(0);
  });

  it("refuses a replay an hour late", async () => {
    const outcome = await deliver(COMMAND_IN_CHANNEL_BODY, new Date(FIXTURE_INSTANT.getTime() + 3_600_000));
    expect(outcome.refusedWith).toBe("CHANNELS_SIGNATURE_STALE");
    expect(context.repository.events.size).toBe(0);
  });

  it("refuses an unsigned body that would parse perfectly, before anything reads it", async () => {
    const outcome = await harness.admit({ rawBody: COMMAND_IN_CHANNEL_BODY, headers: {}, receivedAt: FIXTURE_INSTANT });
    expect(outcome.refusedWith).toBe("CHANNELS_SIGNATURE_ABSENT");
    expect(context.repository.events.size).toBe(0);
  });
});

describe("the PING and an ignorable interaction are acknowledged, not admitted", () => {
  it("answers the PING with the PONG body and writes no row", async () => {
    const outcome = await deliver(PING_BODY);
    expect(outcome.outcome).toBe("handshake");
    expect(outcome.echo).toBe('{"type":1}');
    expect(context.repository.events.size).toBe(0);
  });

  it("drops a component click rather than queueing a turn for it", async () => {
    const outcome = await deliver(COMPONENT_BODY);
    expect(outcome.outcome).toBe("ignored");
    expect(context.repository.events.size).toBe(0);
  });
});

describe("a Discord app with no Discord runtime composed", () => {
  it("is refused UNSUPPORTED, a composition gap and not an authentication failure", async () => {
    const bare = buildChannelsTestContext();
    const app = buildApp({ provider: DISCORD_APP_PROVIDER });
    bare.repository.seedApp(app);
    const outcome = await inboundHarness({ dependencies: bare.dependencies, appId: app.appId, secret }).admit(
      signDiscordDelivery(COMMAND_IN_CHANNEL_BODY),
    );
    expect(outcome.refusedWith).toBe("CHANNELS_PROVIDER_UNSUPPORTED");
  });
});

describe("the Core gap this suite papers over", () => {
  it("is still open: channels admits no Discord app, so production cannot reach the case above", () => {
    // WHEN THIS FAILS, a change inside `channels` has admitted Discord as an app
    // provider. Delete `DISCORD_APP_PROVIDER`'s cast and seed a real app instead.
    expect(APP_PROVIDERS).toEqual(["slack"]);
  });
});
