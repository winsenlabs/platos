import { task, logger, metadata } from "@platos/sdk/v3";
import { env } from "../shared/env";

/**
 * REFACTOR (control-plane + trigger substrate) — skill-as-task runner.
 *
 * Heavy / parallel / long skills (e.g. `parallel-web` fan-out,
 * `code_execution` E2B sandboxes) run as trigger tasks instead of tying up
 * the agent event loop. Governed by a per-skill task-offload flag: quick
 * skills stay in-process (no hop on a `direct` turn), heavy ones dispatch
 * here. Fan-out uses `.batchTrigger()` at the call site; the queue's
 * `concurrencyLimit` provides rate-limiting for free.
 *
 * Thin shell: calls back into the agent's
 * `POST /api/v1/agent/internal/skill-run` (admin-token gated) which runs the
 * existing skill handler in-scope (so gateway/entity/HMAC plumbing stays in
 * the agent process). Exposed to callers via the platform-MCP `skills_run`.
 *
 * NOTE: `/api/v1/agent/internal/skill-run` is added in the callbacks step;
 * until then this task compiles but is inert.
 */
export interface SkillRunPayload {
  skillId: string;
  toolName: string;
  input: Record<string, unknown>;
  threadId?: string;
  scope: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    userId: string;
    agentId?: string;
    threadId?: string;
  };
}

export interface SkillRunOutput {
  status: "ok" | "skipped" | "failed";
  reason?: string;
  skillId: string;
  toolName: string;
  result?: unknown;
  durationMs?: number;
}

export const skillRun = task({
  id: "platos.skill.run",
  description:
    "Skill-as-task runner — executes a heavy/parallel/long skill tool (parallel-web, code_execution, …) durably off the agent event loop. Fan-out via batchTrigger; rate-limited by the queue. Runs the skill handler in-scope via /internal/skill-run.",
  queue: { name: "platos-skill-run", concurrencyLimit: 100 },
  maxDuration: 300, // heavy skill work bounded at 5m; raise per-skill if needed
  retry: { maxAttempts: 2 }, // skills are typically pure/idempotent external I/O — a retry is safe
  run: async (payload: SkillRunPayload): Promise<SkillRunOutput> => {
    const start = Date.now();
    metadata.set("skillId", payload.skillId);
    metadata.set("toolName", payload.toolName);
    metadata.set("scope.organizationId", payload.scope.organizationId);
    metadata.set("status", "running");

    const AGENT_API_URL =
      env.PLATOS_AGENT_HTTP_URL || env.PLATOS_AGENT_API_URL || "http://localhost:3100";
    const adminToken = env.PLATOS_ADMIN_TOKEN;
    if (!adminToken) {
      logger.warn("skill-run: PLATOS_ADMIN_TOKEN not set — skipping");
      return {
        status: "skipped",
        reason: "PLATOS_ADMIN_TOKEN unset",
        skillId: payload.skillId,
        toolName: payload.toolName,
      };
    }

    try {
      const res = await fetch(`${AGENT_API_URL}/api/v1/agent/internal/skill-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Platos-Admin-Token": adminToken },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(290_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`skill-run failed: ${res.status} ${body.slice(0, 200)}`);
      }
      const result = (await res.json()) as Partial<SkillRunOutput>;
      const out: SkillRunOutput = {
        status: (result.status as SkillRunOutput["status"]) ?? "ok",
        reason: result.reason,
        skillId: payload.skillId,
        toolName: payload.toolName,
        result: result.result,
        durationMs: Date.now() - start,
      };
      metadata.set("status", out.status);
      logger.info("skill-run: done", { skillId: out.skillId, toolName: out.toolName, status: out.status });
      return out;
    } catch (err: any) {
      logger.error("skill-run: errored", { error: err?.message ?? String(err) });
      metadata.set("status", "failed");
      return {
        status: "failed",
        reason: err?.message ?? String(err),
        skillId: payload.skillId,
        toolName: payload.toolName,
        durationMs: Date.now() - start,
      };
    }
  },
});
