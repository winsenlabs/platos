// The CHANNELS section — the inbound channel adapter and the two notifiers.
//
// ADR M0.3 §4 gives the channel and notifier adapter directories to this section:
// `channel-slack` and — since WIN-271 (M4.5), D10 — `channel-discord` satisfy
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
