// Identifiers owned by the `cost-monitoring` context (ADR M0.3 §1, context 13).
//
// The kernel brands the tenancy tree; these brand the six rows this context is
// SOLE WRITER of — Budget, BudgetThresholdEvent, AlertChannel,
// AlertChannelConfiguration, AlertDelivery, AlertDeliveryRetry — plus the five
// opaque strings that are NOT primary keys and are the easiest to substitute for
// one another.
//
// Those five are worth naming, because every one of them is a bare `String`
// column that reads as ordinary prose in a log line:
//
//   WindowKey        `2026-09-03`, `W2026-08-30`, `2026-09`. It is a DEDUPLICATION
//                    bucket, not a date, and it is what makes a threshold event
//                    unique per budget per period.
//   IdempotencyKey   `budget:<eventId>:<channelId>`. Unique per environment; it
//                    is what stops a redelivery from creating a second row for
//                    one recipient.
//   DeduplicationKey an operator-supplied or system-minted label, unique per
//                    environment across live channels.
//   ClaimToken       the uuid one dispatcher writes to say "this delivery is
//                    mine". Comparing it to a WindowKey must not compile.
//   CredentialRef    a handle into the `secrets` vault. This context NEVER reads
//                    one; see `application/ports/notifier.ts` for why it can
//                    name a credential it has no allow-list edge to open.
//
// `AgentId`, `EndUserId` and `SkillSlug` are the three things a budget can be
// aimed at. They are branded for the same reason: `Budget.agentId` and the
// per-user counter key are both `String`, and swapping them silently charges one
// principal's spend against another's cap.

import type { Branded } from "@platos/kernel";

/** `Budget.id` — uuid. */
export type BudgetId = Branded<string, "BudgetId">;

/** `BudgetThresholdEvent.id` — uuid. */
export type ThresholdEventId = Branded<string, "ThresholdEventId">;

/** `AlertChannel.id` — uuid. `AlertChannelConfiguration` is keyed by it too. */
export type AlertChannelId = Branded<string, "AlertChannelId">;

/** `AlertDelivery.id` — uuid. */
export type AlertDeliveryId = Branded<string, "AlertDeliveryId">;

/** `AlertDeliveryRetry.id` — uuid. */
export type AlertDeliveryRetryId = Branded<string, "AlertDeliveryRetryId">;

/**
 * The period bucket a threshold event is unique within.
 *
 * `@@unique([budgetId, windowKey, threshold])` is the store's expression of
 * "one alert per budget per window per threshold, ever". The key is a STRING
 * and not a date range on purpose: see `domain/window.ts` for the one place its
 * three shapes are minted, and for why the weekly key and the weekly window
 * deliberately do not describe the same seven days.
 */
export type WindowKey = Branded<string, "WindowKey">;

/** `AlertDelivery.idempotencyKey` — unique per environment. */
export type IdempotencyKey = Branded<string, "IdempotencyKey">;

/** `AlertChannel.deduplicationKey` — unique per environment among live rows. */
export type DeduplicationKey = Branded<string, "DeduplicationKey">;

/** `AlertDelivery.claimToken` — the uuid that says which dispatcher holds a row. */
export type ClaimToken = Branded<string, "ClaimToken">;

/**
 * `Credential.id`, as seen from outside `secrets`.
 *
 * Deliberately a DIFFERENT brand from the one `secrets` and `providers` share.
 * Those two contexts hold a credential id they may open; this context holds one
 * only to hand to a `Notifier` adapter, and `secrets` is not on its ADR §1 row 13
 * allow-list. Spelling the brand differently is what stops a value from here
 * reaching a vault call if a future edge is ever added by accident.
 */
export type CredentialRef = Branded<string, "CredentialRef">;

/** `Budget.agentId` and the agent a spend is charged to. */
export type AgentId = Branded<string, "AgentId">;

/** The end user a per-user cap and its spend counter are keyed by. */
export type EndUserId = Branded<string, "EndUserId">;

/** The skill slug a `skill`-tier cap filters on. */
export type SkillSlug = Branded<string, "SkillSlug">;

/**
 * Whoever acted. Deliberately not the kernel `PrincipalId`, for the reason
 * `providers` gives: the override author is a plain `String` recording
 * authorship, and this context may not import identity-access (ADR M0.3 §1 row
 * 13 allows `tenancy`, `providers`, `kernel`), so it names the actor without
 * adopting identity's model of one.
 */
export type ActorId = Branded<string, "ActorId">;

/**
 * Tag an already-provenanced string. Like the kernel's `asIdentifier`, this is
 * an assertion and not validation: adapters reading a row, and transports
 * parsing a request, are the only callers that should reach for it.
 */
export function asCostIdentifier<Id extends Branded<string, string>>(value: string): Id {
  return value as Id;
}
