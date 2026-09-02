// `NotificationRequested` — what this context EMITS.
//
// ADR M0.3 §1 row 17: eventing "drains the kernel outbox; evaluates
// `NotificationRule`; emits `NotificationRequested`". That sentence draws the
// context's outer edge, and it is narrower than the legacy service: in
// `McpEventsService` the same class both evaluated rules AND made the outbound
// HTTP call. Here evaluation ends at this value. Delivery is downstream — the
// `notifier-*` adapters, wired at the composition root — and eventing holds no
// HTTP client, no SDK, and no socket.
//
// This value is the legacy `PendingDelivery` frame, renamed to what the ADR
// calls it and with its fields given types. It is deliberately SELF-CONTAINED:
// it carries the rule's name and destination rather than a rule id to look up,
// because a delivery that runs minutes later, after a retry, must not change
// behaviour because someone edited the rule in between. The legacy frame has the
// same property, and it is worth keeping on purpose rather than by accident.

import type { EnvironmentScope, EventId, JsonValue } from "@platos/kernel";

import type { Destination } from "./destination.js";
import type { EventName, NotificationRuleId, RuleName, SubjectId } from "./identifiers.js";

/**
 * How bad the underlying event is, as far as this context can tell.
 *
 * The legacy Slack renderer colours an attachment `"danger"` when the event name
 * ends in `.failed` or `.exceeded`, and `"good"` otherwise. That is a real
 * classification living inside a presentation function; lifting it here makes it
 * available to every delivery channel and testable without rendering anything.
 * It stays a two-valued judgement because that is all the legacy rule supports —
 * inventing a third level would be new behaviour, not a refactor.
 */
export type NotificationSeverity = "alert" | "info";

const ALERT_SUFFIXES = [".failed", ".exceeded"] as const;

export function severityOf(eventName: EventName): NotificationSeverity {
  return ALERT_SUFFIXES.some((suffix) => eventName.endsWith(suffix)) ? "alert" : "info";
}

export interface NotificationRequested {
  readonly ruleId: NotificationRuleId;
  readonly ruleName: RuleName;
  readonly scope: EnvironmentScope;
  /** The outbox event that caused this, for correlation across the drain. */
  readonly eventId: EventId;
  readonly eventName: EventName;
  readonly subjectId: SubjectId | null;
  readonly payload: JsonValue;
  readonly destination: Destination;
  readonly severity: NotificationSeverity;
  /** 0 on the first request; incremented by the retry schedule. */
  readonly retryCount: number;
  readonly requestedAt: Date;
}

/**
 * The one-line human summary.
 *
 * Format preserved from `McpEventsService.summarize`:
 * `[platos] <eventName>[ subject=<id>] (rule: <ruleName>)`. Operators have this
 * string in their Slack history and in alert-routing regexes, so its shape is
 * part of the observable contract even though nothing type-checks it.
 */
export function summarize(request: NotificationRequested): string {
  const subject = request.subjectId === null ? "" : ` subject=${request.subjectId}`;
  return `[platos] ${request.eventName}${subject} (rule: ${request.ruleName})`;
}
