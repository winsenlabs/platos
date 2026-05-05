/**
 * @platosdev/client — approvals API (human-in-the-loop).
 *
 * Scope-gated list + resolve endpoints backing the HITL approval
 * waitpoint that agents open via `request_approval` / `cancel_run`.
 * EOBD.85.
 */

import type { PlatosClient } from "../client.js";
import type { PlatosScope } from "../types.js";

export interface PlatosApproval {
  id: string;
  scope: {
    organizationId: string;
    projectId: string;
    environmentId: string;
  };
  agentId: string;
  threadId: string;
  runId?: string | null;
  question: string;
  context?: unknown;
  status: "pending" | "approved" | "rejected" | "timed_out";
  createdAt: string;
  resolvedAt?: string | null;
  timeoutAt?: string | null;
  resolution?: {
    response: "approve" | "reject";
    reason?: string;
    resolvedByUserId?: string;
  } | null;
}

export interface ListApprovalsOptions {
  status?: PlatosApproval["status"];
  agentId?: string;
  threadId?: string;
  limit?: number;
}

export class ApprovalsApi {
  constructor(private readonly client: PlatosClient) {}

  async list(
    options: ListApprovalsOptions = {},
    scope?: PlatosScope,
  ): Promise<PlatosApproval[]> {
    const qs = new URLSearchParams();
    if (options.status) qs.set("status", options.status);
    if (options.agentId) qs.set("agentId", options.agentId);
    if (options.threadId) qs.set("threadId", options.threadId);
    if (options.limit) qs.set("limit", String(options.limit));
    const tail = qs.toString() ? `?${qs}` : "";
    const res = await this.client._fetch<{ approvals: PlatosApproval[] }>(
      `/api/v1/agent/monitoring/approvals${tail}`,
      { method: "GET" },
      scope,
    );
    return res?.approvals ?? [];
  }

  async get(approvalId: string, scope?: PlatosScope): Promise<PlatosApproval | null> {
    return this.client._fetch<PlatosApproval>(
      `/api/v1/agent/monitoring/approvals/${encodeURIComponent(approvalId)}`,
      { method: "GET" },
      scope,
    );
  }

  async resolve(
    approvalId: string,
    body: { response: "approve" | "reject"; reason?: string },
    scope?: PlatosScope,
  ): Promise<PlatosApproval> {
    return this.client._fetch<PlatosApproval>(
      `/api/v1/agent/monitoring/approvals/${encodeURIComponent(approvalId)}/resolve`,
      { method: "POST", body: JSON.stringify(body) },
      scope,
    );
  }
}
