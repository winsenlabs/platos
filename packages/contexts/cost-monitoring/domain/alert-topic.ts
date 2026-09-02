// What a channel has subscribed to.
//
// `AlertChannel.alertTypes` is a `String[]`. In the running system it carries six
// values, and only ONE of them belongs to this context: the budget topic. The
// other five describe durable-runtime lifecycle events, and they are minted,
// interpreted and delivered by that boundary.
//
// SO THIS CONTEXT DOES NOT TRANSCRIBE THEM, AND THAT IS A DECISION, NOT AN
// OMISSION. Copying the list here would put another context's vocabulary inside
// this one's domain and make `cost-monitoring` the place a new runtime event has
// to be registered — a coupling with no compensating benefit, on a context whose
// ADR §1 row 13 allow-list is `tenancy`, `providers`, `kernel` and nothing else.
//
// A topic is therefore an OPAQUE token to this context, with exactly one
// exception it recognises by name. It validates the SHAPE of every token so a
// typo cannot silently subscribe a channel to nothing, records the rest
// untouched so a round-trip through this context does not erase another
// boundary's subscriptions, and interprets only its own.

import { err, ok, type Result } from "@platos/kernel";

import { alertTopicInvalid } from "./errors.js";

/** The one topic this context mints, fans out and interprets. */
export const BUDGET_TOPIC = "BUDGET";

/** SCREAMING_SNAKE, the shape every topic in the column has. */
const TOPIC_SHAPE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u;

/** Ceiling on how many topics one channel may hold. */
export const MAX_TOPICS = 32;

/**
 * Admit a subscription list.
 *
 * Deduplicated and sorted, so `[BUDGET, BUDGET]` and `[BUDGET]` are the same
 * subscription and two channels differing only in list order compare equal. An
 * empty list is refused: a channel subscribed to nothing is a channel that will
 * never fire, and the source refuses it too rather than storing a row that looks
 * configured.
 */
export function admitTopics(values: readonly string[]): Result<readonly string[]> {
  if (values.length === 0) {
    return err(alertTopicInvalid("a channel must subscribe to at least one topic", ""));
  }
  if (values.length > MAX_TOPICS) {
    return err(alertTopicInvalid(`at most ${MAX_TOPICS} topics may be set`, ""));
  }
  const admitted = new Set<string>();
  for (const value of values) {
    const topic = value.trim();
    if (!TOPIC_SHAPE.test(topic)) {
      return err(alertTopicInvalid(`invalid alert topic: ${value}`, value));
    }
    admitted.add(topic);
  }
  return ok([...admitted].sort());
}

/** Does this channel want budget alerts? The only interpretation made here. */
export function wantsBudgetAlerts(topics: readonly string[]): boolean {
  return topics.includes(BUDGET_TOPIC);
}
