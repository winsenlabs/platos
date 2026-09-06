// `observability`'s canonical store — one table, four methods, and one of them
// the real database will not honour.
//
// ADR M0.3 §1 row 12 gives this context exactly one Prisma row, `AdminAudit`.
// The four analytical tables are NOT here: they live in a different store with a
// different failure model and are reached through `ObservabilitySink`, which is
// `packages/adapters/clickhouse-observability`'s to satisfy.
//
// *** `clearAdminAuditActor` CANNOT BE HONOURED, AND THIS FILE DOES NOT PRETEND
// OTHERWISE. ***
//
// `00000000000000_initial/migration.sql` installs `reject_admin_audit_mutation()`
// on UPDATE, on DELETE and on TRUNCATE of this table, and withdraws all three
// privileges from PUBLIC. Its own comment states the intent: "Administrative
// audit evidence is append-only... no role can rewrite or remove an accepted
// event. Corrections must be represented by a new row." The port asks this store
// to clear `actorUserId` on every row naming an actor and return how many rows
// changed. Against a database these migrations build, the number of rows that
// can change is ZERO and the statement raises.
//
// So the unlink is SENT and the database's refusal is mapped, under its own code
// (`observability-guards.ts` says why it is not pre-checked). Two consequences
// are pinned as named cases in `observability-constraints.integration.test.ts`
// rather than described here and hoped for:
//
//   * With NO matching row the same call returns `ok(0)`, because a row-level
//     rule never fires on an UPDATE that matched nothing. The port is honourable
//     exactly when there is nothing to do.
//   * With one matching row it refuses AND leaves the caller's transaction
//     unusable, which is what proves the refusal is the DATABASE's and not this
//     adapter's opinion.
//
// `observability-erasure-target.ts` refuses the whole erasure on that `err`,
// which is the correct outcome and not a workaround: an operator's audit trail
// cannot be unlinked, so a receipt claiming it was would be false.
//
// EVERY WRITE TAKES THE CALLER'S TRANSACTION, and the port explains why in one
// sentence worth repeating: an audit trail that can disagree with what actually
// happened is worse than no audit trail, because it is believed.

import {
  ok,
  type AdminAuditQuery,
  type AdminAuditRecord,
  type ObservabilityRepository,
  type Result,
  type TransactionScope,
} from "@platos/context-observability/application/ports/index.js";
import type { AdminAuditActorSelector } from "@platos/context-observability/application/ports/index.js";

import { nullableJson } from "./client.js";
import {
  AUDIT_SCOPE_UNRESOLVED,
  ObservabilityStoreRefused,
  requireAuditActor,
  requireAuditLimit,
  requireAuditUuid,
} from "./observability-guards.js";
import { refuseObservability } from "./observability-refusal.js";
import {
  AUDIT_COLUMNS,
  environmentWhere,
  organizationWhere,
  readAdminAudit,
  type AdminAuditRow,
} from "./observability-rows.js";
import type { TenancyTransactions } from "./transaction.js";

/**
 * The filters a trail read narrows on, absent when the caller did not ask.
 *
 * `null` and `undefined` are both "no filter" on this query — the port's type
 * says `string | null | undefined` for all three — and a blank string is too:
 * `subjectId: ""` would otherwise be a filter matching rows whose subject id is
 * the empty string, which is a row `domain/admin-audit.ts` cannot produce, so
 * the page would be empty for a reason no caller could see.
 */
function auditFilters(query: AdminAuditQuery): Record<string, unknown> {
  const filters: Record<string, unknown> = {};
  const action = query.action ?? "";
  const subjectType = query.subjectType ?? "";
  const subjectId = query.subjectId ?? "";
  if (action.length > 0) filters["action"] = action;
  if (subjectType.length > 0) filters["subjectType"] = subjectType;
  if (subjectId.length > 0) filters["subjectId"] = subjectId;
  return filters;
}

export function createObservabilityRepository(
  transactions: TenancyTransactions,
): ObservabilityRepository {
  return {
    async recordAdminAudit(
      record: AdminAuditRecord,
      transaction: TransactionScope,
    ): Promise<Result<AdminAuditRecord>> {
      return refuseObservability(async () => {
        // Both are `@db.Uuid`. A malformed one refused here leaves the caller's
        // transaction usable; the same value refused by the column would abort
        // the admin action this row is evidence of.
        requireAuditUuid("AdminAudit.id", record.adminAuditId);
        requireAuditUuid("AdminAudit.environmentId", record.scope.environmentId);
        const client = transactions.writer(transaction);

        // THE ANCESTRY STATEMENT. `AdminAudit` carries no ancestry rule, so
        // nothing in the database relates this environment to the organization
        // the record claims — see `AUDIT_SCOPE_UNRESOLVED`. Read INSIDE the
        // caller's transaction, so an environment the same unit of work has just
        // created is visible and one another transaction has not committed is
        // not.
        const environment = await client.environment.findFirst({
          where: {
            id: record.scope.environmentId,
            projectId: record.scope.projectId,
            project: { organizationId: record.scope.organizationId },
          },
          select: { id: true },
        });
        if (environment === null) {
          throw new ObservabilityStoreRefused(
            AUDIT_SCOPE_UNRESOLVED,
            `environment ${record.scope.environmentId} is not under project ${record.scope.projectId} of organization ${record.scope.organizationId}`,
          );
        }

        // The id and the instant come from the caller: `domain/admin-audit.ts`
        // mints both through the kernel's `IdGenerator` and `Clock`, which is
        // what makes a recorded action reproducible at an instant. A store that
        // stamped `createdAt` itself would make the record it returns disagree
        // with the record it was handed.
        const row = await client.adminAudit.create({
          data: {
            id: record.adminAuditId,
            environmentId: record.scope.environmentId,
            actorUserId: record.actorUserId,
            action: record.action,
            subjectType: record.subjectType,
            subjectId: record.subjectId,
            // SQL NULL, never the JSON scalar `null`: both `_json_root` CHECKs
            // on this table read `IS NULL OR jsonb_typeof(...) = 'object'`, and
            // the scalar's `jsonb_typeof` is `'null'`.
            before: nullableJson(record.before),
            after: nullableJson(record.after),
            reason: record.reason,
            source: record.source,
            createdAt: record.recordedAt,
          },
          select: AUDIT_COLUMNS,
        });
        // The scope handed back is the one the statement above PROVED, not the
        // one the caller asserted: `environment` is null unless all three levels
        // matched, and the refusal is the branch immediately before this.
        return ok(readAdminAudit(row as AdminAuditRow, record.scope));
      }, "admin audit record");
    },

    async listAdminAudit(query: AdminAuditQuery): Promise<Result<readonly AdminAuditRecord[]>> {
      return refuseObservability(async () => {
        requireAuditLimit(query.limit);
        // ONE statement, and the SAME one statement for a page of three and a
        // page of three hundred. The two ancestry clauses are subqueries the
        // database resolves inside it, not a second read of the tenancy tree —
        // and the scope handed back on each row is what they proved rather than
        // a relation this store loaded. `observability-rows.ts` says why that
        // shape replaced the loaded one.
        const rows = await transactions.reader().adminAudit.findMany({
          where: { ...environmentWhere(query.scope), ...auditFilters(query) },
          select: AUDIT_COLUMNS,
          // `id` breaks the tie, so the order is TOTAL. `createdAt` is
          // `timestamp(3)` and two admin actions in one unit of work share an
          // instant; a listing whose order is not total repeats a row on one
          // page and drops it from the next.
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: query.limit,
        });
        return ok(rows.map((row) => readAdminAudit(row as AdminAuditRow, query.scope)));
      }, "admin audit list");
    },

    async countAdminAuditForActor(selector: AdminAuditActorSelector): Promise<Result<number>> {
      return refuseObservability(async () => {
        requireAuditActor(selector.organizationId, selector.actorUserId);
        const total = await transactions.reader().adminAudit.count({
          where: {
            actorUserId: selector.actorUserId,
            ...organizationWhere(selector.organizationId),
          },
        });
        return ok(total);
      }, "admin audit count");
    },

    async clearAdminAuditActor(
      selector: AdminAuditActorSelector,
      transaction: TransactionScope,
    ): Promise<Result<number>> {
      return refuseObservability(async () => {
        requireAuditActor(selector.organizationId, selector.actorUserId);
        const client = transactions.writer(transaction);
        // UNLINK, NEVER DELETE — and, against a database these migrations build,
        // never at all. The header of this file is the whole story; the
        // statement is sent so the refusal comes from the rule rather than from
        // this adapter's memory of having read the migration.
        const outcome = await client.adminAudit.updateMany({
          where: {
            actorUserId: selector.actorUserId,
            ...organizationWhere(selector.organizationId),
          },
          data: { actorUserId: null },
        });
        return ok(outcome.count);
      }, "admin audit unlink");
    },
  };
}
