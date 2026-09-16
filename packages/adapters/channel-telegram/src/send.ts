// The outbound half: one Bot API call under a deadline, a rate-limit gate, and a
// classifier — and the four methods built on it.
//
// EVERY CALL HAS A DEADLINE for the reason `channel-slack/src/send.ts` gives at
// length: an unbounded post outlives the inbox lease it was made under, a second
// worker claims the row, and the message goes out twice. The deadline is an
// `AbortController` and a timer this module owns, cleared in a `finally`.
//
// THE METHODS, from the published Bot API reference (see `vendor.ts`):
//
//   send   POST bot<token>/sendMessage      { chat_id, text, message_thread_id? }
//   edit   POST bot<token>/editMessageText  { chat_id, message_id, text }
//   probe  POST bot<token>/getMe            {}
//   read   POST bot<token>/getChat          { chat_id }
//
// EVERY METHOD IS A POST WITH A JSON BODY, including the two reads. The Bot API
// accepts GET with a query string as well, and the ids would then be in the URL —
// which is exactly what this adapter avoids: the only thing in the path is the
// token, whose grammar is checked on every call.
//
// THE TOKEN IS IN THE PATH, AND THAT IS WHY IT NEVER REACHES A `DomainError`.
// `bot<token>/sendMessage` means a refusal's reason must never carry the URL, and
// `failure.ts` carries a status and a code and nothing else.
//
// `fetch` AND `apiUrl` ARE CONSTRUCTION OPTIONS AND NEVER CONFIGURATION, for the
// reason Slack's transport states: an operator-settable host for every outbound
// channel message is an exfiltration primitive — and here it would be an
// exfiltration primitive for the bot token itself.

import {
  adapterRejected,
  adapterUnavailable,
  err,
  ok,
  type DeliveredMessage,
  type Result,
} from "@platos/context-channels/application/ports/index.js";

import {
  classifyTelegramStatus,
  classifyTelegramThrow,
  classifyUnreadableAnswer,
  type TelegramOperation,
} from "./failure.js";
import { TELEGRAM_PROVIDER } from "./provider.js";
import { TelegramRateLimits, type TelegramRoute } from "./rate-limit.js";
import {
  DEFAULT_RETRY_AFTER_SECONDS,
  TELEGRAM_BOT_PATH_PREFIX,
  TELEGRAM_BOT_TOKEN_PATTERN,
  TELEGRAM_RETRY_AFTER_FIELD,
} from "./vendor.js";

/** Ten seconds, matching `channel-slack`'s default and the webhook notifier's. */
export const DEFAULT_SEND_TIMEOUT_MS = 10_000;

export interface TelegramTransport {
  readonly apiUrl: string;
  readonly timeoutMs: number;
  readonly fetch: typeof fetch;
  readonly limits: TelegramRateLimits;
}

/** One call, fully described before anything is sent. */
export interface TelegramCall {
  readonly method: string;
  readonly token: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly operation: TelegramOperation;
  readonly route: TelegramRoute;
}

/** A Bot API `result` object, as it came back. */
export type TelegramResult = Readonly<Record<string, unknown>>;

/** True for a token whose shape `bot<token>/method` can safely carry. */
export function isBotToken(value: string): boolean {
  return TELEGRAM_BOT_TOKEN_PATTERN.test(value);
}

/**
 * The absolute URL one call is made to.
 *
 * THE LEADING `./` IS LOAD-BEARING, AND IT IS THE ONE THING ABOUT THIS ROUTE
 * THAT IS NOT OBVIOUS. A Telegram path segment is `bot<bot id>:<secret>`, so the
 * FIRST segment of the relative reference contains a COLON — and RFC 3986 §4.2
 * says a relative-path reference whose first segment contains a colon must be
 * prefixed, or it parses as an absolute URI with that segment as its SCHEME.
 * `new URL("bot7654321:AAF-x/getMe", base)` really does resolve to the string
 * `bot7654321:AAF-x/getMe` with scheme `bot7654321`: the base is discarded, the
 * request goes nowhere, and `fetch` fails with an unhelpful transport error
 * rather than with anything that names the cause. `telegram-transport.test.ts`
 * asserts the resolved string against `api.telegram.org` for exactly that reason.
 */
export function callUrl(apiUrl: string, token: string, method: string): URL {
  return new URL(`./${TELEGRAM_BOT_PATH_PREFIX}${token}/${method}`, apiUrl);
}

function objectOf(value: unknown): TelegramResult | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as TelegramResult) : null;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function integerOf(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/**
 * How long a refusal asked the caller to wait, in seconds.
 *
 * `ResponseParameters.retry_after` FIRST, because that is where Telegram puts it;
 * `Retry-After` second, because a proxy in front of the API may add one; and with
 * neither, one second, which is Telegram's own documented per-chat cadence.
 */
export function requestedWaitSeconds(envelope: TelegramResult | null, header: (name: string) => string | null): number {
  const parameters = objectOf(envelope?.["parameters"]);
  const fromBody = integerOf(parameters?.[TELEGRAM_RETRY_AFTER_FIELD]);
  if (fromBody !== null) return Math.max(1, fromBody);
  const fromHeader = header("retry-after");
  if (fromHeader !== null && /^\d+(?:\.\d+)?$/u.test(fromHeader.trim())) {
    return Math.max(1, Math.ceil(Number(fromHeader)));
  }
  return DEFAULT_RETRY_AFTER_SECONDS;
}

/**
 * Make one call. The rate-limit gate is consulted BEFORE the socket and fed AFTER
 * it; the deadline covers the whole exchange including reading the body, because
 * a server that sends headers and then stalls the body has not answered either.
 */
export async function telegramCall(
  transport: TelegramTransport,
  call: TelegramCall,
): Promise<Result<TelegramResult>> {
  // THE CREDENTIAL IS INPUT. It arrives per call from a store, and it becomes a
  // URL path segment; a token with a `/` in it would address another method or
  // another path entirely on this process's own egress.
  if (!isBotToken(call.token)) {
    return err(adapterRejected(TELEGRAM_PROVIDER, "credential is not a Telegram bot token"));
  }

  const gate = transport.limits.admit(call.route);
  if (!gate.admitted) {
    return err(
      adapterUnavailable(TELEGRAM_PROVIDER, `rate limited before sending: ${gate.reason}`, gate.retryAfterSeconds),
    );
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, transport.timeoutMs);
  try {
    const response = await transport.fetch(
      callUrl(transport.apiUrl, call.token, call.method),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(call.body),
        signal: controller.signal,
      },
    );
    const envelope = objectOf(await readJson(response));
    if (envelope === null) return err(classifyUnreadableAnswer(response.status, call.operation));

    // THE ENVELOPE DECIDES, NOT THE STATUS. See `failure.ts`: when a proxy has
    // rewritten one of the two, the body is the one Telegram wrote.
    if (envelope["ok"] !== true) {
      const errorCode = integerOf(envelope["error_code"]);
      const wait = requestedWaitSeconds(envelope, (name) => response.headers.get(name));
      if ((errorCode ?? response.status) === 429) transport.limits.hold(call.route, wait);
      return err(classifyTelegramStatus(response.status, errorCode, call.operation, wait));
    }
    const result = objectOf(envelope["result"]);
    // `getMe` answers an object; `sendMessage` answers a Message. An `ok: true`
    // with no object `result` is not an answer this adapter can act on, and
    // whether anything happened is not knowable from here.
    if (result === null) {
      return err(adapterRejected(TELEGRAM_PROVIDER, "success envelope carried no result object"));
    }
    return ok(result);
  } catch (error) {
    return err(classifyTelegramThrow(error, timedOut, call.operation));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A sent or edited message's id and the instant TELEGRAM stamped it.
 *
 * `Message.date` is "Date the message was sent in Unix time" — the PROVIDER's own
 * clock, which is what `deliveredAt` means. That is the same property a Discord
 * snowflake gives and the property `channel-whatsapp` explicitly cannot have, so
 * it is used rather than this process's clock.
 */
export function deliveredFrom(result: TelegramResult): Result<DeliveredMessage> {
  const messageId = integerOf(result["message_id"]);
  const date = integerOf(result["date"]);
  if (messageId === null || date === null) {
    // It answered `ok: true` and named no message. Whether a message exists is
    // not knowable from here, so this is the far side's defect reported as one.
    return err(adapterRejected(TELEGRAM_PROVIDER, "success answer carried no message id and date"));
  }
  return ok({ providerMessageId: String(messageId), deliveredAt: new Date(date * 1000) });
}
