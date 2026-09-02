// Domain aggregate -> published view.
//
// The boundary exists so `contracts/` can be types-only and carry no domain
// internals. A caller receives the rule's filters and destination in their
// COLUMN shape (`eventTypes`, `type`) rather than as this context's parsed value
// objects, because a transport re-serialising them must not have to know that
// `EventPattern` is a brand or that `Destination` discriminates on `kind` while
// the column discriminates on `type`.

import type { NotificationRequested, NotificationRule } from "../domain/index.js";
import { summarize, toDestinationInput, toRuleFilterInput } from "../domain/index.js";
import type { NotificationRequestView, NotificationRuleView } from "../contracts/index.js";

export function toNotificationRuleView(rule: NotificationRule): NotificationRuleView {
  return {
    ruleId: rule.ruleId,
    scope: rule.scope,
    name: rule.name,
    filters: toRuleFilterInput(rule.filter),
    delivery: toDestinationInput(rule.destination),
    enabled: rule.enabled,
    createdBy: rule.createdBy,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

export function toNotificationRequestView(request: NotificationRequested): NotificationRequestView {
  return {
    ruleId: request.ruleId,
    ruleName: request.ruleName,
    scope: request.scope,
    eventId: request.eventId,
    eventName: request.eventName,
    subjectId: request.subjectId,
    payload: request.payload,
    delivery: toDestinationInput(request.destination),
    severity: request.severity,
    attempt: request.attempt,
    requestedAt: request.requestedAt,
    summary: summarize(request),
  };
}
