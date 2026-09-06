// The erasure half of `NotificationRuleRepository`: count a subject's rules, and
// scrub the one column that names them.
//
// ANONYMISE, NOT DELETE, AND THE CONTEXT ARGUES IT AT LENGTH.
// `eventing-erasure-target.ts` records why: `NotificationRule` has exactly one
// column that could name a person, `createdBy`, and it is an OPERATOR principal
// rather than the subject the rule is about — so deleting the row would "silently
// disable an environment's alerting because an administrator exercised a data
// right". This file is that decision in statements: one UPDATE of one column,
// and no DELETE anywhere.
//
// *** THE ANONYMISATION IS RAW SQL, AND `@updatedAt` IS WHY ***
// `NotificationRule.updatedAt` carries `@updatedAt`, so the generated client
// stamps it on EVERY `updateMany` unless a value is supplied — and there is no
// value to supply here, because the correct one differs per row and is the one
// already stored. Three arguments say the column must not move:
//
//   THE DOMAIN OWNS IT. `editNotificationRule(rule, edit, now)` computes
//   `updatedAt` from the context's `Clock`, and `updateRule` writes exactly that
//   value. A store that let the client stamp this column on the erasure path
//   would be deciding a domain value on one path and honouring it on another.
//
//   IT WOULD NOT BE TRUE. `updatedAt` is when the standing ORDER last changed —
//   its patterns, its destination, whether it is on. Scrubbing the author
//   changes none of those.
//
//   AND THE DOUBLE DOES NOT MOVE IT. `InMemoryNotificationRuleRepository`
//   rewrites `createdBy` and keeps the rest of the record, so a client-stamped
//   column would be a difference the conformance scenario compares verbatim and
//   would have to normalise away — which is the normalisation that hides a real
//   difference.
//
// There is no delegate form of "update this column and leave that one alone" for
// a `@updatedAt` field, so the statement is written out. It is the same
// arrangement `skills-erasure.ts` and `memory-vectors.ts` are in, for the same
// reason: `MUTATING_SQL_STATEMENT` attributes a raw statement to the TABLE it
// names, `NotificationRule` is `eventing`'s row, and this directory is
// `eventing`'s canonical-store delegate.
//
// ONE STATEMENT AT EVERY LEVEL. An erasure may be addressed at an organization,
// a project or an environment, and this table stores one `environmentId`. The
// containment is a JOIN through `Environment` and `Project` with the two narrower
// ids bound as NULL when the level does not name them, so the statement text is
// the same for all three and the count does not grow with the tree. Reading the
// environments a scope reaches and then updating them by `IN` list would have
// been the N+1 this shape is easy to write by accident.
//
// THE COUNT AND THE UPDATE MUST AGREE, AND THEY ARE WRITTEN TWICE. `count` goes
// through the delegate with `tenantWhere`, the scrub goes through the join
// above; two spellings of one containment rule can drift, so
// `eventing-conformance.ts` asserts at every level that the number planned is
// the number erased.

import type {
  EventingErasureSelector,
  Result,
  TransactionScope,
} from "@platos/context-eventing/application/ports/index.js";
import { ok } from "@platos/context-eventing/application/ports/index.js";

import { guardReplacementPrincipal, guardScope } from "./eventing-guards.js";
import { refuse } from "./eventing-refusal.js";
import { tenantWhere } from "./eventing-rows.js";
import type { TenancyTransactions } from "./transaction.js";

/** The project a selector narrows to, or null when it reaches wider. */
function selectedProject(selector: EventingErasureSelector): string | null {
  return selector.scope.level === "organization" ? null : selector.scope.projectId;
}

/** The environment a selector narrows to, or null when it reaches wider. */
function selectedEnvironment(selector: EventingErasureSelector): string | null {
  return selector.scope.level === "environment" ? selector.scope.environmentId : null;
}

export function createEventingErasure(transactions: TenancyTransactions) {
  return {
    async countRulesForSubject(selector: EventingErasureSelector): Promise<Result<number>> {
      return refuse(async () => {
        // A subject with no principal selects nothing, and the port's own
        // comment says so: `createdBy` is an operator, so an `end-user` or an
        // `entity` produces a vacuous plan. Answering zero WITHOUT a statement
        // is what makes that vacuity free rather than a round trip per subject.
        if (selector.principalId === null) return ok(0);
        guardScope(selector.scope);
        const total = await transactions.reader().notificationRule.count({
          where: { ...tenantWhere(selector.scope), createdBy: selector.principalId },
        });
        return ok(total);
      }, "countRulesForSubject");
    },

    async anonymizeRulesForSubject(
      selector: EventingErasureSelector,
      replacement: string,
      transaction: TransactionScope,
    ): Promise<Result<number>> {
      return refuse(async () => {
        if (selector.principalId === null) return ok(0);
        guardScope(selector.scope);
        guardReplacementPrincipal(replacement);
        const organizationId = selector.scope.organizationId;
        const projectId = selectedProject(selector);
        const environmentId = selectedEnvironment(selector);
        const count = await transactions.writer(transaction).$executeRaw`
          UPDATE "NotificationRule" AS r
             SET "createdBy" = ${replacement}
            FROM "Environment" AS e
            JOIN "Project" AS p ON p."id" = e."projectId"
           WHERE r."environmentId" = e."id"
             AND p."organizationId" = ${organizationId}::uuid
             AND (${projectId}::uuid IS NULL OR e."projectId" = ${projectId}::uuid)
             AND (${environmentId}::uuid IS NULL OR r."environmentId" = ${environmentId}::uuid)
             AND r."createdBy" = ${selector.principalId}
        `;
        return ok(count);
      }, "anonymizeRulesForSubject");
    },
  };
}
