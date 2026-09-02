// Use case: fire a synthetic event at one rule so an operator can verify the
// wiring without waiting for a real event.
//
// Descendant of `McpEventsService.testRule`, and its three refusals are
// preserved with their reasons made addressable instead of being prose in a
// `note` field:
//
//   rule not found in scope   -> EVENTING_RULE_NOT_FOUND
//   rule is disabled          -> EVENTING_RULE_DISABLED
//   delivery malformed        -> EVENTING_RULE_DESTINATION_INVALID
//
// THE SYNTHETIC EVENT BYPASSES THE FILTER, AND THAT IS THE POINT. The legacy
// code builds the `PendingDelivery` directly rather than running
// `notifications.test_fired` through `matchesFilters` — if it did, a rule
// filtered to `run.*` would never see its own test and the feature would be
// useless exactly when an operator most needs it. So this is a delivery-path
// test, not a matcher test. Preserved, and stated, because it looks like a bug
// until you see why.
//
// The event name `notifications.test_fired` is part of the observable contract:
// operators filter on it downstream.

import { asIdentifier, err, ok, type EnvironmentScope, type EventId, type Result } from "@platos/kernel";

import {
  asEventName,
  parseDestination,
  ruleDisabled,
  ruleNotFound,
  severityOf,
  toDestinationInput,
  type NotificationRequested,
  type NotificationRuleId,
} from "../domain/index.js";
import type { EventingDependencies } from "./dependencies.js";

export const TEST_EVENT_NAME = "notifications.test_fired";

/** The legacy id shape: `synthetic-<epoch ms>`, from the injected clock. */
export function syntheticEventId(now: Date): EventId {
  return asIdentifier<EventId>(`synthetic-${now.getTime()}`);
}

export async function testNotificationRule(
  dependencies: EventingDependencies,
  scope: EnvironmentScope,
  ruleId: NotificationRuleId,
): Promise<Result<NotificationRequested>> {
  const found = await dependencies.repository.findRule(scope, ruleId);
  if (!found.ok) return err(found.error);
  const rule = found.value;
  if (rule === null) return err(ruleNotFound(ruleId));
  if (!rule.enabled) return err(ruleDisabled(ruleId));

  const destination = parseDestination(toDestinationInput(rule.destination));
  if (!destination.ok) return err(destination.error);

  const now = dependencies.clock.now();
  const eventName = asEventName(TEST_EVENT_NAME);
  const request: NotificationRequested = Object.freeze({
    ruleId: rule.ruleId,
    ruleName: rule.name,
    scope: rule.scope,
    eventId: syntheticEventId(now),
    eventName,
    subjectId: null,
    payload: { ruleId: rule.ruleId, ruleName: rule.name, synthetic: true },
    destination: destination.value,
    severity: severityOf(eventName),
    attempt: 0,
    requestedAt: new Date(now.getTime()),
  });

  const enqueued = await dependencies.queue.enqueue({ request, availableAt: request.requestedAt });
  if (!enqueued.ok) return err(enqueued.error);
  return ok(request);
}
