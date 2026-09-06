// Reads, and the one delete.
//
// All three narrow to the scope they were given. `describeNotificationRule`
// returns a `Result` with EVENTING_RULE_NOT_FOUND rather than a nullable, which
// is the difference between "there is no such rule here" as a handled outcome
// and as a null a caller forgets to check.
//
// `deleteNotificationRule` returns `false` for an absent rule rather than
// failing, preserving the legacy `deleteRule`'s boolean: delete is idempotent,
// and a caller retrying after a timeout must not get an error for having
// succeeded the first time.

import { err, ok, runResult, type EnvironmentScope, type Result } from "@platos/kernel";

import { ruleNotFound, type NotificationRule, type NotificationRuleId } from "../domain/index.js";
import type { EventingDependencies } from "./dependencies.js";

export async function listNotificationRules(
  dependencies: EventingDependencies,
  scope: EnvironmentScope,
): Promise<Result<readonly NotificationRule[]>> {
  return dependencies.repository.listRules(scope);
}

export async function describeNotificationRule(
  dependencies: EventingDependencies,
  scope: EnvironmentScope,
  ruleId: NotificationRuleId,
): Promise<Result<NotificationRule>> {
  const found = await dependencies.repository.findRule(scope, ruleId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(ruleNotFound(ruleId));
  return ok(found.value);
}

export async function deleteNotificationRule(
  dependencies: EventingDependencies,
  scope: EnvironmentScope,
  ruleId: NotificationRuleId,
): Promise<Result<boolean>> {
  const found = await dependencies.repository.findRule(scope, ruleId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return ok(false);
  return runResult(dependencies.unitOfWork, (transaction) =>
    dependencies.repository.deleteRule(scope, ruleId, transaction),
  );
}
