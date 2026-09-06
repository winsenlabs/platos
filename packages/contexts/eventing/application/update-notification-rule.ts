// Use case: change a notification rule.
//
// PARTIAL, AND THE PARTIALITY IS THE HARD PART. The legacy `updateRule` builds a
// Prisma `data` object field by field, each guarded by `!== undefined`, so
// omitting a field and setting it are genuinely different requests. That is
// reproduced exactly: `NotificationRuleEdit` uses optional properties and
// `editNotificationRule` falls back to the CURRENT value, never to a default.
// The failure this avoids is the one every naive "update" has — a PATCH that
// re-enables a rule the operator disabled, because `enabled` defaulted to true
// on the way through.
//
// EVERY FIELD IS RE-VALIDATED ON THE WAY IN, with the same parsers registration
// uses. A rule cannot be edited into a state it could not have been created in;
// in particular a URL destination is re-screened, so an operator cannot register
// a public webhook and then quietly repoint it at link-local space.
//
// THE LOOKUP IS SCOPED FIRST. `updateRule` reads through `findRule(scope, id)`
// before writing, which is what makes a cross-environment id a
// EVENTING_RULE_NOT_FOUND rather than a successful write to someone else's row.
// The legacy code does this too — and then calls
// `prisma.notificationRule.update({ where: { id } })` with an UNSCOPED where,
// which is safe only because of the preceding read. Here the repository's
// `updateRule` takes the whole rule, whose `scope` came from the scoped read, so
// the unscoped-write shape does not exist to get wrong.

import { err, ok, runResult, type EnvironmentScope, type Result } from "@platos/kernel";

import {
  editIsVacuous,
  editNotificationRule,
  parseDestination,
  parseRuleFilter,
  parseRuleName,
  ruleNameTaken,
  ruleNotFound,
  type DestinationInput,
  type NotificationRule,
  type NotificationRuleEdit,
  type NotificationRuleId,
  type RuleFilterInput,
} from "../domain/index.js";
import type { EventingDependencies } from "./dependencies.js";
import { screenDestination } from "./screen-destination.js";

export interface UpdateNotificationRuleCommand {
  readonly scope: EnvironmentScope;
  readonly ruleId: NotificationRuleId;
  readonly name?: string;
  readonly filters?: RuleFilterInput;
  readonly delivery?: DestinationInput;
  readonly enabled?: boolean;
}

async function buildEdit(
  dependencies: EventingDependencies,
  command: UpdateNotificationRuleCommand,
): Promise<Result<NotificationRuleEdit>> {
  const edit: {
    name?: NotificationRuleEdit["name"];
    filter?: NotificationRuleEdit["filter"];
    destination?: NotificationRuleEdit["destination"];
    enabled?: boolean;
  } = {};

  if (command.name !== undefined) {
    const name = parseRuleName(command.name);
    if (!name.ok) return err(name.error);
    edit.name = name.value;
  }
  if (command.filters !== undefined) {
    const filter = parseRuleFilter(command.filters);
    if (!filter.ok) return err(filter.error);
    edit.filter = filter.value;
  }
  if (command.delivery !== undefined) {
    const parsed = parseDestination(command.delivery);
    if (!parsed.ok) return err(parsed.error);
    const screened = await screenDestination(dependencies.screen, parsed.value);
    if (!screened.ok) return err(screened.error);
    edit.destination = screened.value;
  }
  if (command.enabled !== undefined) edit.enabled = command.enabled;

  return ok(edit);
}

/**
 * A rename must not collide with a sibling. The unique index is on
 * `(environmentId, name)`, so renaming to the rule's OWN current name is a
 * no-op, not a conflict.
 *
 * TWO GUARDS, AND ON THE RESULT ALONE THEY MASK EACH OTHER. The same-name
 * shortcut returns before the lookup; the id-inequality test admits the rule's
 * own row when the lookup happens anyway. The 2026-09-03 enumerated mutation
 * control found each to be an EQUIVALENT MUTANT against the suite as it then
 * stood — delete either line and all 147 cases stayed green, because the
 * survivor still admitted the re-PUT — while deleting BOTH turned "ALLOWS a
 * rename to the rule's own current name" red.
 *
 * That is a description of the SUITE, not of the code, and it is no longer
 * true. Both lines stay because they defend different things, and each of those
 * two things now has its own control in update-notification-rule.test.ts:
 *
 *   the shortcut  makes the common idempotent re-PUT cost NO READ at all.
 *                 Pinned by "re-PUTting the rule's OWN name costs no lookup at
 *                 all", which asserts on the store's recorded lookups, because
 *                 the RESULT is identical either way — one query later.
 *   the id test   keeps a STALE read from being reported as a conflict with
 *                 itself: this rule renamed by a concurrent writer between the
 *                 `findRule` above and this lookup. Pinned by "does NOT report
 *                 a conflict when the clashing row is the rule's OWN, renamed
 *                 concurrently", which drives that interleaving through the
 *                 double's `beforeFindRuleByName` hook.
 *
 * Deleting either line now turns exactly one of those red. The earlier version
 * of this comment credited the id test alone for the property, which was wrong;
 * the version after that said the pair defends it, which was true of the suite
 * and left both lines individually unproven. Neither is left standing on prose.
 */
async function assertNameFree(
  dependencies: EventingDependencies,
  rule: NotificationRule,
  edit: NotificationRuleEdit,
): Promise<Result<void>> {
  if (edit.name === undefined || edit.name === rule.name) return ok(undefined);
  const clash = await dependencies.repository.findRuleByName(rule.scope, edit.name);
  if (!clash.ok) return err(clash.error);
  if (clash.value !== null && clash.value.ruleId !== rule.ruleId) {
    return err(ruleNameTaken(edit.name));
  }
  return ok(undefined);
}

export async function updateNotificationRule(
  dependencies: EventingDependencies,
  command: UpdateNotificationRuleCommand,
): Promise<Result<NotificationRule>> {
  const found = await dependencies.repository.findRule(command.scope, command.ruleId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(ruleNotFound(command.ruleId));

  const edit = await buildEdit(dependencies, command);
  if (!edit.ok) return err(edit.error);
  if (editIsVacuous(edit.value)) return ok(found.value);

  const free = await assertNameFree(dependencies, found.value, edit.value);
  if (!free.ok) return err(free.error);

  const next = editNotificationRule(found.value, edit.value, dependencies.clock.now());
  if (!next.ok) return err(next.error);

  return runResult(dependencies.unitOfWork, (transaction) =>
    dependencies.repository.updateRule(next.value, transaction),
  );
}
