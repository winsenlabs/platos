// THE FAR SIDE MISBEHAVING, OVER A REAL SOCKET.
//
// Every case here drives the real adapter, through the real vendor SDK, over a
// real TCP connection to a real `node:http` server on loopback. Nothing is
// stubbed and nothing is instructed to fail: the server either answers, answers
// slowly, answers with a refusal Slack really sends, or does not answer at all —
// and the connection-refused case is the operating system refusing a port
// nothing is bound to.
//
// THE ASSERTION THAT MAKES IT WORTH DOING is `farSide.received`. That array is
// appended to by the SERVER's request handler, before it decides what to answer.
// So a case can ask the question no stub can answer: the adapter reported a
// failure — did the message actually land? An adapter that answered
// `UNAVAILABLE` (meaning "retry me, nothing happened") about a request the far
// side has in hand would pass every mock-based test ever written and duplicate
// a customer's message in production. Here it fails.

import { deliveryDisposition, mayRetryDelivery } from "@platos/context-channels/application/ports/index.js";
import type {
  ChannelCredential,
  DomainError,
  OutboundMessage,
  Result,
} from "@platos/context-channels/application/ports/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createChannelSlackAdapter, type ChannelSlackAdapter } from "./adapter.js";
import { FarSide } from "./far-side.js";
import { SLACK_API_URL } from "./send.js";

const CREDENTIAL: ChannelCredential = { token: "xoxb-not-a-real-token", tokenGeneration: 3 };

function message(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    channelThreadKey: "slack:C0LAN2Q65:1515449522.000016" as OutboundMessage["channelThreadKey"],
    text: "the assistant's answer",
    replacesProviderMessageId: null,
    ...overrides,
  } as OutboundMessage;
}

function failure(outcome: Result<unknown>): DomainError {
  if (outcome.ok) throw new Error("expected a failure and the call succeeded");
  return outcome.error;
}

let farSide: FarSide;
let adapter: ChannelSlackAdapter;

beforeEach(async () => {
  farSide = new FarSide();
  await farSide.listen();
  adapter = createChannelSlackAdapter({ apiUrl: farSide.apiUrl, timeoutMs: 300 });
});

afterEach(async () => {
  await farSide.stop();
});

describe("the ordinary path, so the failures below are not vacuous", () => {
  it("posts the message and reports the provider's own id", async () => {
    const sent = await adapter.send(CREDENTIAL, message());
    expect(sent.ok).toBe(true);
    expect(farSide.received).toHaveLength(1);
    expect(farSide.received[0]?.slackMethod).toBe("chat.postMessage");
    expect(farSide.received[0]?.form["channel"]).toBe("C0LAN2Q65");
    expect(farSide.received[0]?.form["thread_ts"]).toBe("1515449522.000016");
    expect(farSide.received[0]?.form["text"]).toBe("the assistant's answer");
    expect(farSide.received[0]?.authorization).toBe(`Bearer ${CREDENTIAL.token}`);
  });

  it("resolves the API method against the base URL without eating a path segment", async () => {
    // THE BUG THIS CASE EXISTS FOR, caught during the build. The SDK resolves a
    // method as a RELATIVE REFERENCE against `apiUrl`, so a base with no
    // trailing slash silently drops its last segment:
    // `new URL("chat.postMessage", "https://slack.com/api")` is
    // `https://slack.com/chat.postMessage`. Every call 404s against a path that
    // never existed. Asserting the CONSTANT would not have caught it; asserting
    // what the vendor's own resolution produces does.
    expect(new URL("chat.postMessage", SLACK_API_URL).toString()).toBe(
      "https://slack.com/api/chat.postMessage",
    );
    await adapter.send(CREDENTIAL, message());
    expect(farSide.received[0]?.slackMethod).toBe("chat.postMessage");
  });
});

describe("a delivery that times out mid-flight", () => {
  it("is INDETERMINATE, and the far side really did receive the message", async () => {
    // The server reads the request to completion, records it, and never writes a
    // response. The message is posted as far as the provider is concerned; only
    // the answer is lost. This is the state that has no honest name other than
    // "unknown".
    farSide.next({ kind: "silent" });
    const error = failure(await adapter.send(CREDENTIAL, message()));

    expect(error.code).toBe("CHANNELS_DELIVERY_INDETERMINATE");
    // The far side's OWN record, not the adapter's report.
    expect(farSide.received).toHaveLength(1);
    expect(farSide.received[0]?.form["text"]).toBe("the assistant's answer");
  });

  it("is RECONCILE and not RETRY, which is the whole reason it has its own code", async () => {
    farSide.next({ kind: "silent" });
    const error = failure(await adapter.send(CREDENTIAL, message()));
    expect(deliveryDisposition(error)).toBe("reconcile");
    expect(mayRetryDelivery(error)).toBe(false);
  });

  it("does NOT post twice when a caller obeys the disposition rule", async () => {
    // THE IDEMPOTENCY CLAIM, MEASURED AT THE FAR SIDE. A caller that retried on
    // any failure would leave two messages in the channel here — the first from
    // the timed-out call the server actually received, the second from the
    // retry. Obeying `mayRetryDelivery` leaves exactly one.
    farSide.next({ kind: "silent" });
    const first = await adapter.send(CREDENTIAL, message());
    expect(first.ok).toBe(false);

    if (!first.ok && mayRetryDelivery(first.error)) {
      await adapter.send(CREDENTIAL, message());
    }
    expect(farSide.received).toHaveLength(1);
  });

  it("answers normally when the far side is merely SLOW rather than silent", async () => {
    // The deadline must not fire on a merely busy provider: one that answers
    // inside the budget is a success, not an indeterminate outcome, or every
    // busy afternoon becomes a reconciliation queue.
    farSide.next({ kind: "slow", afterMs: 30 });
    const sent = await adapter.send(CREDENTIAL, message());
    expect(sent.ok).toBe(true);
    expect(farSide.received).toHaveLength(1);
  });

  it("leaves no timer holding the event loop open", async () => {
    // A per-call timer that outlives its call keeps a process from exiting on
    // SIGTERM. `clearTimeout` in the `finally` is what prevents it, and this is
    // the case that fails if the `finally` is ever removed: without it the
    // 300ms deadline timer for a call that answered in 30ms is still armed.
    farSide.next({ kind: "ok" });
    await adapter.send(CREDENTIAL, message());
    const armed = process.getActiveResourcesInfo().filter((resource) => resource === "Timeout");
    expect(armed).toHaveLength(0);
  });
});

describe("a delivery that provably never landed", () => {
  it("is UNAVAILABLE and RETRY when the connection is refused", async () => {
    // Not simulated: the listener is closed and the operating system refuses the
    // connection to a port nothing is bound to.
    const url = farSide.deadApiUrl;
    await farSide.stop();
    const refusedAdapter = createChannelSlackAdapter({ apiUrl: url, timeoutMs: 2000 });

    const error = failure(await refusedAdapter.send(CREDENTIAL, message()));
    expect(error.code).toBe("CHANNELS_ADAPTER_UNAVAILABLE");
    expect(deliveryDisposition(error)).toBe("retry");
    expect(farSide.received).toHaveLength(0);
  });

  it("delivers exactly once across a reconnect", async () => {
    // THE RECONNECT CASE. The provider is down, the rule says retry, the
    // provider comes back on the SAME address, and the retry succeeds. The far
    // side's record must show ONE message: the failed call left nothing behind.
    const url = farSide.deadApiUrl;
    await farSide.stop();
    const reconnecting = createChannelSlackAdapter({ apiUrl: url, timeoutMs: 2000 });

    const first = await reconnecting.send(CREDENTIAL, message());
    expect(first.ok).toBe(false);
    expect(first.ok ? true : mayRetryDelivery(first.error)).toBe(true);

    await farSide.restart();
    const second = await reconnecting.send(CREDENTIAL, message());
    expect(second.ok).toBe(true);
    expect(farSide.received).toHaveLength(1);
  });
});

describe("the provider's own refusals, in this context's vocabulary", () => {
  it("maps a dead credential to UNAUTHORIZED, which must never be retried", async () => {
    farSide.next({ kind: "refuse", error: "token_revoked" });
    const error = failure(await adapter.send(CREDENTIAL, message()));
    expect(error.code).toBe("CHANNELS_ADAPTER_UNAUTHORIZED");
    expect(deliveryDisposition(error)).toBe("refuse");
  });

  it("maps a bad message to REJECTED, which must never be retried either", async () => {
    farSide.next({ kind: "refuse", error: "channel_not_found" });
    const error = failure(await adapter.send(CREDENTIAL, message()));
    expect(error.code).toBe("CHANNELS_ADAPTER_REJECTED");
    expect(deliveryDisposition(error)).toBe("refuse");
  });

  it("maps rate limiting to UNAVAILABLE, which IS retried", async () => {
    farSide.next({ kind: "status", status: 429, error: "ratelimited" });
    const error = failure(await adapter.send(CREDENTIAL, message()));
    expect(error.code).toBe("CHANNELS_ADAPTER_UNAVAILABLE");
    expect(error.retryAfterSeconds).not.toBeNull();
    expect(deliveryDisposition(error)).toBe("retry");
  });

  it("maps a gateway's non-JSON error page to INDETERMINATE, not UNAVAILABLE", async () => {
    // A proxy answering `502 Bad Gateway` in HTML says nothing about whether the
    // backend posted the message before the gateway gave up. The SDK throws a
    // `SyntaxError` from its own JSON parse, and defaulting that to RETRY is
    // exactly the mistake that duplicates a message.
    farSide.next({ kind: "notJson", status: 502 });
    const error = failure(await adapter.send(CREDENTIAL, message()));
    expect(error.code).toBe("CHANNELS_DELIVERY_INDETERMINATE");
    expect(mayRetryDelivery(error)).toBe(false);
    expect(farSide.received).toHaveLength(1);
  });

  it("gives four DISTINGUISHABLE codes for the four outcomes", async () => {
    // Lesson 7 again, on the outbound side: four failure modes that call for
    // four different actions must not collapse into one code.
    farSide.next(
      { kind: "refuse", error: "token_revoked" },
      { kind: "refuse", error: "msg_too_long" },
      { kind: "status", status: 503, error: "service_unavailable" },
      { kind: "silent" },
    );
    const codes: string[] = [];
    for (let call = 0; call < 4; call += 1) {
      codes.push(failure(await adapter.send(CREDENTIAL, message())).code);
    }
    expect(new Set(codes).size).toBe(4);
    expect(codes.sort()).toEqual([
      "CHANNELS_ADAPTER_REJECTED",
      "CHANNELS_ADAPTER_UNAUTHORIZED",
      "CHANNELS_ADAPTER_UNAVAILABLE",
      "CHANNELS_DELIVERY_INDETERMINATE",
    ]);
  });
});

describe("streaming a turn back is an EDIT, not a flood", () => {
  it("uses chat.update once a message id exists, so a redelivery is harmless", async () => {
    const first = await adapter.send(CREDENTIAL, message());
    expect(first.ok).toBe(true);
    const id = first.ok ? first.value.providerMessageId : "";

    await adapter.send(CREDENTIAL, message({ text: "answer, longer", replacesProviderMessageId: id }));
    await adapter.send(CREDENTIAL, message({ text: "answer, longer", replacesProviderMessageId: id }));

    const methods = farSide.received.map((request) => request.slackMethod);
    expect(methods).toEqual(["chat.postMessage", "chat.update", "chat.update"]);
    // ONE post. The two identical edits are what an at-least-once event bus
    // redelivering the same outbound event looks like, and they leave the
    // channel in the state one of them would have.
    expect(methods.filter((method) => method === "chat.postMessage")).toHaveLength(1);
    expect(farSide.received[1]?.form["ts"]).toBe(id);
    expect(farSide.received[2]?.form["ts"]).toBe(id);
  });
});

describe("a key this adapter did not render is refused before a socket opens", () => {
  it("refuses rather than posting somebody else's address as a channel id", async () => {
    const error = failure(
      await adapter.send(CREDENTIAL, message({
        channelThreadKey: "telegram:-100123:77" as OutboundMessage["channelThreadKey"],
      })),
    );
    expect(error.code).toBe("CHANNELS_ADAPTER_REJECTED");
    expect(farSide.received).toHaveLength(0);
  });
});
