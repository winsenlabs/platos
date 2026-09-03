// The `channels` domain (ADR M0.3 §1, context 9).
//
// Six aggregates in three families, plus the vocabulary they share.
//
//   ChannelConnection    a DIRECT connection to a provider, environment-scoped.
//   ChannelApp           an OAUTH-DISTRIBUTED application, environment-scoped.
//   ChannelInstallation  one workspace's install of an app, carrying the
//                        rotating-grant refresh fence.
//   ChannelThread        a link from a provider conversation to a Platos thread,
//   ChannelAppThread     the same link on the hosted-app path (one union here).
//   ChannelEventInbox    durable, idempotent admission plus a processing lease.
//
// THE TWO EDGES THIS LAYER DOES NOT HAVE. ADR M0.3 §3 makes `channels` and
// `conversations` mutually non-importing: inbound becomes a durable job payload
// (`inbound.ts`) and outbound becomes an event subscription. Nothing in this
// directory names a turn engine, and nothing names a provider SDK either — the
// vendor lives behind `ChannelAdapter` in `application/ports`.
//
// This layer imports `@platos/kernel` and its own siblings, and nothing else —
// no framework, no client, no peer context (ADR M0.3 §2).
export * from "./identifiers.js";
export * from "./errors.js";
export * from "./provider.js";
export * from "./policy.js";
export * from "./routing.js";
export * from "./connection.js";
export * from "./installation.js";
export * from "./thread-link.js";
export * from "./event-inbox.js";
export * from "./inbound.js";
