// Use cases: read budget caps.
//
// The weaker of tenancy's two levels is enough. A cap holds no material — a
// limit, a period, a subject and a list of percentages — so listing them is a
// metadata read, and demanding a vault-mutating grant to see one would push every
// dashboard into holding an access level it has no use for.

import { err, ok, type Result } from "@platos/kernel";

import { budgetNotFound, byListingOrder, type Budget, type BudgetId } from "../domain/index.js";
import { verifyOperator } from "./authorization.js";
import type { CostMonitoringDependencies } from "./dependencies.js";
import type { BudgetPage } from "./ports/index.js";

export interface ReadBudgetsQuery {
  /** A grant minted by `tenancy`. Its scope is the only environment it reaches. */
  readonly authorization: unknown;
}

export interface PageBudgetsQuery extends ReadBudgetsQuery {
  readonly limit: number;
  readonly offset: number;
}

export interface DescribeBudgetQuery extends ReadBudgetsQuery {
  readonly budgetId: BudgetId;
}

export async function listBudgets(
  dependencies: CostMonitoringDependencies,
  query: ReadBudgetsQuery,
): Promise<Result<readonly Budget[]>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  const listed = await dependencies.repository.listBudgets(granted.value.scope);
  if (!listed.ok) return err(listed.error);
  // Sorted here as well as in the store. The store's order is the one that makes
  // paging correct; repeating it here makes an unpaged listing independent of
  // whether a particular adapter honoured it.
  return ok([...listed.value].sort(byListingOrder));
}

export async function pageBudgets(
  dependencies: CostMonitoringDependencies,
  query: PageBudgetsQuery,
): Promise<Result<BudgetPage>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  return dependencies.repository.pageBudgets(granted.value.scope, {
    limit: Math.min(Math.max(Math.trunc(query.limit), 1), dependencies.policy.maxPageSize),
    offset: Math.max(Math.trunc(query.offset), 0),
  });
}

export async function describeBudget(
  dependencies: CostMonitoringDependencies,
  query: DescribeBudgetQuery,
): Promise<Result<Budget>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  const found = await dependencies.repository.findBudget(granted.value.scope, query.budgetId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(budgetNotFound(query.budgetId));
  return ok(found.value);
}
