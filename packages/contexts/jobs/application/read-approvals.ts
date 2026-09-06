// Use cases: read approvals, and record that an approved call was carried out.
//
// PAGINATION IS CLAMPED HERE, NOT AT THE TRANSPORT. The live service clamps
// `limit` to [1, 200] and `offset` to >= 0 before it builds a query. Leaving that
// to a caller means an unclamped one can ask for every row in the environment,
// and the clamp is a property of what this context will serve rather than of any
// one transport.
//
// `markConsumed` IS NOT A RESOLUTION. It records that an already-approved call
// actually happened, which is a different fact from the human's decision and is
// written after the work, not before it. Conflating the two would make an
// approval that was granted but never acted on indistinguishable from one that
// was carried out.

import { err, ok, runResult, type EnvironmentScope, type JsonValue, type Result } from "@platos/kernel";

import { approvalNotFound, type ApprovalId } from "../domain/index.js";
import type { JobsDependencies } from "./dependencies.js";
import type { ApprovalQuery } from "./ports/index.js";
import { toApprovalView, type ApprovalView } from "./views.js";

/** The live clamp: a page is between 1 and 200 rows, defaulting to 50. */
export const APPROVAL_PAGE_LIMITS = Object.freeze({ min: 1, max: 200, fallback: 50 });

/** The live default window for a listing: the last 30 days. */
export const APPROVAL_DEFAULT_SINCE_DAYS = 30;

export function clampLimit(requested: number | null | undefined): number {
  return Math.min(Math.max(requested ?? APPROVAL_PAGE_LIMITS.fallback, APPROVAL_PAGE_LIMITS.min), APPROVAL_PAGE_LIMITS.max);
}

export function clampOffset(requested: number | null | undefined): number {
  return Math.max(requested ?? 0, 0);
}

export interface ApprovalPageView {
  readonly rows: readonly ApprovalView[];
  readonly total: number;
  readonly pendingCount: number;
  readonly limit: number;
  readonly offset: number;
}

export async function listApprovals(
  dependencies: JobsDependencies,
  scope: EnvironmentScope,
  query: ApprovalQuery = {},
): Promise<Result<ApprovalPageView>> {
  const limit = clampLimit(query.limit);
  const offset = clampOffset(query.offset);
  const page = await dependencies.approvals.list(scope, {
    ...query,
    limit,
    offset,
    sinceDays: query.sinceDays ?? APPROVAL_DEFAULT_SINCE_DAYS,
  });
  if (!page.ok) return err(page.error);

  const now = dependencies.clock.now();
  return ok({
    rows: page.value.rows.map((approval) => toApprovalView(approval, now)),
    total: page.value.total,
    pendingCount: page.value.pendingCount,
    limit,
    offset,
  });
}

export async function describeApproval(
  dependencies: JobsDependencies,
  scope: EnvironmentScope,
  approvalId: ApprovalId,
): Promise<Result<ApprovalView>> {
  const found = await dependencies.approvals.findByApprovalId(scope, approvalId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(approvalNotFound(approvalId));
  return ok(toApprovalView(found.value, dependencies.clock.now()));
}

export interface MarkConsumedCommand {
  readonly scope: EnvironmentScope;
  readonly approvalId: ApprovalId;
  readonly outcome: JsonValue | null;
}

export async function markApprovalConsumed(
  dependencies: JobsDependencies,
  command: MarkConsumedCommand,
): Promise<Result<boolean>> {
  const found = await dependencies.approvals.findByApprovalId(command.scope, command.approvalId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(approvalNotFound(command.approvalId));

  return runResult(dependencies.unitOfWork, (transaction) =>
    dependencies.approvals.markConsumed(
      command.scope,
      command.approvalId,
      command.outcome,
      dependencies.clock.now(),
      transaction,
    ),
  );
}
