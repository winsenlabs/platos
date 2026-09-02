// The composition of this context's use cases into its published contract.
//
// Thin on purpose. Every rule lives in `domain/`, every orchestration in a named
// use-case module, and this file is the adapter between the command shapes the
// contract publishes and the ones the use cases take. It holds no rule of its
// own, which is what keeps it from becoming the god-service ADR M0.3 §6 exists
// to prevent.
//
// `recordDeliveryFailure` is the one method that takes a VIEW rather than a
// command, because its input is a request this context previously emitted and
// that a delivery adapter is handing back. `rehydrate` is the inverse of
// `toNotificationRequestView`, and it re-parses the destination rather than
// trusting it: the value has been outside this process, possibly through JSON,
// possibly for minutes.

import { err, ok, type ErasureTarget, type Result } from "@platos/kernel";

import type {
  AddressRule,
  DeliveryFailureView,
  EventRoutingView,
  EventingContract,
  NotificationRequestView,
  NotificationRuleView,
  RegisterNotificationRule,
  RouteEventRequest,
  UpdateNotificationRule,
} from "../contracts/index.js";
import {
  asEventName,
  asSubjectId,
  observedEventFrom,
  parseDestination,
  parseRuleName,
  severityOf,
  type NotificationRequested,
} from "../domain/index.js";
import type { EventingDependencies } from "./dependencies.js";
import { createEventingErasureTarget } from "./eventing-erasure-target.js";
import {
  deleteNotificationRule,
  describeNotificationRule,
  listNotificationRules,
} from "./read-notification-rules.js";
import { recordDeliveryFailure } from "./record-delivery-failure.js";
import { registerNotificationRule } from "./register-notification-rule.js";
import { routeObservedEvent } from "./route-observed-event.js";
import { testNotificationRule } from "./test-notification-rule.js";
import { updateNotificationRule } from "./update-notification-rule.js";
import { toNotificationRequestView, toNotificationRuleView } from "./views.js";

async function routeEvent(
  dependencies: EventingDependencies,
  request: RouteEventRequest,
): Promise<Result<EventRoutingView>> {
  const observed = observedEventFrom(request.event);
  if (observed === null) {
    // Not environment-scoped, so no rule can match. An empty pass, not a refusal.
    return ok({ eventId: null, considered: 0, requested: [], skippedCount: 0, failedRuleIds: [] });
  }
  const routed = await routeObservedEvent(dependencies, observed);
  if (!routed.ok) return err(routed.error);
  return ok({
    eventId: routed.value.eventId,
    considered: routed.value.considered,
    requested: routed.value.requested.map(toNotificationRequestView),
    skippedCount: routed.value.skipped.length,
    failedRuleIds: routed.value.failures.map((failure) => failure.ruleId),
  });
}

async function registerRule(
  dependencies: EventingDependencies,
  request: RegisterNotificationRule,
): Promise<Result<NotificationRuleView>> {
  const registered = await registerNotificationRule(dependencies, {
    scope: request.scope,
    name: request.name,
    filters: request.filters,
    delivery: request.delivery,
    createdBy: request.createdBy,
  });
  if (!registered.ok) return err(registered.error);
  return ok(toNotificationRuleView(registered.value));
}

async function updateRule(
  dependencies: EventingDependencies,
  request: UpdateNotificationRule,
): Promise<Result<NotificationRuleView>> {
  const updated = await updateNotificationRule(dependencies, request);
  if (!updated.ok) return err(updated.error);
  return ok(toNotificationRuleView(updated.value));
}

async function listRules(
  dependencies: EventingDependencies,
  scope: RegisterNotificationRule["scope"],
): Promise<Result<readonly NotificationRuleView[]>> {
  const listed = await listNotificationRules(dependencies, scope);
  if (!listed.ok) return err(listed.error);
  return ok(listed.value.map(toNotificationRuleView));
}

async function describeRule(
  dependencies: EventingDependencies,
  request: AddressRule,
): Promise<Result<NotificationRuleView>> {
  const found = await describeNotificationRule(dependencies, request.scope, request.ruleId);
  if (!found.ok) return err(found.error);
  return ok(toNotificationRuleView(found.value));
}

async function testRule(
  dependencies: EventingDependencies,
  request: AddressRule,
): Promise<Result<NotificationRequestView>> {
  const fired = await testNotificationRule(dependencies, request.scope, request.ruleId);
  if (!fired.ok) return err(fired.error);
  return ok(toNotificationRequestView(fired.value));
}

/**
 * View -> domain, for a request that is coming BACK from a delivery adapter.
 *
 * Every branded field is re-parsed rather than cast. The value has been outside
 * this process — through JSON, possibly for minutes, possibly across a restart —
 * so it is untrusted input arriving at an application boundary, and the fact
 * that this context minted it originally is not evidence about what came back.
 * A malformed destination in particular must be refused here rather than
 * delivered to whatever `type` happens to say.
 */
function rehydrate(view: NotificationRequestView): Result<NotificationRequested> {
  const destination = parseDestination(view.delivery);
  if (!destination.ok) return err(destination.error);
  const ruleName = parseRuleName(view.ruleName);
  if (!ruleName.ok) return err(ruleName.error);
  const eventName = asEventName(view.eventName);
  return ok(
    Object.freeze({
      ruleId: view.ruleId,
      ruleName: ruleName.value,
      scope: view.scope,
      eventId: view.eventId,
      eventName,
      subjectId: view.subjectId === null ? null : asSubjectId(view.subjectId),
      payload: view.payload,
      destination: destination.value,
      severity: severityOf(eventName),
      retryCount: view.retryCount,
      requestedAt: view.requestedAt,
    }),
  );
}

async function reportDeliveryFailure(
  dependencies: EventingDependencies,
  view: NotificationRequestView,
): Promise<Result<DeliveryFailureView>> {
  const request = rehydrate(view);
  if (!request.ok) return err(request.error);
  const outcome = await recordDeliveryFailure(dependencies, request.value);
  if (!outcome.ok) return err(outcome.error);
  const { decision, rescheduled } = outcome.value;
  return ok({
    retrying: decision.kind === "retry",
    retryCount: decision.retryCount,
    delayMs: decision.kind === "retry" ? decision.delayMs : null,
    rescheduled: rescheduled === null ? null : toNotificationRequestView(rescheduled),
  });
}

/** Build the context. The composition root calls this once, at boot. */
export function createEventingContract(dependencies: EventingDependencies): EventingContract {
  const erasure: ErasureTarget = createEventingErasureTarget(dependencies);
  return {
    name: "eventing",
    routeEvent: (request) => routeEvent(dependencies, request),
    registerRule: (request) => registerRule(dependencies, request),
    updateRule: (request) => updateRule(dependencies, request),
    listRules: (scope) => listRules(dependencies, scope),
    describeRule: (request) => describeRule(dependencies, request),
    deleteRule: (request) => deleteNotificationRule(dependencies, request.scope, request.ruleId),
    testRule: (request) => testRule(dependencies, request),
    recordDeliveryFailure: (request) => reportDeliveryFailure(dependencies, request),
    erasureTarget: () => erasure,
  };
}
