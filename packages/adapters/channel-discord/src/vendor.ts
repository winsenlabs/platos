// THE ONE FILE IN THIS DIRECTORY THAT NAMES DISCORD'S WIRE VOCABULARY.
//
// `channel-slack/src/vendor.ts` funnels a vendor SDK: every other module there
// imports the SDK through it, so the whole vendor surface can be read in one
// screen. THIS DIRECTORY HOLDS NO SDK, and that is a decision rather than an
// omission. Discord's inbound half is an Ed25519 signature `node:crypto` verifies
// natively, and its outbound half is four JSON-over-HTTPS routes. A client
// library for that would be a dependency, an SBOM row and an advisory stream
// bought to save a `fetch` — and the SDK already in the lockfile
// (`@chat-adapter/discord`, which `apps/agent` ships) is pinned by
// `chat-sdk-only` to `packages/adapters/channel-slack/`, so it is not available
// here anyway.
//
// So the funnel is kept for the same reason with a different content: every
// number and header name Discord defines is spelled HERE, once, with where it is
// written down, and nothing else in this directory writes one. A Discord
// constant typed twice is a constant that can be corrected in one place.
//
// PROVENANCE. Transcribed from `discord/discord-api-docs` at commit
// 52ecc8a1908cc3a8dadb55671aef696bb1ed270e:
//   developers/interactions/overview.mdx              — the two signature headers,
//                                                       PING/PONG, the 401 rule
//   developers/interactions/receiving-and-responding.mdx — interaction and
//                                                       callback types, followups
//   developers/resources/channel.mdx                  — the three thread types
//   developers/topics/rate-limits.mdx                 — the X-RateLimit-* headers
//   developers/reference.mdx                          — v10, the User-Agent form,
//                                                       the snowflake epoch
//
// AND IT IS JOINED, NOT TRUSTED. `discord-signature.test.ts` asks
// `discord-interactions` — Discord's OWN published helper library, a devDependency
// pinned at the version `apps/agent` already resolves — for its enum values and
// asserts they equal the numbers below. A mistyped `PONG` would answer every
// endpoint check with the wrong body and Discord would remove the endpoint.

/**
 * The REST base. Version 10, the current documented version. The trailing slash
 * is load-bearing for the reason `channel-slack/src/send.ts` gives: a route is
 * resolved with `new URL(route, base)`, and a base with no trailing slash drops
 * its last path segment.
 */
export const DISCORD_API_URL = "https://discord.com/api/v10/";

/** The two headers an interaction is signed with. Lower-cased; see the port. */
export const DISCORD_SIGNATURE_HEADER = "x-signature-ed25519";
export const DISCORD_TIMESTAMP_HEADER = "x-signature-timestamp";

/**
 * `Authorization: Bot <token>` — a bot token is presented with this scheme, not
 * `Bearer`. A `Bearer` bot token is refused with 401, which this adapter would
 * report as a dead credential while the credential is perfectly alive.
 */
export const DISCORD_BOT_AUTHORIZATION_SCHEME = "Bot";

/**
 * `developers/reference.mdx` § HTTP API: "Clients using the HTTP API must provide
 * a valid User Agent ... `DiscordBot ($url, $versionNumber)`".
 */
export const DISCORD_USER_AGENT = "DiscordBot (https://github.com/winsenlabs/platos, 1)";

/** Interaction types. */
export const DISCORD_INTERACTION_TYPE = Object.freeze({
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
  MODAL_SUBMIT: 5,
} as const);

/** Interaction callback types — what the HTTP response to an interaction says. */
export const DISCORD_CALLBACK_TYPE = Object.freeze({
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
} as const);

/** Application command types. Only CHAT_INPUT carries typed text. */
export const DISCORD_APPLICATION_COMMAND_TYPE = Object.freeze({
  CHAT_INPUT: 1,
  USER: 2,
  MESSAGE: 3,
} as const);

/**
 * The channel types that are THREADS: ANNOUNCEMENT_THREAD (10), PUBLIC_THREAD
 * (11), PRIVATE_THREAD (12). A thread is itself a channel with a `parent_id`,
 * which is why a Discord conversation address has a channel and an optional
 * thread and not a message timestamp.
 *
 * All three, and not the two `@chat-adapter/discord@4.34.0` checks (it tests
 * `11 || 12` only). An announcement thread has a parent exactly as the other two
 * do, and leaving it out would key a reply inside one on the THREAD id as if it
 * were a top-level channel — so a `channel` routing rule naming the announcement
 * channel would never match it.
 */
export const DISCORD_THREAD_CHANNEL_TYPES: ReadonlySet<number> = new Set([10, 11, 12]);

/** The first millisecond of 2015, which every snowflake's timestamp counts from. */
export const DISCORD_EPOCH_MS = 1_420_070_400_000n;

/**
 * The rate-limit response headers, lower-cased.
 *
 * `X-RateLimit-Global` and `X-RateLimit-Scope` are "returned only on HTTP 429
 * responses"; the other three arrive on ordinary answers too, which is what lets
 * a client stop BEFORE it is refused.
 */
export const DISCORD_RATE_LIMIT_HEADER = Object.freeze({
  bucket: "x-ratelimit-bucket",
  remaining: "x-ratelimit-remaining",
  resetAfter: "x-ratelimit-reset-after",
  global: "x-ratelimit-global",
  scope: "x-ratelimit-scope",
  retryAfter: "retry-after",
} as const);

/**
 * `allowed_mentions: { parse: [] }` on every message this adapter writes.
 *
 * THE ASSISTANT'S TEXT IS PARTLY THE USER'S TEXT. A reply that quotes
 * `@everyone` or a role mention back would ping a whole server on the bot's
 * authority, and Discord's default is to parse every mention in `content`. An
 * empty `parse` list renders the mention and notifies nobody.
 */
export const DISCORD_NO_MENTIONS = Object.freeze({ parse: Object.freeze([]) });
