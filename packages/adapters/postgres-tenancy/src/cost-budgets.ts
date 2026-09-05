// The `Budget` and `BudgetThresholdEvent` halves of `BudgetRepository`.
//
// TWO ROWS WITH OPPOSITE LIFECYCLES, WHICH IS WHY THEY SHARE A FILE. A cap is
// edited, overridden and eventually tombstoned; a crossing is INSERTED AND NEVER
// TOUCHED AGAIN. The migrations say the second part outright — three database
// rules reject UPDATE, DELETE and TRUNCATE on `BudgetThresholdEvent` and all
// three are revoked from PUBLIC — and that is not decoration. The unique index on
// `(budgetId, windowKey, threshold)` is what makes "one alert per cap per window
// per threshold, ever" true across a restart, a redelivery and two evaluators
// racing, and a row that could be updated could be re-used, which would send the
// alert twice.
//
// SO A DUPLICATE IS `ok(null)` AND AN IDENTIFIER CLASH IS NOT. Both arrive as
// SQLSTATE 23505, and the port's contract distinguishes them: `null` means "the
// alert has already fired for this cap, window and threshold", which is a normal
// outcome. A crossing whose `id` was already taken is a caller minting a
// duplicate identifier, which is not, and answering `null` to it would tell an
// evaluator its alert had already been sent when a different alert entirely is
// on the row. The driver names the index it refused on, so the two are told
// apart by the constraint rather than by guessing.
//
// THE LISTING ORDER IS COMPUTED HERE AND NOT IN SQL, AND THAT IS A FINDING
// RATHER THAN A SHORTCUT. `byListingOrder` sorts by `target.subject` first, and
// `target.subject` is not a column: it is one field inside the JSON that
// `Budget.scope` — a `TEXT` column with no index and no jsonb type — carries. A
// database-side `ORDER BY ("scope"::jsonb->>'scopeType')` would not reproduce it
// either, for two reasons that both come from `domain/budget-scope.ts`: the cast
// RAISES on a row whose column is not JSON, and the decoder's documented
// fallback reads exactly that row as a `scope`-subject cap. So the order is
// applied after the read, over the decoded values, which is the only place the
// domain's own total order exists.

import type {
  Budget,
  BudgetId,
  EnvironmentScope,
  Result,
  ThresholdEvent,
  ThresholdEventId,
  TransactionScope,
  WindowKey,
} from "@platos/context-cost-monitoring/application/ports/index.js";
import type {
  BudgetPage,
  BudgetQuery,
} from "@platos/context-cost-monitoring/application/ports/index.js";
import {
  byListingOrder,
  err,
  ok,
  repositoryUnavailable,
} from "@platos/context-cost-monitoring/application/ports/index.js";

import { isUniqueViolation } from "./client.js";
import { readBudget, readCrossing, scopedWhere, writeBudget, writeCrossing } from "./cost-rows.js";
import type { TenancyTransactions } from "./transaction.js";

/** The columns every `Budget` read selects. One place, so no read is wider. */
const BUDGET_COLUMNS = {
  id: true,
  environmentId: true,
  agentId: true,
  scope: true,
  period: true,
  limitCents: true,
  turnsLimit: true,
  alertThresholds: true,
  enabled: true,
  overrideUntil: true,
  createdAt: true,
  updatedAt: true,
} as const;

const CROSSING_COLUMNS = {
  id: true,
  environmentId: true,
  budgetId: true,
  windowKey: true,
  threshold: true,
  spentCents: true,
  runs: true,
  createdAt: true,
} as const;

/**
 * Did the driver refuse on the crossing's uniqueness rule, or on its identifier?
 *
 * Prisma reports the refused index in `meta.target`, as either the column list
 * or the index name depending on the connector's version. Both forms are checked
 * because a mapper that recognised only one would silently take the OTHER
 * branch, and the two branches are "the alert already fired" and "this caller
 * minted a duplicate identifier".
 */
function isCrossingDuplicate(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const meta = (error as { readonly meta?: { readonly target?: unknown } }).meta;
  const target = meta?.target;
  const columns = Array.isArray(target) ? target.map(String) : [String(target ?? "")];
  const joined = columns.join(",");
  return (
    joined.includes("windowKey") ||
    joined.includes("BudgetThresholdEvent_budgetId_windowKey_threshold_key")
  );
}

export interface BudgetStore {
  listBudgets(scope: EnvironmentScope): Promise<Result<readonly Budget[]>>;
  pageBudgets(scope: EnvironmentScope, query: BudgetQuery): Promise<Result<BudgetPage>>;
  findBudget(scope: EnvironmentScope, budgetId: BudgetId): Promise<Result<Budget | null>>;
  insertBudget(budget: Budget, transaction: TransactionScope): Promise<Result<Budget>>;
  updateBudget(budget: Budget, transaction: TransactionScope): Promise<Result<Budget>>;
  retireBudget(
    scope: EnvironmentScope,
    budgetId: BudgetId,
    at: Date,
    transaction: TransactionScope,
  ): Promise<Result<boolean>>;
  insertThresholdEvent(
    event: ThresholdEvent,
    transaction: TransactionScope,
  ): Promise<Result<ThresholdEvent | null>>;
  findThresholdEvent(
    scope: EnvironmentScope,
    eventId: ThresholdEventId,
  ): Promise<Result<ThresholdEvent | null>>;
  listRecordedThresholds(
    scope: EnvironmentScope,
    budgetId: BudgetId,
    windowKey: WindowKey,
  ): Promise<Result<readonly number[]>>;
}

export function createBudgetStore(transactions: TenancyTransactions): BudgetStore {
  /** Every LIVE cap in a scope, decoded and in the domain's total order. */
  async function liveBudgets(scope: EnvironmentScope): Promise<Budget[]> {
    const rows = await transactions.reader().budget.findMany({
      // `deletedAt: null` is the tombstone filter. `retireBudget` sets it and
      // nothing else does, so a retired cap disappears from every read while its
      // row stays available to the threshold events that point at it.
      where: { ...scopedWhere(scope), deletedAt: null },
      select: BUDGET_COLUMNS,
    });
    return rows.map(readBudget).sort(byListingOrder);
  }

  return {
    async listBudgets(scope: EnvironmentScope): Promise<Result<readonly Budget[]>> {
      return ok(await liveBudgets(scope));
    },

    async pageBudgets(scope: EnvironmentScope, query: BudgetQuery): Promise<Result<BudgetPage>> {
      // ONE statement, and the page is cut after the sort rather than by `skip`
      // and `take`. Cutting in SQL would need the leading sort key, which lives
      // inside a text column; cutting here over the decoded values applies the
      // exact order the port names, tie-break included. `total` is the same read
      // rather than a second `count`, so the page and the total it is rendered
      // beside cannot disagree about which rows exist.
      const all = await liveBudgets(scope);
      return ok({
        items: all.slice(query.offset, query.offset + query.limit),
        total: all.length,
      });
    },

    async findBudget(scope: EnvironmentScope, budgetId: BudgetId): Promise<Result<Budget | null>> {
      const row = await transactions.reader().budget.findFirst({
        where: { id: budgetId, ...scopedWhere(scope), deletedAt: null },
        select: BUDGET_COLUMNS,
      });
      return ok(row === null ? null : readBudget(row));
    },

    async insertBudget(budget: Budget, transaction: TransactionScope): Promise<Result<Budget>> {
      const client = transactions.writer(transaction);
      try {
        await client.budget.create({ data: writeBudget(budget) });
      } catch (error) {
        if (isUniqueViolation(error)) return err(repositoryUnavailable("budget id already exists"));
        throw error;
      }
      return ok(budget);
    },

    async updateBudget(budget: Budget, transaction: TransactionScope): Promise<Result<Budget>> {
      const client = transactions.writer(transaction);
      const written = writeBudget(budget);
      // `updateMany` KEYED ON BOTH id AND environmentId, not `update` keyed on
      // id. `Budget` is the one row of the six with no `reject_canonical_owner_change`
      // rule, so an `update` by id alone would let a caller holding a cap from
      // another tenant move it into this one. Writing zero rows and answering
      // "no such budget" is the same answer the caller would get for an id that
      // does not exist, which is the answer a foreign id deserves.
      const { id, environmentId, createdAt, ...mutable } = written;
      const outcome = await client.budget.updateMany({
        where: { id, environmentId },
        data: mutable,
      });
      if (outcome.count === 0) return err(repositoryUnavailable("no such budget"));
      return ok(budget);
    },

    async retireBudget(
      scope: EnvironmentScope,
      budgetId: BudgetId,
      at: Date,
      transaction: TransactionScope,
    ): Promise<Result<boolean>> {
      const client = transactions.writer(transaction);
      // SOFT, and both columns move together. `deletedAt` is what every read
      // filters on and `enabled` is what the domain's own `retire` clears, so a
      // row carrying one without the other would be visible to a guard that
      // reads the column the tombstone did not set.
      const outcome = await client.budget.updateMany({
        where: { id: budgetId, ...scopedWhere(scope), deletedAt: null },
        data: { deletedAt: at, enabled: false, updatedAt: at },
      });
      return ok(outcome.count > 0);
    },

    async insertThresholdEvent(
      event: ThresholdEvent,
      transaction: TransactionScope,
    ): Promise<Result<ThresholdEvent | null>> {
      const client = transactions.writer(transaction);
      try {
        await client.budgetThresholdEvent.create({ data: writeCrossing(event) });
      } catch (error) {
        if (isUniqueViolation(error) && isCrossingDuplicate(error)) return ok(null);
        if (isUniqueViolation(error)) {
          return err(repositoryUnavailable("threshold event id already exists"));
        }
        throw error;
      }
      return ok(event);
    },

    async findThresholdEvent(
      scope: EnvironmentScope,
      eventId: ThresholdEventId,
    ): Promise<Result<ThresholdEvent | null>> {
      const row = await transactions.reader().budgetThresholdEvent.findFirst({
        where: { id: eventId, ...scopedWhere(scope) },
        select: CROSSING_COLUMNS,
      });
      return ok(row === null ? null : readCrossing(row));
    },

    async listRecordedThresholds(
      scope: EnvironmentScope,
      budgetId: BudgetId,
      windowKey: WindowKey,
    ): Promise<Result<readonly number[]>> {
      // ONE statement selecting ONE column. This read is on the evaluation path,
      // it is asked once per cap per evaluation, and every other column on the
      // row — including the `spentCents` figure that would have to be converted
      // to an exact amount — is unused by the caller, which only wants to know
      // which lines have already fired.
      const rows = await transactions.reader().budgetThresholdEvent.findMany({
        where: { budgetId, windowKey, ...scopedWhere(scope) },
        select: { threshold: true },
        orderBy: { threshold: "asc" },
      });
      return ok(rows.map((row) => row.threshold));
    },
  };
}
