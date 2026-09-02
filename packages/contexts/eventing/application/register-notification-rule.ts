// Use case: register a notification rule.
//
// The legacy `registerRule` validates name, then filters, then delivery, then
// screens the URL, then writes. The order is preserved because it is the order
// an operator experiences: the cheapest, most-likely-wrong field is reported
// first, and the network round trip happens only once everything local is good.
//
// ONE THING IS ADDED, AND IT IS A DEFECT FIX, NOT A REDESIGN. The legacy path
// writes straight into `prisma.notificationRule.create` and lets the
// `@@unique([environmentId, name])` index reject a duplicate — which surfaces to
// the operator as a raw Prisma constraint violation, not as a handled outcome.
// This use case pre-flights the name and returns EVENTING_RULE_NAME_TAKEN. The
// index remains the authority: the pre-flight closes the common case, and a
// racing insert still fails at the store, where the adapter maps it onto the
// same code. Two writers cannot make a duplicate here that the index would not
// also refuse.

import { asIdentifier, err, type Result } from "@platos/kernel";
import type { EnvironmentScope, PrincipalId } from "@platos/kernel";

import {
  createNotificationRule,
  parseDestination,
  parseRuleFilter,
  parseRuleName,
  ruleNameTaken,
  type DestinationInput,
  type NotificationRule,
  type NotificationRuleId,
  type RuleFilterInput,
} from "../domain/index.js";
import type { EventingDependencies } from "./dependencies.js";
import { screenDestination } from "./screen-destination.js";

export interface RegisterNotificationRuleCommand {
  readonly scope: EnvironmentScope;
  readonly name: string;
  readonly filters: RuleFilterInput;
  readonly delivery: DestinationInput;
  readonly createdBy: PrincipalId;
}

export async function registerNotificationRule(
  dependencies: EventingDependencies,
  command: RegisterNotificationRuleCommand,
): Promise<Result<NotificationRule>> {
  const name = parseRuleName(command.name);
  if (!name.ok) return err(name.error);

  const filter = parseRuleFilter(command.filters);
  if (!filter.ok) return err(filter.error);

  const parsed = parseDestination(command.delivery);
  if (!parsed.ok) return err(parsed.error);

  const destination = await screenDestination(dependencies.screen, parsed.value);
  if (!destination.ok) return err(destination.error);

  const existing = await dependencies.repository.findRuleByName(command.scope, name.value);
  if (!existing.ok) return err(existing.error);
  if (existing.value !== null) return err(ruleNameTaken(name.value));

  const rule = createNotificationRule(
    {
      ruleId: asIdentifier<NotificationRuleId>(dependencies.ids.uuid()),
      scope: command.scope,
      name: name.value,
      filter: filter.value,
      destination: destination.value,
      createdBy: command.createdBy,
    },
    dependencies.clock.now(),
  );

  return dependencies.unitOfWork.run((transaction) =>
    dependencies.repository.insertRule(rule, transaction),
  );
}
