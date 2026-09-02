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

import { err, ok, type EnvironmentScope, type Result } from "@platos/kernel";

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
 * no-op, not a conflict — checking id inequality is what keeps an idempotent
 * re-PUT of an unchanged rule from failing.
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

  return dependencies.unitOfWork.run((transaction) =>
    dependencies.repository.updateRule(next.value, transaction),
  );
}
