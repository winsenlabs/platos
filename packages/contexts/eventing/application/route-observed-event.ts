// Use case: route one drained outbox event to the rules that want it.
//
// This is the context's reason to exist (ADR M0.3 §1 row 17) and the direct
// descendant of the rule-evaluation half of `McpEventsService.emit`.
//
// WHAT IS PRESERVED
//
//   - Only ENABLED rules in the environment are considered, narrowed in the
//     store (`listEnabledRules`) exactly as the legacy `where` narrows.
//   - A rule whose stored `filters` or `delivery` JSON does not parse is
//     SKIPPED, not failed. The legacy loop does `if (!filters || !matches)
//     continue;` and `if (!isRuleDelivery(rule.delivery)) continue;`. A single
//     corrupt row must not stop the other rules in the environment from firing,
//     and the row is already persisted so refusing it here changes nothing about
//     it. Every skip is REPORTED rather than discarded, which is the part the
//     legacy code cannot do.
//   - One `NotificationRequested` per matching rule, carrying the rule's name
//     and destination by value.
//
// WHAT IS DELIBERATELY NOT PRESERVED, AND WHY
//
//   The legacy `emit` swallows EVERYTHING: `catch (err) { logger.warn(...) }`
//   around rule evaluation, and another around the whole method, with the
//   comment "Fail-open everywhere — an emitter that throws never bricks the
//   calling business path". That was correct for its call site. `emit` ran
//   INLINE on a business path — a run finishing, a budget tripping — and a
//   notification failure genuinely must not fail the run.
//
//   This use case does not run there. Its caller is the OUTBOX DRAIN (§7
//   decision 8), whose entire contract is at-least-once redelivery. A drain that
//   is told "fine" when the rules could not be read will mark the event done and
//   the notification is lost with no record. So the two failure classes are now
//   distinguished:
//
//     could not LIST the rules      -> `err`. The drain retries the event.
//     could not ENQUEUE one match   -> reported in `failures`, pass continues.
//
//   The per-rule fail-open behaviour is unchanged. The whole-pass one is
//   narrowed on purpose, because "fail-open" against a retrying drain means
//   "drop silently", and that is not the same guarantee the legacy call site
//   had. This is the one behavioural judgement in this refactor and it is
//   recorded here rather than made quietly.

import { err, ok, type Result } from "@platos/kernel";

import {
  parseDestination,
  parseRuleFilter,
  ruleAdmits,
  severityOf,
  toDestinationInput,
  toRuleFilterInput,
  type NotificationRequested,
  type NotificationRule,
  type NotificationRuleId,
  type ObservedEvent,
} from "../domain/index.js";
import type { EventingDependencies } from "./dependencies.js";

/** Why a rule that was loaded did not produce a notification. */
export type RuleSkipReason = "filters-unparsable" | "destination-unparsable" | "did-not-match";

export interface SkippedRule {
  readonly ruleId: NotificationRuleId;
  readonly reason: RuleSkipReason;
}

export interface FailedNotification {
  readonly ruleId: NotificationRuleId;
  readonly code: string;
}

export interface EventRoutingReport {
  readonly eventId: ObservedEvent["eventId"];
  readonly considered: number;
  readonly requested: readonly NotificationRequested[];
  readonly skipped: readonly SkippedRule[];
  /** Enqueue failures. Non-empty means the pass was partial, not clean. */
  readonly failures: readonly FailedNotification[];
}

/**
 * Re-parse a stored rule's JSON halves.
 *
 * A `NotificationRule` in memory already holds parsed values, so this looks
 * redundant — but the round trip is the point at the drain boundary. The columns
 * are `Json` with no database-level shape, an adapter reconstructs the aggregate
 * from them, and this is where a row written by an older binary (or by hand)
 * gets one last total check before its destination is acted on.
 */
function reparse(rule: NotificationRule): RuleSkipReason | null {
  if (!parseRuleFilter(toRuleFilterInput(rule.filter)).ok) return "filters-unparsable";
  if (!parseDestination(toDestinationInput(rule.destination)).ok) return "destination-unparsable";
  return null;
}

function requestFor(
  rule: NotificationRule,
  event: ObservedEvent,
  requestedAt: Date,
): NotificationRequested {
  return Object.freeze({
    ruleId: rule.ruleId,
    ruleName: rule.name,
    scope: rule.scope,
    eventId: event.eventId,
    eventName: event.name,
    subjectId: event.subjectId,
    payload: event.payload,
    destination: rule.destination,
    severity: severityOf(event.name),
    retryCount: 0,
    requestedAt: new Date(requestedAt.getTime()),
  });
}

export async function routeObservedEvent(
  dependencies: EventingDependencies,
  event: ObservedEvent,
): Promise<Result<EventRoutingReport>> {
  const rules = await dependencies.repository.listEnabledRules(event.scope);
  if (!rules.ok) return err(rules.error);

  const now = dependencies.clock.now();
  const requested: NotificationRequested[] = [];
  const skipped: SkippedRule[] = [];
  const failures: FailedNotification[] = [];

  for (const rule of rules.value) {
    const unusable = reparse(rule);
    if (unusable !== null) {
      skipped.push({ ruleId: rule.ruleId, reason: unusable });
      continue;
    }
    if (!ruleAdmits(rule, event.name, event.subjectId)) {
      skipped.push({ ruleId: rule.ruleId, reason: "did-not-match" });
      continue;
    }
    const request = requestFor(rule, event, now);
    const enqueued = await dependencies.queue.enqueue({ request, availableAt: request.requestedAt });
    if (!enqueued.ok) {
      failures.push({ ruleId: rule.ruleId, code: enqueued.error.code });
      continue;
    }
    requested.push(request);
  }

  return ok({
    eventId: event.eventId,
    considered: rules.value.length,
    requested,
    skipped,
    failures,
  });
}
