// The `AgentApproval` aggregate — a human decision a turn is waiting on.
//
// ADR M0.3 §1 (context 15): "A turn needing approval creates `AgentApproval` and
// parks on a `DurableRuntime` suspension." This module owns the row and the rules
// over it; the parking is `application/request-approval.ts`.
//
// -------------------------------------------------------------------------
// TWO EXPIRY PREDICATES, PRESERVED RATHER THAN UNIFIED
// -------------------------------------------------------------------------
// The live system asks "has this elapsed?" in two places and asks it slightly
// differently:
//
//   the read path   `expired = isPending && now >= deadlineMs`          (>=)
//     (`toRecord`)
//   the sweep       `now - createdAt > timeoutSeconds * 1000`           (>)
//     (`sweepExpired`)
//
// At the single instant `now === deadline` they disagree: the dashboard renders
// the approval as expired while the sweep leaves it `PENDING`. One millisecond
// later they agree again.
//
// This extraction PRESERVES the divergence and gives the two predicates different
// names, because collapsing them would be a behaviour change smuggled into a
// refactor — and because the safer of the two is not obviously the right one to
// keep. `hasElapsed` (>=) is the conservative answer for a reader deciding
// whether a decision still matters; `isSweepable` (>) is the conservative answer
// for a writer deciding whether to flip a row someone may be resolving right now.
// Choosing one is a product decision, and it is reported, not taken here.
// -------------------------------------------------------------------------

import { err, ok, type JsonValue, type Result } from "@platos/kernel";

import { approvalAlreadyResolved, approvalEditMissing } from "./errors.js";
import type { AgentId, ApprovalId, ApprovalRowId, ThreadId, TurnId } from "./identifiers.js";
import {
  isDecision,
  type ApprovalDecision,
  type ApprovalSource,
  type ApprovalStatus,
} from "./approval-status.js";

/** The live default and floor for a generic approval request. */
export const APPROVAL_TIMEOUT_DEFAULT_SECONDS = 300;
export const APPROVAL_TIMEOUT_FLOOR_SECONDS = 1;

/**
 * The MCP tool-call path uses a different default AND a different floor: an hour
 * to decide, and never less than a minute. A human approving a tool call is at a
 * dashboard; a minute is the smallest window in which that is possible at all.
 */
export const MCP_APPROVAL_TIMEOUT_DEFAULT_SECONDS = 3600;
export const MCP_APPROVAL_TIMEOUT_FLOOR_SECONDS = 60;

/**
 * Clamp a requested timeout. Rounds first, then applies the floor — the live
 * order, and it matters: `Math.max(60, Math.round(0.4))` is 60, whereas rounding
 * after clamping would yield the same here but diverge for a floor that is not an
 * integer. There is no ceiling in the live system and none is invented.
 */
export function clampTimeoutSeconds(requested: number | null | undefined, floor: number, fallback: number): number {
  return Math.max(floor, Math.round(requested ?? fallback));
}

/** Edits a human made to the proposed arguments while approving. */
export interface ApprovalEdit {
  readonly editedArguments: JsonValue;
  readonly editedBy: string | null;
}

export interface ApprovalResolution {
  readonly status: ApprovalDecision;
  readonly respondedBy: string | null;
  readonly comment: string | null;
  readonly resolvedAt: Date;
  /** Present only for an `approved` decision that carried edits. */
  readonly edit: ApprovalEdit | null;
}

export interface Approval {
  readonly rowId: ApprovalRowId;
  readonly approvalId: ApprovalId;
  readonly source: ApprovalSource;
  readonly agentId: AgentId | null;
  readonly threadId: ThreadId | null;
  readonly turnId: TurnId | null;
  readonly action: string;
  readonly details: string | null;
  readonly toolName: string | null;
  /** The proposed arguments, as stored under `arguments.value`. */
  readonly arguments: JsonValue | null;
  readonly requestedBy: string | null;
  /** Set only on the MCP path; what makes a concurrent retry dedupe. */
  readonly requestDigest: string | null;
  readonly requestedByTokenId: string | null;
  readonly status: ApprovalStatus;
  readonly timeoutSeconds: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly resolution: ApprovalResolution | null;
  /** Set when an approved MCP call has actually been carried out. */
  readonly consumedAt: Date | null;
  /** The terminal outcome recorded against the row, if any. */
  readonly outcome: JsonValue | null;
}

export function isPending(approval: Approval): boolean {
  return approval.status === "pending";
}

/** `createdAt + timeoutSeconds`. The instant a decision stops being possible. */
export function deadlineOf(approval: Approval): Date {
  return new Date(approval.createdAt.getTime() + approval.timeoutSeconds * 1000);
}

/**
 * The READ-PATH predicate (`>=`). True when a pending approval is at or past its
 * deadline. See the header for why this is not the same question as `isSweepable`.
 */
export function hasElapsed(approval: Approval, now: Date): boolean {
  return isPending(approval) && now.getTime() >= deadlineOf(approval).getTime();
}

/**
 * The SWEEP predicate (`>`). True when a pending approval is STRICTLY past its
 * deadline and may be flipped to `timed_out`.
 */
export function isSweepable(approval: Approval, now: Date): boolean {
  return isPending(approval) && now.getTime() > deadlineOf(approval).getTime();
}

/**
 * Whole seconds left to decide, or null once there are none to count — pending
 * and not yet elapsed is the only state in which the number means anything.
 */
export function secondsRemaining(approval: Approval, now: Date): number | null {
  if (!isPending(approval) || hasElapsed(approval, now)) return null;
  return Math.max(0, Math.floor((deadlineOf(approval).getTime() - now.getTime()) / 1000));
}

/**
 * Record a human decision.
 *
 * REFUSES A SECOND DECISION. The live `resolve()` guards with
 * `updateMany({ where: { status: "PENDING" } })` and reports `count === 1`, so a
 * double-click resolves once. That guard is a WRITE-time race defence and stays
 * in the repository port; this is the same rule stated where it can be read.
 *
 * EDITS SURVIVE ONLY AN APPROVAL. `persistEdits` in the live service is
 * `status === "approved" && editedArgs != null`; a rejection carrying edits
 * stores none. Edits are a modification to work that is about to happen, and no
 * work happens after a rejection.
 */
export function resolveApproval(
  approval: Approval,
  decision: ApprovalDecision,
  at: Date,
  options: {
    readonly respondedBy?: string | null;
    readonly comment?: string | null;
    readonly edit?: ApprovalEdit | null;
  } = {},
): Result<Approval> {
  if (!isPending(approval)) {
    return err(approvalAlreadyResolved(approval.approvalId, approval.status));
  }
  const edit = decision === "approved" ? (options.edit ?? null) : null;
  return ok({
    ...approval,
    status: decision,
    updatedAt: at,
    resolution: {
      status: decision,
      respondedBy: options.respondedBy ?? null,
      comment: options.comment ?? null,
      resolvedAt: at,
      edit,
    },
  });
}

/**
 * The arguments a caller should proceed with after an approval.
 *
 * Edited arguments replace the originals; this is the live
 * `params: editedArgs ?? original`. A caller that ignored the return value and
 * used its own copy would execute what the human declined to approve.
 */
export function effectiveArguments(approval: Approval): JsonValue | null {
  const edit = approval.resolution?.edit;
  return edit ? edit.editedArguments : approval.arguments;
}

/**
 * The live `ApprovalEditMissingError`, as a rule. An "approved with edits"
 * decision that carries no edits is a caller mistake, not an approval.
 */
export function requireEdit(decision: ApprovalDecision, edit: ApprovalEdit | null): Result<ApprovalEdit | null> {
  if (decision === "approved" && edit !== null && edit.editedArguments === null) {
    return err(approvalEditMissing());
  }
  return ok(edit);
}

/** Time out a pending approval. The sweep's only transition. */
export function timeOutApproval(approval: Approval, at: Date): Result<Approval> {
  return resolveApproval(approval, "timed_out", at);
}

export function isResolved(approval: Approval): boolean {
  return isDecision(approval.status);
}
