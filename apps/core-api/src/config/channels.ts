// The CHANNELS section — the inbound channel adapter and the two notifiers.
//
// ADR M0.3 §4 gives the channel and notifier adapter directories to this section:
// `channel-slack` and — since WIN-271 (M4.5), D10 — `channel-discord`,
// `channel-whatsapp` and `channel-telegram` satisfy
// `ChannelAdapter` and `ChannelRuntime` for the `channels` context, and
// `notifier-email` and `notifier-webhook` each satisfy `Notifier` for
// `cost-monitoring`. Since D20 (2026-09-15) `notifier-email` also satisfies
// identity-access's `MagicLinkDelivery`, which is why its group now names a login
// page. Two adapters
// on one port is not a mistake in the binding table — a budget alert can go to a
// mailbox, to an endpoint, or to both — so they are two independent groups here,
// and an install may declare either, neither or both.
//
// THE SIGNING SECRET IS THE ANCHOR, NOT A BOT TOKEN. An inbound channel is
// reachable from the public internet, and the only thing that makes a request on
// it trustworthy is the signature. Anchoring the group on the outbound token
// would let an install declare a channel it cannot verify: the process would
// boot, the endpoint would answer, and every forged request would be accepted.
// Anchoring on the signing secret makes "the channel is wired" and "the channel
// can tell a real caller from a forged one" the same statement.
//
// AND THE PER-INSTALLATION TOKENS ARE NOT HERE, for the reason the providers
// section gives at length: a workspace's bot token belongs to the organisation
// that installed the app, is a row in the `channels` context's canonical store,
// and is encrypted under the security section's root key. This section holds the
// APP's identity, which is one per deployable; not the INSTALLATIONS', which are
// one per customer.

import type { ConfigFieldSpec, ConfigSectionSpec } from "./schema.js";
import type { GroupPresence, SectionReader } from "./stores.js";

const slackSigningSecret: ConfigFieldSpec = Object.freeze({
  name: "PLATOS_CHANNELS_SLACK_SIGNING_SECRET",
  kind: "string",
  required: false,
  defaultValue: null,
  secret: true,
  describe: "the signing secret every inbound channel request is verified against",
  // Thirty-two is the shortest secret worth the name for an HMAC an attacker can
  // grind offline against a body they chose. The vendor mints longer ones; this
  // refuses the hand-typed placeholder that would otherwise ship to production.
  minimumLength: 32,
});

/**
 * WIN-271 (M4.5), D10. Discord's verification material is a PUBLIC KEY, and the
 * anchor rule above holds for it unchanged: the group is declared by the thing
 * that lets the endpoint tell Discord from a forger, never by a bot token.
 *
 * NOT A SECRET, and marked so deliberately. Discord shows it on the application's
 * General Information page and anybody holding it can do exactly one thing:
 * verify a signature. Redacting it from diagnostics would hide the one value an
 * operator needs to compare against the developer portal when every delivery is
 * refused INVALID.
 *
 * SIXTY-FOUR HEX DIGITS, AND NOTHING LONGER. It is a raw 32-byte Ed25519 key.
 * `packages/adapters/channel-discord/src/ed25519.ts` refuses anything else at
 * verification time as well, and explains why a longer value is the dangerous
 * one: `Buffer.from(value, "hex")` stops at the first non-hex character, so a key
 * with a stray suffix would decode to the genuine key. Refusing it HERE turns a
 * process that would boot and refuse every interaction into one that does not
 * boot and says which variable is wrong.
 *
 * AND NO BOT TOKEN BESIDE IT, for the reason the header gives about Slack's: a bot
 * token is the credential a CONNECTION holds, read per send from the `channels`
 * store through `ChannelCredentialReader`, so a rotation takes effect on the next
 * message. A process-wide token here would be a second copy of a credential with
 * a second rotation story, and nothing in the adapter would read it.
 */
const discordPublicKey: ConfigFieldSpec = Object.freeze({
  name: "PLATOS_CHANNELS_DISCORD_PUBLIC_KEY",
  kind: "string",
  required: false,
  defaultValue: null,
  secret: false,
  describe: "the application public key every inbound Discord interaction is verified against",
  pattern: "[0-9a-fA-F]{64}",
  patternDescribe: "sixty-four hexadecimal digits (a raw Ed25519 public key)",
  minimumLength: 64,
});

/**
 * WIN-271 (M4.5), D10. Meta's APP SECRET — the key `X-Hub-Signature-256` is
 * computed under. The anchor rule above holds for it unchanged: the group is
 * declared by the thing that lets the endpoint tell Meta from a forger, never by
 * a business access token.
 *
 * A SECRET, unlike Discord's public key, and the difference is not cosmetic.
 * Discord's verification material verifies and nothing else; Meta's app secret
 * PRODUCES signatures, so anybody holding it can forge a delivery for any
 * business this app serves. It is redacted from diagnostics for exactly that
 * reason.
 *
 * THIRTY-TWO IS THE FLOOR, for the reason Slack's signing secret has the same
 * one: an attacker can grind an HMAC offline against a body they chose. Meta
 * mints 32 hexadecimal characters; this refuses the hand-typed placeholder that
 * would otherwise ship to production.
 *
 * AND NO REPLAY WINDOW BESIDE IT. Slack's and Discord's groups carry a
 * `_REQUEST_MAX_AGE_S` because both providers SIGN a timestamp. Meta signs the
 * body alone — the only instant inside the signed bytes is the customer's send
 * time, and Meta retries an undelivered webhook for days — so a window here would
 * throw away exactly the deliveries an outage delayed, labelled as an
 * authentication failure. `packages/adapters/channel-whatsapp/src/verify.ts`
 * states that at length and names what defends against a replay instead: the
 * inbox's idempotency on the provider's own message id. A variable no code reads
 * would be worse than no variable.
 */
const whatsappAppSecret: ConfigFieldSpec = Object.freeze({
  name: "PLATOS_CHANNELS_WHATSAPP_APP_SECRET",
  kind: "string",
  required: false,
  defaultValue: null,
  secret: true,
  describe: "the Meta app secret every inbound WhatsApp webhook signature is verified against",
  minimumLength: 32,
});

/**
 * WIN-271 (M4.5), D10. The VERIFY TOKEN, which is a different secret from the app
 * secret and is required with it.
 *
 * WHY IT IS `requiredWithAnchor` AND NOT OPTIONAL. Meta will not deliver a single
 * webhook until the subscription handshake succeeds, and the handshake is
 * answered against this value alone. An install that set the app secret and left
 * this blank would boot, serve, verify nothing and receive nothing — and the
 * failure would surface as silence rather than as an error.
 *
 * ITS OWN VARIABLE, AND THE ADAPTER GIVES IT ITS OWN TYPE. `verify.ts` takes the
 * app secret and the verify token through two different parameter types, because
 * an endpoint that served both the signed POST and the subscription GET from one
 * slot is one refactor away from comparing the app secret against a query
 * parameter an anonymous caller chose.
 */
const whatsappVerifyToken: ConfigFieldSpec = Object.freeze({
  name: "PLATOS_CHANNELS_WHATSAPP_VERIFY_TOKEN",
  kind: "string",
  required: false,
  defaultValue: null,
  secret: true,
  describe: "the token Meta's subscription handshake is answered against",
  minimumLength: 32,
});

/**
 * WIN-271 (M4.5), D10. Telegram's WEBHOOK SECRET TOKEN — the value this install
 * gave `setWebhook`, echoed back in `X-Telegram-Bot-Api-Secret-Token` on every
 * delivery. The anchor rule holds: the group is declared by what authenticates
 * the endpoint, never by the bot token that sends.
 *
 * IT IS THE WEAKEST INBOUND MATERIAL OF THE FOUR CHANNEL GROUPS, and
 * `packages/adapters/channel-telegram/src/adapter.ts` opens with that sentence.
 * Telegram signs nothing: a caller who learns this string can post any body it
 * likes, because nothing in the request ties the token to the bytes. So the
 * grammar below is not a formality —
 *
 *   THE ALPHABET IS `setWebhook`'s OWN. "1-256 characters. Only characters A-Z,
 *   a-z, 0-9, _ and - are allowed." A value outside it is one `setWebhook` would
 *   have REFUSED, so no genuine delivery could ever carry it: the process would
 *   boot, the endpoint would answer, and every real request would be refused as a
 *   forgery. Refusing it HERE turns that into a boot failure that names the
 *   variable.
 *
 *   THIRTY-TWO IS THE FLOOR AND NOT ONE. Telegram permits a single character.
 *   Since the token is a bare bearer string on a public endpoint with no
 *   signature behind it, a short one is guessable online at whatever rate the
 *   endpoint can be called, and there is no second factor anywhere in the
 *   request. This is the one place an install can be stopped from choosing
 *   something catastrophic.
 *
 * AND NO REPLAY WINDOW BESIDE IT, for a sharper reason than WhatsApp's: with
 * nothing signed, a window would bound an UNAUTHENTICATED claim.
 */
const telegramSecretToken: ConfigFieldSpec = Object.freeze({
  name: "PLATOS_CHANNELS_TELEGRAM_SECRET_TOKEN",
  kind: "string",
  required: false,
  defaultValue: null,
  secret: true,
  describe: "the secret token every inbound Telegram update must present",
  pattern: "[A-Za-z0-9_-]{32,256}",
  patternDescribe: "32 to 256 characters from setWebhook's own alphabet (A-Z a-z 0-9 _ -)",
  minimumLength: 32,
});

const emailSmtpUrl: ConfigFieldSpec = Object.freeze({
  name: "PLATOS_CHANNELS_EMAIL_SMTP_URL",
  kind: "url",
  required: false,
  defaultValue: null,
  secret: true,
  describe: "the SMTP relay budget notifications are sent through",
  // `smtp:` and `smtps:` only. An `http:` relay URL is a configuration mistake
  // that would be discovered by a budget alert that never arrived, which is the
  // single worst moment to discover it.
  schemes: Object.freeze(["smtp:", "smtps:"]),
});

const webhookSigningKey: ConfigFieldSpec = Object.freeze({
  name: "PLATOS_CHANNELS_WEBHOOK_SIGNING_KEY",
  kind: "string",
  required: false,
  defaultValue: null,
  secret: true,
  describe: "the key outbound notification bodies are signed with",
  minimumLength: 32,
});

export const CHANNELS_SECTION: ConfigSectionSpec = Object.freeze({
  id: "channels",
  describe: "the inbound channel app and the outbound notifiers",
  groups: Object.freeze([
    Object.freeze({
      id: "slack",
      describe: "the inbound channel app's own identity",
      anchor: slackSigningSecret,
      requiredWithAnchor: Object.freeze([]),
      optional: Object.freeze([
        Object.freeze({
          name: "PLATOS_CHANNELS_SLACK_REQUEST_MAX_AGE_S",
          kind: "integer",
          required: false,
          // Five minutes, which is the window the vendor's own guidance names.
          // It is configurable because a replay window is a trade against clock
          // skew, and an install with a badly synchronised fleet needs to widen
          // it deliberately rather than discover it as intermittent rejections.
          defaultValue: "300",
          secret: false,
          describe: "how old a signed request may be before it is refused as a replay",
          minimum: 1,
          maximum: 3600,
        }),
      ]),
    }),
    Object.freeze({
      id: "discord",
      describe: "the inbound Discord interactions endpoint's application identity",
      anchor: discordPublicKey,
      requiredWithAnchor: Object.freeze([]),
      optional: Object.freeze([
        Object.freeze({
          name: "PLATOS_CHANNELS_DISCORD_REQUEST_MAX_AGE_S",
          kind: "integer",
          required: false,
          // Five minutes and the same bounds as Slack's. Discord documents no
          // replay window at all, which is why the adapter enforces one: the
          // timestamp is signed, and only a clock makes that mean anything.
          defaultValue: "300",
          secret: false,
          describe: "how old a signed interaction may be before it is refused as a replay",
          minimum: 1,
          maximum: 3600,
        }),
      ]),
    }),
    // WIN-271 (M4.5), D10. Two more inbound groups, each anchored on its own
    // verification material and each declaring NO replay window, for the reasons
    // the field comments give.
    Object.freeze({
      id: "whatsapp",
      describe: "the inbound WhatsApp Cloud API webhook's application identity",
      anchor: whatsappAppSecret,
      requiredWithAnchor: Object.freeze([whatsappVerifyToken]),
      optional: Object.freeze([]),
    }),
    Object.freeze({
      id: "telegram",
      describe: "the inbound Telegram webhook's shared secret token",
      anchor: telegramSecretToken,
      requiredWithAnchor: Object.freeze([]),
      optional: Object.freeze([]),
    }),
    Object.freeze({
      id: "emailNotifier",
      describe: "the email notifier",
      anchor: emailSmtpUrl,
      requiredWithAnchor: Object.freeze([
        Object.freeze({
          name: "PLATOS_CHANNELS_EMAIL_FROM",
          kind: "string",
          required: false,
          defaultValue: null,
          secret: false,
          describe: "the envelope sender budget notifications are sent from",
          // One `@`, something either side, a dot in the domain. Deliberately
          // not the full grammar — a relay rejecting an address is a recoverable
          // error, while an empty or obviously malformed sender is a
          // misconfiguration this file exists to refuse at boot.
          pattern: "[^@\\s]+@[^@\\s.]+\\.[^@\\s]+",
          patternDescribe: "an email address",
          minimumLength: 6,
        }),
        // D20 (2026-09-15) — the page a sign-in link opens. REQUIRED WITH THE RELAY
        // because the relay is now also how an operator signs in: `notifier-email`
        // satisfies identity-access's `MagicLinkDelivery`, and a link to nowhere is
        // a sign-in nobody can finish. It is configuration and never request data:
        // a link base a caller could choose would let anyone mail a victim a valid
        // token pointing at the caller's own host. No install declared this group
        // before the adapter existed (nothing read it), so requiring the field
        // breaks no deployed configuration.
        Object.freeze({
          name: "PLATOS_CHANNELS_EMAIL_LOGIN_URL",
          kind: "url",
          required: false,
          defaultValue: null,
          secret: false,
          describe: "the page a sign-in email links to; the single-use token is appended as ?token=",
          schemes: Object.freeze(["https:", "http:"]),
        }),
      ]),
      optional: Object.freeze([
        // TRUE BY DEFAULT, BECAUSE THE RELAY CARRIES A LOGIN-CAPABLE SECRET. An
        // `smtp:` relay upgraded only "when offered" hands a sign-in link in clear
        // to a relay that offers no STARTTLS, or to anybody on the path who strips
        // the offer from EHLO — which a plaintext EHLO cannot detect. With this
        // true, such a relay gets EHLO and nothing else
        // (`NOTIFIER_EMAIL_INSECURE_TRANSPORT_REFUSED`). `false` is for a local sink
        // that speaks no TLS; relay CREDENTIALS still never go in clear.
        Object.freeze({
          name: "PLATOS_CHANNELS_EMAIL_REQUIRE_TLS",
          kind: "boolean",
          required: false,
          defaultValue: "true",
          secret: false,
          describe: "whether a message may only be sent over smtps: or a STARTTLS-upgraded connection",
        }),
      ]),
    }),
    Object.freeze({
      id: "webhookNotifier",
      describe: "the webhook notifier",
      anchor: webhookSigningKey,
      requiredWithAnchor: Object.freeze([]),
      optional: Object.freeze([
        Object.freeze({
          name: "PLATOS_CHANNELS_WEBHOOK_TIMEOUT_MS",
          kind: "integer",
          required: false,
          defaultValue: "10000",
          secret: false,
          describe: "how long one notification delivery may take before it is abandoned",
          minimum: 100,
          maximum: 120000,
        }),
      ]),
    }),
  ]),
});

export interface SlackChannelConfiguration {
  readonly signingSecret: string;
  readonly requestMaxAgeSeconds: number;
}

export interface DiscordChannelConfiguration {
  readonly publicKey: string;
  readonly requestMaxAgeSeconds: number;
}

export interface WhatsAppChannelConfiguration {
  readonly appSecret: string;
  /** A DIFFERENT secret from the app secret; see the field comment. */
  readonly verifyToken: string;
}

export interface TelegramChannelConfiguration {
  readonly secretToken: string;
}

export interface EmailNotifierConfiguration {
  readonly smtpUrl: string;
  readonly from: string;
  readonly loginUrl: string;
  /** `PLATOS_CHANNELS_EMAIL_REQUIRE_TLS`; true unless set to exactly `false`. */
  readonly requireTls: boolean;
}

export interface WebhookNotifierConfiguration {
  readonly signingKey: string;
  readonly timeoutMs: number;
}

export interface ChannelsConfiguration {
  readonly slack: SlackChannelConfiguration | null;
  readonly discord: DiscordChannelConfiguration | null;
  readonly whatsapp: WhatsAppChannelConfiguration | null;
  readonly telegram: TelegramChannelConfiguration | null;
  readonly emailNotifier: EmailNotifierConfiguration | null;
  readonly webhookNotifier: WebhookNotifierConfiguration | null;
}

export function assembleChannels(read: SectionReader, declared: GroupPresence): ChannelsConfiguration {
  return Object.freeze({
    slack: !declared("slack")
      ? null
      : Object.freeze({
          signingSecret: read("PLATOS_CHANNELS_SLACK_SIGNING_SECRET") ?? "",
          requestMaxAgeSeconds: Number(read("PLATOS_CHANNELS_SLACK_REQUEST_MAX_AGE_S")),
        }),
    discord: !declared("discord")
      ? null
      : Object.freeze({
          publicKey: read("PLATOS_CHANNELS_DISCORD_PUBLIC_KEY") ?? "",
          requestMaxAgeSeconds: Number(read("PLATOS_CHANNELS_DISCORD_REQUEST_MAX_AGE_S")),
        }),
    whatsapp: !declared("whatsapp")
      ? null
      : Object.freeze({
          appSecret: read("PLATOS_CHANNELS_WHATSAPP_APP_SECRET") ?? "",
          verifyToken: read("PLATOS_CHANNELS_WHATSAPP_VERIFY_TOKEN") ?? "",
        }),
    telegram: !declared("telegram")
      ? null
      : Object.freeze({
          secretToken: read("PLATOS_CHANNELS_TELEGRAM_SECRET_TOKEN") ?? "",
        }),
    emailNotifier: !declared("emailNotifier")
      ? null
      : Object.freeze({
          smtpUrl: read("PLATOS_CHANNELS_EMAIL_SMTP_URL") ?? "",
          from: read("PLATOS_CHANNELS_EMAIL_FROM") ?? "",
          loginUrl: read("PLATOS_CHANNELS_EMAIL_LOGIN_URL") ?? "",
          requireTls: read("PLATOS_CHANNELS_EMAIL_REQUIRE_TLS") !== "false",
        }),
    webhookNotifier: !declared("webhookNotifier")
      ? null
      : Object.freeze({
          signingKey: read("PLATOS_CHANNELS_WEBHOOK_SIGNING_KEY") ?? "",
          timeoutMs: Number(read("PLATOS_CHANNELS_WEBHOOK_TIMEOUT_MS")),
        }),
  });
}
