// A rule's delivery half: where a matched event goes.
//
// The legacy union is `{type:"slack",url} | {type:"webhook",url} |
// {type:"email",email} | {type:"pagerduty",integrationKey}`, stored in
// `NotificationRule.delivery` and validated by `isRuleDelivery`. The four kinds
// and their exact admission rules are preserved:
//
//   slack / webhook  a non-empty `url` string
//   email            an `email` string CONTAINING "@" — nothing stricter
//   pagerduty        a non-empty `integrationKey`
//
// The email rule really is just "contains @". It is far weaker than any address
// grammar, and tightening it would refuse addresses that operators have working
// rules for today. It is preserved and pinned, and its weakness is recorded here
// rather than quietly corrected.
//
// NO SECRET LIVES HERE. The schema comment on the column says so — "typed
// destination configuration without secrets" — and a PagerDuty integration key
// is the closest thing to a counter-example. It stays because it is what the
// legacy column holds; a credential-vault reference is the `secrets`-shaped
// migration, not a change this refactor may make unilaterally.

import { err, ok, type Result } from "@platos/kernel";

import { ruleDestinationInvalid } from "./errors.js";

export const DESTINATION_KINDS = ["slack", "webhook", "email", "pagerduty"] as const;
export type DestinationKind = (typeof DESTINATION_KINDS)[number];

export type Destination =
  | { readonly kind: "slack"; readonly url: string }
  | { readonly kind: "webhook"; readonly url: string }
  | { readonly kind: "email"; readonly email: string }
  | { readonly kind: "pagerduty"; readonly integrationKey: string };

/** The unparsed column shape. `type` is the legacy discriminator name. */
export interface DestinationInput {
  readonly type?: unknown;
  readonly url?: unknown;
  readonly email?: unknown;
  readonly integrationKey?: unknown;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Parse the column into the union, or refuse.
 *
 * Mirrors `isRuleDelivery` exactly, including its default arm: an unrecognised
 * `type` is a refusal, not a pass-through. A rule whose destination cannot be
 * parsed is skipped at routing time rather than delivered to an unknown place.
 */
export function parseDestination(raw: DestinationInput | null | undefined): Result<Destination> {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    return err(ruleDestinationInvalid("delivery must be { type: slack|webhook|email|pagerduty, ... }"));
  }
  switch (raw.type) {
    case "slack":
      if (!nonEmptyString(raw.url)) return err(ruleDestinationInvalid("slack delivery requires a non-empty url"));
      return ok(Object.freeze({ kind: "slack", url: raw.url }));
    case "webhook":
      if (!nonEmptyString(raw.url)) return err(ruleDestinationInvalid("webhook delivery requires a non-empty url"));
      return ok(Object.freeze({ kind: "webhook", url: raw.url }));
    case "email":
      if (typeof raw.email !== "string" || !raw.email.includes("@")) {
        return err(ruleDestinationInvalid('email delivery requires an email containing "@"'));
      }
      return ok(Object.freeze({ kind: "email", email: raw.email }));
    case "pagerduty":
      if (!nonEmptyString(raw.integrationKey)) {
        return err(ruleDestinationInvalid("pagerduty delivery requires a non-empty integrationKey"));
      }
      return ok(Object.freeze({ kind: "pagerduty", integrationKey: raw.integrationKey }));
    default:
      return err(ruleDestinationInvalid("delivery must be { type: slack|webhook|email|pagerduty, ... }"));
  }
}

/**
 * Does this destination point at a URL the caller supplied?
 *
 * This is the question the SSRF screen is asked about, and it is a property of
 * the KIND rather than of the string: an email address and a PagerDuty key are
 * not fetched by this system, so screening them would be a category error. The
 * legacy code branches on `type === "slack" || type === "webhook"` in three
 * separate places; this is that predicate, named once.
 */
export function isNetworkDestination(
  destination: Destination,
): destination is Extract<Destination, { url: string }> {
  return destination.kind === "slack" || destination.kind === "webhook";
}

/** Back to the column shape, for an adapter that must write the `Json` value. */
export function toDestinationInput(destination: Destination): DestinationInput {
  if (destination.kind === "email") return { type: "email", email: destination.email };
  if (destination.kind === "pagerduty") {
    return { type: "pagerduty", integrationKey: destination.integrationKey };
  }
  return { type: destination.kind, url: destination.url };
}
