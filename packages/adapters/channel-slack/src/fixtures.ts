// PROVIDER FIXTURES: real Slack Events API envelopes, and a signer for them.
//
// WHY THE SIGNER HERE IS NOT A CIRCULAR ASSERTION. `signSlackDelivery` builds a
// signature with `node:crypto` using the documented construction. On its own
// that would be the failure lesson 1 names — two copies of one formula agreeing
// with each other. It is not on its own: `published-vector.ts` proves THAT EXACT
// FORMULA reproduces Slack's own published digest, byte for byte, and
// `slack-signature.test.ts` asserts it on every run. So the chain is
//
//     Slack's published digest  ==  this formula  ==  what signs these fixtures
//
// and these fixtures reach the adapter through the same `verifyInbound` a real
// delivery does, with real HMAC verification in the middle. What they are FOR is
// the step after verification — normalization — which cannot be exercised at all
// without a body that verifies.
//
// THE ENVELOPES ARE REAL SHAPES. Each is the JSON Slack actually posts for that
// event type: an `event_callback` wrapper carrying `event_id`, `team_id` and an
// inner `event` object, or a bare `url_verification`. The field names, the
// nesting and the `ts`/`thread_ts` string format are the provider's, not this
// repository's, which is what makes normalizing them a test of anything.

import { createHmac } from "node:crypto";

import type { SignedDelivery } from "@platos/context-channels/application/ports/index.js";

export const FIXTURE_SIGNING_SECRET = "0123456789abcdef0123456789abcdef";

/** The instant every fixture is signed and received at, unless overridden. */
export const FIXTURE_INSTANT = new Date("2026-04-01T12:00:00.000Z");

/**
 * Sign a body the way Slack does, and present it as a delivery.
 *
 * `receivedAt` defaults to the signing instant, so a fixture is inside the
 * replay window by construction and a suite that wants a stale one moves the
 * clock explicitly rather than by accident.
 */
export function signSlackDelivery(
  rawBody: string,
  options: { readonly secret?: string; readonly signedAt?: Date; readonly receivedAt?: Date } = {},
): SignedDelivery {
  const secret = options.secret ?? FIXTURE_SIGNING_SECRET;
  const signedAt = options.signedAt ?? FIXTURE_INSTANT;
  const timestamp = String(Math.floor(signedAt.getTime() / 1000));
  const digest = createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`, "utf8").digest("hex");
  return {
    rawBody,
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${digest}`,
    },
    receivedAt: options.receivedAt ?? signedAt,
  };
}

/** Slack's endpoint challenge. Answered by echoing `challenge`, never admitted. */
export const URL_VERIFICATION_BODY = JSON.stringify({
  token: "Jhj5dZrVaK7ZwHHjRyZWjbDl",
  challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P",
  type: "url_verification",
});

/** An `@`-mention in a public channel — the ordinary way a turn starts. */
export const APP_MENTION_BODY = JSON.stringify({
  token: "z26uFbvR1xHJEdHE1OQiO6t8",
  team_id: "T061EG9R6",
  api_app_id: "A0MDYCDME",
  event: {
    type: "app_mention",
    user: "U061F7AUR",
    text: "<@U0LAN0Z89> is it everything a river should be?",
    ts: "1515449522.000016",
    channel: "C0LAN2Q65",
    event_ts: "1515449522000016",
    thread_ts: "1515449522.000016",
  },
  type: "event_callback",
  event_id: "Ev0MDYGDK4",
  event_time: 1515449522000016,
});

/** A reply INSIDE that thread. Different message, same conversation. */
export const THREAD_REPLY_BODY = JSON.stringify({
  token: "z26uFbvR1xHJEdHE1OQiO6t8",
  team_id: "T061EG9R6",
  event: {
    type: "app_mention",
    user: "U061F7AUR",
    text: "<@U0LAN0Z89> and the second half?",
    ts: "1515449600.000100",
    channel: "C0LAN2Q65",
    event_ts: "1515449600000100",
    thread_ts: "1515449522.000016",
  },
  type: "event_callback",
  event_id: "Ev0MDYGDK5",
  event_time: 1515449600000100,
});

/** A direct message. */
export const DIRECT_MESSAGE_BODY = JSON.stringify({
  token: "z26uFbvR1xHJEdHE1OQiO6t8",
  team_id: "T061EG9R6",
  event: {
    type: "message",
    channel: "D024BE91L",
    user: "U2147483697",
    text: "Hello hello can you hear me?",
    ts: "1355517523.000005",
    channel_type: "im",
    event_ts: "1355517523000005",
  },
  type: "event_callback",
  event_id: "Ev0MDYGDK6",
  event_time: 1355517523000005,
});

/**
 * THE APP'S OWN MESSAGE, DELIVERED BACK TO IT. `bot_id` is set and `user` is
 * absent. Treating this as inbound is the unbounded reply loop.
 */
export const BOT_ECHO_BODY = JSON.stringify({
  token: "z26uFbvR1xHJEdHE1OQiO6t8",
  team_id: "T061EG9R6",
  event: {
    type: "message",
    channel: "D024BE91L",
    bot_id: "B19LU7CSY",
    text: "Yes, I can hear you.",
    ts: "1355517524.000006",
    channel_type: "im",
    event_ts: "1355517524000006",
  },
  type: "event_callback",
  event_id: "Ev0MDYGDK7",
  event_time: 1355517524000006,
});

/** An edit of an earlier message, which is not a new thing the user said. */
export const MESSAGE_CHANGED_BODY = JSON.stringify({
  token: "z26uFbvR1xHJEdHE1OQiO6t8",
  team_id: "T061EG9R6",
  event: {
    type: "message",
    subtype: "message_changed",
    channel: "D024BE91L",
    user: "U2147483697",
    text: "Hello hello can you hear me now?",
    ts: "1355517525.000007",
    channel_type: "im",
    event_ts: "1355517525000007",
  },
  type: "event_callback",
  event_id: "Ev0MDYGDK8",
  event_time: 1355517525000007,
});

/** A reaction. Real, verified, and nothing this build does anything with. */
export const REACTION_BODY = JSON.stringify({
  token: "z26uFbvR1xHJEdHE1OQiO6t8",
  team_id: "T061EG9R6",
  event: {
    type: "reaction_added",
    user: "U061F7AUR",
    reaction: "thumbsup",
    item: { type: "message", channel: "C0LAN2Q65", ts: "1515449522.000016" },
    event_ts: "1515449523000017",
  },
  type: "event_callback",
  event_id: "Ev0MDYGDK9",
  event_time: 1515449523000017,
});

/** A message Slack delivered with no `event_id`. Cannot be deduplicated. */
export const NO_EVENT_ID_BODY = JSON.stringify({
  token: "z26uFbvR1xHJEdHE1OQiO6t8",
  team_id: "T061EG9R6",
  event: {
    type: "app_mention",
    user: "U061F7AUR",
    text: "<@U0LAN0Z89> anybody there?",
    ts: "1515449700.000200",
    channel: "C0LAN2Q65",
    event_ts: "1515449700000200",
    thread_ts: "1515449700.000200",
  },
  type: "event_callback",
  event_time: 1515449700000200,
});

/** Every fixture, for the suites that walk all of them. */
export const ALL_FIXTURE_BODIES: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["url_verification", URL_VERIFICATION_BODY],
  ["app_mention", APP_MENTION_BODY],
  ["thread_reply", THREAD_REPLY_BODY],
  ["direct_message", DIRECT_MESSAGE_BODY],
  ["bot_echo", BOT_ECHO_BODY],
  ["message_changed", MESSAGE_CHANGED_BODY],
  ["reaction", REACTION_BODY],
  ["no_event_id", NO_EVENT_ID_BODY],
]);
