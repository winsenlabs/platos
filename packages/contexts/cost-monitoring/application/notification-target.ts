// Turning a stored channel configuration into a dispatchable target.
//
// Small, and its own file, because it is the ONE place a configuration becomes
// something a transport can act on — and because the answer is sometimes "it
// cannot", which every dispatch path needs to reach identically.
//
// `null` MEANS UNDELIVERABLE, AND IT IS A CONFIGURATION FACT, NOT A FAILURE.
//
// A chat channel with no token was configured against a workspace link that has
// since been revoked. There is nothing to retry — the row is complete, valid, and
// unable to send — so every path treats it as `missing_configuration` before any
// network call, records that on the ledger, and moves to the next recipient.
//
// The source spells this check five times: twice in the budget dispatcher and
// three times in the test surface, once per kind, each with its own message.
// Two of them also fold in an unrelated condition — whether an optional
// collaborator was injected — so a channel with a perfectly good address reports
// itself as misconfigured when it is the process that is.

import type { AlertChannel } from "../domain/index.js";
import type { NotificationTarget } from "./ports/index.js";

/**
 * The dispatchable form of a channel's configuration, or `null`.
 *
 * Email needs an address. A chat channel needs both an id and a token. A webhook
 * needs a URL and a signing secret — an unsigned webhook is forgeable, so a
 * missing secret is undeliverable rather than deliverable-without-a-signature.
 */
export function targetFor(channel: AlertChannel): NotificationTarget | null {
  const configuration = channel.configuration;
  if (configuration.kind === "EMAIL") {
    return configuration.email === "" ? null : { kind: "EMAIL", email: configuration.email };
  }
  if (configuration.kind === "SLACK") {
    if (configuration.channelId === "" || configuration.credential === null) return null;
    return {
      kind: "SLACK",
      channelId: configuration.channelId,
      credential: configuration.credential,
    };
  }
  if (configuration.url === "") return null;
  return { kind: "WEBHOOK", url: configuration.url, credential: configuration.credential };
}
