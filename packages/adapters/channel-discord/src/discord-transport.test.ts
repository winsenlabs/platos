// THE FAR SIDE MISBEHAVING, OVER A REAL SOCKET.
//
// Every case drives the real adapter over a real TCP connection to a real
// `node:http` server on loopback. The server answers, answers slowly, refuses in
// Discord's own shapes, rate-limits with Discord's documented headers, performs a
// write and never answers, or performs it and drops the connection; the
// connection-refused case is the operating system refusing a port nothing is
// bound to.
//
// THE ASSERTIONS ARE AGAINST TWO RECORDS THE SERVER KEEPS: `received` (the
// request arrived) and `created` (a message now exists in the channel). The
// question every retry decision turns on is the second one.
//
// RECONNECT, STATED PRECISELY. This adapter holds no Gateway connection and no
// socket between calls — it is interactions over HTTP — so there is no session to
// resume. The HTTP equivalent is proven instead, and the case pins WHERE the
// connection was lost: before the request was accepted (refused: UNAVAILABLE, the
// far side holds nothing, retry delivers exactly once) or after the far side read
// it (dropped: INDETERMINATE, the far side holds the message, a retry would
// duplicate it).

import {
  deliveryDisposition,
  mayRetryDelivery,
  type ChannelCredential,
  type DomainError,
  type OutboundMessage,
  type Result,
} from "@platos/context-channels/application/ports/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createChannelDiscordAdapter, type ChannelDiscordAdapter } from "./adapter.js";
import { APPLICATION_ID, TEXT_CHANNEL_ID, THREAD_ID } from "./fixtures.js";
import { FAR_SIDE_INSTANT, FarSide, snowflakeAt } from "./far-side.js";
import { snowflakeInstant } from "./send.js";
import { DISCORD_API_URL } from "./vendor.js";

const CREDENTIAL: ChannelCredential = { token: "bot-token-that-authorizes-nothing", tokenGeneration: 3 };
const OTHER_CREDENTIAL: ChannelCredential = { token: "a-second-bot-entirely", tokenGeneration: 1 };
const REPLY = { applicationId: APPLICATION_ID, interactionToken: "aW50ZXJhY3Rpb24tdG9rZW4tZml4dHVyZQ" };

function message(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    channelThreadKey: `discord:${TEXT_CHANNEL_ID}` as OutboundMessage["channelThreadKey"],
    text: "the assistant's answer, @everyone",
    replacesProviderMessageId: null,
    ...overrides,
  } as OutboundMessage;
}

function failure(outcome: Result<unknown>): DomainError {
  if (outcome.ok) throw new Error("expected a failure and the call succeeded");
  return outcome.error;
}

/** A clock the rate-limit windows are measured on, moved only by the case. */
class Clock {
  at = FAR_SIDE_INSTANT.getTime();
  readonly now = (): number => this.at;
  advanceSeconds(seconds: number): void {
    this.at += seconds * 1000;
  }
}

let farSide: FarSide;
let clock: Clock;
let adapter: ChannelDiscordAdapter;

beforeEach(async () => {
  farSide = new FarSide();
  await farSide.listen();
  clock = new Clock();
  adapter = createChannelDiscordAdapter({ apiUrl: farSide.apiUrl, timeoutMs: 300, now: clock.now });
});

afterEach(async () => {
  await farSide.stop();
});

describe("the ordinary path, so the failures below are not vacuous", () => {
  it("creates the message with the bot token, Discord's User-Agent form, and no mention parsing", async () => {
    const sent = await adapter.send(CREDENTIAL, message());
    expect(sent.ok).toBe(true);
    expect(farSide.received).toHaveLength(1);
    const request = farSide.received[0]!;
    expect(request.method).toBe("POST");
    expect(request.path).toBe(`channels/${TEXT_CHANNEL_ID}/messages`);
    expect(request.authorization).toBe(`Bot ${CREDENTIAL.token}`);
    // `developers/reference.mdx`: "DiscordBot ($url, $versionNumber)".
    expect(request.userAgent).toMatch(/^DiscordBot \(\S+, \S+\)$/u);
    expect(request.contentType).toBe("application/json");
    expect(request.json).toEqual({ content: "the assistant's answer, @everyone", allowed_mentions: { parse: [] } });
    expect(farSide.created).toHaveLength(1);
  });

  it("reports the far side's own message id and the instant that id encodes", async () => {
    const sent = await adapter.send(CREDENTIAL, message());
    expect(sent.ok && sent.value.providerMessageId).toBe(farSide.created[0]?.id);
    // The snowflake the far side minted at FAR_SIDE_INSTANT decodes back to it:
    // Discord's two documented formulas, one each side of the wire.
    expect(sent.ok && sent.value.deliveredAt.toISOString()).toBe(FAR_SIDE_INSTANT.toISOString());
    expect(snowflakeInstant(snowflakeAt(new Date("2015-01-01T00:00:00.001Z"), 0)).getTime()).toBe(1_420_070_400_001);
  });

  it("posts a THREAD reply to the thread's own channel id, not to its parent", async () => {
    await adapter.send(CREDENTIAL, message({ channelThreadKey: `discord:${TEXT_CHANNEL_ID}:${THREAD_ID}` as OutboundMessage["channelThreadKey"] }));
    expect(farSide.received[0]?.path).toBe(`channels/${THREAD_ID}/messages`);
    expect(farSide.created[0]?.channel).toBe(THREAD_ID);
  });

  it("resolves every route under /api/v10/ without eating a path segment", async () => {
    expect(new URL("channels/1/messages", DISCORD_API_URL).toString()).toBe("https://discord.com/api/v10/channels/1/messages");
    await adapter.verifyCredential(CREDENTIAL);
    expect(farSide.received[0]?.path).toBe("users/@me");
  });

  it("describes a user by display name and never claims an email a bot cannot read", async () => {
    const principal = await adapter.describePrincipal(CREDENTIAL, "80351110224678912");
    expect(principal.ok && principal.value).toEqual({ providerUserId: "80351110224678912", displayName: "Nelly", email: null });
    expect(farSide.received[0]?.path).toBe("users/80351110224678912");
  });
});

describe("streaming a turn back is an EDIT, not a flood", () => {
  it("edits the same message twice and the channel still holds ONE", async () => {
    const first = await adapter.send(CREDENTIAL, message());
    const id = first.ok ? first.value.providerMessageId : "";
    await adapter.send(CREDENTIAL, message({ text: "longer", replacesProviderMessageId: id }));
    const again = await adapter.send(CREDENTIAL, message({ text: "longer", replacesProviderMessageId: id }));
    expect(farSide.received.map((request) => `${request.method} ${request.path}`)).toEqual([
      `POST channels/${TEXT_CHANNEL_ID}/messages`,
      `PATCH channels/${TEXT_CHANNEL_ID}/messages/${id}`,
      `PATCH channels/${TEXT_CHANNEL_ID}/messages/${id}`,
    ]);
    expect(again.ok && again.value.providerMessageId).toBe(id);
    expect(farSide.created).toHaveLength(1);
  });
});

describe("an interaction's followups travel on the interaction token", () => {
  it("creates a followup with wait=true and presents NO bot token", async () => {
    const sent = await adapter.sendFollowup(REPLY, { text: "working on it", replacesProviderMessageId: null });
    expect(sent.ok).toBe(true);
    const request = farSide.received[0]!;
    expect(`${request.method} ${request.path}`).toBe(`POST webhooks/${APPLICATION_ID}/${REPLY.interactionToken}?wait=true`);
    expect(request.authorization).toBeNull();
    expect(request.json).toEqual({ content: "working on it", allowed_mentions: { parse: [] } });
    expect(farSide.created).toHaveLength(1);
  });

  it("edits the deferred original response and a followup by id", async () => {
    await adapter.sendFollowup(REPLY, { text: "done", replacesProviderMessageId: "@original" });
    await adapter.sendFollowup(REPLY, { text: "done, edited", replacesProviderMessageId: "1181000000000000777" });
    expect(farSide.received.map((request) => `${request.method} ${request.path}`)).toEqual([
      `PATCH webhooks/${APPLICATION_ID}/${REPLY.interactionToken}/messages/@original`,
      `PATCH webhooks/${APPLICATION_ID}/${REPLY.interactionToken}/messages/1181000000000000777`,
    ]);
    expect(farSide.created).toHaveLength(0);
  });
});

describe("a write that times out mid-flight", () => {
  it("is INDETERMINATE and RECONCILE, and the channel really does hold the message", async () => {
    farSide.next({ kind: "silent" });
    const error = failure(await adapter.send(CREDENTIAL, message()));
    expect(error.code).toBe("CHANNELS_DELIVERY_INDETERMINATE");
    expect(deliveryDisposition(error)).toBe("reconcile");
    expect(farSide.created).toHaveLength(1);
  });

  it("does NOT post twice when the caller obeys the disposition rule", async () => {
    farSide.next({ kind: "silent" });
    const first = await adapter.send(CREDENTIAL, message());
    if (!first.ok && mayRetryDelivery(first.error)) await adapter.send(CREDENTIAL, message());
    expect(farSide.created).toHaveLength(1);
  });

  it("succeeds when the far side is merely SLOW, inside the deadline", async () => {
    farSide.next({ kind: "slow", afterMs: 30 });
    expect((await adapter.send(CREDENTIAL, message())).ok).toBe(true);
  });

  it("is UNAVAILABLE for a READ that times out, because a read changed nothing", async () => {
    farSide.next({ kind: "silent" });
    const error = failure(await adapter.verifyCredential(CREDENTIAL));
    expect(error.code).toBe("CHANNELS_ADAPTER_UNAVAILABLE");
    expect(mayRetryDelivery(error)).toBe(true);
  });

  it("leaves no timer holding the event loop open", async () => {
    await adapter.send(CREDENTIAL, message());
    expect(process.getActiveResourcesInfo().filter((resource) => resource === "Timeout")).toHaveLength(0);
  });
});

describe("a lost connection is classified by WHERE it was lost", () => {
  it("BEFORE the request: refused, UNAVAILABLE, and the far side holds nothing", async () => {
    await farSide.stop();
    const error = failure(await adapter.send(CREDENTIAL, message()));
    expect(error.code).toBe("CHANNELS_ADAPTER_UNAVAILABLE");
    expect(deliveryDisposition(error)).toBe("retry");
    expect(farSide.received).toHaveLength(0);
  });

  it("delivers exactly once across a reconnect on the same address", async () => {
    await farSide.stop();
    const first = await adapter.send(CREDENTIAL, message());
    expect(first.ok ? true : mayRetryDelivery(first.error)).toBe(true);
    await farSide.restart();
    const second = await adapter.send(CREDENTIAL, message());
    expect(second.ok).toBe(true);
    expect(farSide.received).toHaveLength(1);
    expect(farSide.created).toHaveLength(1);
  });

  it("AFTER the far side read the request: dropped, INDETERMINATE, and the far side holds the message", async () => {
    // THE CASE `channel-slack`'s classifier gets wrong: it lists the reset socket
    // among the codes that prove nothing was accepted. Here the far side read the
    // whole request and created the message before destroying the connection.
    farSide.next({ kind: "dropAfterRead" });
    const error = failure(await adapter.send(CREDENTIAL, message()));
    expect(error.code).toBe("CHANNELS_DELIVERY_INDETERMINATE");
    expect(mayRetryDelivery(error)).toBe(false);
    expect(farSide.received).toHaveLength(1);
    expect(farSide.created).toHaveLength(1);
  });
});

describe("Discord's rate limits, read from Discord's headers", () => {
  it("maps a 429 to UNAVAILABLE carrying the LATER of Retry-After and retry_after, and creates nothing", async () => {
    farSide.next({ kind: "rateLimited", retryAfter: 1.5, retryAfterHeader: 3 });
    const error = failure(await adapter.send(CREDENTIAL, message()));
    expect(error.code).toBe("CHANNELS_ADAPTER_UNAVAILABLE");
    expect(error.retryAfterSeconds).toBe(3);
    expect(deliveryDisposition(error)).toBe("retry");
    expect(farSide.created).toHaveLength(0);

    farSide.next({ kind: "rateLimited", retryAfter: 64.57, retryAfterHeader: 2 });
    const other = createChannelDiscordAdapter({ apiUrl: farSide.apiUrl, timeoutMs: 300, now: clock.now });
    expect(failure(await other.send(CREDENTIAL, message())).retryAfterSeconds).toBe(65);
  });

  it("refuses the next call on that bucket BEFORE opening a socket, until the wait has passed", async () => {
    farSide.next({ kind: "rateLimited", retryAfter: 2, limit: { bucket: "abcd1234", remaining: 0, resetAfter: 2 } });
    failure(await adapter.send(CREDENTIAL, message()));
    expect(farSide.received).toHaveLength(1);

    const held = failure(await adapter.send(CREDENTIAL, message()));
    expect(held.code).toBe("CHANNELS_ADAPTER_UNAVAILABLE");
    expect(held.retryAfterSeconds).toBe(2);
    // THE FAR SIDE NEVER SAW IT. A second 429 counts towards Discord's
    // invalid-request ban; a request that never left counts towards nothing.
    expect(farSide.received).toHaveLength(1);

    clock.advanceSeconds(2);
    expect((await adapter.send(CREDENTIAL, message())).ok).toBe(true);
    expect(farSide.received).toHaveLength(2);
    expect(farSide.created).toHaveLength(1);
  });

  it("stops on X-RateLimit-Remaining: 0 from a SUCCESS, before Discord has to refuse", async () => {
    farSide.next({ kind: "ok", limit: { bucket: "abcd1234", remaining: 0, resetAfter: 3 } });
    expect((await adapter.send(CREDENTIAL, message())).ok).toBe(true);
    const held = failure(await adapter.send(CREDENTIAL, message()));
    expect(held.retryAfterSeconds).toBe(3);
    expect(farSide.received).toHaveLength(1);
    clock.advanceSeconds(3);
    expect((await adapter.send(CREDENTIAL, message())).ok).toBe(true);
  });

  it("splits a bucket by channel, so one busy channel does not silence another", async () => {
    farSide.next({ kind: "rateLimited", retryAfter: 5, limit: { bucket: "abcd1234", remaining: 0, resetAfter: 5 } });
    failure(await adapter.send(CREDENTIAL, message()));
    const elsewhere = await adapter.send(CREDENTIAL, message({ channelThreadKey: `discord:${TEXT_CHANNEL_ID}:${THREAD_ID}` as OutboundMessage["channelThreadKey"] }));
    expect(elsewhere.ok).toBe(true);
  });

  it("holds every bot route on a GLOBAL 429, except interaction followups, and only for that bot", async () => {
    farSide.next({ kind: "rateLimited", retryAfter: 4, global: true });
    failure(await adapter.send(CREDENTIAL, message()));
    const before = farSide.received.length;

    expect(failure(await adapter.verifyCredential(CREDENTIAL)).retryAfterSeconds).toBe(4);
    expect(farSide.received).toHaveLength(before);
    // "Interaction endpoints are not bound to the bot's Global Rate Limit."
    expect((await adapter.sendFollowup(REPLY, { text: "still here", replacesProviderMessageId: null })).ok).toBe(true);
    // A different bot token is a different bot.
    expect((await adapter.send(OTHER_CREDENTIAL, message())).ok).toBe(true);
  });

  it("delivers exactly once for a caller that obeys the port's retry rule and retryAfterSeconds", async () => {
    farSide.next({ kind: "rateLimited", retryAfter: 1, limit: { bucket: "abcd1234", remaining: 0, resetAfter: 1 } });
    let outcome = await adapter.send(CREDENTIAL, message());
    let sends = 1;
    while (!outcome.ok && mayRetryDelivery(outcome.error) && sends < 5) {
      clock.advanceSeconds(outcome.error.retryAfterSeconds ?? 5);
      outcome = await adapter.send(CREDENTIAL, message());
      sends += 1;
    }
    expect(outcome.ok).toBe(true);
    expect(sends).toBe(2);
    expect(farSide.created).toHaveLength(1);
  });
});

describe("Discord's own refusals, in this context's vocabulary", () => {
  it("maps 401 to UNAUTHORIZED, which is never retried", async () => {
    farSide.next({ kind: "status", status: 401, code: 0 });
    const error = failure(await adapter.send(CREDENTIAL, message()));
    expect(error.code).toBe("CHANNELS_ADAPTER_UNAUTHORIZED");
    expect(deliveryDisposition(error)).toBe("refuse");
  });

  it("maps 403 Missing Permissions to REJECTED and NOT to a dead credential", async () => {
    farSide.next({ kind: "status", status: 403, code: 50013 });
    const error = failure(await adapter.send(CREDENTIAL, message()));
    expect(error.code).toBe("CHANNELS_ADAPTER_REJECTED");
    expect(error.details).toEqual({ provider: "discord", reason: "http 403 code 50013" });
  });

  it("maps 404 Unknown Channel to REJECTED", async () => {
    farSide.next({ kind: "status", status: 404, code: 10003 });
    expect(failure(await adapter.send(CREDENTIAL, message())).code).toBe("CHANNELS_ADAPTER_REJECTED");
  });

  it("maps a 500 on a WRITE to INDETERMINATE, because the far side may have created it", async () => {
    farSide.next({ kind: "failAfterCreate" });
    const error = failure(await adapter.send(CREDENTIAL, message()));
    expect(error.code).toBe("CHANNELS_DELIVERY_INDETERMINATE");
    expect(farSide.created).toHaveLength(1);
  });

  it("maps a 500 on a READ to UNAVAILABLE, and an unreadable success on a READ too", async () => {
    farSide.next({ kind: "status", status: 500, code: 0 }, { kind: "notJson", status: 200 });
    expect(failure(await adapter.verifyCredential(CREDENTIAL)).code).toBe("CHANNELS_ADAPTER_UNAVAILABLE");
    // A 200 whose body is a proxy's HTML is not Discord confirming the token.
    expect(failure(await adapter.verifyCredential(CREDENTIAL)).code).toBe("CHANNELS_ADAPTER_UNAVAILABLE");
  });

  it("maps a gateway's HTML page to INDETERMINATE on a write, whatever its status", async () => {
    farSide.next({ kind: "notJson", status: 502 }, { kind: "notJson", status: 200 });
    expect(failure(await adapter.send(CREDENTIAL, message())).code).toBe("CHANNELS_DELIVERY_INDETERMINATE");
    expect(failure(await adapter.send(CREDENTIAL, message())).code).toBe("CHANNELS_DELIVERY_INDETERMINATE");
  });

  it("gives four DISTINGUISHABLE codes for the four outcomes", async () => {
    farSide.next(
      { kind: "status", status: 401, code: 0 },
      { kind: "status", status: 400, code: 50035 },
      { kind: "rateLimited", retryAfter: 1 },
      { kind: "silent" },
    );
    const codes: string[] = [];
    for (const credential of [CREDENTIAL, CREDENTIAL, CREDENTIAL]) codes.push(failure(await adapter.send(credential, message())).code);
    // The fourth call goes to another channel: the 429 above holds the first.
    codes.push(failure(await adapter.send(CREDENTIAL, message({ channelThreadKey: `discord:${THREAD_ID}` as OutboundMessage["channelThreadKey"] }))).code);
    expect(codes.sort()).toEqual([
      "CHANNELS_ADAPTER_REJECTED",
      "CHANNELS_ADAPTER_UNAUTHORIZED",
      "CHANNELS_ADAPTER_UNAVAILABLE",
      "CHANNELS_DELIVERY_INDETERMINATE",
    ]);
  });
});

describe("anything that would become a path is refused before a socket opens", () => {
  it.each([
    ["another provider's key", message({ channelThreadKey: "slack:C0LAN2Q65:1515449522.000016" as OutboundMessage["channelThreadKey"] })],
    ["a key with a traversal segment", message({ channelThreadKey: "discord:..%2Fusers%2F@me" as OutboundMessage["channelThreadKey"] })],
    ["a message id that is not a snowflake", message({ replacesProviderMessageId: "../../users/@me" })],
  ])("refuses %s as REJECTED", async (_name, outbound) => {
    expect(failure(await adapter.send(CREDENTIAL, outbound)).code).toBe("CHANNELS_ADAPTER_REJECTED");
    expect(farSide.received).toHaveLength(0);
  });

  it("refuses a malformed interaction reply path and a non-snowflake user id", async () => {
    const bad = [
      await adapter.sendFollowup({ applicationId: "not-an-id", interactionToken: REPLY.interactionToken }, { text: "x", replacesProviderMessageId: null }),
      await adapter.sendFollowup({ applicationId: APPLICATION_ID, interactionToken: "../../channels/1" }, { text: "x", replacesProviderMessageId: null }),
      await adapter.sendFollowup(REPLY, { text: "x", replacesProviderMessageId: "@originals" }),
      await adapter.describePrincipal(CREDENTIAL, "@me"),
    ];
    expect(bad.map((outcome) => failure(outcome).code)).toEqual(Array(4).fill("CHANNELS_ADAPTER_REJECTED"));
    expect(farSide.received).toHaveLength(0);
  });
});
