// Use case: open an approval and suspend the turn until it is decided.
//
// This is the sentence ADR M0.3 §1 writes for this context: "A turn needing
// approval creates `AgentApproval` and parks on a `DurableRuntime` suspension."
//
// THE ROW IS WRITTEN BEFORE THE PARK, and the order is not arbitrary. A suspended
// run with no row behind it is parked on a decision no human can see, and it
// stays parked until its expiry — the worst available outcome. A row with no
// suspended run is a visible approval whose resumption fails loudly and can be
// retried. So the recoverable failure is the one this ordering
// chooses.
//
// DEDUPE IS BY DIGEST AND ONLY ON THE MCP PATH. Concurrent retries of the same
// tool call must collapse onto ONE approval, or a human sees the same question
// three times and answers it three times. A request with no digest is not a
// duplicate of anything and always mints a new row.

import {
  err,
  ok,
  type EnvironmentScope,
  type JobId as RuntimeJobId,
  type ResumeToken,
  type Result,
} from "@platos/kernel";

import {
  approvalSuspensionUnavailable,
  clampTimeoutSeconds,
  deadlineOf,
  hasElapsed,
  APPROVAL_TIMEOUT_DEFAULT_SECONDS,
  APPROVAL_TIMEOUT_FLOOR_SECONDS,
  MCP_APPROVAL_TIMEOUT_DEFAULT_SECONDS,
  MCP_APPROVAL_TIMEOUT_FLOOR_SECONDS,
  type Approval,
  type ApprovalRequest,
} from "../domain/index.js";
import type { JobsDependencies } from "./dependencies.js";
import { asApprovalRowId } from "./minting.js";

export interface RequestApprovalCommand {
  readonly scope: EnvironmentScope;
  readonly request: ApprovalRequest;
  /**
   * The durable run that should PARK on this decision.
   *
   * Null records the approval without parking anything — the live
   * `MonitoringApprovalsService.record()` path, which writes a row for a decision
   * some other mechanism is already waiting on. When set, the run is suspended
   * and the caller receives the token that resumes it.
   */
  readonly parkRunId?: RuntimeJobId | null;
}

export interface RequestApprovalResult {
  readonly approval: Approval;
  /** Null when the caller did not ask to park. */
  readonly resumeToken: ResumeToken | null;
  /** True when an identical pending approval already existed. */
  readonly deduplicated: boolean;
}

/**
 * Find a pending, not-yet-elapsed approval with the same digest.
 *
 * An ELAPSED pending row is deliberately NOT reused: the live
 * `findPendingByRequestHash` returns `null` for it (`record.expired ? null :
 * record`), because handing a caller an approval nobody can still decide would
 * park it on a decision that can only time out.
 */
async function findDuplicate(
  dependencies: JobsDependencies,
  command: RequestApprovalCommand,
): Promise<Result<Approval | null>> {
  const digest = command.request.requestDigest;
  if (digest === null) return ok(null);
  const found = await dependencies.approvals.findPendingByDigest(command.scope, digest);
  if (!found.ok) return err(found.error);
  if (found.value === null) return ok(null);
  return ok(hasElapsed(found.value, dependencies.clock.now()) ? null : found.value);
}

function newApproval(
  dependencies: JobsDependencies,
  request: ApprovalRequest,
  now: Date,
): Approval {
  return {
    rowId: asApprovalRowId(dependencies.ids.uuid()),
    approvalId: request.approvalId,
    source: request.source,
    agentId: request.agentId,
    threadId: request.threadId,
    turnId: request.turnId,
    action: request.action,
    details: request.details,
    toolName: request.toolName,
    arguments: request.arguments,
    requestedBy: request.requestedBy,
    requestDigest: request.requestDigest,
    requestedByTokenId: request.requestedByTokenId,
    status: "pending",
    timeoutSeconds: request.timeoutSeconds,
    createdAt: now,
    updatedAt: now,
    resolution: null,
    consumedAt: null,
    outcome: null,
  };
}

export async function requestApproval(
  dependencies: JobsDependencies,
  command: RequestApprovalCommand,
): Promise<Result<RequestApprovalResult>> {
  const duplicate = await findDuplicate(dependencies, command);
  if (!duplicate.ok) return err(duplicate.error);
  if (duplicate.value !== null) {
    return ok({ approval: duplicate.value, resumeToken: null, deduplicated: true });
  }

  const now = dependencies.clock.now();
  const approval = newApproval(dependencies, command.request, now);

  const inserted = await dependencies.unitOfWork.run((transaction) =>
    dependencies.approvals.insertApproval(command.scope, approval, transaction),
  );
  if (!inserted.ok) return err(inserted.error);

  const parked = await park(dependencies, command, inserted.value);
  if (!parked.ok) return err(parked.error);

  return ok({ approval: inserted.value, resumeToken: parked.value, deduplicated: false });
}

/**
 * Suspend the waiting run until the decision lands.
 *
 * THE SUSPENSION EXPIRES WITH THE APPROVAL. Giving the suspension a later expiry
 * than the approval's own deadline would leave a run parked on a question that
 * has already timed out; an earlier one would resume a run while a human is still
 * deciding. They are the same instant because they are the same deadline.
 *
 * A `suspend` failure is reported, not swallowed. The row is already written, so
 * the approval is visible and the caller can retry the park — which is exactly
 * the recoverable half this use case's ordering was chosen to produce.
 */
async function park(
  dependencies: JobsDependencies,
  command: RequestApprovalCommand,
  approval: Approval,
): Promise<Result<ResumeToken | null>> {
  const runId = command.parkRunId ?? null;
  if (runId === null) return ok(null);
  try {
    const suspension = await dependencies.durableRuntime.suspend(runId, deadlineOf(approval));
    return ok(suspension.resumeToken);
  } catch (cause) {
    return err(approvalSuspensionUnavailable(cause instanceof Error ? cause.message : "suspend failed"));
  }
}

/**
 * Clamp a caller's requested timeout for a GENERIC approval.
 *
 * Exposed as a named function so a transport does not re-derive it and pick up
 * the MCP path's different floor and default by mistake — the two differ and the
 * difference is easy to miss.
 */
export function genericApprovalTimeout(requested: number | null | undefined): number {
  return clampTimeoutSeconds(requested, APPROVAL_TIMEOUT_FLOOR_SECONDS, APPROVAL_TIMEOUT_DEFAULT_SECONDS);
}

/** Clamp for the MCP tool-call path: a higher floor and a much longer default. */
export function mcpApprovalTimeout(requested: number | null | undefined): number {
  return clampTimeoutSeconds(
    requested,
    MCP_APPROVAL_TIMEOUT_FLOOR_SECONDS,
    MCP_APPROVAL_TIMEOUT_DEFAULT_SECONDS,
  );
}
