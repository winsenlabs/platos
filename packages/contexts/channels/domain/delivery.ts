// What a caller may do after an outbound delivery failed — as a RULE, not as a
// habit each call site re-decides.
//
// THE DEFECT THIS EXISTS TO PREVENT. `send` can fail four ways and only three of
// them are safe to repeat. A blind `catch { retry }` around a channel post is
// correct for a refused connection and WRONG for a request that was written and
// whose response was lost: the provider very probably posted the message, and
// the retry posts it a second time into a customer's channel. That failure is
// invisible in every test that stubs the transport, because a stub either
// answers or does not — it never leaves the question open, which is precisely
// the state a real network spends its time in.
//
// SO THE DISPOSITION IS DERIVED FROM THE CODE AND NOTHING ELSE. Not from an
// HTTP status the adapter saw (a transport detail this context must not name),
// not from an exception type (a vendor detail the port exists to contain), and
// not from a boolean the adapter sets (which would let one adapter be careless
// and the rule could not catch it). The adapter's only job is to pick the right
// CODE, and `channels` owns what each code permits.
//
// THREE DISPOSITIONS, BECAUSE THERE ARE THREE ANSWERS.
//
//   RETRY      the message provably did not land. Repeating it is the remedy.
//   RECONCILE  the message may have landed. Repeating it may duplicate it, so
//              the caller must establish the truth before sending again —
//              through the provider's own transcript, or by editing the message
//              it already has an id for. Backing off and retrying anyway is a
//              CHOICE, and one this rule refuses to make silently.
//   REFUSE     repeating it sends the same bad message, or presents the same
//              dead credential. Retrying is pure cost.

import type { DomainError } from "@platos/kernel";

/**
 * What a caller may do next. Ordered by how much freedom it grants, so a reader
 * can see at a glance that `RECONCILE` is the narrow middle rather than a
 * softer `RETRY`.
 */
export const DELIVERY_DISPOSITIONS = Object.freeze(["retry", "reconcile", "refuse"] as const);

export type DeliveryDisposition = (typeof DELIVERY_DISPOSITIONS)[number];

/**
 * The code-to-disposition table, exhaustive over the four outcome codes a
 * `ChannelRuntime` is permitted to produce.
 *
 * It is DATA rather than a switch so `channels-contract.test.ts` can walk it and
 * assert every outcome code appears exactly once — a switch with a missing arm
 * falls through to a default and nothing notices.
 */
const DISPOSITION_BY_CODE: Readonly<Record<string, DeliveryDisposition>> = Object.freeze({
  // The provider did not take the message and said so, or was not reachable at
  // all. Nothing was posted, so posting again is the whole remedy.
  CHANNELS_ADAPTER_UNAVAILABLE: "retry",
  // The request went out and the answer did not come back. See the header.
  CHANNELS_DELIVERY_INDETERMINATE: "reconcile",
  // The credential is dead. Every retry presents the same dead credential and
  // burns the same rate-limit budget; the remedy is a refresh or a
  // re-authorization, both of which happen elsewhere.
  CHANNELS_ADAPTER_UNAUTHORIZED: "refuse",
  // The message itself is bad — an unknown channel, a body the provider will
  // not render. Retrying sends the same bad message.
  CHANNELS_ADAPTER_REJECTED: "refuse",
});

/**
 * The safest disposition for a failure, defaulting CLOSED.
 *
 * An unrecognised code — a repository failure surfacing through a delivery
 * path, a code minted by a context this table has not been taught about — is
 * `reconcile` and NOT `retry`. Defaulting to `retry` would make every future
 * code silently repeatable, which is the wrong direction for the only mistake
 * that duplicates a customer-visible message. `reconcile` says "stop and
 * establish the truth", which is always safe and never silently wrong.
 */
export function deliveryDisposition(error: DomainError): DeliveryDisposition {
  return DISPOSITION_BY_CODE[error.code] ?? "reconcile";
}

/** Whether a failure may be repeated with no further evidence. */
export function mayRetryDelivery(error: DomainError): boolean {
  return deliveryDisposition(error) === "retry";
}

/** The outcome codes this table is exhaustive over. Read back by the suite. */
export const DELIVERY_OUTCOME_CODES: readonly string[] = Object.freeze(Object.keys(DISPOSITION_BY_CODE));
