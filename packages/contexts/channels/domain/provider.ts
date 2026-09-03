// The channel provider vocabulary, and the two places it is NOT the same list.
//
// `provider` is a plain `String` column on both `ChannelConnection` and
// `ChannelApp`, but the live system admits DIFFERENT sets on the two paths and
// that difference is load-bearing, not an oversight:
//
//   DIRECT connections  slack | telegram | whatsapp | discord
//   HOSTED apps         slack
//
// A hosted app is an OAuth-distributed application installed into a workspace by
// a third party. Only Slack has that shape here; the other three are direct
// bot-token connections with no installation model. Collapsing the two lists
// would let an operator mint a `ChannelApp` for a provider that has no
// installation flow, and the failure would surface much later, at OAuth time.
//
// Both are normalized the same way (trim + lower-case) because a provider name
// is compared, indexed and used as a routing discriminator: `"Slack"` and
// `"slack"` reaching the same store as different strings is how a connection
// becomes invisible to its own adapter.

import { err, ok, type Result } from "@platos/kernel";

import { routingInvalid } from "./errors.js";

/** Providers reachable as a direct connection (`ChannelConnection.provider`). */
export const CONNECTION_PROVIDERS = Object.freeze(["slack", "telegram", "whatsapp", "discord"] as const);

/** Providers reachable as a hosted app (`ChannelApp.provider`). */
export const APP_PROVIDERS = Object.freeze(["slack"] as const);

export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number];
export type AppProvider = (typeof APP_PROVIDERS)[number];

/** `ChannelApp.distribution` — who may install the app. */
export const APP_DISTRIBUTIONS = Object.freeze(["private", "public"] as const);
export type AppDistribution = (typeof APP_DISTRIBUTIONS)[number];

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function admit<Value extends string>(
  value: unknown,
  allowed: readonly Value[],
  field: string,
): Result<Value> {
  const normalized = normalize(value);
  const match = allowed.find((candidate) => candidate === normalized);
  if (match === undefined) {
    return err(routingInvalid(`${field} must be one of: ${allowed.join(" | ")}`));
  }
  return ok(match);
}

export function admitConnectionProvider(value: unknown): Result<ConnectionProvider> {
  return admit(value, CONNECTION_PROVIDERS, "provider");
}

/**
 * Deliberately narrower than {@link admitConnectionProvider}. See the header:
 * a provider with no installation model cannot be an app.
 */
export function admitAppProvider(value: unknown): Result<AppProvider> {
  return admit(value, APP_PROVIDERS, "provider");
}

export function admitAppDistribution(value: unknown): Result<AppDistribution> {
  return admit(value, APP_DISTRIBUTIONS, "distribution");
}

/**
 * Slack threads a conversation under a parent message; the other providers do
 * not. The inbound path needs this to decide whether a reply belongs to an
 * existing channel thread or starts a new one, and asking it here keeps the
 * per-provider branch out of the use cases.
 */
export function supportsNativeThreading(provider: ConnectionProvider): boolean {
  return provider === "slack";
}
