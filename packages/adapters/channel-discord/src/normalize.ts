// A verified Discord interaction becomes a `VerifiedDelivery` — this context's
// shape, holding not one Discord field it did not ask for.
//
// WHAT ARRIVES HERE AT ALL. This adapter speaks Discord's INTERACTIONS ENDPOINT:
// the signed HTTP POST Discord sends for a slash command, a component click, an
// autocomplete request, a modal submission and the endpoint check. Ordinary
// channel messages are NOT among them — Discord delivers `MESSAGE_CREATE` only over
// the Gateway WebSocket — so nothing here pretends to normalize one. `adapter.ts`
// says what that excludes and why the port cannot express the Gateway.
//
// THREE OUTCOMES, AND THE RULES LIVE IN THE TWO THAT ARE NOT "MESSAGE".
//
// A PING IS THE HANDSHAKE. `developers/interactions/overview.mdx`: Discord sends
// `type: 1` when the endpoint is saved and on routine checks after, and "your app
// is expected to acknowledge the request by returning a 200 response with a PONG
// payload (which has the same type: 1)". So the echo is not a value lifted out of
// the request, as Slack's `challenge` is — it is the whole response BODY,
// `{"type":1}`, served as `application/json` ("You must provide a valid
// Content-Type when responding to PINGs"). A PING carries an `id` and is still
// never admitted: it is not an event anybody sent.
//
// A CHAT-INPUT COMMAND IS THE ONE THING A TURN RUNS FOR. Its text is the command's
// option values in order, descending into sub-commands, joined by one space —
// the rule `@chat-adapter/discord@4.34.0`'s `parseSlashCommand` applies, so a
// command reads the same through this adapter as through the legacy SDK.
// Components, autocomplete, modal submissions, user and message context-menu
// commands, and any interaction type Discord adds later are verified, real, and
// have no behaviour in this build: IGNORABLE, acknowledged and not admitted.
//
// A BOT IS IGNORED BEFORE ANYTHING ELSE IS READ. Discord does not let a bot
// invoke an application command today, and this is still checked first, for the
// reason `channel-slack/src/normalize.ts` gives about its own bot guard: every
// other property of a self-originated delivery looks ordinary, and the failure is
// an unbounded loop that costs a model call per turn.
//
// AN INTERACTION WITH NO ID OR NO CHANNEL IS REFUSED, NOT IGNORED. The id is the
// admission idempotency key and the channel is the conversation; without either
// a redelivery cannot be recognised or the reply has nowhere to go.

import {
  admitChannelThreadKey,
  err,
  eventPayloadInvalid,
  ok,
  type ProviderEventId,
  type Result,
  type VerifiedDelivery,
} from "@platos/context-channels/application/ports/index.js";

import { DISCORD_PROVIDER, discordThreadKey, isSnowflake, type DiscordAddress } from "./provider.js";
import {
  DISCORD_APPLICATION_COMMAND_TYPE,
  DISCORD_CALLBACK_TYPE,
  DISCORD_INTERACTION_TYPE,
  DISCORD_THREAD_CHANNEL_TYPES,
} from "./vendor.js";

/** The exact PONG body. Built from the vendor constant, serialized once. */
export const DISCORD_PONG_BODY = JSON.stringify({ type: DISCORD_CALLBACK_TYPE.PONG });

type Json = Readonly<Record<string, unknown>>;

function record(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function shape(kind: "handshake" | "ignorable", body: string, echo: string | null): VerifiedDelivery {
  return Object.freeze({
    provider: DISCORD_PROVIDER,
    kind,
    providerEventId: null,
    handshakeEcho: echo,
    message: null,
    verifiedBody: body,
  });
}

/** True when the invoking user (guild member or DM user) is a bot. */
function invokedByBot(interaction: Json): boolean {
  const member = record(interaction["member"]);
  const user = record(member?.["user"]) ?? record(interaction["user"]);
  return user?.["bot"] === true;
}

/**
 * Where the interaction happened, as a conversation address.
 *
 * A thread is recognised by its CHANNEL TYPE and keyed under its parent; any
 * other channel — a text channel, a voice channel's chat, a DM — is keyed on
 * itself. A thread whose partial channel carries no `parent_id` is keyed on
 * itself too: an address with an invented parent would be a routing rule
 * matching a channel the thread does not belong to.
 */
function addressOf(interaction: Json): DiscordAddress | null {
  const channelId = interaction["channel_id"];
  if (!isSnowflake(channelId)) return null;
  const channel = record(interaction["channel"]);
  const type = channel?.["type"];
  const parent = channel?.["parent_id"];
  if (typeof type === "number" && DISCORD_THREAD_CHANNEL_TYPES.has(type) && isSnowflake(parent)) {
    return { channelId: parent, threadId: channelId };
  }
  return { channelId, threadId: null };
}

/** Option values in order, sub-commands descended into, joined by one space. */
export function commandText(options: unknown): string {
  const values: string[] = [];
  const collect = (items: unknown): void => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      const option = record(item);
      if (option === null) continue;
      if (option["value"] !== undefined) {
        values.push(String(option["value"]));
        continue;
      }
      collect(option["options"]);
    }
  };
  collect(options);
  return values.join(" ").trim();
}

export function normalizeDiscordDelivery(verifiedBody: string, receivedAt: Date): Result<VerifiedDelivery> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(verifiedBody);
  } catch {
    // It VERIFIED, so Discord sent it: an input defect, never a signature one.
    return err(eventPayloadInvalid("verified Discord body did not parse"));
  }
  const interaction = record(parsed);
  const type = interaction?.["type"];
  if (interaction === null || typeof type !== "number") {
    return err(eventPayloadInvalid("verified Discord body is not an interaction"));
  }

  if (type === DISCORD_INTERACTION_TYPE.PING) return ok(shape("handshake", verifiedBody, DISCORD_PONG_BODY));

  if (invokedByBot(interaction)) return ok(shape("ignorable", verifiedBody, null));

  if (type !== DISCORD_INTERACTION_TYPE.APPLICATION_COMMAND) return ok(shape("ignorable", verifiedBody, null));
  const data = record(interaction["data"]);
  // `type` is a REQUIRED field of the command data
  // (`receiving-and-responding.mdx`, Application Command Data Structure), so a
  // payload without it is not a chat-input command and is not guessed into one.
  if (data?.["type"] !== DISCORD_APPLICATION_COMMAND_TYPE.CHAT_INPUT) {
    return ok(shape("ignorable", verifiedBody, null));
  }

  const id = interaction["id"];
  if (!isSnowflake(id)) {
    return err(eventPayloadInvalid("verified Discord command carries no interaction id to deduplicate on"));
  }
  const address = addressOf(interaction);
  if (address === null) {
    return err(eventPayloadInvalid("verified Discord command carries no channel to answer in"));
  }
  const key = admitChannelThreadKey(discordThreadKey(address));
  if (!key.ok) return err(key.error);

  return ok(
    Object.freeze({
      provider: DISCORD_PROVIDER,
      kind: "message" as const,
      providerEventId: id as ProviderEventId,
      handshakeEcho: null,
      message: Object.freeze({
        channelThreadKey: key.value,
        platformChannelId: address.channelId,
        text: commandText(data?.["options"]),
        // `identity-access` owns the link from a Discord user to an end user,
        // and this adapter must not guess at it.
        endUserId: null,
        receivedAt,
      }),
      verifiedBody,
    }),
  );
}
