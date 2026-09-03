// The composition of this context's use cases into its published contract.
//
// Thin on purpose. Every rule lives in `domain/`, every orchestration in a named
// use-case module, and this file is the adapter between the command shapes the
// contract publishes and the ones the use cases take. It holds no rule of its
// own, which is what keeps it from becoming the god-service ADR M0.3 §6 exists
// to prevent.

import { asIdentifier, err, ok, type EnvironmentScope, type ErasureTarget, type Result } from "@platos/kernel";

import type {
  ApprovalRequestedView,
  ApprovalResolvedView,
  JobExecutionView,
  JobsContract,
  ListApprovals,
  MarkApprovalConsumed,
  RegisterJob,
  RegisteredJobView,
  RequestApprovalCommandView,
  RequestJobExecution,
  ResolveApproval,
} from "../contracts/index.js";
import {
  admitExecutionRequest,
  computeApprovalDigest,
  invalidRequest,
  mcpActionLabel,
  type AgentId,
  type ApprovalRequest,
  type ThreadId,
  type TurnId,
} from "../domain/index.js";
import type { JobsDependencies } from "./dependencies.js";
import { executeJob } from "./execute-job.js";
import { createJobsErasureTarget } from "./jobs-erasure-target.js";
import { describeApproval, listApprovals, markApprovalConsumed } from "./read-approvals.js";
import { describeJob, describeJobByKey, listJobs, readJobSource } from "./read-jobs.js";
import { registerJob } from "./register-job.js";
import { mcpApprovalTimeout, requestApproval } from "./request-approval.js";
import { resolveApprovalDecision } from "./resolve-approval.js";
import { sweepAllScopes, sweepExpiredApprovals } from "./sweep-expired-approvals.js";
import { toApprovalView, toJobView } from "./views.js";

async function register(
  dependencies: JobsDependencies,
  request: RegisterJob,
): Promise<Result<RegisteredJobView>> {
  const registered = await registerJob(dependencies, {
    scope: request.scope,
    createdBy: request.createdBy,
    draft: {
      jobKey: request.jobKey,
      displayName: request.displayName,
      handler: request.handler,
      description: request.description ?? null,
      invocationType: request.invocationType ?? null,
      scheduleCron: request.scheduleCron ?? null,
      scheduleTimezone: request.scheduleTimezone ?? null,
      allowedAgentIds: request.allowedAgentIds ?? null,
      payloadSchema: request.payloadSchema ?? null,
      timeoutSeconds: request.timeoutSeconds ?? null,
      maxRetries: request.maxRetries ?? null,
    },
  });
  if (!registered.ok) return err(registered.error);
  return ok({ job: toJobView(registered.value.job), syntaxError: registered.value.syntaxError });
}

async function execute(
  dependencies: JobsDependencies,
  request: RequestJobExecution,
): Promise<Result<JobExecutionView>> {
  const admitted = admitExecutionRequest(request.body, dependencies.knownSecrets);
  if (!admitted.ok) return err(admitted.error);
  return executeJob(dependencies, { scope: request.scope, request: admitted.value });
}

/**
 * The label a human reads in the approval queue.
 *
 * A caller that says what is being approved is taken at its word. A caller that
 * says nothing is on the MCP tool-call path, which in the live system does not
 * compose the string itself — the server writes `` `MCP tool call: ${toolName}` ``
 * — so the default comes from the ONE definition of it, `mcpActionLabel`, rather
 * than being re-spelled here. Neither an action nor a tool name is refused: an
 * approval whose action is blank is a question no human can answer, and
 * defaulting it to something plausible would put that unanswerable question in
 * front of one.
 */
function approvalActionFor(request: RequestApprovalCommandView): Result<string> {
  const supplied = (request.action ?? "").trim();
  if (supplied !== "") return ok(supplied);
  const toolName = request.deduplicateOn?.toolName ?? request.toolName ?? null;
  if (toolName === null || toolName.trim() === "") {
    return err(
      invalidRequest("an approval needs an action, or a tool name to derive the MCP label from", [
        { field: "action", code: "REQUIRED", message: "action or toolName must be supplied" },
      ]),
    );
  }
  return ok(mcpActionLabel(toolName));
}

/**
 * Build the domain request, computing the dedupe digest only when the caller
 * asked for one. The digest subject is a wire format (`approval-request.ts`), so
 * it is built by the domain rather than assembled here.
 */
function approvalRequestFrom(
  dependencies: JobsDependencies,
  request: RequestApprovalCommandView,
  action: string,
): ApprovalRequest {
  const dedupe = request.deduplicateOn ?? null;
  return {
    approvalId: request.approvalId,
    source: request.source,
    action,
    details: request.details ?? null,
    agentId: request.agentId === undefined || request.agentId === null ? null : asIdentifier<AgentId>(request.agentId),
    threadId:
      request.threadId === undefined || request.threadId === null ? null : asIdentifier<ThreadId>(request.threadId),
    turnId: request.turnId === undefined || request.turnId === null ? null : asIdentifier<TurnId>(request.turnId),
    toolName: request.toolName ?? null,
    arguments: request.arguments ?? null,
    requestedBy: request.requestedBy ?? null,
    requestedByTokenId: request.requestedByTokenId ?? null,
    requestDigest:
      dedupe === null
        ? null
        : computeApprovalDigest(
            dependencies.digest,
            {
              organizationId: request.scope.organizationId,
              projectId: request.scope.projectId,
              environmentId: request.scope.environmentId,
            },
            dedupe.toolName,
            dedupe.arguments,
          ),
    timeoutSeconds: mcpApprovalTimeout(request.timeoutSeconds),
  };
}

async function openApproval(
  dependencies: JobsDependencies,
  request: RequestApprovalCommandView,
): Promise<Result<ApprovalRequestedView>> {
  const action = approvalActionFor(request);
  if (!action.ok) return err(action.error);
  const opened = await requestApproval(dependencies, {
    scope: request.scope,
    request: approvalRequestFrom(dependencies, request, action.value),
    parkRunId: request.parkRunId ?? null,
  });
  if (!opened.ok) return err(opened.error);
  return ok({
    approval: toApprovalView(opened.value.approval, dependencies.clock.now()),
    resumeToken: opened.value.resumeToken,
    deduplicated: opened.value.deduplicated,
  });
}

async function resolve(
  dependencies: JobsDependencies,
  request: ResolveApproval,
): Promise<Result<ApprovalResolvedView>> {
  const resolved = await resolveApprovalDecision(dependencies, {
    scope: request.scope,
    approvalId: request.approvalId,
    decision: request.decision,
    respondedBy: request.respondedBy ?? null,
    comment: request.comment ?? null,
    edit:
      request.editedArguments === undefined || request.editedArguments === null
        ? null
        : { editedArguments: request.editedArguments, editedBy: request.editedBy ?? request.respondedBy ?? null },
    resumeToken: request.resumeToken ?? null,
  });
  if (!resolved.ok) return err(resolved.error);
  return ok({
    approval: toApprovalView(resolved.value.approval, dependencies.clock.now()),
    effectiveArguments: resolved.value.effectiveArguments,
    resume: resolved.value.resume,
  });
}

export function createJobsContract(dependencies: JobsDependencies): JobsContract {
  return {
    name: "jobs",
    registerJob: (request) => register(dependencies, request),
    execute: (request) => execute(dependencies, request),
    describeJob: (request) => describeJob(dependencies, request),
    describeJobByKey: (request) => describeJobByKey(dependencies, request),
    readJobSource: (request) => readJobSource(dependencies, request),
    listJobs: (scope: EnvironmentScope) => listJobs(dependencies, scope),
    requestApproval: (request) => openApproval(dependencies, request),
    resolveApproval: (request) => resolve(dependencies, request),
    describeApproval: (scope, approvalId) => describeApproval(dependencies, scope, approvalId),
    listApprovals: (request: ListApprovals) =>
      listApprovals(dependencies, request.scope, {
        threadId: request.threadId ?? null,
        agentId: request.agentId ?? null,
        status: request.status ?? null,
        source: request.source ?? null,
        sinceDays: request.sinceDays ?? null,
        limit: request.limit ?? null,
        offset: request.offset ?? null,
        search: request.search ?? null,
      }),
    markApprovalConsumed: (request: MarkApprovalConsumed) =>
      markApprovalConsumed(dependencies, {
        scope: request.scope,
        approvalId: request.approvalId,
        outcome: request.outcome ?? null,
      }),
    sweepApprovals: (scope: EnvironmentScope) => sweepExpiredApprovals(dependencies, scope),
    sweepAllApprovals: () => sweepAllScopes(dependencies),
    erasureTarget: (): ErasureTarget => createJobsErasureTarget(dependencies),
  };
}
