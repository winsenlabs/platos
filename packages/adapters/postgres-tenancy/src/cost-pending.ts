// The one statement `listPendingCrossings` is, and the only hand-written SQL in
// this context's half of the adapter.
//
// THREE THINGS THE QUERY BUILDER CANNOT SAY, AND ALL THREE ARE THE CONTRACT.
//
//   DISTINCT ON THE CROSSING. The port is explicit: "the dispatcher's unit of
//   work is a whole crossing, and returning four rows for one crossing would
//   have four dispatchers race over the same four deliveries instead of one
//   handling them in order." `distinct` in the query builder de-duplicates the
//   ROWS it selected; `DISTINCT ON` picks ONE row per crossing under an ordering
//   this query chooses, which is what makes the earliest deadline the one that
//   survives the collapse.
//
//   OLDEST DEADLINE FIRST, ACROSS crossings, after that collapse. `DISTINCT ON`
//   demands its own key lead the inner `ORDER BY`, so the outer order has to be
//   applied to the collapsed set — which is a second ordering over a subquery,
//   and not something a single builder call expresses.
//
//   THE TENANT CHAIN, RE-DERIVED. `PendingCrossing.scope` is "the RE-DERIVED
//   ancestry of the crossing's environment, not three ids the caller supplied",
//   because this sweep runs installation-wide and has no request scope at all.
//   The joins to `Environment` and `Project` are where the organization and the
//   project come from, and they are in the SAME statement as the crossing, so
//   the count does not grow with the number of crossings returned.
//
// IT IS A SELECT, AND THAT MATTERS FOR THE OWNERSHIP GATE. `sole-writer.mjs`
// judges raw statements by verb: a mutating verb naming a canonical table is a
// write and is attributed to the file's directory, and a read is exempt by
// design because ADR M0.3 §1 restricts WRITES. Nothing below mutates anything.

import type { DeliveryStatus } from "@platos/context-cost-monitoring/application/ports/index.js";

import type { BudgetRow, CrossingRow } from "./cost-rows.js";
import type { TenancyTransactions } from "./transaction.js";

/** One crossing with work outstanding, its cap, and where in the tree it lives. */
export interface PendingCrossingRow {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly event: CrossingRow;
  readonly budget: BudgetRow;
}

/** The flat shape the driver returns, before the two records are assembled. */
interface RawPendingRow {
  readonly organizationId: string;
  readonly projectId: string;
  readonly eventId: string;
  readonly eventEnvironmentId: string;
  readonly eventBudgetId: string;
  readonly windowKey: string;
  readonly threshold: number;
  readonly spentCents: number;
  readonly runs: number;
  readonly eventCreatedAt: Date;
  readonly budgetId: string;
  readonly budgetEnvironmentId: string;
  readonly agentId: string | null;
  readonly scope: string;
  readonly period: string;
  readonly limitCents: number;
  readonly turnsLimit: number | null;
  readonly alertThresholds: unknown;
  readonly enabled: boolean;
  readonly overrideUntil: Date | null;
  readonly budgetCreatedAt: Date;
  readonly budgetUpdatedAt: Date;
}

export async function readPendingCrossings(
  transactions: TenancyTransactions,
  statuses: readonly DeliveryStatus[],
  dueAt: Date,
  limit: number,
): Promise<readonly PendingCrossingRow[]> {
  // The statuses travel as ONE text parameter rather than as an array binding.
  // `status` is a PostgreSQL enum, and an enum compared against a bound array
  // has to be told which array type it is being compared with; splitting a
  // delimited scalar server-side is the form that needs no such declaration and
  // still keeps the values out of the statement text.
  const wanted = statuses.join(",");
  const rows = await transactions.reader().$queryRaw<RawPendingRow[]>`
    SELECT
      project."organizationId"  AS "organizationId",
      environment."projectId"   AS "projectId",
      crossing."id"             AS "eventId",
      crossing."environmentId"  AS "eventEnvironmentId",
      crossing."budgetId"       AS "eventBudgetId",
      crossing."windowKey"      AS "windowKey",
      crossing."threshold"      AS "threshold",
      crossing."spentCents"     AS "spentCents",
      crossing."runs"           AS "runs",
      crossing."createdAt"      AS "eventCreatedAt",
      cap."id"                  AS "budgetId",
      cap."environmentId"       AS "budgetEnvironmentId",
      cap."agentId"             AS "agentId",
      cap."scope"               AS "scope",
      cap."period"              AS "period",
      cap."limitCents"          AS "limitCents",
      cap."turnsLimit"          AS "turnsLimit",
      cap."alertThresholds"     AS "alertThresholds",
      cap."enabled"             AS "enabled",
      cap."overrideUntil"       AS "overrideUntil",
      cap."createdAt"           AS "budgetCreatedAt",
      cap."updatedAt"           AS "budgetUpdatedAt"
    FROM (
      SELECT DISTINCT ON (outstanding."budgetThresholdEventId")
             outstanding."budgetThresholdEventId" AS "crossingId",
             outstanding."availableAt"            AS "dueAt"
      FROM "AlertDelivery" outstanding
      WHERE outstanding."kind" = 'BUDGET'
        AND outstanding."budgetThresholdEventId" IS NOT NULL
        AND outstanding."status"::text = ANY(string_to_array(${wanted}, ','))
        AND outstanding."availableAt" <= ${dueAt}
      ORDER BY outstanding."budgetThresholdEventId", outstanding."availableAt" ASC
    ) picked
    JOIN "BudgetThresholdEvent" crossing ON crossing."id" = picked."crossingId"
    JOIN "Budget" cap
      ON cap."id" = crossing."budgetId" AND cap."environmentId" = crossing."environmentId"
    JOIN "Environment" environment ON environment."id" = crossing."environmentId"
    JOIN "Project" project ON project."id" = environment."projectId"
    ORDER BY picked."dueAt" ASC, crossing."id" ASC
    LIMIT ${limit}
  `;
  return rows.map((row) => ({
    organizationId: row.organizationId,
    projectId: row.projectId,
    environmentId: row.eventEnvironmentId,
    event: {
      id: row.eventId,
      environmentId: row.eventEnvironmentId,
      budgetId: row.eventBudgetId,
      windowKey: row.windowKey,
      threshold: row.threshold,
      spentCents: row.spentCents,
      runs: row.runs,
      createdAt: row.eventCreatedAt,
    },
    budget: {
      id: row.budgetId,
      environmentId: row.budgetEnvironmentId,
      agentId: row.agentId,
      scope: row.scope,
      period: row.period,
      limitCents: row.limitCents,
      turnsLimit: row.turnsLimit,
      alertThresholds: row.alertThresholds,
      enabled: row.enabled,
      overrideUntil: row.overrideUntil,
      createdAt: row.budgetCreatedAt,
      updatedAt: row.budgetUpdatedAt,
    },
  }));
}
