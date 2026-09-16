// The `ChannelRuntime` implementation for Telegram, and its constructor.
//
// READ THIS FIRST: THE INBOUND HALF OF THIS ADAPTER IS THE WEAK ONE, AND NO SUITE
// IN THIS DIRECTORY CAN MAKE IT STRONG.
//
// `channel-runtime.ts`'s own header named the hazard before any of these
// directories existed, and it is worth repeating in full because this is the
// directory it was about: Telegram's inbound verification is a constant-time
// comparison against `X-Telegram-Bot-Api-Secret-Token`, "a value the integrator
// itself chose when it called `setWebhook` — so there is no published vector to
// transcribe, and a suite for it would compare a secret the suite set against a
// header the suite wrote. An adapter whose central assertion compares two values
// it controls cannot fail."
//
// THAT IS EXACTLY WHAT A NAIVE INBOUND SUITE HERE WOULD BE. Set the token, put
// the token in the header, assert acceptance: the assertion passes for a correct
// implementation, and it passes for `return ok()`. It is not evidence. So this
// directory does not present it as evidence, and states instead what each half
// of its inbound testing is actually worth:
//
//   NOT JOINED, AND NAMED AS SUCH. "This header carries the token Telegram was
//   given" rests on Telegram's prose and on nothing executable. `channel-slack`
//   has Slack's published worked example, `channel-discord` has RFC 8032 and
//   Discord's own helper library, `channel-whatsapp` has RFC 4231 and a second
//   HMAC — Telegram has none of those, because there is no algorithm to check,
//   only a string that was handed over.
//
//   JOINED, AND WORTH SOMETHING. Three things here DO answer to something this
//   repository does not control:
//
//     1. THE COMPARISON ITSELF, against `node:crypto`'s own `timingSafeEqual`
//        semantics. `secret-token.test.ts` requires this adapter's answer to
//        equal `timingSafeEqual`'s for every equal-length pair it is given, and
//        requires `false` — never a throw — exactly where `timingSafeEqual`
//        raises. That is a join to Node's documented behaviour, and it is the
//        half that actually protects the token: a byte-at-a-time comparison is a
//        remote timing oracle, and a length mismatch reaching `timingSafeEqual`
//        is a 500 an anonymous caller can trigger at will.
//
//     2. THE UPDATE SHAPE, through fixtures transcribed from the published Bot
//        API reference. `normalize.ts` decides a conversation identity, a bot
//        guard and a topic rule from fields Telegram documents; `fixtures.ts`
//        records where each field comes from. A wrong reading there is a wrong
//        reading of a public document, which a reader can check.
//
//     3. THE OUTBOUND CONTRACT, against a recording server. `telegram-transport.test.ts`
//        drives real sockets and asserts the METHOD, the PATH, the BODY and the
//        classification of every documented refusal — none of which this adapter
//        gets to decide.
//
// THE REFUSALS ARE STILL PROVEN, AND THEY ARE THE ASSERTIONS THAT CAN FAIL. A
// wrong token, a missing header, a token that is a PREFIX of the right one and a
// token LONGER than it are all refused, and each of those is a real defect a
// plausible implementation has: `===` after a `slice`, a missing header treated
// as a match against `undefined`, an unguarded `timingSafeEqual` that throws on
// the length mismatch. `secret-token.test.ts` and `verify.ts` carry them.
//
// ---------------------------------------------------------------------------
//
// THE THIRD RUNTIME (D10: Discord, then WhatsApp, then Telegram; none dropped),
// and the second exercise of the sentence `channel-runtime.ts` makes: a new
// provider is "a new directory satisfying this interface and a row in the
// registry, and not one line inside `channels`". This directory satisfies
// `ChannelRuntime` and `ChannelAdapter` through
// `@platos/context-channels/application/ports/index.js` alone, and
// `git diff <base> -- packages/contexts/channels` over the commits that added it
// is empty. That emptiness is not the clause closed — an empty diff is what any
// branch that never touched Core would show — and inbound admission is still
// blocked by 2 below.
//
// WEBHOOKS OVER HTTP, AND NOTHING HELD OPEN. This object owns no socket, no timer
// and no subscription between calls, so there is nothing to reconnect and nothing
// to close. What it holds is the process's transport policy plus the throughput
// windows Telegram has already refused on.
//
// IT HOLDS NO CREDENTIAL. The secret token arrives per delivery on the command,
// and the bot token per call, as `ChannelAdapter` requires.
//
// WHAT THIS DIRECTORY DOES NOT DO, EACH FOR A REASON THAT IS NOT IN IT.
//
//   1. LONG POLLING. `getUpdates` is the other way to receive, and it needs a
//      port that can start, stop and hold a cursor between calls. `ChannelRuntime`
//      is `verifyInbound` over bytes somebody else received, plus three calls —
//      there is no lifecycle to hold a poll loop in, and adding one would be a
//      change inside `channels`.
//
//   2. PRODUCTION ADMISSION. `admitSignedDelivery` keys the inbox on a
//      `ChannelApp`, `APP_PROVIDERS` is `["slack"]`, and `postgres-tenancy`'s
//      `requireAppProvider` refuses to read an app row naming another provider.
//      `signed-admission.test.ts` pins that gap and fails the day it closes.
//
//   3. `setWebhook` ITSELF. Registering the endpoint and its secret token is an
//      administrative act with a URL in it, performed once per installation. It
//      is not a `ChannelAdapter` method, it is not on the inbound path, and
//      putting it here would give this object a reason to know the public base
//      URL of the deployment.
//
//   4. MEDIA. A photo, a voice note or a document is IGNORABLE: this build
//      answers typed text. Downloading a file needs `getFile` plus a second host
//      (`api.telegram.org/file/bot<token>/…`), which is a second egress and a
//      storage decision that belongs above a transport.

import {
  adapterRejected,
  err,
  ok,
  type ChannelCredential,
  type ChannelPrincipal,
  type ChannelRuntime,
  type DeliveredMessage,
  type InboundVerificationSecret,
  type OutboundMessage,
  type Result,
  type SignedDelivery,
  type VerifiedDelivery,
} from "@platos/context-channels/application/ports/index.js";

import { normalizeTelegramUpdate } from "./normalize.js";
import { deliveryChatId, isChatId, parseTelegramThreadKey, TELEGRAM_PROVIDER } from "./provider.js";
import { credentialIdentity, TelegramRateLimits } from "./rate-limit.js";
import { DEFAULT_SEND_TIMEOUT_MS, deliveredFrom, telegramCall, type TelegramTransport } from "./send.js";
import { TELEGRAM_API_URL, TELEGRAM_MAX_TEXT_LENGTH, TELEGRAM_METHOD } from "./vendor.js";
import { verifyTelegramDelivery } from "./verify.js";

export interface ChannelTelegramAdapter extends ChannelRuntime {
  readonly adapterName: "channel-telegram";
  readonly provider: typeof TELEGRAM_PROVIDER;
}

export interface ChannelTelegramOptions {
  /** How long one outbound call may take before it is abandoned. */
  readonly timeoutMs?: number;
  /** The Bot API base. In-process only; see `send.ts`. */
  readonly apiUrl?: string;
  /** The `fetch` every call is made with. In-process only. */
  readonly fetch?: typeof fetch;
  /** The clock rate-limit windows are measured on. In-process only. */
  readonly now?: () => number;
}

class TelegramRuntime implements ChannelTelegramAdapter {
  readonly adapterName = "channel-telegram" as const;
  readonly provider = TELEGRAM_PROVIDER;

  constructor(private readonly transport: TelegramTransport) {}

  async verifyInbound(
    secret: InboundVerificationSecret,
    delivery: SignedDelivery,
  ): Promise<Result<VerifiedDelivery>> {
    const verified = verifyTelegramDelivery(secret.secret, delivery);
    if (!verified.ok) return err(verified.error);
    return normalizeTelegramUpdate(delivery.rawBody, delivery.receivedAt);
  }

  async send(credential: ChannelCredential, message: OutboundMessage): Promise<Result<DeliveredMessage>> {
    const address = parseTelegramThreadKey(message.channelThreadKey);
    if (address === null) {
      return err(adapterRejected(TELEGRAM_PROVIDER, "channelThreadKey is not a Telegram thread key"));
    }
    const edit = message.replacesProviderMessageId;
    if (edit !== null && !/^\d{1,19}$/u.test(edit)) {
      return err(adapterRejected(TELEGRAM_PROVIDER, "replacesProviderMessageId is not a Telegram message id"));
    }
    if (message.text.length > TELEGRAM_MAX_TEXT_LENGTH) {
      return err(adapterRejected(TELEGRAM_PROVIDER, `text exceeds the ${TELEGRAM_MAX_TEXT_LENGTH} character limit`));
    }
    const chatId = deliveryChatId(address);
    // AN EDIT, NOT A SECOND POST — the same property `chat.update` gives Slack and
    // `PATCH channels/{id}/messages/{id}` gives Discord: a streamed turn stays one
    // message, and a redelivered outbound event edits the same message to the same
    // text, which is indistinguishable from once.
    //
    // A TOPIC IS NOT A CHAT. `message_thread_id` travels BESIDE `chat_id` on a
    // send and is absent from an edit, because an edit names a message that
    // already knows where it is. Sending to the topic id instead would address a
    // chat that does not exist.
    const body =
      edit === null
        ? {
            chat_id: chatId,
            text: message.text,
            ...(address.threadId === null ? {} : { message_thread_id: Number(address.threadId) }),
          }
        : { chat_id: chatId, message_id: Number(edit), text: message.text };
    const answer = await telegramCall(this.transport, {
      method: edit === null ? TELEGRAM_METHOD.sendMessage : TELEGRAM_METHOD.editMessageText,
      token: credential.token,
      body,
      operation: "write",
      route: { identity: credentialIdentity(credential.token), chatId },
    });
    return answer.ok ? deliveredFrom(answer.value) : err(answer.error);
  }

  async describePrincipal(credential: ChannelCredential, providerUserId: string): Promise<Result<ChannelPrincipal>> {
    if (!isChatId(providerUserId)) {
      return err(adapterRejected(TELEGRAM_PROVIDER, "providerUserId is not a Telegram user id"));
    }
    const answer = await telegramCall(this.transport, {
      method: TELEGRAM_METHOD.getChat,
      token: credential.token,
      body: { chat_id: providerUserId },
      operation: "read",
      route: { identity: credentialIdentity(credential.token), chatId: providerUserId },
    });
    if (!answer.ok) return err(answer.error);
    const text = (key: string): string | null => {
      const value = answer.value[key];
      return typeof value === "string" && value !== "" ? value : null;
    };
    const first = text("first_name");
    const last = text("last_name");
    return ok({
      providerUserId,
      // The name a person set, then the handle. `username` is optional on
      // Telegram and `first_name` is not, so the order is the reverse of
      // Discord's for a documented reason and not by accident.
      displayName: first === null ? text("username") : [first, last].filter((part) => part !== null).join(" "),
      // TELEGRAM HAS NO EMAIL. It identifies people by phone number and never
      // discloses one to a bot, so null is the answer the port asks for and not
      // an omission.
      email: null,
    });
  }

  async verifyCredential(credential: ChannelCredential): Promise<Result<void>> {
    const answer = await telegramCall(this.transport, {
      method: TELEGRAM_METHOD.getMe,
      token: credential.token,
      body: {},
      operation: "read",
      route: { identity: credentialIdentity(credential.token), chatId: null },
    });
    if (!answer.ok) return err(answer.error);
    return answer.value["is_bot"] === true
      ? ok(undefined)
      : err(adapterRejected(TELEGRAM_PROVIDER, "token probe did not answer with a bot account"));
  }
}

/** Build the adapter. Total over its options: nothing to parse, nothing to open. */
export function createChannelTelegramAdapter(options: ChannelTelegramOptions = {}): ChannelTelegramAdapter {
  return new TelegramRuntime(
    Object.freeze({
      apiUrl: options.apiUrl ?? TELEGRAM_API_URL,
      timeoutMs: options.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS,
      // Bound to `globalThis` at construction; an unbound `fetch` throws
      // "Illegal invocation" when called through a property.
      fetch: options.fetch ??
        (((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
          globalThis.fetch(input, init)) as typeof fetch),
      limits: new TelegramRateLimits(options.now ?? (() => Date.now())),
    }),
  );
}
