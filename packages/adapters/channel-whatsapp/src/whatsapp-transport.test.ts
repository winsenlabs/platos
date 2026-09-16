// THE FAR SIDE MISBEHAVING, OVER A REAL SOCKET.
//
// Every case drives the real adapter over a real TCP connection to a real
// `node:http` server on loopback. The server answers, answers slowly, refuses in
// Graph's own shapes, throttles with Meta's own error codes, performs a send and
// never answers, or performs it and drops the connection; the connection-refused
// case is the operating system refusing a port nothing is bound to.
//
// THE ASSERTIONS ARE AGAINST TWO RECORDS THE SERVER KEEPS: `received` (the
// request arrived) and `sent` (a message is now on a customer's phone). The
// question every retry decision turns on is the second one — and on WhatsApp it
// is sharper than anywhere else, because the Cloud API has NO EDIT and NO DELETE:
// a duplicate here is permanent.
//
// RECONNECT, STATED PRECISELY. This adapter holds no socket between calls — it is
// webhooks in and Graph out — so there is no session to resume. The HTTP
// equivalent is proven instead, and the case pins WHERE the connection was lost:
// before the request was accepted (refused: UNAVAILABLE, the far side holds
// nothing, retry delivers exactly once) or after the far side read it (dropped:
// INDETERMINATE, the message is already sent, a retry would duplicate it).

import {
  deliveryDisposition,
  mayRetryDelivery,
  type ChannelCredential,
  type DomainError,
  type OutboundMessage,
  type Result,
} from "@platos/context-channels/application/ports/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createChannelWhatsAppAdapter, type ChannelWhatsAppAdapter } from "./adapter.js";
import { FAR_SIDE_INSTANT, FarSide } from "./far-side.js";
import { CUSTOMER_WA_ID, OTHER_CUSTOMER_WA_ID, OTHER_PHONE_NUMBER_ID, PHONE_NUMBER_ID } from "./fixtures.js";
import { MAX_REMEMBERED_WINDOWS, WhatsAppRateLimits } from "./rate-limit.js";
import { DEFAULT_RATE_LIMIT_WAIT_SECONDS } from "./failure.js";
import { deliveredFrom } from "./send.js";
import { WHATSAPP_ERROR_CODE, WHATSAPP_GRAPH_URL, WHATSAPP_MAX_TEXT_LENGTH } from "./vendor.js";

const CREDENTIAL: ChannelCredential = { token: "a-token-that-authorizes-nothing", tokenGeneration: 3 };
const OTHER_CREDENTIAL: ChannelCredential = { token: "a-second-business-entirely", tokenGeneration: 1 };

function message(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    channelThreadKey: `whatsapp:${PHONE_NUMBER_ID}:${CUSTOMER_WA_ID}` as OutboundMessage["channelThreadKey"],
    text: "the assistant's answer, https://example.invalid/report",
    replacesProviderMessageId: null,
    ...overrides,
  } as OutboundMessage;
}

function toOther(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return message({
    channelThreadKey: `whatsapp:${PHONE_NUMBER_ID}:${OTHER_CUSTOMER_WA_ID}` as OutboundMessage["channelThreadKey"],
    ...overrides,
  });
}

function onOtherLine(): OutboundMessage {
  return message({
    channelThreadKey: `whatsapp:${OTHER_PHONE_NUMBER_ID}:${CUSTOMER_WA_ID}` as OutboundMessage["channelThreadKey"],
  });
}

function failure(outcome: Result<unknown>): DomainError {
  if (outcome.ok) throw new Error("expected a failure and the call succeeded");
  return outcome.error;
}

/** A clock the rate-limit windows and `deliveredAt` are measured on. */
class Clock {
  at = FAR_SIDE_INSTANT.getTime();
  readonly now = (): number => this.at;
  advanceSeconds(seconds: number): void {
    this.at += seconds * 1000;
  }
}

let farSide: FarSide;
let clock: Clock;
let adapter: ChannelWhatsAppAdapter;

beforeEach(async () => {
  farSide = new FarSide();
  await farSide.listen();
  clock = new Clock();
  adapter = createChannelWhatsAppAdapter({ graphUrl: farSide.graphUrl, timeoutMs: 300, now: clock.now });
});

afterEach(async () => {
  await farSide.stop();
});

describe("the ordinary path, so the failures below are not vacuous", () => {
  it("sends the text on the LINE to the CUSTOMER, bearer-authorized, with link previews off", async () => {
    const sent = await adapter.send(CREDENTIAL, message());
    expect(sent.ok).toBe(true);
    expect(farSide.received).toHaveLength(1);
    const request = farSide.received[0]!;
    expect(request.method).toBe("POST");
    expect(request.path).toBe(`${PHONE_NUMBER_ID}/messages`);
    expect(request.authorization).toBe(`Bearer ${CREDENTIAL.token}`);
    expect(request.contentType).toBe("application/json");
    // `preview_url: false` is the one field that stops Meta FETCHING a URL the
    // model echoed back and rendering it in the customer's chat.
    expect(request.json).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: CUSTOMER_WA_ID,
      type: "text",
      text: { preview_url: false, body: "the assistant's answer, https://example.invalid/report" },
    });
    expect(farSide.sent).toHaveLength(1);
    expect(farSide.sent[0]?.to).toBe(CUSTOMER_WA_ID);
  });

  it("reports the far side's own message id and THIS PROCESS's clock as deliveredAt", async () => {
    const sent = await adapter.send(CREDENTIAL, message());
    expect(sent.ok && sent.value.providerMessageId).toBe(farSide.sent[0]?.id);
    // GRAPH'S SEND ANSWER CARRIES NO TIMESTAMP — unlike a Discord snowflake,
    // which encodes one. So `deliveredAt` is measured here and is an upper bound,
    // and the injected clock is what proves it is not `Date.now()` in disguise.
    expect(sent.ok && sent.value.deliveredAt.toISOString()).toBe(FAR_SIDE_INSTANT.toISOString());
  });

  it("resolves every route under /v21.0/ without eating a path segment", async () => {
    expect(new URL("me", WHATSAPP_GRAPH_URL).toString()).toBe("https://graph.facebook.com/v21.0/me");
    expect((await adapter.verifyCredential(CREDENTIAL)).ok).toBe(true);
    expect(farSide.received[0]?.path).toBe("me");
    expect(farSide.received[0]?.method).toBe("GET");
  });

  it("refuses a token probe whose 200 names no node", async () => {
    farSide.next({ kind: "notJson", status: 200 });
    expect(failure(await adapter.verifyCredential(CREDENTIAL)).code).toBe("CHANNELS_ADAPTER_UNAVAILABLE");
  });
});

describe("what the Cloud API cannot do, refused rather than approximated", () => {
  it("REFUSES an edit instead of posting a second message", async () => {
    // THE DECISION THIS DIRECTORY MAKES AND STATES. There is no edit route. A
    // streamed turn honoured by re-posting would arrive as N notifications on a
    // customer's phone, and a redelivered outbound event would duplicate a
    // message that can never be taken back.
    const error = failure(await adapter.send(CREDENTIAL, message({ replacesProviderMessageId: "wamid.X" })));
    expect(error.code).toBe("CHANNELS_ADAPTER_REJECTED");
    expect(error.details).toEqual({
      provider: "whatsapp",
      reason: "WhatsApp Cloud API cannot edit a sent message",
    });
    expect(farSide.received).toHaveLength(0);
    expect(farSide.sent).toHaveLength(0);
  });

  it("refuses text past the vendor's own length limit before opening a socket", async () => {
    const error = failure(
      await adapter.send(CREDENTIAL, message({ text: "x".repeat(WHATSAPP_MAX_TEXT_LENGTH + 1) })),
    );
    expect(error.code).toBe("CHANNELS_ADAPTER_REJECTED");
    expect(farSide.received).toHaveLength(0);
    // ...and exactly at the limit it goes.
    expect((await adapter.send(CREDENTIAL, message({ text: "x".repeat(WHATSAPP_MAX_TEXT_LENGTH) }))).ok).toBe(true);
  });

  it("describes a principal with the number and two nulls, and OPENS NO SOCKET", async () => {
    // Meta publishes no route that reads a customer's profile from a `wa_id`.
    // A request here would 400 forever; the honest answer is what the provider
    // will describe, which is nothing beyond the number.
    const principal = await adapter.describePrincipal(CREDENTIAL, CUSTOMER_WA_ID);
    expect(principal.ok && principal.value).toEqual({
      providerUserId: CUSTOMER_WA_ID,
      displayName: null,
      email: null,
    });
    expect(farSide.received).toHaveLength(0);
  });
});

describe("a write that times out mid-flight", () => {
  it("is INDETERMINATE and RECONCILE, and the customer really did get the message", async () => {
    farSide.next({ kind: "silent" });
    const error = failure(await adapter.send(CREDENTIAL, message()));
    expect(error.code).toBe("CHANNELS_DELIVERY_INDETERMINATE");
    expect(deliveryDisposition(error)).toBe("reconcile");
    expect(farSide.sent).toHaveLength(1);
  });

  it("does NOT send twice when the caller obeys the disposition rule", async () => {
    farSide.next({ kind: "silent" });
    const first = await adapter.send(CREDENTIAL, message());
    if (!first.ok && mayRetryDelivery(first.error)) await adapter.send(CREDENTIAL, message());
    expect(farSide.sent).toHaveLength(1);
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
    expect(farSide.sent).toHaveLength(1);
  });

  it("AFTER the far side read the request: dropped, INDETERMINATE, and the message is sent", async () => {
    // THE CASE `channel-slack`'s classifier gets wrong: it lists the reset socket
    // among the codes that prove nothing was accepted. Here the far side read the
    // whole request and sent the message before destroying the connection.
    farSide.next({ kind: "dropAfterRead" });
    const error = failure(await adapter.send(CREDENTIAL, message()));
    expect(error.code).toBe("CHANNELS_DELIVERY_INDETERMINATE");
    expect(mayRetryDelivery(error)).toBe(false);
    expect(farSide.received).toHaveLength(1);
    expect(farSide.sent).toHaveLength(1);
  });
});

describe("Meta's throughput refusals, held at the scope Meta named", () => {
  it("holds ONE RECIPIENT on a pair limit and leaves the rest of the line free", async () => {
    farSide.next({ kind: "rateLimited", code: WHATSAPP_ERROR_CODE.pairRateLimit });
    const error = failure(await adapter.send(CREDENTIAL, message()));
    expect(error.code).toBe("CHANNELS_ADAPTER_UNAVAILABLE");
    expect(error.retryAfterSeconds).toBe(DEFAULT_RATE_LIMIT_WAIT_SECONDS);
    expect(farSide.sent).toHaveLength(0);

    const held = failure(await adapter.send(CREDENTIAL, message()));
    // THE FAR SIDE NEVER SAW IT. Meta counts refused calls against an app's error
    // rate; a request that never left counts against nothing.
    expect(held.code).toBe("CHANNELS_ADAPTER_UNAVAILABLE");
    expect(farSide.received).toHaveLength(1);

    expect((await adapter.send(CREDENTIAL, toOther())).ok).toBe(true);
    expect(farSide.received).toHaveLength(2);

    clock.advanceSeconds(DEFAULT_RATE_LIMIT_WAIT_SECONDS);
    expect((await adapter.send(CREDENTIAL, message())).ok).toBe(true);
  });

  it("holds the WHOLE LINE on a Cloud API throughput limit and leaves another line free", async () => {
    farSide.next({ kind: "rateLimited", code: WHATSAPP_ERROR_CODE.rateLimitHit, retryAfterHeader: 4 });
    expect(failure(await adapter.send(CREDENTIAL, message())).retryAfterSeconds).toBe(4);
    expect(failure(await adapter.send(CREDENTIAL, toOther())).retryAfterSeconds).toBe(4);
    expect(farSide.received).toHaveLength(1);
    expect((await adapter.send(CREDENTIAL, onOtherLine())).ok).toBe(true);
    clock.advanceSeconds(4);
    expect((await adapter.send(CREDENTIAL, message())).ok).toBe(true);
  });

  it("holds EVERY line for one token on an account limit, and only for that token", async () => {
    farSide.next({ kind: "rateLimited", code: WHATSAPP_ERROR_CODE.accountRateLimit, retryAfterHeader: 5 });
    failure(await adapter.send(CREDENTIAL, message()));
    const before = farSide.received.length;
    expect(failure(await adapter.send(CREDENTIAL, onOtherLine())).retryAfterSeconds).toBe(5);
    // Even the credential probe, which names no line, is held.
    expect(failure(await adapter.verifyCredential(CREDENTIAL)).retryAfterSeconds).toBe(5);
    expect(farSide.received).toHaveLength(before);
    // A different access token is a different business.
    expect((await adapter.send(OTHER_CREDENTIAL, message())).ok).toBe(true);
  });

  it("falls to the WIDEST scope for a bare 429 that named no code", async () => {
    // An unattributed refusal is the one case where holding too much is safer
    // than holding too little.
    farSide.next({ kind: "rateLimited", status: 429, code: 0 });
    failure(await adapter.send(CREDENTIAL, message()));
    expect(failure(await adapter.send(CREDENTIAL, onOtherLine())).code).toBe("CHANNELS_ADAPTER_UNAVAILABLE");
    expect(farSide.received).toHaveLength(1);
  });

  it("delivers exactly once for a caller that obeys the port's retry rule and retryAfterSeconds", async () => {
    farSide.next({ kind: "rateLimited", code: WHATSAPP_ERROR_CODE.rateLimitHit, retryAfterHeader: 1 });
    let outcome = await adapter.send(CREDENTIAL, message());
    let sends = 1;
    while (!outcome.ok && mayRetryDelivery(outcome.error) && sends < 5) {
      clock.advanceSeconds(outcome.error.retryAfterSeconds ?? 5);
      outcome = await adapter.send(CREDENTIAL, message());
      sends += 1;
    }
    expect(outcome.ok).toBe(true);
    expect(sends).toBe(2);
    expect(farSide.sent).toHaveLength(1);
  });

  it("never shortens a wait a later, smaller refusal asks for", () => {
    const limits = new WhatsAppRateLimits(clock.now);
    const route = { identity: "b", phoneNumberId: PHONE_NUMBER_ID, recipient: CUSTOMER_WA_ID };
    limits.hold(route, "line", 60);
    limits.hold(route, "line", 1);
    expect(limits.admit(route)).toMatchObject({ admitted: false, retryAfterSeconds: 60 });
  });

  it("sweeps windows that have passed once the table is large, and keeps the live one", () => {
    const limits = new WhatsAppRateLimits(clock.now);
    const line = (id: string) => ({ identity: "b", phoneNumberId: id, recipient: null });
    limits.hold(line("live"), "line", 600);
    // Bounded, not "until full": a table that stopped growing must fail here, not hang.
    for (let next = 1; next <= MAX_REMEMBERED_WINDOWS - 1; next += 1) limits.hold(line(`p${next}`), "line", 1);
    expect(limits.size).toBe(MAX_REMEMBERED_WINDOWS);
    clock.advanceSeconds(2);
    limits.hold(line("after"), "line", 1);
    expect(limits.size).toBe(2);
    expect(limits.admit(line("live"))).toMatchObject({ admitted: false, retryAfterSeconds: 598 });
    expect(limits.admit(line("p1"))).toEqual({ admitted: true });
  });
});

describe("Graph's own refusals, in this context's vocabulary", () => {
  it("maps error code 190 on an HTTP 400 to UNAUTHORIZED, which a status alone gets wrong", async () => {
    // THE CASE THAT JUSTIFIES READING THE CODE. Graph answers a dead token with
    // 400, not 401. Classified on status alone this is REJECTED, the refresh
    // fence never fires, and the connection is dead forever with nobody asking
    // for a new token.
    farSide.next({ kind: "status", status: 400, code: WHATSAPP_ERROR_CODE.accessToken });
    const error = failure(await adapter.send(CREDENTIAL, message()));
    expect(error.code).toBe("CHANNELS_ADAPTER_UNAUTHORIZED");
    expect(deliveryDisposition(error)).toBe("refuse");
    expect(error.details).toEqual({ provider: "whatsapp", reason: "http 400 code 190" });
  });

  it("maps a plain 401 to UNAUTHORIZED too", async () => {
    farSide.next({ kind: "status", status: 401, code: 0 });
    expect(failure(await adapter.send(CREDENTIAL, message())).code).toBe("CHANNELS_ADAPTER_UNAUTHORIZED");
  });

  it("maps a closed 24-hour window and an undeliverable number to REJECTED", async () => {
    farSide.next({ kind: "status", status: 400, code: 131047 }, { kind: "status", status: 400, code: 131026 });
    expect(failure(await adapter.send(CREDENTIAL, message())).code).toBe("CHANNELS_ADAPTER_REJECTED");
    expect(failure(await adapter.send(CREDENTIAL, message())).code).toBe("CHANNELS_ADAPTER_REJECTED");
  });

  it("treats a Graph error carried under HTTP 200 as the refusal it is", async () => {
    // A 200 with `{ error: { code } }` is a real Graph shape, and reporting it as
    // a delivered message would claim a send that never happened.
    farSide.next({ kind: "okWithError", code: 131026 });
    const error = failure(await adapter.send(CREDENTIAL, message()));
    expect(error.code).toBe("CHANNELS_ADAPTER_REJECTED");
    expect(error.details).toEqual({ provider: "whatsapp", reason: "http 200 code 131026" });
    expect(farSide.sent).toHaveLength(0);
  });

  it("maps a 500 on a WRITE to INDETERMINATE, because the far side may have sent it", async () => {
    farSide.next({ kind: "failAfterSend" });
    const error = failure(await adapter.send(CREDENTIAL, message()));
    expect(error.code).toBe("CHANNELS_DELIVERY_INDETERMINATE");
    expect(farSide.sent).toHaveLength(1);
  });

  it("maps a 500 on a READ to UNAVAILABLE, and a gateway page on a WRITE to INDETERMINATE", async () => {
    farSide.next({ kind: "status", status: 500, code: 1 }, { kind: "notJson", status: 502 });
    expect(failure(await adapter.verifyCredential(CREDENTIAL)).code).toBe("CHANNELS_ADAPTER_UNAVAILABLE");
    expect(failure(await adapter.send(CREDENTIAL, message())).code).toBe("CHANNELS_DELIVERY_INDETERMINATE");
  });

  it("refuses a 2xx that named no message id, rather than reporting a send", () => {
    // A success whose body is not the send answer — a proxy's rewritten JSON, or
    // Graph answering the wrong shape. Whether a message exists is not knowable
    // from here, so it is the far side's defect reported as one.
    for (const answer of [{}, { messages: [] }, { messages: [{}] }, { messages: "no" }, { messages: [{ id: "" }] }]) {
      const outcome = deliveredFrom(answer, clock.now());
      expect(failure(outcome).code).toBe("CHANNELS_ADAPTER_REJECTED");
    }
    expect(deliveredFrom({ messages: [{ id: "wamid.OK" }] }, clock.now())).toEqual({
      ok: true,
      value: { providerMessageId: "wamid.OK", deliveredAt: FAR_SIDE_INSTANT },
    });
  });

  it("gives four DISTINGUISHABLE codes for the four outcomes", async () => {
    farSide.next(
      { kind: "status", status: 401, code: 0 },
      { kind: "status", status: 400, code: 131026 },
      { kind: "rateLimited", code: WHATSAPP_ERROR_CODE.pairRateLimit },
      { kind: "silent" },
    );
    const codes: string[] = [];
    codes.push(failure(await adapter.send(CREDENTIAL, message())).code);
    codes.push(failure(await adapter.send(CREDENTIAL, message())).code);
    codes.push(failure(await adapter.send(CREDENTIAL, message())).code);
    // The fourth call goes to another recipient: the pair limit above holds the first.
    codes.push(failure(await adapter.send(CREDENTIAL, toOther())).code);
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
    ["another provider's key", message({ channelThreadKey: "discord:1181000000000000100" as OutboundMessage["channelThreadKey"] })],
    ["a key with a traversal segment", message({ channelThreadKey: "whatsapp:..%2Fme%2Faccounts:1" as OutboundMessage["channelThreadKey"] })],
    ["a two-segment key, which no WhatsApp conversation has", message({ channelThreadKey: `whatsapp:${PHONE_NUMBER_ID}` as OutboundMessage["channelThreadKey"] })],
    ["a recipient that is not a number", message({ channelThreadKey: `whatsapp:${PHONE_NUMBER_ID}:me` as OutboundMessage["channelThreadKey"] })],
  ])("refuses %s as REJECTED", async (_name, outbound) => {
    expect(failure(await adapter.send(CREDENTIAL, outbound)).code).toBe("CHANNELS_ADAPTER_REJECTED");
    expect(farSide.received).toHaveLength(0);
  });

  it("refuses a providerUserId that is not a WhatsApp id", async () => {
    expect(failure(await adapter.describePrincipal(CREDENTIAL, "../me")).code).toBe("CHANNELS_ADAPTER_REJECTED");
    expect(farSide.received).toHaveLength(0);
  });
});
