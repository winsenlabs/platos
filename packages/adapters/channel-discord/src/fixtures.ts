// PROVIDER FIXTURES: Discord interaction bodies, and a signer for them.
//
// WHY THE SIGNER IS NOT A CIRCULAR ASSERTION. `signDiscordDelivery` signs with
// `node:crypto` over `discordSignedMessage` — the construction under test — so on
// its own it would be two copies of one formula agreeing. It is not on its own:
//
//   RFC 8032's published vectors  ==  node:crypto Ed25519 over a raw key
//                                     (`rfc8032.test.ts`, all five vectors)
//   Discord's own helper library  ==  this construction
//                                     (`discord-signature.test.ts`: every fixture
//                                     below is ALSO verified by
//                                     `discord-interactions`' `verifyKey`, and a
//                                     body+timestamp ordering it refuses is
//                                     refused here too)
//
// and the KEY PAIR is not one this repository minted either: it is RFC 8032 §7.1
// TEST 1's, so anybody can re-derive every signature below from a public document.
//
// THE BODIES ARE DISCORD'S SHAPES — the fields `receiving-and-responding.mdx`
// documents for an interaction: `id`, `application_id`, `type`, `data`,
// `guild_id`, `channel` (a partial channel with `type` and `parent_id`),
// `channel_id`, `member.user` in a guild or `user` in a DM, `token`, `version`.
// Ids are snowflakes; the `token` values are inert strings that authorize
// nothing anywhere.

import { createPrivateKey, sign } from "node:crypto";

import type { SignedDelivery } from "@platos/context-channels/application/ports/index.js";

import { RFC8032_ED25519_VECTORS } from "./rfc8032-vectors.js";
import { DISCORD_SIGNATURE_HEADER, DISCORD_TIMESTAMP_HEADER } from "./vendor.js";
import { discordSignedMessage } from "./verify.js";

/** RFC 8410 §7 PKCS#8 header for a raw 32-byte Ed25519 seed. */
const ED25519_PKCS8_PREFIX_HEX = "302e020100300506032b657004220420";

const TEST_1 = RFC8032_ED25519_VECTORS[0]!;

/** The application public key every fixture verifies against: RFC 8032 TEST 1's. */
export const FIXTURE_PUBLIC_KEY = TEST_1.publicKey;

/** RFC 8032 TEST 2's public key — a real key that did NOT sign the fixtures. */
export const OTHER_PUBLIC_KEY = RFC8032_ED25519_VECTORS[1]!.publicKey;

export const FIXTURE_INSTANT = new Date("2026-04-01T12:00:00.000Z");

export function privateKeyFromSeed(seedHex: string) {
  return createPrivateKey({
    key: Buffer.concat([Buffer.from(ED25519_PKCS8_PREFIX_HEX, "hex"), Buffer.from(seedHex, "hex")]),
    format: "der",
    type: "pkcs8",
  });
}

const FIXTURE_PRIVATE_KEY = privateKeyFromSeed(TEST_1.secretKey);

/** Sign `timestamp + body` the way Discord does and present it as a delivery. */
export function signDiscordDelivery(
  rawBody: string,
  options: { readonly signedAt?: Date; readonly receivedAt?: Date; readonly timestamp?: string } = {},
): SignedDelivery {
  const signedAt = options.signedAt ?? FIXTURE_INSTANT;
  const timestamp = options.timestamp ?? String(Math.floor(signedAt.getTime() / 1000));
  const signature = sign(null, discordSignedMessage(timestamp, rawBody), FIXTURE_PRIVATE_KEY).toString("hex");
  return {
    rawBody,
    headers: { [DISCORD_TIMESTAMP_HEADER]: timestamp, [DISCORD_SIGNATURE_HEADER]: signature },
    receivedAt: options.receivedAt ?? signedAt,
  };
}

export const APPLICATION_ID = "1181222333444555666";
export const GUILD_ID = "1181000000000000001";
export const TEXT_CHANNEL_ID = "1181000000000000100";
export const THREAD_ID = "1181000000000000200";
export const DM_CHANNEL_ID = "1181000000000000300";
export const USER_ID = "1181000000000000900";

const user = { id: USER_ID, username: "riverwatcher", global_name: "River Watcher" };

function interaction(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    application_id: APPLICATION_ID,
    token: "aW50ZXJhY3Rpb24tdG9rZW4tZml4dHVyZQ",
    version: 1,
    ...overrides,
  });
}

/** The endpoint check. Answered `{"type":1}`, never admitted. */
export const PING_BODY = interaction({ id: "1181999000000000001", type: 1 });

/** `/ask question:"is it everything a river should be?"` in a guild text channel. */
export const COMMAND_IN_CHANNEL_BODY = interaction({
  id: "1181999000000000010",
  type: 2,
  guild_id: GUILD_ID,
  channel_id: TEXT_CHANNEL_ID,
  channel: { id: TEXT_CHANNEL_ID, type: 0, guild_id: GUILD_ID },
  member: { user, roles: [] },
  data: {
    id: "1181888000000000001",
    name: "ask",
    type: 1,
    options: [{ name: "question", type: 3, value: "is it everything a river should be?" }],
  },
});

/** The same command, a SECOND time, in a thread under that channel. */
export const COMMAND_IN_THREAD_BODY = interaction({
  id: "1181999000000000011",
  type: 2,
  guild_id: GUILD_ID,
  channel_id: THREAD_ID,
  channel: { id: THREAD_ID, type: 11, parent_id: TEXT_CHANNEL_ID, guild_id: GUILD_ID },
  member: { user, roles: [] },
  data: { id: "1181888000000000001", name: "ask", type: 1, options: [{ name: "question", type: 3, value: "and the second half?" }] },
});

/** A later command in the SAME thread. Different interaction, same conversation. */
export const SECOND_COMMAND_IN_THREAD_BODY = interaction({
  id: "1181999000000000012",
  type: 2,
  guild_id: GUILD_ID,
  channel_id: THREAD_ID,
  channel: { id: THREAD_ID, type: 11, parent_id: TEXT_CHANNEL_ID, guild_id: GUILD_ID },
  member: { user, roles: [] },
  data: { id: "1181888000000000001", name: "ask", type: 1, options: [{ name: "question", type: 3, value: "and after that?" }] },
});

/** An announcement thread (type 10) — the thread type the legacy SDK does not check. */
export const COMMAND_IN_ANNOUNCEMENT_THREAD_BODY = interaction({
  id: "1181999000000000013",
  type: 2,
  guild_id: GUILD_ID,
  channel_id: "1181000000000000210",
  channel: { id: "1181000000000000210", type: 10, parent_id: "1181000000000000110", guild_id: GUILD_ID },
  member: { user, roles: [] },
  data: { id: "1181888000000000001", name: "ask", type: 1, options: [{ name: "question", type: 3, value: "news?" }] },
});

/** A sub-command with nested options, in a DM: `/agent ask topic:rivers depth:3`. */
export const SUBCOMMAND_IN_DM_BODY = interaction({
  id: "1181999000000000020",
  type: 2,
  channel_id: DM_CHANNEL_ID,
  channel: { id: DM_CHANNEL_ID, type: 1 },
  user,
  data: {
    id: "1181888000000000002",
    name: "agent",
    type: 1,
    options: [{ name: "ask", type: 1, options: [{ name: "topic", type: 3, value: "rivers" }, { name: "depth", type: 4, value: 3 }] }],
  },
});

/** A button click. Verified, real, no behaviour in this build. */
export const COMPONENT_BODY = interaction({
  id: "1181999000000000030",
  type: 3,
  guild_id: GUILD_ID,
  channel_id: TEXT_CHANNEL_ID,
  member: { user, roles: [] },
  data: { custom_id: "retry", component_type: 2 },
});

/** Autocomplete while typing an option. */
export const AUTOCOMPLETE_BODY = interaction({
  id: "1181999000000000031",
  type: 4,
  guild_id: GUILD_ID,
  channel_id: TEXT_CHANNEL_ID,
  member: { user, roles: [] },
  data: { id: "1181888000000000001", name: "ask", type: 1, options: [{ name: "question", type: 3, value: "is it", focused: true }] },
});

/** A message context-menu command (application command type 3). */
export const MESSAGE_COMMAND_BODY = interaction({
  id: "1181999000000000032",
  type: 2,
  guild_id: GUILD_ID,
  channel_id: TEXT_CHANNEL_ID,
  member: { user, roles: [] },
  data: { id: "1181888000000000003", name: "Ask about this", type: 3, target_id: "1181000000000000555" },
});

/** A command whose invoker is flagged as a bot. */
export const BOT_COMMAND_BODY = interaction({
  id: "1181999000000000040",
  type: 2,
  guild_id: GUILD_ID,
  channel_id: TEXT_CHANNEL_ID,
  member: { user: { ...user, bot: true }, roles: [] },
  data: { id: "1181888000000000001", name: "ask", type: 1, options: [{ name: "question", type: 3, value: "loop?" }] },
});

/** A command with no interaction id. Cannot be deduplicated. */
export const NO_ID_COMMAND_BODY = interaction({
  type: 2,
  guild_id: GUILD_ID,
  channel_id: TEXT_CHANNEL_ID,
  member: { user, roles: [] },
  data: { id: "1181888000000000001", name: "ask", type: 1, options: [{ name: "question", type: 3, value: "anyone?" }] },
});

/** A command with no channel. Nowhere to answer. */
export const NO_CHANNEL_COMMAND_BODY = interaction({
  id: "1181999000000000050",
  type: 2,
  member: { user, roles: [] },
  data: { id: "1181888000000000001", name: "ask", type: 1, options: [{ name: "question", type: 3, value: "where?" }] },
});

/** Every fixture, for the suites that walk all of them. */
export const ALL_FIXTURE_BODIES: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["ping", PING_BODY],
  ["command_in_channel", COMMAND_IN_CHANNEL_BODY],
  ["command_in_thread", COMMAND_IN_THREAD_BODY],
  ["second_command_in_thread", SECOND_COMMAND_IN_THREAD_BODY],
  ["command_in_announcement_thread", COMMAND_IN_ANNOUNCEMENT_THREAD_BODY],
  ["subcommand_in_dm", SUBCOMMAND_IN_DM_BODY],
  ["component", COMPONENT_BODY],
  ["autocomplete", AUTOCOMPLETE_BODY],
  ["message_command", MESSAGE_COMMAND_BODY],
  ["bot_command", BOT_COMMAND_BODY],
  ["no_id_command", NO_ID_COMMAND_BODY],
  ["no_channel_command", NO_CHANNEL_COMMAND_BODY],
]);
