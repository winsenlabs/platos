import { task, metadata, logger } from "@trigger.dev/sdk";
import { createHmac } from "node:crypto";
const env = process.env;

/**
 * Durable tool block execution — PPR-25 full impl.
 *
 * Triggered by the agent runtime (via the `spawn_bgo` meta-tool — formerly
 * `spawn_task`, kept as a deprecated alias) whenever the
 * LLM decides a tool call needs to survive a restart, exceed the default
 * 30s agent HTTP budget, or benefit from trigger.dev's retry policy.
 *
 * The task calls back into the agent service's
 * `POST /internal/execute-tool` endpoint (HMAC-signed, scope-gated). That
 * endpoint is the only bridge from a durable worker back into the scoped
 * tool registry + ToolExecutorService — keeping entity `serviceSecret`s
 * out of the worker sandbox.
 *
 * On final failure the task resolves with `{ status: "failed", error }`
 * rather than re-throwing, so `runs.retrieve` callers see a clean handle.
 */
export interface AgentToolBlockPayload {
  /**
   * The tool to invoke, exactly as it appears in the scoped tool registry
   * (e.g. `list_deals`). Matches the MCP `tools/call` name.
   */
  tool: string;
  params: Record<string, unknown>;
  /**
   * Full RequestScope tuple + acting user. Mirrors
   * `apps/agent/src/auth/scope.guard.ts` — required because the
   * ToolExecutorService needs it to resolve the entity + HMAC secret.
   */
  scope: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    userId: string;
    agentId?: string;
    sessionId?: string;
    userToken?: string;
    entityId?: string;
    traceId?: string;
    parentSpanId?: string;
  };
  /**
   * Why the agent spawned this durable call. Propagated to audit rows so
   * the governance dashboard can distinguish model-initiated from
   * user-initiated durable invocations.
   */
  origin: {
    agentId: string;
    threadId: string;
    /**
     * Stable per-call id minted by the agent runtime (`crypto.randomUUID`).
     * Matches the `callId` embedded in the `__platos` envelope on the
     * corresponding `tool_call` stream event. Propagated so replays can
     * be correlated with their original streaming turn.
     */
    callId: string;
  };
  /**
   * Legacy fields retained from the BLOCK-1 scaffold so existing callers
   * (the old `spawn_task` — now `spawn_bgo` — payload shape) stay
   * wire-compatible. Ignored when the new `tool` field is present.
   */
  taskId?: string;
  instruction?: string;
  tools?: string[];
  timeout?: string;
  organizationId?: string;
  projectId?: string;
  environmentId?: string;
  userId?: string;
  agentId?: string;
}

export interface AgentToolBlockOutput {
  status: "success" | "failed" | "timeout";
  tool: string;
  result?: unknown;
  error?: string;
  latencyMs: number;
  attempts: number;
}

/**
 * Backwards-compat shim: the original `spawn_task` (now `spawn_bgo`) payload used
 * `{ organizationId, projectId, ... }` at the top level. If we receive a
 * legacy payload, lift it into the new shape so BLOCK-2 contract holds.
 */
function normalizePayload(p: AgentToolBlockPayload): AgentToolBlockPayload | null {
  if (p.tool && p.scope?.organizationId) return p;
  if (p.instruction && p.organizationId && p.projectId && p.environmentId && p.userId) {
    return {
      tool: p.taskId ?? p.instruction,
      params: { instruction: p.instruction, tools: p.tools ?? [] },
      scope: {
        organizationId: p.organizationId,
        projectId: p.projectId,
        environmentId: p.environmentId,
        userId: p.userId,
        agentId: p.agentId,
      },
      origin: {
        agentId: p.agentId ?? "default",
        threadId: "",
        callId: `legacy-${Date.now()}`,
      },
    };
  }
  return null;
}

export const agentToolBlock = task({
  id: "platos-agent-tool-block",
  description: "Durable execution of a single agent tool call via the scoped registry. Survives restarts, retries on transient failure.",
  queue: { concurrencyLimit: parseInt(process.env.PLATOS_WORKER_CONCURRENCY ?? "50", 10) },
  maxDuration: 600,
  // Trigger.dev handles exponential backoff via its native retry policy.
  // We set maxAttempts=3 so transient entity-side 5xx/timeouts self-heal
  // without user intervention; final failure resolves (not rejects) so
  // the handle reports a structured `{ status: "failed" }`.
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1000, maxTimeoutInMs: 10000 },
  run: async (payload: AgentToolBlockPayload, { ctx }): Promise<AgentToolBlockOutput> => {
    const normalized = normalizePayload(payload);
    if (!normalized) {
      const error = "Invalid agent-tool-block payload — missing `tool` + `scope`";
      logger.error(error, { payload });
      return {
        status: "failed",
        tool: payload.tool ?? "unknown",
        error,
        latencyMs: 0,
        attempts: ctx?.attempt?.number ?? 1,
      };
    }
    const { tool, params, scope, origin } = normalized;

    metadata.set("organizationId", scope.organizationId);
    metadata.set("projectId", scope.projectId);
    metadata.set("environmentId", scope.environmentId);
    metadata.set("agentId", origin.agentId);
    metadata.set("threadId", origin.threadId);
    metadata.set("tool", tool);
    metadata.set("callId", origin.callId);
    // `metadata.set` fills the same "progress" channel the dashboard renders.
    // Each stage bump shows up in the trigger.dev UI + in any realtime
    // subscriber (PPR-26 RunsBridgeService wires these to Socket.IO).
    metadata.set("progress", { step: 0, total: 3, stage: "resolving" });

    const agentUrl =
      env.PLATOS_AGENT_HTTP_URL ||
      env.PLATOS_AGENT_API_URL ||
      "http://localhost:3100";
    const internalSecret = env.TRIGGER_INTERNAL_SECRET;
    if (!internalSecret || internalSecret === "dev-internal-secret-change-me") {
      if (env.NODE_ENV === "production") {
        throw new Error("TRIGGER_INTERNAL_SECRET must be set to a secure value in production (openssl rand -hex 32)");
      }
      logger.warn("TRIGGER_INTERNAL_SECRET is using the insecure default — set it via env var before production deploy");
    }
    const resolvedInternalSecret = internalSecret || "dev-internal-secret-change-me";
    const timestamp = new Date().toISOString();
    const body = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      userId: scope.userId,
      agentId: origin.agentId,
      tool,
      params,
      purpose: "durable",
      scopeExtras: {
        sessionId: scope.sessionId ?? origin.threadId,
        userToken: scope.userToken,
        entityId: scope.entityId,
        traceId: scope.traceId,
        parentSpanId: scope.parentSpanId,
      },
      origin,
    };
    const bodyStr = JSON.stringify(body);
    const signature = createHmac("sha256", resolvedInternalSecret)
      .update(bodyStr + timestamp)
      .digest("hex");

    metadata.set("progress", { step: 1, total: 3, stage: "dispatching" });

    const startedAt = Date.now();
    try {
      const res = await fetch(`${agentUrl}/internal/execute-tool`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Platos-Signature": signature,
          "X-Platos-Timestamp": timestamp,
        },
        body: bodyStr,
      });
      const latencyMs = Date.now() - startedAt;
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        // Throwing here hands control back to trigger.dev's retry engine —
        // 5xx / network errors get retried per the `retry` config above.
        // On the final attempt the outer catch turns it into a structured
        // failure payload.
        throw new Error(`internal/execute-tool ${res.status}: ${errText.slice(0, 200)}`);
      }
      const json = (await res.json()) as {
        status: "success" | "failed" | "timeout";
        result?: unknown;
        error?: string;
      };
      metadata.set("progress", {
        step: 3,
        total: 3,
        stage: json.status === "success" ? "completed" : "failed",
      });
      if (json.status !== "success") {
        // Non-success from the entity side — don't retry (the tool ran and
        // errored, retrying won't help). Return structured failure.
        return {
          status: json.status,
          tool,
          error: json.error,
          latencyMs,
          attempts: ctx?.attempt?.number ?? 1,
        };
      }
      return {
        status: "success",
        tool,
        result: json.result,
        latencyMs,
        attempts: ctx?.attempt?.number ?? 1,
      };
    } catch (err: any) {
      const latencyMs = Date.now() - startedAt;
      const attempts = ctx?.attempt?.number ?? 1;
      // `ctx.run.maxAttempts` is optional; default to the task-level retry
      // config (3). If the SDK doesn't surface it on this version we fall
      // back to the attempt bound.
      const maxAttempts = (ctx as any)?.run?.maxAttempts ?? 3;
      const isFinal = attempts >= maxAttempts;
      if (!isFinal) {
        // Re-throw so trigger.dev's retry policy fires. The dashboard still
        // shows the attempt + reason thanks to metadata above.
        throw err;
      }
      logger.error("agent-tool-block final failure", {
        tool,
        error: err?.message,
        attempts,
      });
      metadata.set("progress", { step: 3, total: 3, stage: "failed" });
      return {
        status: "failed",
        tool,
        error: err?.message || String(err),
        latencyMs,
        attempts,
      };
    }
  },
});
