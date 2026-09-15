// The `ChannelRuntime` implementation for Discord, and its constructor.
//
// THE SECOND RUNTIME, AND THE EVIDENCE FOR A SENTENCE THE PORT COULD ONLY ASSERT.
// `channel-runtime.ts` says a new provider is "a new directory satisfying this
// interface and a row in the registry, and not one line inside `channels`", and
// records that with one implementation the claim was "asserted and not
// exercised". This directory exercises it AT THE PORT and NO FURTHER: it satisfies
// `ChannelRuntime` and `ChannelAdapter` through
// `@platos/context-channels/application/ports/index.js` alone, and
// `git diff -- packages/contexts/channels` over the commits that added it is
// empty. That emptiness is not the clause closed. An empty diff is what any branch
// that never touched Core would show, whether or not the adapter is usable; and
// this one is NOT usable for production inbound without a change inside
// `channels` (2 below). The sentence is therefore true of the port and of the
// outbound half, and false of inbound admission until `channels` decides how a
// Discord delivery is owned. What it could NOT do without a change inside
// `channels` is written down below rather than worked around.
//
// INTERACTIONS OVER HTTP, AND NOTHING HELD OPEN. This object owns no socket, no
// timer and no subscription between calls, so there is nothing to reconnect and
// nothing to close.
//
// WHAT THIS DIRECTORY DOES NOT DO, EACH FOR A REASON THAT IS NOT IN IT.
//
//   1. THE GATEWAY. Discord delivers ordinary channel messages — an @mention in a
//      channel, a DM that is not a slash command — only over the Gateway
//      WebSocket, which `apps/agent` holds today through the chat SDK (D16 keeps
//      that monolith live). `ChannelRuntime` has no lifecycle to hold a socket in:
//      it is `verifyInbound` over bytes somebody else received, plus three calls.
//      A Gateway ingress needs a port that can start, stop and resume a session,
//      and that port would be a change inside `channels`.
//
//   2. PRODUCTION ADMISSION. `admitSignedDelivery` keys the inbox on a
//      `ChannelApp`, `APP_PROVIDERS` is `["slack"]`, and `postgres-tenancy`'s
//      `requireAppProvider` refuses to read an app row naming another provider.
//      So this runtime verifies and normalizes a Discord interaction and no
//      production store can admit it until `channels` decides how a Discord
//      delivery is owned. `signed-admission.test.ts` pins that gap.
//
//   3. THE THREE-SECOND ANSWER. An admitted slash command must be answered with an
//      interaction response body — `{"type":5}`, DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE —
//      within three seconds — "If the 3 second deadline is exceeded, the token
//      will be invalidated" (`receiving-and-responding.mdx`), and every followup
//      with it. `VerifiedDelivery` carries an echo only for a handshake, so the
//      transport that serves this endpoint has to know that body; the port cannot
//      tell it.
//
//   4. OUTBOUND IDEMPOTENCY. Discord offers `nonce` + `enforce_nonce` on message
//      create, which would make a RECONCILE safely retryable. `OutboundMessage`
//      carries no idempotency key to derive a nonce from, and deriving one from
//      the text would silently drop a genuine repeat, so it is not used.
//
//   5. THE LEGACY THREAD KEY. `provider.ts` renders the domain's key shape, which
//      is not the chat SDK's; a cutover re-keys existing Discord thread links or
//      starts a new Platos thread per existing conversation.
//
// IT HOLDS NO CREDENTIAL. The public key arrives per delivery on the command, and
// the bot token per call, as `ChannelAdapter` requires. What it holds is the
// process's transport policy — where Discord is, how long a call may take, which
// `fetch` — plus the two things that are genuinely process-lifetime: the rate-limit
// windows Discord has announced, and the last public key it parsed.

import {
  adapterRejected,
  err,
  ok,
  type ChannelCredential,
  type ChannelPrincipal,
  type ChannelRuntime,
  type DeliveredMessage,
  type InboundVerificationSecret,
  type OutboundMessage,
  type Result,
  type SignedDelivery,
  type VerifiedDelivery,
} from "@platos/context-channels/application/ports/index.js";

import { normalizeDiscordDelivery } from "./normalize.js";
import { DISCORD_PROVIDER, deliveryChannelId, isSnowflake, parseDiscordThreadKey } from "./provider.js";
import { credentialIdentity, DiscordRateLimits } from "./rate-limit.js";
import {
  botAuthorization,
  DEFAULT_SEND_TIMEOUT_MS,
  deliveredFrom,
  discordCall,
  isInteractionToken,
  messageBody,
  type DiscordTransport,
} from "./send.js";
import { DISCORD_API_URL } from "./vendor.js";
import { DEFAULT_REQUEST_MAX_AGE_SECONDS, DiscordPublicKeyCache, verifyDiscordDelivery } from "./verify.js";

/**
 * The reply path an INTERACTION opens, which a channel message does not have.
 *
 * Discord answers a slash command in two steps: the HTTP response within three
 * seconds, and then messages sent with the interaction's own token for fifteen
 * minutes. Neither the application id nor that token is a `ChannelCredential` or
 * a part of a `ChannelThreadKey` — the token expires, and a key is a conversation
 * identity stored forever — so the port has no slot for them and this method sits
 * beside the port rather than on it. Both values are in the verified interaction
 * body (`application_id`, `token`).
 */
export interface DiscordInteractionReply {
  readonly applicationId: string;
  readonly interactionToken: string;
}

export interface DiscordFollowup {
  readonly text: string;
  /**
   * A followup's message id to edit, or `"@original"` for the deferred response
   * itself. Null posts a new followup.
   */
  readonly replacesProviderMessageId: string | null;
}

export interface ChannelDiscordAdapter extends ChannelRuntime {
  readonly adapterName: "channel-discord";
  readonly provider: typeof DISCORD_PROVIDER;
  /** Post or edit a message through an interaction's own token. See above. */
  sendFollowup(reply: DiscordInteractionReply, message: DiscordFollowup): Promise<Result<DeliveredMessage>>;
}

export interface ChannelDiscordOptions {
  /** Replay window in seconds; `PLATOS_CHANNELS_DISCORD_REQUEST_MAX_AGE_S`. */
  readonly requestMaxAgeSeconds?: number;
  /** How long one outbound call may take before it is abandoned. */
  readonly timeoutMs?: number;
  /** Discord's REST base. In-process only; see `send.ts`. */
  readonly apiUrl?: string;
  /** The `fetch` every call is made with. In-process only. */
  readonly fetch?: typeof fetch;
  /** The clock rate-limit windows are measured on. In-process only. */
  readonly now?: () => number;
}

class DiscordRuntime implements ChannelDiscordAdapter {
  readonly adapterName = "channel-discord" as const;
  readonly provider = DISCORD_PROVIDER;
  private readonly keys = new DiscordPublicKeyCache();

  constructor(
    private readonly transport: DiscordTransport,
    private readonly requestMaxAgeSeconds: number,
  ) {}

  async verifyInbound(secret: InboundVerificationSecret, delivery: SignedDelivery): Promise<Result<VerifiedDelivery>> {
    const verified = await verifyDiscordDelivery(this.keys, secret.secret, delivery, this.requestMaxAgeSeconds);
    if (!verified.ok) return err(verified.error);
    return normalizeDiscordDelivery(delivery.rawBody, delivery.receivedAt);
  }

  async send(credential: ChannelCredential, message: OutboundMessage): Promise<Result<DeliveredMessage>> {
    const address = parseDiscordThreadKey(message.channelThreadKey);
    if (address === null) {
      return err(adapterRejected(DISCORD_PROVIDER, "channelThreadKey is not a Discord thread key"));
    }
    const edit = message.replacesProviderMessageId;
    if (edit !== null && !isSnowflake(edit)) {
      return err(adapterRejected(DISCORD_PROVIDER, "replacesProviderMessageId is not a Discord message id"));
    }
    const channel = deliveryChannelId(address);
    const route = {
      identity: credentialIdentity(credential.token),
      template: edit === null ? "POST channels/{channel}/messages" : "PATCH channels/{channel}/messages/{message}",
      resource: channel,
    };
    // AN EDIT, NOT A SECOND POST — the same property Slack's `chat.update` gives:
    // a streamed turn stays one message, and a redelivered outbound event edits
    // the same message to the same text, which is indistinguishable from once.
    const answer = await discordCall(this.transport, {
      method: edit === null ? "POST" : "PATCH",
      path: edit === null ? `channels/${channel}/messages` : `channels/${channel}/messages/${edit}`,
      authorization: botAuthorization(credential.token),
      body: messageBody(message.text),
      operation: "write",
      route,
    });
    return answer.ok ? deliveredFrom(answer.value) : err(answer.error);
  }

  async sendFollowup(reply: DiscordInteractionReply, message: DiscordFollowup): Promise<Result<DeliveredMessage>> {
    if (!isSnowflake(reply.applicationId) || !isInteractionToken(reply.interactionToken)) {
      return err(adapterRejected(DISCORD_PROVIDER, "interaction reply path is malformed"));
    }
    const edit = message.replacesProviderMessageId;
    if (edit !== null && edit !== "@original" && !isSnowflake(edit)) {
      return err(adapterRejected(DISCORD_PROVIDER, "replacesProviderMessageId is not a followup message id"));
    }
    const base = `webhooks/${reply.applicationId}/${reply.interactionToken}`;
    const answer = await discordCall(this.transport, {
      method: edit === null ? "POST" : "PATCH",
      // `wait=true` so Discord answers with the created message rather than 204:
      // without it there is no id to edit the followup by, and a streamed answer
      // would become a new message per chunk.
      path: edit === null ? `${base}?wait=true` : `${base}/messages/${edit}`,
      authorization: null,
      body: messageBody(message.text),
      operation: "write",
      route: {
        identity: credentialIdentity(reply.interactionToken),
        template: edit === null ? "POST webhooks/{application}/{token}" : "PATCH webhooks/{application}/{token}/messages/{message}",
        resource: `${reply.applicationId}:${credentialIdentity(reply.interactionToken)}`,
      },
    });
    return answer.ok ? deliveredFrom(answer.value) : err(answer.error);
  }

  async describePrincipal(credential: ChannelCredential, providerUserId: string): Promise<Result<ChannelPrincipal>> {
    if (!isSnowflake(providerUserId)) {
      return err(adapterRejected(DISCORD_PROVIDER, "providerUserId is not a Discord user id"));
    }
    const answer = await this.read(credential, `users/${providerUserId}`, "GET users/{user}");
    if (!answer.ok) return err(answer.error);
    const text = (key: string): string | null => {
      const value = answer.value[key];
      return typeof value === "string" && value !== "" ? value : null;
    };
    return ok({
      providerUserId,
      // `global_name` is the display name a user chose; `username` is the handle.
      displayName: text("global_name") ?? text("username"),
      // A BOT CANNOT READ ANOTHER USER'S EMAIL. Discord returns `email` only to
      // an OAuth2 bearer holding the `email` scope for THAT user, so for a bot
      // token null is the answer the port asks for and not an omission.
      email: null,
    });
  }

  async verifyCredential(credential: ChannelCredential): Promise<Result<void>> {
    const answer = await this.read(credential, "users/@me", "GET users/@me");
    return answer.ok ? ok(undefined) : err(answer.error);
  }

  private read(credential: ChannelCredential, path: string, template: string) {
    const identity = credentialIdentity(credential.token);
    return discordCall(this.transport, {
      method: "GET",
      path,
      authorization: botAuthorization(credential.token),
      body: null,
      operation: "read",
      route: { identity, template, resource: identity },
    });
  }
}

/** Build the adapter. Total over its options: nothing to parse, nothing to open. */
export function createChannelDiscordAdapter(options: ChannelDiscordOptions = {}): ChannelDiscordAdapter {
  return new DiscordRuntime(
    Object.freeze({
      apiUrl: options.apiUrl ?? DISCORD_API_URL,
      timeoutMs: options.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS,
      // Bound to `globalThis` at construction; an unbound `fetch` throws
      // "Illegal invocation" when called through a property.
      fetch: options.fetch ??
        (((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
          globalThis.fetch(input, init)) as typeof fetch),
      limits: new DiscordRateLimits(options.now ?? (() => Date.now())),
    }),
    options.requestMaxAgeSeconds ?? DEFAULT_REQUEST_MAX_AGE_SECONDS,
  );
}
