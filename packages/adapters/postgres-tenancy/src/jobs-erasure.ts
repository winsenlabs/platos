// `ApprovalsRepository`' erasure pair — the two methods that count and destroy
// one person's approvals.
//
// THEY ARE ONE MODULE BECAUSE THEY ARE ONE OPERATION AND THEY MUST NOT DRIFT.
// `jobs-erasure-target.ts` in the context counts to make a PLAN and then
// destroys to make a RECEIPT, and a plan that promised a number the erasure
// then missed would be an operator reading a receipt that is not true. The
// selector is built ONCE, here, and both statements are narrowed by the same
// expression — a change made to one of them is impossible to forget in the
// other because there is only one of them.
//
// A SUBJECT-LESS SELECTOR ERASES NOTHING AND COUNTS ZERO. `JobsErasureSelector`
// carries a tenant scope and a NULLABLE `principalId` — the target's own
// `selectorFor` answers `principalId: null` for an `entity` subject, because
// this context owns no entity-keyed row. A null subject would make the `WHERE` a
// tenant alone, which is every approval of every person in that organization, so
// it answers zero and destroys nothing. That is the fail-CLOSED direction and it
// is a named case in both directions.
//
// THE SUBJECT IS TWO PLACES, AND ONLY ONE OF THEM IS A COLUMN. `respondedBy` is
// the operator who DECIDED; the requester lives inside the `arguments` envelope
// at `__platosApproval.requestedBy`, because the canonical table has no column
// for it. Both halves are in one `OR`, so the two statements are one scan
// rather than two, and a person who only ever ASKED for approvals is erased as
// completely as one who only ever granted them.
//
// THE TENANT FILTER IS A RELATION, NOT AN `IN` LIST. An erasure is addressed at
// an organization, a project or an environment; every approval stores exactly
// one `environmentId`. `tenantWhere` resolves the containment through
// `Environment` and `Project` in the SAME statement, so a person's approvals
// across forty environments are counted by one count and destroyed by one
// delete — where a caller that read the tree first and passed an id list would
// have paid one statement per environment.
//
// NOTHING POINTS AT AN APPROVAL, so the delete is the whole erasure and its
// count is truthful. `jobs-erasure-target.ts` records the same decision from the
// other side: "Nothing holds a foreign key TO an approval, so the row can go
// outright", and no cascade contributes a row this count did not see.

import type {
  JobsErasureSelector,
  Result,
  TransactionScope,
} from "@platos/context-jobs/application/ports/index.js";
import { ok } from "@platos/context-jobs/application/ports/index.js";

import { refuseJobs } from "./jobs-refusal.js";
import { tenantWhere, APPROVAL_METADATA_MARKER } from "./jobs-rows.js";
import type { TenancyTransactions } from "./transaction.js";

export interface ApprovalsErasureStore {
  countErasable(selector: JobsErasureSelector): Promise<Result<number>>;
  erase(selector: JobsErasureSelector, transaction: TransactionScope): Promise<Result<number>>;
}

/**
 * The one `WHERE` both statements are narrowed by, or `null` when the selector
 * names no subject.
 */
function erasureWhere(selector: JobsErasureSelector): Record<string, unknown> | null {
  const principalId = selector.principalId;
  if (principalId === null) return null;
  return {
    ...tenantWhere(selector.scope),
    OR: [
      { respondedBy: principalId },
      { arguments: { path: [APPROVAL_METADATA_MARKER, "requestedBy"], equals: principalId } },
    ],
  };
}

export function createApprovalsErasureStore(
  transactions: TenancyTransactions,
): ApprovalsErasureStore {
  return {
    async countErasable(selector: JobsErasureSelector): Promise<Result<number>> {
      return refuseJobs(async () => {
        const where = erasureWhere(selector);
        if (where === null) return ok(0);
        return ok(await transactions.reader().agentApproval.count({ where }));
      }, "approvals countErasable");
    },

    async erase(
      selector: JobsErasureSelector,
      transaction: TransactionScope,
    ): Promise<Result<number>> {
      return refuseJobs(async () => {
        const where = erasureWhere(selector);
        // The zero answer is given WITHOUT resolving the writer, deliberately:
        // an erasure of nobody should not be the thing that reports a caller's
        // missing transaction, and the three transaction refusals stay reserved
        // for a write that was actually going to happen.
        if (where === null) return ok(0);
        const client = transactions.writer(transaction);
        const destroyed = await client.agentApproval.deleteMany({ where });
        return ok(destroyed.count);
      }, "approvals erase");
    },
  };
}
