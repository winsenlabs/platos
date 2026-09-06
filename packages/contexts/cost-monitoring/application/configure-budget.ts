// Use cases: write a budget cap.
//
// `configureBudget` is an UPSERT keyed by the collision tuple, not by an id. That
// is the source's shape and it is the right one for this surface: an operator
// declaring "the daily scope-wide LLM cap is $50" should not have to know whether
// one already exists, and an infrastructure tool re-applying the same declaration
// must be idempotent.
//
// THE COLLISION KEY IS SIX-DIMENSIONAL, AND THE SOURCE RECORDS WHY. Written with
// only (subject, target, period), an `llm` environment-wide cap and a `skill`
// environment-wide cap at the same period aliased onto one row and the second
// declaration silently replaced the first. `domain/budget-scope.ts` holds the
// full tuple, and it is the only definition of "the same cap" — the store has no
// unique index over it.
//
// EVERY WRITE FORGETS THE CACHE. ADR §7 decision 3(b) caches caps for the guard;
// an operator who lowers a cap and watches spend sail past it for the cache's
// lifetime will conclude the feature does not work. The forget is best-effort and
// its failure is not the write's failure: the entry expires on its own, and
// reporting an error would say the cap was not saved when it was.

import { err, ok, runResult, type Result } from "@platos/kernel";

import {
  admitBudget,
  applyIntake,
  asCostIdentifier,
  collisionKey,
  retire,
  withOverride,
  type ActorId,
  type Budget,
  type BudgetId,
  type BudgetIntake,
} from "../domain/index.js";
import { budgetNotFound } from "../domain/index.js";
import { authorize } from "./authorization.js";
import type { CostMonitoringDependencies } from "./dependencies.js";

export interface ConfigureBudgetCommand {
  readonly authorization: unknown;
  readonly intake: BudgetIntake;
}

export interface RemoveBudgetCommand {
  readonly authorization: unknown;
  readonly budgetId: BudgetId;
}

export interface OverrideBudgetCommand {
  readonly authorization: unknown;
  readonly budgetId: BudgetId;
  /** Zero clears the override and its author. */
  readonly minutes: number;
}

export async function configureBudget(
  dependencies: CostMonitoringDependencies,
  command: ConfigureBudgetCommand,
): Promise<Result<Budget>> {
  // `metadata`, not `secret:mutate`: a cap holds no material. The channel
  // surface is the one that needs the higher level, because writing a channel
  // mints or rotates a credential.
  const granted = authorize(dependencies, command.authorization, "metadata");
  if (!granted.ok) return err(granted.error);

  const admitted = admitBudget(command.intake);
  if (!admitted.ok) return err(admitted.error);

  const scope = granted.value.scope;
  const existing = await dependencies.repository.listBudgets(scope);
  if (!existing.ok) return err(existing.error);

  const wanted = collisionKey(admitted.value.target, admitted.value.period);
  const collision = existing.value.find(
    (budget) => collisionKey(budget.target, budget.period) === wanted,
  );

  const now = dependencies.clock.now();
  const written = await runResult(dependencies.unitOfWork, async (transaction) => {
    if (collision !== undefined) {
      return dependencies.repository.updateBudget(
        applyIntake(collision, admitted.value, now),
        transaction,
      );
    }
    const draft: Budget = {
      budgetId: asCostIdentifier<BudgetId>(dependencies.ids.uuid()),
      environmentId: scope.environmentId,
      target: admitted.value.target,
      period: admitted.value.period,
      limitCents: admitted.value.limitCents,
      runsLimit: admitted.value.runsLimit,
      alertThresholds: admitted.value.alertThresholds,
      enabled: admitted.value.enabled,
      overrideUntil: null,
      createdAt: now,
      updatedAt: now,
    };
    return dependencies.repository.insertBudget(draft, transaction);
  });
  if (!written.ok) return err(written.error);

  await dependencies.capCache.forget(scope);
  return ok(written.value);
}

export async function removeBudget(
  dependencies: CostMonitoringDependencies,
  command: RemoveBudgetCommand,
): Promise<Result<Budget>> {
  const granted = authorize(dependencies, command.authorization, "metadata");
  if (!granted.ok) return err(granted.error);

  const scope = granted.value.scope;
  const found = await dependencies.repository.findBudget(scope, command.budgetId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(budgetNotFound(command.budgetId));

  const now = dependencies.clock.now();
  const removed = await runResult(dependencies.unitOfWork, (transaction) =>
    dependencies.repository.retireBudget(scope, command.budgetId, now, transaction),
  );
  if (!removed.ok) return err(removed.error);
  // A cap that vanished between the read and the write was already gone. The
  // source returns false here and the surface renders a 404; the same fact,
  // spelled as the same error the read path would have produced.
  if (!removed.value) return err(budgetNotFound(command.budgetId));

  await dependencies.capCache.forget(scope);
  return ok(retire(found.value, now));
}

/**
 * Grant or clear a temporary override.
 *
 * The AUTHOR is taken from the verified grant, never from the command. An
 * override is the one operation on a cap whose whole value is the audit trail —
 * "who let this through" — and a caller-supplied author is not an audit trail.
 */
export async function overrideBudget(
  dependencies: CostMonitoringDependencies,
  command: OverrideBudgetCommand,
): Promise<Result<Budget>> {
  const granted = authorize(dependencies, command.authorization, "metadata");
  if (!granted.ok) return err(granted.error);

  const scope = granted.value.scope;
  const found = await dependencies.repository.findBudget(scope, command.budgetId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(budgetNotFound(command.budgetId));

  const now = dependencies.clock.now();
  const overridden = withOverride(
    found.value,
    command.minutes,
    asCostIdentifier<ActorId>(granted.value.effectiveUserId),
    now,
  );
  if (!overridden.ok) return err(overridden.error);

  const written = await runResult(dependencies.unitOfWork, (transaction) =>
    dependencies.repository.updateBudget(overridden.value, transaction),
  );
  if (!written.ok) return err(written.error);

  await dependencies.capCache.forget(scope);
  return ok(written.value);
}
