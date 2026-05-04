import { task, wait, metadata, logger } from "@platos/sdk/v3";

/**
 * PPR-51 — Durable HITL approval waitpoint.
 *
 * Fired from the agent runtime's `request_durable_approval` meta-tool
 * when the LLM needs a human go/no-go on a destructive action AND wants
 * the waitpoint to survive a process restart (the default
 * `request_approval` uses Redis BLPOP, which is lost if the agent dies
 * mid-turn).
 *
 * Flow:
 *   1. Agent mints a token (via `wait.createToken`) bound to the scope
 *      and the approval row (persisted by MonitoringApprovalsService).
 *   2. Agent fires this task with `{ token, timeoutSeconds, scope, ... }`.
 *   3. Task calls `wait.forToken(token, { timeoutInSeconds })`. Zero
 *      compute while the waitpoint is open.
 *   4. UI hits `POST /api/v1/agent/durable-approvals/:token/resolve` —
 *      the controller calls `completeWaitToken` which wakes this task.
 *   5. Task returns `{ approved, comment, respondedBy }`.
 *
 * On timeout the task returns `{ approved: false, reason: "timeout" }`.
 */
export interface AgentDurableApprovalPayload {
  token: string;
  approvalId: string;
  action: string;
  details?: string;
  timeoutSeconds?: number;
  scope: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    userId: string;
    agentId?: string;
    threadId?: string;
  };
}

export interface AgentDurableApprovalOutput {
  approved: boolean;
  reason?: "timeout" | "rejected";
  comment?: string | null;
  respondedBy?: string | null;
  approvalId: string;
}

export const agentDurableApprovalWait = task({
  id: "platos-agent-durable-approval-wait",
  description: "Durable HITL approval waitpoint — pauses until the user resolves the token or the timeout fires.",
  queue: { concurrencyLimit: 50 },
  // maxDuration mirrors the default timeout (1 day) so we don't starve the
  // queue with forever-pending waits. The inner `wait.forToken` provides
  // the actual finer-grained timeout.
  maxDuration: 86400 + 60,
  retry: { maxAttempts: 1 },
  run: async (payload: AgentDurableApprovalPayload): Promise<AgentDurableApprovalOutput> => {
    const timeoutInSeconds = Math.max(1, payload.timeoutSeconds ?? 86400);
    metadata.set("approvalId", payload.approvalId);
    metadata.set("action", payload.action);
    metadata.set("organizationId", payload.scope.organizationId);
    metadata.set("projectId", payload.scope.projectId);
    metadata.set("environmentId", payload.scope.environmentId);
    metadata.set("timeoutSeconds", timeoutInSeconds);
    metadata.set("status", "waiting");

    logger.info("durable approval wait started", {
      approvalId: payload.approvalId,
      token: payload.token,
      timeoutInSeconds,
    });

    // `wait.forToken` pauses this task with zero compute until the UI
    // calls `wait.completeToken(token, data)` — that happens from the
    // controller's `/durable-approvals/:token/resolve` endpoint.
    const result = await wait.forToken<{
      approved: boolean;
      comment?: string | null;
      respondedBy?: string | null;
    }>(payload.token);

    if (!result.ok) {
      metadata.set("status", "timed_out");
      return {
        approved: false,
        reason: "timeout",
        approvalId: payload.approvalId,
      };
    }
    const data = result.output;
    metadata.set("status", data.approved ? "approved" : "rejected");
    return {
      approved: !!data.approved,
      ...(data.approved ? {} : { reason: "rejected" as const }),
      comment: data.comment ?? null,
      respondedBy: data.respondedBy ?? null,
      approvalId: payload.approvalId,
    };
  },
});
