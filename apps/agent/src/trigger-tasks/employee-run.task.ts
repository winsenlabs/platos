import { task, logger, metadata } from "@trigger.dev/sdk";

/**
 * REFACTOR (control-plane + trigger substrate) — AI-employee workflow runner.
 *
 * Long-running, multi-step autonomous agent work (minutes→hours): the
 * "AI employee" shape. Unlike a durable *turn* (one request→response), an
 * employee run orchestrates many sub-turns, tool calls, and human-in-the-loop
 * waitpoints toward a goal. Latency is irrelevant here; durability and
 * no-timeout execution are the point.
 *
 * Thin shell (variant A): calls back into the agent's
 * `POST /api/v1/agent/internal/employee-run` (admin-token gated) which drives
 * the orchestration using existing runtime services. Progress via `metadata`
 * → RunsBridgeService. Human approvals inside the run use the existing
 * `agentDurableApprovalWait` waitpoint.
 *
 * NOTE: `/api/v1/agent/internal/employee-run` is added in the callbacks step;
 * until then this task compiles but is inert.
 */
export interface EmployeeRunPayload {
  agentId: string;
  goal: string;
  input?: Record<string, unknown>;
  maxSteps?: number;
  threadId?: string;
  scope: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    userId: string;
    agentId?: string;
  };
}

export interface EmployeeRunOutput {
  status: "ok" | "skipped" | "failed";
  reason?: string;
  agentId: string;
  threadId?: string;
  summary?: string;
  steps?: number;
  durationMs?: number;
}

export const employeeRun = task({
  id: "platos.agent.employee-run",
  description:
    "AI-employee workflow runner — long/multi-step autonomous agent work (no timeout, machine-backed). Orchestrates sub-turns + tools + approval waitpoints toward a goal via the agent's /internal/employee-run.",
  queue: { name: "platos-employee-run", concurrencyLimit: 50 },
  maxDuration: 3600, // long/autonomous work — up to 1h per run
  retry: { maxAttempts: 1 },
  run: async (payload: EmployeeRunPayload): Promise<EmployeeRunOutput> => {
    const start = Date.now();
    metadata.set("agentId", payload.agentId);
    metadata.set("scope.organizationId", payload.scope.organizationId);
    metadata.set("status", "running");
    metadata.set("goal", payload.goal.slice(0, 200));

    const AGENT_API_URL =
      process.env.PLATOS_AGENT_HTTP_URL || process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
    const adminToken = process.env.PLATOS_INTERNAL_AUTH_TOKEN;
    if (!adminToken) {
      logger.warn("employee-run: PLATOS_INTERNAL_AUTH_TOKEN not set — skipping");
      return { status: "skipped", reason: "PLATOS_INTERNAL_AUTH_TOKEN unset", agentId: payload.agentId };
    }

    try {
      const res = await fetch(`${AGENT_API_URL}/api/v1/agent/internal/employee-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Platos-Internal-Auth": adminToken },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(3_590_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`employee-run failed: ${res.status} ${body.slice(0, 200)}`);
      }
      const result = (await res.json()) as Partial<EmployeeRunOutput>;
      const out: EmployeeRunOutput = {
        status: (result.status as EmployeeRunOutput["status"]) ?? "ok",
        reason: result.reason,
        agentId: payload.agentId,
        threadId: result.threadId ?? payload.threadId,
        summary: result.summary,
        steps: result.steps,
        durationMs: Date.now() - start,
      };
      metadata.set("status", out.status);
      if (out.steps !== undefined) metadata.set("steps", out.steps);
      logger.info("employee-run: done", out as unknown as Record<string, unknown>);
      return out;
    } catch (err: any) {
      logger.error("employee-run: errored", { error: err?.message ?? String(err) });
      metadata.set("status", "failed");
      return {
        status: "failed",
        reason: err?.message ?? String(err),
        agentId: payload.agentId,
        durationMs: Date.now() - start,
      };
    }
  },
});
