// Use case: record a human decision and resume the run waiting on it.
//
// THE CONDITIONAL WRITE IS THE RACE DEFENCE. Two dashboards clicking Approve at
// the same instant both read a pending row and both build a valid resolution; the
// repository's guarded update lets exactly one land, and the loser is told
// `JOBS_APPROVAL_ALREADY_RESOLVED`. The live code returns `false` for that case
// and for a store failure alike, so a caller cannot tell "someone else decided"
// from "the write did not happen" — this use case can.
//
// THE ROW IS WRITTEN BEFORE THE RESUME, mirroring `request-approval.ts`. Resuming
// first would let a run continue on a decision that then failed to persist: the
// work happens and no record of who authorised it survives. Writing first means a
// resume failure leaves a recorded decision and a parked run, which is visible
// and retryable.
//
// AN ELAPSED APPROVAL CANNOT BE DECIDED. Checked against `hasElapsed` (the `>=`
// read-path predicate), because this is a read deciding whether a decision still
// matters. See `domain/approval.ts` for why the sweep uses a different one.

import { err, ok, type EnvironmentScope, type JsonValue, type Result } from "@platos/kernel";

import {
  approvalElapsed,
  approvalNotFound,
  approvalAlreadyResolved,
  approvalSuspensionUnavailable,
  deadlineOf,
  effectiveArguments,
  hasElapsed,
  requireEdit,
  resolveApproval as decide,
  type Approval,
  type ApprovalDecision,
  type ApprovalEdit,
  type ApprovalId,
} from "../domain/index.js";
import type { ResumeToken } from "@platos/kernel";
import type { JobsDependencies } from "./dependencies.js";

export interface ResolveApprovalCommand {
  readonly scope: EnvironmentScope;
  readonly approvalId: ApprovalId;
  readonly decision: ApprovalDecision;
  readonly respondedBy?: string | null;
  readonly comment?: string | null;
  /** Edits a human made while approving. Ignored for any other decision. */
  readonly edit?: ApprovalEdit | null;
  /** The resume token minted when the run parked, if one did. */
  readonly resumeToken?: ResumeToken | null;
}

export interface ResolveApprovalResult {
  readonly approval: Approval;
  /**
   * The arguments the caller should proceed with: the human's edits when there
   * were any, otherwise the originals. Null for a rejection.
   */
  readonly effectiveArguments: JsonValue | null;
  /**
   * What the durable runtime said. `null` when nothing was parked. `resumed` is
   * the only outcome that continued a run — the other two are reported so a
   * caller can tell a double-resolve from a lost suspension.
   */
  readonly resume: "resumed" | "already-resolved" | "expired" | null;
}

export async function resolveApprovalDecision(
  dependencies: JobsDependencies,
  command: ResolveApprovalCommand,
): Promise<Result<ResolveApprovalResult>> {
  const found = await dependencies.approvals.findByApprovalId(command.scope, command.approvalId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(approvalNotFound(command.approvalId));

  const approval = found.value;
  const now = dependencies.clock.now();
  if (hasElapsed(approval, now)) {
    return err(
      approvalElapsed(approval.approvalId, deadlineOf(approval).toISOString(), now.toISOString()),
    );
  }

  const edit = requireEdit(command.decision, command.edit ?? null);
  if (!edit.ok) return err(edit.error);

  const decided = decide(approval, command.decision, now, {
    respondedBy: command.respondedBy ?? null,
    comment: command.comment ?? null,
    edit: edit.value,
  });
  if (!decided.ok) return err(decided.error);

  const written = await dependencies.unitOfWork.run((transaction) =>
    dependencies.approvals.resolve(command.scope, decided.value, transaction),
  );
  if (!written.ok) return err(written.error);
  if (!written.value) {
    // The guarded update matched nothing: someone else decided between our read
    // and our write. Their decision stands.
    return err(approvalAlreadyResolved(approval.approvalId, "pending"));
  }

  const resume = await resumeParked(dependencies, command);
  if (!resume.ok) return err(resume.error);

  return ok({
    approval: decided.value,
    effectiveArguments: command.decision === "approved" ? effectiveArguments(decided.value) : null,
    resume: resume.value,
  });
}

/**
 * Resume the parked run, carrying the decision as the suspension's value.
 *
 * The kernel's `resume` is idempotent BY REPORT, not by silence: it distinguishes
 * `resumed` from `already-resolved` and `expired` so a double-click cannot resume
 * a run twice unnoticed. All three are passed through rather than collapsed.
 */
async function resumeParked(
  dependencies: JobsDependencies,
  command: ResolveApprovalCommand,
): Promise<Result<"resumed" | "already-resolved" | "expired" | null>> {
  const token = command.resumeToken ?? null;
  if (token === null) return ok(null);
  try {
    return ok(await dependencies.durableRuntime.resume(token, { decision: command.decision }));
  } catch (cause) {
    return err(approvalSuspensionUnavailable(cause instanceof Error ? cause.message : "resume failed"));
  }
}
