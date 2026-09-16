// THE FAR SIDE MISBEHAVING, OVER A REAL SOCKET — AND MOST OF THIS DIRECTORY'S
// EVIDENCE.
//
// Every case drives the real adapter over a real TCP connection to a real
// `node:http` server on loopback. The server answers, answers slowly, refuses in
// the Bot API's own envelope, rate-limits with `parameters.retry_after`, performs
// a write and never answers, or performs it and drops the connection; the
// connection-refused case is the operating system refusing a port nothing is
// bound to.
//
// IT CARRIES MORE WEIGHT HERE THAN IN THE OTHER CHANNEL DIRECTORIES, and
// `adapter.ts` says why: Telegram's inbound check cannot be joined to anything
// outside this repository, so the OUTBOUND contract — the method, the path, the
// body, and the classification of every documented refusal — is where the
// falsifiable assertions live. None of that is this adapter's to decide, and the
// server is never told what to expect.
//
// THE ASSERTIONS ARE AGAINST TWO RECORDS THE SERVER KEEPS: `received` (the
// request arrived) and `sent` (the chat now holds a message). The question every
// retry decision turns on is the second one.
//
// RECONNECT, STATED PRECISELY. This adapter holds no socket between calls — it is
// webhooks in and Bot API out — so there is no session to resume. The HTTP
// equivalent is proven instead, and the case pins WHERE the connection was lost:
// before the request was accepted (refused: UNAVAILABLE, the far side holds
// nothing, retry delivers exactly once) or after the far side read it (dropped:
// INDETERMINATE, the chat holds the message, a retry would duplicate it).

import {
  deliveryDisposition,
  mayRetryDelivery,
  type ChannelCredential,
  type DomainError,
  type OutboundMessage,
  type Result,
} from "@platos/context-channels/application/ports/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createChannelTelegramAdapter, type ChannelTelegramAdapter } from "./adapter.js";
import { FAR_SIDE_INSTANT, FarSide } from "./far-side.js";
import {
  FIXTURE_BOT_TOKEN,
  PRIVATE_CHAT_ID,
  SUPERGROUP_CHAT_ID,
  TOPIC_THREAD_ID,
  USER_ID,
} from "./fixtures.js";
import { MAX_REMEMBERED_WINDOWS, TelegramRateLimits } from "./rate-limit.js";
import { classifyTelegramThrow } from "./failure.js";
import { callUrl, deliveredFrom, isBotToken } from "./send.js";
import { TELEGRAM_API_URL, TELEGRAM_MAX_TEXT_LENGTH } from "./vendor.js";

const CREDENTIAL: ChannelCredential = { token: FIXTURE_BOT_TOKEN, tokenGeneration: 3 };
const OTHER_CREDENTIAL: ChannelCredential = { token: "7654322:AAF-a-second-bot-entirely", tokenGeneration: 1 };

function message(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    channelThreadKey: `telegram:${PRIVATE_CHAT_ID}` as OutboundMessage["channelThreadKey"],
    text: "the assistant's answer with *stars* and [brackets]",
    replacesProviderMessageId: null,
    ...overrides,
  } as OutboundMessage;
}

function inTopic(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return message({
    channelThreadKey: `telegram:${SUPERGROUP_CHAT_ID}:${TOPIC_THREAD_ID}` as OutboundMessage["channelThreadKey"],
    ...overrides,
  });
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
let adapter: ChannelTelegramAdapter;

beforeEach(async () => {
  farSide = new FarSide();
  await farSide.listen();
  clock = new Clock();
  adapter = createChannelTelegramAdapter({ apiUrl: farSide.apiUrl, timeoutMs: 300, now: clock.now });
});

afterEach(async () => {
  await farSide.stop();
});

describe("the ordinary path, so the failures below are not vacuous", () => {
  it("calls sendMessage under bot<token>, with the chat id and NO parse mode", async () => {
    const sent = await adapter.send(CREDENTIAL, message());
    expect(sent.ok).toBe(true);
    expect(farSide.received).toHaveLength(1);
    const request = farSide.received[0]!;
    expect(request.method).toBe("POST");
    expect(request.apiMethod).toBe("sendMessage");
    expect(request.token).toBe(FIXTURE_BOT_TOKEN);
    expect(request.contentType).toBe("application/json");
    // NO `parse_mode`. With one set, the `*` and `[` in this text would make
    // Telegram refuse the whole send with "can't parse entities" — and a crafted
    // one would render a link the assistant did not write.
    expect(request.json).toEqual({
      chat_id: String(PRIVATE_CHAT_ID),
      text: "the assistant's answer with *stars* and [brackets]",
    });
    expect(farSide.sent).toHaveLength(1);
  });

  it("reports the far side's own message id and the instant TELEGRAM stamped", async () => {
    const sent = await adapter.send(CREDENTIAL, message());
    expect(sent.ok && sent.value.providerMessageId).toBe(String(farSide.sent[0]?.messageId));
    // `Message.date` is the PROVIDER's clock, which is what `deliveredAt` means —
    // the property `channel-whatsapp` explicitly cannot have, because Graph's
    // send answer carries no time at all.
    expect(sent.ok && sent.value.deliveredAt.toISOString()).toBe(FAR_SIDE_INSTANT.toISOString());
  });

  it("sends a TOPIC reply to the SUPERGROUP with message_thread_id beside it", async () => {
    // A topic is not a chat of its own — unlike a Discord thread, which is a
    // channel. Sending to the topic id would address a chat that does not exist.
    await adapter.send(CREDENTIAL, inTopic());
    expect(farSide.received[0]?.json).toEqual({
      chat_id: String(SUPERGROUP_CHAT_ID),
      text: "the assistant's answer with *stars* and [brackets]",
      message_thread_id: TOPIC_THREAD_ID,
    });
    expect(farSide.sent[0]?.chatId).toBe(String(SUPERGROUP_CHAT_ID));
    expect(farSide.sent[0]?.threadId).toBe(TOPIC_THREAD_ID);
  });

  it("resolves every route under the API base, with the colon in the token surviving", async () => {
    // THE CASE THAT CAUGHT A REAL DEFECT. A Telegram path segment is
    // `bot<id>:<secret>`, so the first segment of the relative reference contains
    // a COLON — and without a `./` prefix `new URL` parses it as an absolute URI
    // whose SCHEME is `bot7654321`, discards the base entirely, and the request
    // goes nowhere. The naive form is asserted here beside the real one so the
    // hazard cannot be reintroduced by "simplifying" `callUrl`.
    expect(callUrl(TELEGRAM_API_URL, FIXTURE_BOT_TOKEN, "getMe").toString()).toBe(
      `https://api.telegram.org/bot${FIXTURE_BOT_TOKEN}/getMe`,
    );
    expect(new URL(`bot${FIXTURE_BOT_TOKEN}/getMe`, TELEGRAM_API_URL).protocol).not.toBe("https:");
    expect((await adapter.verifyCredential(CREDENTIAL)).ok).toBe(true);
    expect(farSide.received[0]?.apiMethod).toBe("getMe");
  });

  it("describes a user by the name they set, and never claims an email Telegram has none of", async () => {
    const principal = await adapter.describePrincipal(CREDENTIAL, String(USER_ID));
    expect(principal.ok && principal.value).toEqual({
      providerUserId: String(USER_ID),
      displayName: "River Watcher",
      email: null,
    });
    expect(farSide.received[0]?.apiMethod).toBe("getChat");
    expect(farSide.received[0]?.json).toEqual({ chat_id: String(USER_ID) });
  });

  it("refuses a token probe whose account is not a bot", async () => {
    farSide.next({ kind: "okWithoutResult" });
    expect(failure(await adapter.verifyCredential(CREDENTIAL)).code).toBe("CHANNELS_ADAPTER_REJECTED");
  });
});

describe("streaming a turn back is an EDIT, not a flood", () => {
  it("edits the same message twice and the chat still holds ONE", async () => {
    const first = await adapter.send(CREDENTIAL, message());
    const id = first.ok ? first.value.providerMessageId : "";
    await adapter.send(CREDENTIAL, message({ text: "longer", replacesProviderMessageId: id }));
    const again = await adapter.send(CREDENTIAL, message({ text: "longer", replacesProviderMessageId: id }));
    expect(farSide.received.map((request) => request.apiMethod)).toEqual([
      "sendMessage",
      "editMessageText",
      "editMessageText",
    ]);
    // AN EDIT NAMES NO TOPIC. The message already knows where it is, and
    // `editMessageText` has no `message_thread_id` parameter at all.
    expect(farSide.received[1]?.json).toEqual({
      chat_id: String(PRIVATE_CHAT_ID),
      message_id: Number(id),
      text: "longer",
    });
    expect(again.ok && again.value.providerMessageId).toBe(id);
    expect(farSide.sent).toHaveLength(1);
  });

  it("edits a message INSIDE A TOPIC without naming the topic, because editMessageText has no such field", async () => {
    // `sendMessage` takes `message_thread_id` and `editMessageText` does NOT — the
    // message already knows where it is. A send-shaped edit body would be a field
    // the Bot API does not define on that method, and the private-chat case above
    // cannot see it because a private chat has no topic at all.
    const first = await adapter.send(CREDENTIAL, inTopic());
    const id = first.ok ? first.value.providerMessageId : "";
    await adapter.send(CREDENTIAL, inTopic({ text: "longer", replacesProviderMessageId: id }));
    expect(farSide.received[0]?.json).toHaveProperty("message_thread_id", TOPIC_THREAD_ID);
    expect(farSide.received[1]?.apiMethod).toBe("editMessageText");
    expect(farSide.received[1]?.json).toEqual({
      chat_id: String(SUPERGROUP_CHAT_ID),
      message_id: Number(id),
      text: "longer",
    });
  });

  it("holds the vendor's own documented text limit, so the case below is not scaled by the code", () => {
    // TRANSCRIBED FROM THE BOT API's `sendMessage` REFERENCE: "Text of the message
    // to be sent, 1-4096 characters after entities parsing". The behavioural case
    // below reads the CONSTANT, so without this line a mutation that widened the
    // constant would widen the case with it and survive — which is exactly what a
    // sweep found.
    expect(TELEGRAM_MAX_TEXT_LENGTH).toBe(4096);
  });

  it("refuses text past the vendor's own length limit before opening a socket", async () => {
    expect(failure(await adapter.send(CREDENTIAL, message({ text: "x".repeat(TELEGRAM_MAX_TEXT_LENGTH + 1) }))).code).toBe(
      "CHANNELS_ADAPTER_REJECTED",
    );
    expect(farSide.received).toHaveLength(0);
    expect((await adapter.send(CREDENTIAL, message({ text: "x".repeat(TELEGRAM_MAX_TEXT_LENGTH) }))).ok).toBe(true);
  });
});

describe("a write that times out mid-flight", () => {
  it("is INDETERMINATE and RECONCILE, and the chat really does hold the message", async () => {
    farSide.next({ kind: "silent" });
    const error = failure(await adapter.send(CREDENTIAL, message()));
    expect(error.code).toBe("CHANNELS_DELIVERY_INDETERMINATE");
    expect(deliveryDisposition(error)).toBe("reconcile");
    expect(farSide.sent).toHaveLength(1);
  });

  it("does NOT post twice when the caller obeys the disposition rule", async () => {
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

  it("names the code a REAL dropped socket produces, and does not treat it as never-connected", async () => {
    // THE JOIN THAT MAKES THE NEVER-CONNECTED LIST FALSIFIABLE, and it exists
    // because a mutation sweep found the claim unprovable without it. The list is
    // carried from `channel-slack`, whose own comment names `ECONNRESET` — and on
    // this runtime `fetch` NEVER reports that for a socket dropped after the
    // request was read. It reports undici's `UND_ERR_SOCKET` ("other side
    // closed"), so a list judged against `ECONNRESET` is judged against a code
    // that cannot arrive. The code is read OFF THE WIRE here and then fed to the
    // classifier, so the two halves are joined rather than asserted separately.
    farSide.next({ kind: "dropAfterRead" });
    let observed: string | null = null;
    try {
      await fetch(callUrl(farSide.apiUrl, FIXTURE_BOT_TOKEN, "sendMessage"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: PRIVATE_CHAT_ID, text: "x" }),
      });
    } catch (error) {
      observed = ((error as { cause?: { code?: string } }).cause?.code) ?? null;
    }
    expect(observed).toBe("UND_ERR_SOCKET");
    // A write that met THAT code may have landed, so it is RECONCILE...
    expect(classifyTelegramThrow({ cause: { code: observed } }, false, "write").code).toBe(
      "CHANNELS_DELIVERY_INDETERMINATE",
    );
    // ...while a connection that was never established is RETRY, which is the
    // distinction the list exists to draw and the reason this case is not vacuous.
    expect(classifyTelegramThrow({ cause: { code: "ECONNREFUSED" } }, false, "write").code).toBe(
      "CHANNELS_ADAPTER_UNAVAILABLE",
    );
  });

  it("AFTER the far side read the request: dropped, INDETERMINATE, and the chat holds it", async () => {
    // THE CASE `channel-slack`'s classifier gets wrong: it lists the reset socket
    // among the codes that prove nothing was accepted. Here the far side read the
    // whole request and delivered the message before destroying the connection.
    farSide.next({ kind: "dropAfterRead" });
    const error = failure(await adapter.send(CREDENTIAL, message()));
    expect(error.code).toBe("CHANNELS_DELIVERY_INDETERMINATE");
    expect(mayRetryDelivery(error)).toBe(false);
    expect(farSide.received).toHaveLength(1);
    expect(farSide.sent).toHaveLength(1);
  });
});

describe("Telegram's 429, whose wait is in the BODY and not in a header", () => {
  it("reads parameters.retry_after and refuses the next call on that chat before a socket opens", async () => {
    farSide.next({ kind: "rateLimited", retryAfter: 7 });
    const error = failure(await adapter.send(CREDENTIAL, message()));
    expect(error.code).toBe("CHANNELS_ADAPTER_UNAVAILABLE");
    // A CLIENT READING ONLY `Retry-After` FINDS NOTHING HERE and hammers the API,
    // which is how a bot gets its webhook dropped.
    expect(error.retryAfterSeconds).toBe(7);
    expect(deliveryDisposition(error)).toBe("retry");
    expect(farSide.sent).toHaveLength(0);

    const held = failure(await adapter.send(CREDENTIAL, message()));
    expect(held.retryAfterSeconds).toBe(7);
    expect(farSide.received).toHaveLength(1);

    clock.advanceSeconds(7);
    expect((await adapter.send(CREDENTIAL, message())).ok).toBe(true);
    expect(farSide.received).toHaveLength(2);
    expect(farSide.sent).toHaveLength(1);
  });

  it("holds the CHAT and leaves other chats free", async () => {
    farSide.next({ kind: "rateLimited", retryAfter: 5 });
    failure(await adapter.send(CREDENTIAL, message()));
    expect((await adapter.send(CREDENTIAL, inTopic())).ok).toBe(true);
    // ...and a topic shares its parent's window, because the limit is per CHAT.
    farSide.next({ kind: "rateLimited", retryAfter: 5 });
    failure(await adapter.send(CREDENTIAL, inTopic()));
    const heldGroup = failure(
      await adapter.send(CREDENTIAL, message({ channelThreadKey: `telegram:${SUPERGROUP_CHAT_ID}` as OutboundMessage["channelThreadKey"] })),
    );
    expect(heldGroup.code).toBe("CHANNELS_ADAPTER_UNAVAILABLE");
  });

  it("holds only that BOT, so a second bot in the process is unaffected", async () => {
    farSide.next({ kind: "rateLimited", retryAfter: 9 });
    failure(await adapter.send(CREDENTIAL, message()));
    expect((await adapter.send(OTHER_CREDENTIAL, message())).ok).toBe(true);
  });

  it("falls back to Retry-After, then to one second, when the body names no wait", async () => {
    farSide.next({ kind: "rateLimited", retryAfterHeader: 3 });
    expect(failure(await adapter.send(CREDENTIAL, message())).retryAfterSeconds).toBe(3);
    clock.advanceSeconds(3);
    farSide.next({ kind: "rateLimited" });
    expect(failure(await adapter.send(CREDENTIAL, message())).retryAfterSeconds).toBe(1);
  });

  it("trusts the ENVELOPE over the status when a proxy has rewritten one of them", async () => {
    // `error_code: 429` under an HTTP 200 is what a caching proxy produces. The
    // body is the one Telegram wrote.
    farSide.next({ kind: "rateLimited", retryAfter: 2, status: 200 });
    const error = failure(await adapter.send(CREDENTIAL, message()));
    expect(error.code).toBe("CHANNELS_ADAPTER_UNAVAILABLE");
    expect(error.retryAfterSeconds).toBe(2);
  });

  it("delivers exactly once for a caller that obeys the port's retry rule and retryAfterSeconds", async () => {
    farSide.next({ kind: "rateLimited", retryAfter: 1 });
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

  it("never shortens a wait a later, smaller refusal asks for, and sweeps what has passed", () => {
    const limits = new TelegramRateLimits(clock.now);
    const chat = (id: string) => ({ identity: "bot", chatId: id });
    limits.hold(chat("live"), 600);
    limits.hold(chat("live"), 1);
    expect(limits.admit(chat("live"))).toMatchObject({ admitted: false, retryAfterSeconds: 600 });
    // Bounded, not "until full": a table that stopped growing must fail here, not hang.
    for (let next = 1; next <= MAX_REMEMBERED_WINDOWS - 1; next += 1) limits.hold(chat(`c${next}`), 1);
    expect(limits.size).toBe(MAX_REMEMBERED_WINDOWS);
    clock.advanceSeconds(2);
    limits.hold(chat("after"), 1);
    expect(limits.size).toBe(2);
    expect(limits.admit(chat("live"))).toMatchObject({ admitted: false, retryAfterSeconds: 598 });
    expect(limits.admit(chat("c1"))).toEqual({ admitted: true });
  });
});

describe("Telegram's own refusals, in this context's vocabulary", () => {
  it("maps 401 Unauthorized to UNAUTHORIZED, which is never retried", async () => {
    farSide.next({ kind: "refused", code: 401 });
    const error = failure(await adapter.send(CREDENTIAL, message()));
    expect(error.code).toBe("CHANNELS_ADAPTER_UNAUTHORIZED");
    expect(deliveryDisposition(error)).toBe("refuse");
  });

  it("maps 403 blocked-by-user to REJECTED and NOT to a dead credential", async () => {
    // One person blocking the bot must not send the refresh fence to
    // re-authorize a bot that works everywhere else.
    farSide.next({ kind: "refused", code: 403 });
    const error = failure(await adapter.send(CREDENTIAL, message()));
    expect(error.code).toBe("CHANNELS_ADAPTER_REJECTED");
    expect(error.details).toEqual({ provider: "telegram", reason: "http 403" });
  });

  it("maps 400 chat-not-found to REJECTED", async () => {
    farSide.next({ kind: "refused", code: 400 });
    expect(failure(await adapter.send(CREDENTIAL, message())).code).toBe("CHANNELS_ADAPTER_REJECTED");
  });

  it("names the error_code when it disagrees with the status, and never the description", async () => {
    farSide.next({ kind: "refused", code: 403, status: 200 });
    const error = failure(await adapter.send(CREDENTIAL, message()));
    expect(error.code).toBe("CHANNELS_ADAPTER_REJECTED");
    expect(error.details).toEqual({ provider: "telegram", reason: "http 200 error_code 403" });
    // Telegram's `description` echoes request content back — a chat title, a
    // message fragment — and it is never carried into something that is logged.
    expect(JSON.stringify(error.details)).not.toContain("refused");
  });

  it("maps a 500 on a WRITE to INDETERMINATE, because the far side may have sent it", async () => {
    farSide.next({ kind: "failAfterSend" });
    const error = failure(await adapter.send(CREDENTIAL, message()));
    expect(error.code).toBe("CHANNELS_DELIVERY_INDETERMINATE");
    expect(farSide.sent).toHaveLength(1);
  });

  it("maps a 500 on a READ to UNAVAILABLE, and a gateway page on a READ too", async () => {
    farSide.next({ kind: "refused", code: 500 }, { kind: "notJson", status: 200 });
    expect(failure(await adapter.verifyCredential(CREDENTIAL)).code).toBe("CHANNELS_ADAPTER_UNAVAILABLE");
    // A 200 whose body is a proxy's HTML is not Telegram confirming the token.
    expect(failure(await adapter.verifyCredential(CREDENTIAL)).code).toBe("CHANNELS_ADAPTER_UNAVAILABLE");
  });

  it("maps a gateway's HTML page to INDETERMINATE on a write, whatever its status", async () => {
    farSide.next({ kind: "notJson", status: 502 }, { kind: "notJson", status: 200 });
    expect(failure(await adapter.send(CREDENTIAL, message())).code).toBe("CHANNELS_DELIVERY_INDETERMINATE");
    expect(failure(await adapter.send(CREDENTIAL, message())).code).toBe("CHANNELS_DELIVERY_INDETERMINATE");
  });

  it("refuses an ok:true envelope with no result object", () => {
    for (const result of [{}, { message_id: 1 }, { date: 1 }, { message_id: "1", date: 1 }]) {
      expect(failure(deliveredFrom(result)).code).toBe("CHANNELS_ADAPTER_REJECTED");
    }
    expect(deliveredFrom({ message_id: 42, date: 1_780_000_000 })).toEqual({
      ok: true,
      value: { providerMessageId: "42", deliveredAt: new Date(1_780_000_000_000) },
    });
  });

  it("gives four DISTINGUISHABLE codes for the four outcomes", async () => {
    farSide.next(
      { kind: "refused", code: 401 },
      { kind: "refused", code: 400 },
      { kind: "rateLimited", retryAfter: 1 },
      { kind: "silent" },
    );
    const codes: string[] = [];
    codes.push(failure(await adapter.send(CREDENTIAL, message())).code);
    codes.push(failure(await adapter.send(CREDENTIAL, message())).code);
    codes.push(failure(await adapter.send(CREDENTIAL, message())).code);
    // The fourth call goes to another chat: the 429 above holds the first.
    codes.push(failure(await adapter.send(CREDENTIAL, inTopic())).code);
    expect(codes.sort()).toEqual([
      "CHANNELS_ADAPTER_REJECTED",
      "CHANNELS_ADAPTER_UNAUTHORIZED",
      "CHANNELS_ADAPTER_UNAVAILABLE",
      "CHANNELS_DELIVERY_INDETERMINATE",
    ]);
  });
});

describe("anything that would become a path is refused before a socket opens", () => {
  it("refuses a bot token whose shape could address another method", async () => {
    // THE CREDENTIAL IS INPUT, even read from a store. `bot<token>/sendMessage`
    // puts it in the URL, so a token carrying `/` or `..` addresses somewhere
    // else on this process's own egress.
    expect(isBotToken(FIXTURE_BOT_TOKEN)).toBe(true);
    for (const token of ["", "no-colon", "7654321:has/slash", "7654321:has..dots/..", "abc:def", `7654321:${"x".repeat(201)}`]) {
      expect(isBotToken(token), token).toBe(false);
      const outcome = await adapter.send({ token, tokenGeneration: 1 }, message());
      expect(failure(outcome).code, token).toBe("CHANNELS_ADAPTER_REJECTED");
    }
    expect(farSide.received).toHaveLength(0);
  });

  it.each([
    ["another provider's key", message({ channelThreadKey: "discord:1181000000000000100" as OutboundMessage["channelThreadKey"] })],
    ["a key with a traversal segment", message({ channelThreadKey: "telegram:..%2Fbot%2FgetMe" as OutboundMessage["channelThreadKey"] })],
    ["a negative TOPIC id, which no message id is", message({ channelThreadKey: `telegram:${SUPERGROUP_CHAT_ID}:-47` as OutboundMessage["channelThreadKey"] })],
    ["a message id that is not a message id", message({ replacesProviderMessageId: "../../getMe" })],
  ])("refuses %s as REJECTED", async (_name, outbound) => {
    expect(failure(await adapter.send(CREDENTIAL, outbound)).code).toBe("CHANNELS_ADAPTER_REJECTED");
    expect(farSide.received).toHaveLength(0);
  });

  it("refuses a providerUserId that is not a Telegram id", async () => {
    expect(failure(await adapter.describePrincipal(CREDENTIAL, "@me")).code).toBe("CHANNELS_ADAPTER_REJECTED");
    expect(farSide.received).toHaveLength(0);
  });
});
