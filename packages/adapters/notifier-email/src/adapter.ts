// `notifier-email` — outbound email over an SMTP relay, for TWO owners.
//
// It was WIN-251's generated interface until D20 (2026-09-15): "core-api sends [the
// magic-link email] through the notifier-email adapter. A login-capable token is
// never returned to the BFF." So the directory gained a constructor, and with it
// the binding it always declared plus one more:
//
//   cost-monitoring:Notifier           a budget alert, rendered by the ONE renderer
//                                      that context publishes, to an EMAIL target
//   identity-access:MagicLinkDelivery  a sign-in link, to the address that asked
//
// ONE DIRECTORY, BECAUSE ONE RELAY. ADR M0.3 §15's amendment is "one vendor
// client, one directory", and both ports speak to the same relay with the same
// credentials from the same configuration group; a second directory would be a
// second SMTP client for one relay. Neither context imports the other: each names
// its own port, and only this object satisfies both.
//
// WHAT IT OWNS, AND WHAT IT DOES NOT. It owns the relay conversation, the bytes of
// a message and the shape of the link (which page opens it is install
// configuration: `PLATOS_CHANNELS_EMAIL_LOGIN_URL`). It does not own the token —
// what it is, how long it lives, whether it may be spent twice — which
// identity-access decided before calling, nor any budget fact.
//
// THE TOKEN IS WRITTEN INTO THE LINK AND INTO NOTHING ELSE: not a log line, not a
// refusal's `details`, not a header.

import { randomUUID } from "node:crypto";

import type {
  MagicLinkDelivery,
  MagicLinkMessage,
  Result,
} from "@platos/context-identity-access/application/ports/index.js";
import { err, ok } from "@platos/context-identity-access/application/ports/index.js";
import type {
  DeliveryOutcome,
  NotificationProbe,
  NotificationRequest,
  NotificationTarget,
  Notifier,
} from "@platos/context-cost-monitoring/application/ports/index.js";
import {
  delivered,
  notDelivered,
  renderAlertSubject,
  renderAlertText,
} from "@platos/context-cost-monitoring/application/ports/index.js";

import { configurationInvalid } from "./errors.js";
import { admitAddress, domainOf, renderMessage } from "./message.js";
import { parseRelayUrl, type RelayEndpoint } from "./relay.js";
import { sendOverSmtp, type SmtpOptions } from "./smtp-session.js";

export interface NotifierEmailAdapter extends Notifier, MagicLinkDelivery {
  readonly adapterName: "notifier-email";
}

export interface NotifierEmailOptions {
  /** `PLATOS_CHANNELS_EMAIL_SMTP_URL`. */
  readonly smtpUrl: string;
  /** `PLATOS_CHANNELS_EMAIL_FROM`. */
  readonly from: string;
  /** `PLATOS_CHANNELS_EMAIL_LOGIN_URL` — the page a sign-in link opens; `?token=` is appended. */
  readonly loginUrl: string;
  /** Stamps the `Date` header. Injected, so a message is a function of its inputs. */
  readonly clock: { now(): Date };
  /** The whole relay transaction's budget. Fifteen seconds unless told otherwise. */
  readonly timeoutMs?: number;
  /** A private CA for the relay's certificate. Verification is never turned off. */
  readonly tls?: SmtpOptions["tls"];
}

/** The subject the oracle's sign-in form used, byte for byte. */
export const MAGIC_LINK_SUBJECT = "Sign in to Platos";

const DEFAULT_TIMEOUT_MS = 15_000;

/** The text of a sign-in email. Exported so a suite asserts on the renderer, not on a copy. */
export function renderMagicLinkText(link: string, expiresAt: Date): string {
  return [
    `Sign in to Platos: ${link}`,
    "",
    `This link works once and expires at ${expiresAt.toISOString()}.`,
    "If you did not ask to sign in, you can ignore this message.",
  ].join("\n");
}

/** The link, with the token as its one added query parameter. */
export function magicLinkUrl(loginUrl: URL, token: string): string {
  const link = new URL(loginUrl.href);
  link.searchParams.set("token", token);
  return link.href;
}

function admitLoginUrl(value: string): Result<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return err(configurationInvalid("loginUrl", "not a URL"));
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return err(configurationInvalid("loginUrl", "scheme must be http: or https:"));
  }
  if (url.searchParams.has("token")) {
    return err(configurationInvalid("loginUrl", "must not already carry a token parameter"));
  }
  return ok(url);
}

export function createNotifierEmailAdapter(options: NotifierEmailOptions): Result<NotifierEmailAdapter> {
  const relay = parseRelayUrl(options.smtpUrl);
  if (!relay.ok) return relay;
  const from = admitAddress("from", options.from);
  if (!from.ok) return err(configurationInvalid("from", "not a single ASCII address"));
  const loginUrl = admitLoginUrl(options.loginUrl);
  if (!loginUrl.ok) return loginUrl;
  return ok(buildAdapter(relay.value, from.value, loginUrl.value, options));
}

function buildAdapter(
  relay: RelayEndpoint,
  from: string,
  loginUrl: URL,
  options: NotifierEmailOptions,
): NotifierEmailAdapter {
  const smtp: SmtpOptions = {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(options.tls === undefined ? {} : { tls: options.tls }),
  };
  const senderDomain = domainOf(from);

  async function send(to: string, subject: string, text: string, messageLocal: string): Promise<Result<void>> {
    const data = renderMessage({
      from,
      to,
      subject,
      text,
      messageId: `${messageLocal}@${senderDomain}`,
      date: options.clock.now(),
    });
    if (!data.ok) return data;
    return sendOverSmtp(relay, { from, to, data: data.value, clientName: senderDomain }, smtp);
  }

  /** The recipient of a target this adapter serves, or null for one it does not. */
  function emailOf(target: NotificationTarget): string | null {
    return target.kind === "EMAIL" ? target.email : null;
  }

  function outcome(sent: Result<void>): Result<DeliveryOutcome> {
    return ok(sent.ok ? delivered() : notDelivered(sent.error.code, sent.error.message));
  }

  /** The delivery's idempotency key as a msg-id local part; its `:` separators are not legal there. */
  function messageLocalOf(idempotencyKey: string): string {
    return Buffer.from(idempotencyKey, "utf8").toString("base64url");
  }

  return Object.freeze({
    adapterName: "notifier-email" as const,
    kinds: Object.freeze(["EMAIL" as const]),

    async deliverMagicLink(message: MagicLinkMessage): Promise<Result<void>> {
      return send(
        message.email,
        MAGIC_LINK_SUBJECT,
        renderMagicLinkText(magicLinkUrl(loginUrl, message.token), message.expiresAt),
        randomUUID(),
      );
    },

    async deliver(request: NotificationRequest): Promise<Result<DeliveryOutcome>> {
      const to = emailOf(request.target);
      if (to === null) return ok(notDelivered("unsupported_channel", "this notifier delivers EMAIL targets only"));
      // THE DELIVERY'S IDEMPOTENCY KEY IS THE MESSAGE-ID, as `notifier.ts` asks, so
      // a redelivered alert is recognisably the same message to its recipient.
      return outcome(
        await send(
          to,
          renderAlertSubject(request.alert),
          renderAlertText(request.alert),
          messageLocalOf(request.idempotencyKey),
        ),
      );
    },

    async probe(request: NotificationProbe): Promise<Result<DeliveryOutcome>> {
      const to = emailOf(request.target);
      if (to === null) return ok(notDelivered("unsupported_channel", "this notifier delivers EMAIL targets only"));
      return outcome(
        await send(
          to,
          `Platos test notification: ${request.channelName}`,
          request.message,
          messageLocalOf(request.idempotencyKey),
        ),
      );
    },
  });
}
