// The CHANNELS section — the inbound channel adapter and the two notifiers.
//
// ADR M0.3 §4 gives three adapter directories to this section: `channel-slack`
// satisfies `ChannelAdapter` for the `channels` context, and `notifier-email` and
// `notifier-webhook` each satisfy `Notifier` for `cost-monitoring`. Two adapters
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
      ]),
      optional: Object.freeze([]),
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

export interface EmailNotifierConfiguration {
  readonly smtpUrl: string;
  readonly from: string;
}

export interface WebhookNotifierConfiguration {
  readonly signingKey: string;
  readonly timeoutMs: number;
}

export interface ChannelsConfiguration {
  readonly slack: SlackChannelConfiguration | null;
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
    emailNotifier: !declared("emailNotifier")
      ? null
      : Object.freeze({
          smtpUrl: read("PLATOS_CHANNELS_EMAIL_SMTP_URL") ?? "",
          from: read("PLATOS_CHANNELS_EMAIL_FROM") ?? "",
        }),
    webhookNotifier: !declared("webhookNotifier")
      ? null
      : Object.freeze({
          signingKey: read("PLATOS_CHANNELS_WEBHOOK_SIGNING_KEY") ?? "",
          timeoutMs: Number(read("PLATOS_CHANNELS_WEBHOOK_TIMEOUT_MS")),
        }),
  });
}
