// `NotificationRule` — the ONE canonical row this context is sole writer of.
//
// ADR M0.3 §1 row 17 names three rows for `eventing`. Only this one exists in
// the canonical schema; see `legacy-rows.ts` for the other two and why they are
// not modelled here.
//
// The row (internal-packages/tenancy-database/prisma/schema.prisma):
//
//   id            uuid, pk
//   environmentId uuid, FK -> Environment, onDelete: Cascade
//   name          String            @@unique([environmentId, name])
//   filters       Json              typed event predicates
//   delivery      Json              typed destination, no secrets
//   enabled       Boolean           @default(true)
//   createdBy     String            an OPERATOR principal, not a data subject
//   createdAt / updatedAt
//
// A rule is environment-scoped, and there is no wider form. `NotificationRule`
// has no organization or project column: its scope is the environment it hangs
// off, and every read narrows to it. That is why the aggregate carries an
// `EnvironmentScope` rather than a `TenantScope` — an organization-wide rule is
// not representable, and it should not be possible to write code that assumes it
// is.

import { ok, type EnvironmentScope, type PrincipalId, type Result } from "@platos/kernel";

import type { Destination } from "./destination.js";
import type { EventName, NotificationRuleId, RuleName, SubjectId } from "./identifiers.js";
import { filterAdmits, type RuleFilter } from "./rule-filter.js";

export interface NotificationRule {
  readonly ruleId: NotificationRuleId;
  readonly scope: EnvironmentScope;
  readonly name: RuleName;
  readonly filter: RuleFilter;
  readonly destination: Destination;
  readonly enabled: boolean;
  /** `NotificationRule.createdBy` — an operator principal. */
  readonly createdBy: PrincipalId;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewNotificationRule {
  readonly ruleId: NotificationRuleId;
  readonly scope: EnvironmentScope;
  readonly name: RuleName;
  readonly filter: RuleFilter;
  readonly destination: Destination;
  readonly createdBy: PrincipalId;
}

/**
 * Mint a rule. `enabled` is true, matching the column default — the legacy
 * `registerRule` writes `enabled: true` explicitly and there is no create path
 * that produces a disabled rule.
 */
export function createNotificationRule(input: NewNotificationRule, now: Date): NotificationRule {
  return Object.freeze({
    ruleId: input.ruleId,
    scope: input.scope,
    name: input.name,
    filter: input.filter,
    destination: input.destination,
    enabled: true,
    createdBy: input.createdBy,
    createdAt: new Date(now.getTime()),
    updatedAt: new Date(now.getTime()),
  });
}

/**
 * The four independently-settable fields of an update.
 *
 * `undefined` means "leave alone" and is distinct from any value — the legacy
 * `updateRule` builds its `data` object field by field on `!== undefined`, so
 * omitting `enabled` and passing `enabled: false` are different requests. A
 * partial-update shape that collapsed the two would silently re-enable rules.
 */
export interface NotificationRuleEdit {
  readonly name?: RuleName;
  readonly filter?: RuleFilter;
  readonly destination?: Destination;
  readonly enabled?: boolean;
}

export function editNotificationRule(
  rule: NotificationRule,
  edit: NotificationRuleEdit,
  now: Date,
): Result<NotificationRule> {
  return ok(
    Object.freeze({
      ...rule,
      name: edit.name ?? rule.name,
      filter: edit.filter ?? rule.filter,
      destination: edit.destination ?? rule.destination,
      enabled: edit.enabled ?? rule.enabled,
      updatedAt: new Date(now.getTime()),
    }),
  );
}

/** True when `edit` would change nothing. Lets a no-op update skip a write. */
export function editIsVacuous(edit: NotificationRuleEdit): boolean {
  return (
    edit.name === undefined &&
    edit.filter === undefined &&
    edit.destination === undefined &&
    edit.enabled === undefined
  );
}

/**
 * Does this rule want this event?
 *
 * A DISABLED RULE MATCHES NOTHING. The legacy routing query narrows with
 * `enabled: true` in the `where`, so a disabled rule is never even loaded; here
 * the predicate is total over any rule it is handed, so a caller that lists
 * rules some other way cannot accidentally deliver through a disabled one.
 */
export function ruleAdmits(
  rule: NotificationRule,
  eventName: EventName,
  subjectId: SubjectId | null,
): boolean {
  if (!rule.enabled) return false;
  return filterAdmits(rule.filter, eventName, subjectId);
}
