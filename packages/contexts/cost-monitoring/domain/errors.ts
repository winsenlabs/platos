// The `cost-monitoring` error catalogue.
//
// M0.4 §2 fixes `code` as a SCREAMING_SNAKE string that is immutable within a
// major, and the kernel makes an error a VALUE rather than a thrown class. Every
// code this context can produce is minted here, once, so a transport builds its
// status table from one list and an operator grepping a log finds exactly one
// definition.
//
// THE EXTRACTION SOURCE THREW BARE `Error(message)` AND MATCHED ON THE TEXT.
//
// `BudgetService.validate` throws `new Error("invalid scopeType: user")`; the
// alert-channel surface throws `new Error("invalid_email")` and its caller then
// runs `message.startsWith("invalid_")` to decide what to return. That is a
// control-flow decision made by string prefix, and it fails open in both
// directions: a new message that happens to start with `invalid_` becomes a 400,
// and a genuine validation failure phrased differently becomes a 500. Every one
// of those texts is a code below.
//
// TWO FAILURE VOCABULARIES ARE PRESERVED, BECAUSE THEY ARE NOT THE SAME THING.
//
//   The CONTROL codes describe an operator's request — a cap that does not
//   exist, a threshold out of range, a channel whose configuration is
//   incomplete.
//
//   The DELIVERY codes describe an outbound send. They are not returned to the
//   party being alerted; they are recorded on `AlertDelivery.lastErrorCode` and
//   read by the operator who owns the channel. `domain/alert-delivery.ts` mints
//   them as OUTCOMES rather than as errors, because a failed delivery is a
//   durable business fact the ledger must hold, not an exception that aborts a
//   dispatcher mid-batch.

import { domainError, type DomainError, type FieldViolation } from "@platos/kernel";

export const COST_MONITORING_ERROR_CODES = [
  "COST_BUDGET_NOT_FOUND",
  "COST_BUDGET_INVALID",
  "COST_BUDGET_TARGET_INVALID",
  "COST_THRESHOLD_INVALID",
  "COST_WINDOW_INVALID",
  "COST_SPEND_INVALID",
  "COST_ALERT_CHANNEL_NOT_FOUND",
  "COST_ALERT_CHANNEL_INVALID",
  "COST_ALERT_CHANNEL_EXISTS",
  "COST_ALERT_CHANNEL_UNCHANGED",
  "COST_ALERT_TOPIC_INVALID",
  "COST_DELIVERY_NOT_FOUND",
  "COST_DELIVERY_UNAVAILABLE",
  "COST_DELIVERY_FAILED",
  "COST_THRESHOLD_EVENT_UNAVAILABLE",
  "COST_SCOPE_MISMATCH",
  "COST_LEDGER_UNAVAILABLE",
  "COST_REPOSITORY_UNAVAILABLE",
] as const;

export type CostMonitoringErrorCode = (typeof COST_MONITORING_ERROR_CODES)[number];

export function budgetNotFound(budgetId: string): DomainError {
  return domainError("COST_BUDGET_NOT_FOUND", "not_found", "budget is not visible in this scope", {
    details: { budgetId },
  });
}

export function budgetInvalid(message: string, fields: readonly FieldViolation[] = []): DomainError {
  return domainError("COST_BUDGET_INVALID", "invalid_input", message, { fields });
}

/**
 * The wildcard rule, which the source enforces with its own throw: `targetId="*"`
 * is the DEFAULT-PER-USER sentinel and is meaningless on any other scope type.
 * A wildcard agent cap would silently match no agent and cap nothing.
 */
export function budgetTargetInvalid(message: string, scopeType: string, targetId: string): DomainError {
  return domainError("COST_BUDGET_TARGET_INVALID", "invalid_input", message, {
    details: { scopeType, targetId },
    fields: [{ field: "targetId", code: "invalid", message }],
  });
}

export function thresholdInvalid(message: string, threshold: number): DomainError {
  return domainError("COST_THRESHOLD_INVALID", "invalid_input", message, {
    details: { threshold },
    fields: [{ field: "alertThresholds", code: "out_of_range", message }],
  });
}

export function windowInvalid(message: string, details: Readonly<Record<string, string>> = {}): DomainError {
  return domainError("COST_WINDOW_INVALID", "invalid_input", message, { details });
}

export function spendInvalid(message: string, details: Readonly<Record<string, string>> = {}): DomainError {
  return domainError("COST_SPEND_INVALID", "invalid_input", message, { details });
}

export function alertChannelNotFound(channelId: string): DomainError {
  return domainError(
    "COST_ALERT_CHANNEL_NOT_FOUND",
    "not_found",
    "alert channel is not visible in this scope",
    { details: { channelId } },
  );
}

export function alertChannelInvalid(message: string, fields: readonly FieldViolation[] = []): DomainError {
  return domainError("COST_ALERT_CHANNEL_INVALID", "invalid_input", message, { fields });
}

/** The `@@unique([environmentId, deduplicationKey])` constraint, in the domain. */
export function alertChannelExists(deduplicationKey: string): DomainError {
  return domainError(
    "COST_ALERT_CHANNEL_EXISTS",
    "conflict",
    "a live alert channel already holds that deduplication key in this environment",
    { details: { deduplicationKey } },
  );
}

/**
 * An update that changes nothing. The source returns `{ error: "no_changes" }`
 * rather than writing a row whose only effect is to move `updatedAt`, and that
 * refusal is kept: a no-op write is indistinguishable from a real one in an
 * audit trail.
 */
export function alertChannelUnchanged(channelId: string): DomainError {
  return domainError("COST_ALERT_CHANNEL_UNCHANGED", "invalid_input", "the patch changes nothing", {
    details: { channelId },
  });
}

export function alertTopicInvalid(message: string, topic: string): DomainError {
  return domainError("COST_ALERT_TOPIC_INVALID", "invalid_input", message, {
    details: { topic },
    fields: [{ field: "topics", code: "invalid", message }],
  });
}

export function deliveryNotFound(deliveryId: string): DomainError {
  return domainError("COST_DELIVERY_NOT_FOUND", "not_found", "delivery is not visible in this scope", {
    details: { deliveryId },
  });
}

/**
 * The row could not be CLAIMED — another dispatcher holds it, or its backoff has
 * not elapsed. `precondition_failed`, not `conflict`: nothing is wrong, the work
 * simply belongs to someone else right now, and the caller should move on.
 */
export function deliveryUnavailable(deliveryId: string, reason: string): DomainError {
  return domainError("COST_DELIVERY_UNAVAILABLE", "precondition_failed", "delivery is not claimable", {
    details: { deliveryId, reason },
  });
}

/**
 * At least one recipient of a threshold event could not be reached.
 *
 * The source raises `BudgetAlertDeliveryError` here so the durable dispatcher
 * fails and is retried. The count travels with the error because the dispatcher
 * logs it, and because "three of four channels succeeded" is a materially
 * different operational state from "everything failed".
 */
export function deliveryFailed(failed: number, delivered: number): DomainError {
  return domainError("COST_DELIVERY_FAILED", "unavailable", "one or more alert deliveries failed", {
    retryAfterSeconds: 30,
    details: { failed, delivered },
  });
}

/**
 * The threshold event named does not exist, or exists somewhere else in the
 * tenant tree. One code for both, deliberately: the source's lookup joins the
 * whole ancestry precisely so a caller cannot tell the two apart.
 */
export function thresholdEventUnavailable(eventId: string): DomainError {
  return domainError(
    "COST_THRESHOLD_EVENT_UNAVAILABLE",
    "not_found",
    "budget threshold event is unavailable in this scope",
    { details: { eventId } },
  );
}

/**
 * `forbidden`, not `not_found`: the grant resolves, but to a different place in
 * the tenant tree than the caller claimed.
 */
export function scopeMismatch(expectedPath: string, grantedPath: string): DomainError {
  return domainError(
    "COST_SCOPE_MISMATCH",
    "forbidden",
    "authorization does not belong to the requested scope",
    { details: { expectedPath, grantedPath } },
  );
}

/**
 * The near-line spend counters could not be read.
 *
 * Almost every caller of this one swallows it, and that is a deliberate
 * fail-open: enforcement sits on the hot path and a counter blip must not stall
 * a turn. The code exists so the swallow is a decision recorded at each call
 * site rather than a bare `catch {}`.
 */
export function ledgerUnavailable(reason: string): DomainError {
  return domainError("COST_LEDGER_UNAVAILABLE", "unavailable", "the spend ledger is unavailable", {
    retryAfterSeconds: 5,
    details: { reason },
  });
}

export function repositoryUnavailable(reason: string): DomainError {
  return domainError("COST_REPOSITORY_UNAVAILABLE", "unavailable", "cost-monitoring repository is unavailable", {
    retryAfterSeconds: 5,
    details: { reason },
  });
}
