// A verified Slack body becomes a `VerifiedDelivery` — this context's shape, in
// this context's vocabulary, holding not one vendor type.
//
// THREE OUTCOMES, AND THE TWO THAT ARE NOT "MESSAGE" CARRY THE INTERESTING
// RULES.
//
// A HANDSHAKE MUST NOT BE ADMITTED. `url_verification` is Slack asking whether
// the endpoint is alive; it has no event id, so admitting it would need an
// invented key, and it must be answered by echoing `challenge` verbatim or Slack
// marks the endpoint dead and stops delivering to it.
//
// A BOT'S OWN MESSAGE MUST BE IGNORED, AND THIS IS THE ONE WITH TEETH. Slack
// delivers the message the app itself just posted back to the app. Treating that
// as inbound starts a turn, whose reply is posted, which is delivered, which
// starts a turn: an unbounded loop that costs a model call each time round and
// is visible to the customer as the assistant talking to itself. The guard is
// `botId !== undefined` — set by the SDK exactly when the event carries
// `bot_id` — and it is checked BEFORE anything else about a message, because
// every other property of a self-message looks perfectly ordinary.
//
// A MESSAGE WITH NO EVENT ID IS REFUSED RATHER THAN IGNORED. `providerEventId`
// is the admission idempotency key; without it a redelivery cannot be
// recognised, so admitting one would break exactly-once for that message. There
// is no safe way to synthesize one — hashing the body makes a genuine repeat of
// the same text look like a duplicate forever — so the delivery is refused with
// `CHANNELS_EVENT_PAYLOAD_INVALID` and shows up as a defect rather than as
// silence.

import {
  admitChannelThreadKey,
  err,
  eventPayloadInvalid,
  ok,
  type ProviderEventId,
  type Result,
  type VerifiedDelivery,
} from "@platos/context-channels/application/ports/index.js";

import { SLACK_PROVIDER, slackThreadKey } from "./provider.js";
import { parseSlackWebhookBody, type SlackWebhookPayload } from "./vendor.js";

function handshake(echo: string, body: string): VerifiedDelivery {
  return Object.freeze({
    provider: SLACK_PROVIDER,
    kind: "handshake" as const,
    providerEventId: null,
    handshakeEcho: echo,
    message: null,
    verifiedBody: body,
  });
}

function ignorable(body: string): VerifiedDelivery {
  return Object.freeze({
    provider: SLACK_PROVIDER,
    kind: "ignorable" as const,
    providerEventId: null,
    handshakeEcho: null,
    message: null,
    verifiedBody: body,
  });
}

/**
 * The two payload kinds this build runs a turn for.
 *
 * Everything else the SDK can produce — slash commands, block actions, view
 * submissions, and the `unsupported` catch-all that carries reactions, channel
 * joins and every other event type — is a real, verified Slack event with no
 * behaviour here. It is ACKNOWLEDGED and dropped rather than refused, because
 * refusing makes Slack retry a delivery that is not going to be handled on the
 * tenth try either.
 */
const TURN_BEARING_KINDS = new Set<SlackWebhookPayload["kind"]>(["app_mention", "direct_message"]);

export function normalizeSlackDelivery(
  verifiedBody: string,
  receivedAt: Date,
): Result<VerifiedDelivery> {
  let payload: SlackWebhookPayload;
  try {
    payload = parseSlackWebhookBody(verifiedBody);
  } catch {
    // A body that VERIFIED and does not PARSE is not a forgery — the signature
    // proves Slack sent it — so it is an input defect and not an authentication
    // one, and it must not be reported as a signature failure.
    return err(eventPayloadInvalid("verified Slack body did not parse"));
  }

  if (payload.kind === "url_verification") {
    return ok(handshake(payload.challenge, verifiedBody));
  }

  if (!TURN_BEARING_KINDS.has(payload.kind)) return ok(ignorable(verifiedBody));

  // Narrowed by the set membership above; both members of it extend
  // `SlackEventBasePayload`, which is where these five properties live.
  const event = payload as Extract<SlackWebhookPayload, { readonly kind: "app_mention" | "direct_message" }>;

  // THE SELF-MESSAGE GUARD. See the header — this is the loop.
  if ("botId" in event && event.botId !== undefined) return ok(ignorable(verifiedBody));

  // A message edit, deletion or file-share notice arrives as `message` with a
  // subtype. None of them is a new thing the user said, and running a turn on
  // an edit would answer text that has already been answered.
  if ("subtype" in event && event.subtype !== undefined) return ok(ignorable(verifiedBody));

  const eventId = event.eventId;
  if (eventId === undefined || eventId === "") {
    return err(eventPayloadInvalid("verified Slack message carries no event id to deduplicate on"));
  }

  const key = admitChannelThreadKey(slackThreadKey(event.channelId, event.threadTs));
  if (!key.ok) return err(key.error);

  return ok(
    Object.freeze({
      provider: SLACK_PROVIDER,
      kind: "message" as const,
      providerEventId: eventId as ProviderEventId,
      handshakeEcho: null,
      message: Object.freeze({
        channelThreadKey: key.value,
        platformChannelId: event.channelId,
        text: event.text,
        // `channels` NEVER WRITES AN IDENTITY ROW — `identity-access` owns that
        // — so this adapter cannot map a Slack user id to an `EndUserId` and
        // must not guess. Null means "not linked yet", and the linking decision
        // is made above this line by the context entitled to make it.
        endUserId: null,
        receivedAt,
      }),
      verifiedBody,
    }),
  );
}
