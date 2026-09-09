// The outbound half: post a message, edit a message, and bound both in time.
//
// EVERY CALL HAS A DEADLINE, AND THE DEADLINE IS THE POINT. A channel post with
// no deadline is a request that can hang for the operating system's TCP
// timeout — minutes — while the caller holds an inbox lease that will expire
// underneath it, at which point a second worker claims the row and posts the
// message again. The deadline turns "hangs forever" into a NAMED outcome the
// retry policy can act on, and `classifySlackFailure` names it
// `CHANNELS_DELIVERY_INDETERMINATE` rather than `UNAVAILABLE` because a request
// that was written and not answered may well have been performed.
//
// THE DEADLINE IS OURS AND NOT THE SDK'S. `AbortController` plus a timer, with
// the timer CLEARED in a `finally`: a per-call timer that outlives its call
// keeps the event loop alive, and a process that will not exit on SIGTERM
// because of one is a genuinely miserable thing to diagnose.
//
// `fetch` AND `apiUrl` ARE INJECTABLE, AND NOT FROM CONFIGURATION. They are
// construction options with real defaults, so a test can point this adapter at a
// real HTTP server on localhost and observe what the far side actually received
// — which is the only way to tell a delivery that never landed from one that
// landed and lost its answer. They are deliberately NOT operator-settable: an
// environment variable that redirects every outbound channel message to an
// arbitrary host is an exfiltration primitive, and no install needs it.

import {
  err,
  ok,
  type ChannelCredential,
  type DeliveredMessage,
  type OutboundMessage,
  type Result,
} from "@platos/context-channels/application/ports/index.js";

import { classifySlackFailure } from "./failure.js";
import { parseSlackThreadKey, SLACK_PROVIDER } from "./provider.js";
import { adapterRejected } from "@platos/context-channels/application/ports/index.js";
import { postSlackMessage, updateSlackMessage, type SlackPostedMessage } from "./vendor.js";

/**
 * Slack's own API host. Overridden only in-process, never by configuration.
 *
 * THE TRAILING SLASH IS LOAD-BEARING AND IS NOT A TYPO. The SDK resolves a
 * method against this value with the URL specification's relative-reference
 * rules — `new URL("chat.postMessage", base)` — under which a base of
 * `https://slack.com/api` yields `https://slack.com/chat.postMessage`, dropping
 * the `/api` segment entirely. Every call would 404 against a path that has
 * never existed. `slack-transport.test.ts` asserts the resolved URL rather than
 * this constant, so the mistake cannot come back by editing the string.
 */
export const SLACK_API_URL = "https://slack.com/api/";

/**
 * Ten seconds, matching `PLATOS_CHANNELS_WEBHOOK_TIMEOUT_MS`'s default next
 * door. Long enough that a healthy call never trips it, short enough that a
 * five-minute inbox lease is not spent waiting on one post.
 */
export const DEFAULT_SEND_TIMEOUT_MS = 10_000;

export interface SlackTransportOptions {
  readonly apiUrl: string;
  readonly timeoutMs: number;
  readonly fetch: typeof fetch;
}

/**
 * One dispatched call's answer, wrapped so `underDeadline` can return a `Result`
 * over a value that may itself legitimately be `undefined`.
 */
interface Dispatched<Value> {
  readonly value: Value;
}

/**
 * Run one vendor call under a deadline.
 *
 * `timedOut` is tracked HERE, by the code that owns the timer, and handed to the
 * classifier. Inferring it from the error would be guessing at undici's internal
 * shapes; a boolean set by the timer callback cannot be wrong about whether the
 * timer fired.
 */
async function underDeadline<Value>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<Value>,
): Promise<Result<Dispatched<Value>>> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return ok({ value: await run(controller.signal) });
  } catch (error) {
    return err(classifySlackFailure(error, timedOut));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A `fetch` that carries the deadline's signal.
 *
 * The SDK takes a `fetch` and not a signal, so the signal is bound here. A
 * caller-supplied `signal` on `init` is respected but the deadline wins: two
 * signals cannot be merged without `AbortSignal.any`, and the deadline is the
 * one this adapter's failure taxonomy is built around.
 */
function fetchWithSignal(base: typeof fetch, signal: AbortSignal): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    base(input, { ...init, signal })) as typeof fetch;
}

export async function sendSlackMessage(
  transport: SlackTransportOptions,
  credential: ChannelCredential,
  message: OutboundMessage,
): Promise<Result<DeliveredMessage>> {
  const address = parseSlackThreadKey(message.channelThreadKey);
  if (address === null) {
    // REFUSED BEFORE A SOCKET IS OPENED. A key this adapter did not render names
    // a conversation on some other provider; posting its second segment as a
    // Slack channel id would either fail obscurely or, worse, hit a real channel
    // whose id happened to collide.
    return err(adapterRejected(SLACK_PROVIDER, "channelThreadKey is not a Slack thread key"));
  }

  const dispatched = await underDeadline<SlackPostedMessage>(transport.timeoutMs, async (signal) => {
    const common = {
      token: credential.token,
      apiUrl: transport.apiUrl,
      fetch: fetchWithSignal(transport.fetch, signal),
      channel: address.channelId,
      text: message.text,
    };
    // AN EDIT, NOT A SECOND POST. `replacesProviderMessageId` is how a streaming
    // turn stays one message in the channel instead of a flood, and it is also
    // what makes a REDELIVERED outbound event harmless: editing the same message
    // to the same text twice is indistinguishable from doing it once.
    return message.replacesProviderMessageId === null
      ? postSlackMessage({ ...common, threadTs: address.threadTs })
      : updateSlackMessage({ ...common, ts: message.replacesProviderMessageId });
  });
  if (!dispatched.ok) return err(dispatched.error);

  return ok({
    providerMessageId: dispatched.value.value.id,
    // THE PROVIDER'S OWN TIMESTAMP, and not this process's clock. Slack's
    // message id IS a timestamp (`1712000000.000100`), and it is the instant the
    // message exists at as far as every other Slack client is concerned. Falling
    // back to the wall clock only when it will not parse keeps the field
    // populated without inventing a provider fact.
    deliveredAt: slackTimestampToDate(dispatched.value.value.id),
  });
}

/**
 * A Slack `ts` (`"1712000000.000100"`) as a `Date`.
 *
 * The fractional part is microseconds and `Date` holds milliseconds, so this
 * loses precision by construction — deliberately, because the field's job is to
 * order and display a delivery, not to reproduce Slack's message id. The id
 * itself travels unchanged in `providerMessageId`, which is what an edit needs.
 */
export function slackTimestampToDate(ts: string): Date {
  const seconds = Number.parseFloat(ts);
  return Number.isFinite(seconds) ? new Date(Math.round(seconds * 1000)) : new Date(0);
}
