import { task, metadata, logger } from "@trigger.dev/sdk";
import { createHmac } from "node:crypto";
import {
  SUBAGENT_MAX_DEPTH,
  budgetExhausted,
  isSubagentDoneSignal,
  composeSubagentTurnMessage,
  buildSubagentReportMessage,
} from "../agent-runtime/subagent-guardrails";

const env = process.env;

/**
 * `spawn_agent` durable executor — `platos.agent.subrun`
 * (docs/subagent-spawning-spec.md § "The primitive").
 *
 * Fires when the LLM calls the `spawn_agent` meta-tool (agent.service.ts,
 * registered beside `agent_batch`). Unlike `agent_batch` (N items × ONE turn
 * each), this runs the FULL agent loop: repeated turns on ONE child thread
 * until the child signals done, `maxTurns` is reached, or the shared budget
 * pool drains. It composes owned rails — no new provider keys, no BYOK in
 * Trigger:
 *
 *   1. Per turn, POST `/internal/subagent-turn` (HMAC-signed, same scheme as
 *      `/internal/batch-turn`) — but threads the CHILD thread id through every
 *      call so multi-turn history accumulates on one thread (the batch endpoint
 *      deliberately does the opposite). The endpoint runs the EXISTING runtime
 *      (tools, memory, scope enforcement, approvals, cost ledger).
 *   2. Accumulates `costCents` per turn and self-terminates once the running
 *      sum ≥ `budgetCents` (shared-pool floor). The scope-wide BudgetService
 *      gate inside every turn stays a coarser backstop (child inherits the
 *      parent's scope tuple unchanged).
 *   3. Streams per-turn progress via `metadata.progress` → RunsBridgeService →
 *      the parent thread's Socket.IO room (the `agent_batch` pattern).
 *   4. Report-back:
 *        - background: POST `/api/v1/agent/internal/subagent-report`
 *          (admin-token gated) → the result is injected into the PARENT thread
 *          as a synthetic `[subagent_report]` message and a durable PARENT turn
 *          runs, so the parent wakes and reasons over the result.
 *        - wait: no report POST; the caller (meta-tool handler) polls the run
 *          and returns the output as the tool result.
 *
 * Scope is INHERITED verbatim from the parent — the payload copies the parent's
 * (org, project, env, userId) 1:1 and NOTHING here re-derives or accepts a
 * caller-chosen scope. Depth is server-stamped: the handler passed the child's
 * depth in; we re-check the cap here as defense-in-depth.
 */
export interface AgentSubrunPayload {
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
  /** Parent thread the spawn came from — where the report is injected + progress streamed. */
  parentThreadId: string;
  parentAgentId: string;
  /** L7 run-tagging: the parent's Trigger run id, if known, for the runs-tree. */
  parentRunId?: string | null;
  /** Server-stamped depth of THIS child (root spawn = 1). Re-checked against the cap. */
  spawnDepth: number;
  task: string;
  context?: string | null;
  /** WHO — referenced Platos agent (mode a). Null ⇒ ephemeral spec (mode b). */
  referencedAgentId?: string | null;
  /** WHO — ephemeral spec (mode b). Config passed per-turn; no registry row. */
  spec?: { model?: string | null; systemPrompt?: string | null; skills?: string[] | null } | null;
  /** Already-narrowed (child ⊆ parent ∩ requested) at spawn time — passed straight through. */
  allowedTools: string[];
  maxTurns: number;
  budgetCents: number;
  mode: "background" | "wait";
}

export interface AgentSubrunOutput {
  status: "ok" | "skipped" | "failed";
  reason?: string;
  childThreadId?: string;
  turnsUsed: number;
  totalCostCents: number;
  done: boolean;
  finalStatus: "completed" | "max_turns" | "budget_exhausted" | "failed";
  result: string;
  reportDelivered: boolean;
}

interface SubagentTurnResult {
  status: "success" | "failed";
  text?: string;
  threadId?: string;
  costCents?: number;
  hadToolCalls?: boolean;
  error?: string;
}

export const agentSubrun = task({
  id: "platos.agent.subrun",
  description:
    "Durable subagent — runs a full multi-turn tool-calling agent loop on a child thread (parentThreadId lineage), streams progress to the parent, and reports the result back into the parent thread so the parent reasons over it. Depth ≤ 2, shared budget pool, tool-ACL narrowed.",
  queue: { name: "platos-agent-subrun", concurrencyLimit: parseInt(process.env.PLATOS_SUBAGENT_CONCURRENCY ?? "20", 10) },
  maxDuration: 3600, // long autonomous work — up to 1h per subagent
  retry: { maxAttempts: 1 }, // dedupe is at dispatch (idempotencyKey); the inner turn handles its own retries
  run: async (payload: AgentSubrunPayload, { ctx }): Promise<AgentSubrunOutput> => {
    const {
      scope,
      parentThreadId,
      parentAgentId,
      spawnDepth,
      task: goal,
      context,
      referencedAgentId,
      spec,
      allowedTools,
      maxTurns,
      budgetCents,
      mode,
    } = payload;

    // Canonical header for RunsBridge routing (mirrors agent-batch).
    metadata.set("organizationId", scope.organizationId);
    metadata.set("projectId", scope.projectId);
    metadata.set("environmentId", scope.environmentId);
    metadata.set("agentId", referencedAgentId || parentAgentId);
    metadata.set("threadId", parentThreadId);
    metadata.set("spawnDepth", spawnDepth);
    metadata.set("kind", "subagent");
    metadata.set("status", "running");

    // Defense-in-depth: the meta-tool handler already gated depth at spawn
    // time; refuse to run a child that exceeds the cap even if a payload were
    // somehow forged past it.
    if (typeof spawnDepth !== "number" || spawnDepth > SUBAGENT_MAX_DEPTH || spawnDepth < 1) {
      logger.warn("agent-subrun: depth out of range — refusing", { spawnDepth });
      metadata.set("status", "skipped");
      return {
        status: "skipped",
        reason: `spawnDepth ${spawnDepth} outside 1..${SUBAGENT_MAX_DEPTH}`,
        turnsUsed: 0,
        totalCostCents: 0,
        done: false,
        finalStatus: "failed",
        result: "",
        reportDelivered: false,
      };
    }

    const agentUrl =
      env.PLATOS_AGENT_HTTP_URL || env.PLATOS_AGENT_API_URL || "http://localhost:3100";

    const internalSecret = env.TRIGGER_INTERNAL_SECRET;
    if (!internalSecret || internalSecret === "dev-internal-secret-change-me") {
      if (env.NODE_ENV === "production") {
        throw new Error(
          "TRIGGER_INTERNAL_SECRET must be set to a secure value in production (openssl rand -hex 32)",
        );
      }
      logger.warn("TRIGGER_INTERNAL_SECRET is using the insecure default — set it before production deploy");
    }
    const resolvedInternalSecret = internalSecret || "dev-internal-secret-change-me";
    const adminToken = env.PLATOS_INTERNAL_AUTH_TOKEN;

    const scopeExtras = {
      sessionId: scope.sessionId,
      userToken: scope.userToken,
      entityId: scope.entityId,
      traceId: scope.traceId,
      parentSpanId: scope.parentSpanId,
    };

    const callSubagentTurn = async (message: string, threadId: string | null): Promise<SubagentTurnResult> => {
      const body = {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        userId: scope.userId,
        // WHO: referenced agent runs as itself; ephemeral runs under the parent
        // agent row (BYOK/provider resolution) with per-turn config overrides.
        agentId: referencedAgentId || parentAgentId,
        message,
        allowedTools,
        // Thread the CHILD thread through every call (opposite of batch-turn).
        threadId,
        parentThreadId,
        // Server-stamped depth so the child turn's own buildMetaTools enforces
        // the grandchild cap.
        spawnDepth,
        // Ephemeral spec params applied per-turn (no registry row).
        systemPromptOverride: spec?.systemPrompt ?? null,
        modelLabel: spec?.model ?? null,
        scopeExtras,
      };
      const bodyStr = JSON.stringify(body);
      const timestamp = new Date().toISOString();
      const signature = createHmac("sha256", resolvedInternalSecret)
        .update(bodyStr + timestamp)
        .digest("hex");
      const res = await fetch(`${agentUrl}/internal/subagent-turn`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Platos-Signature": signature,
          "X-Platos-Timestamp": timestamp,
        },
        body: bodyStr,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`/internal/subagent-turn ${res.status}: ${errText.slice(0, 200)}`);
      }
      return (await res.json()) as SubagentTurnResult;
    };

    let childThreadId: string | undefined;
    let totalCostCents = 0;
    let turnsUsed = 0;
    let done = false;
    let lastText = "";
    let finalStatus: AgentSubrunOutput["finalStatus"] = "max_turns";

    logger.info("agent-subrun start", { parentThreadId, spawnDepth, maxTurns, budgetCents, mode });

    for (let turn = 0; turn < maxTurns; turn++) {
      if (budgetExhausted(totalCostCents, budgetCents)) {
        finalStatus = "budget_exhausted";
        break;
      }

      metadata.set("progress", {
        type: "subagent_progress",
        parentThreadId,
        turn: turn + 1,
        maxTurns,
        spawnDepth,
        status: "running",
      });

      const message = composeSubagentTurnMessage({ turnIndex: turn, task: goal, context });

      let result: SubagentTurnResult;
      try {
        result = await callSubagentTurn(message, childThreadId ?? null);
      } catch (err: any) {
        logger.warn("agent-subrun turn failed", { turn: turn + 1, error: err?.message ?? String(err) });
        finalStatus = "failed";
        lastText = lastText || `subagent turn ${turn + 1} failed: ${err?.message ?? String(err)}`;
        metadata.set("progress", {
          type: "subagent_progress",
          parentThreadId,
          turn: turn + 1,
          maxTurns,
          spawnDepth,
          status: "failed",
          error: err?.message ?? String(err),
        });
        break;
      }

      if (result.status !== "success") {
        finalStatus = "failed";
        lastText = result.error ? `subagent error: ${result.error}` : lastText;
        metadata.set("progress", {
          type: "subagent_progress",
          parentThreadId,
          turn: turn + 1,
          maxTurns,
          spawnDepth,
          status: "failed",
          error: result.error ?? "non-success turn",
        });
        break;
      }

      childThreadId = result.threadId ?? childThreadId;
      totalCostCents += result.costCents ?? 0;
      turnsUsed += 1;
      lastText = result.text ?? "";

      metadata.set("progress", {
        type: "subagent_progress",
        parentThreadId,
        turn: turn + 1,
        maxTurns,
        spawnDepth,
        status: "success",
        childThreadId: childThreadId ?? null,
        costCents: result.costCents ?? 0,
      });

      // Stop conditions: explicit done marker, OR the agent produced a final
      // answer with no tool calls (it stopped acting → it is done).
      if (isSubagentDoneSignal(lastText)) {
        done = true;
        finalStatus = "completed";
        break;
      }
      if (result.hadToolCalls === false) {
        done = true;
        finalStatus = "completed";
        break;
      }
    }

    if (!done && finalStatus === "max_turns" && budgetExhausted(totalCostCents, budgetCents)) {
      finalStatus = "budget_exhausted";
    }

    metadata.set("progress", {
      type: "subagent_complete",
      parentThreadId,
      turnsUsed,
      totalCostCents,
      status: finalStatus,
    });
    metadata.set("status", finalStatus === "failed" ? "failed" : "completed");

    // Report-back (background mode only). Wakes the parent: the result is
    // injected into the PARENT thread as a synthetic message and a durable
    // parent turn runs. wait-mode returns the output to the polling handler
    // instead, so we skip the report to avoid a double parent turn.
    let reportDelivered = false;
    if (mode !== "wait") {
      if (!adminToken) {
        logger.warn("agent-subrun: PLATOS_INTERNAL_AUTH_TOKEN unset — cannot report back to parent");
      } else {
        const reportBody = {
          agentId: parentAgentId,
          threadId: parentThreadId,
          // SECURITY (subagent depth cap) — the parent thread we are waking sits
          // ONE level shallower than this child. The report handler stamps this
          // onto the woken turn's scope.spawnDepth so its depth cap holds. Omit
          // (or send 0) ⇒ the wake defaults to depth 0, which would reset the
          // counter on every report-back and let the tree recurse without bound.
          parentSpawnDepth: Math.max(0, spawnDepth - 1),
          scope: {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            userId: scope.userId,
            agentId: parentAgentId,
            threadId: parentThreadId,
          },
          report: buildSubagentReportMessage({
            task: goal,
            status: finalStatus,
            result: lastText,
            costCents: totalCostCents,
            turnsUsed,
            childThreadId,
            childRunId: ctx?.run?.id ?? null,
          }),
          childThreadId: childThreadId ?? null,
          finalStatus,
          costCents: totalCostCents,
          turnsUsed,
        };
        try {
          const res = await fetch(`${agentUrl}/api/v1/agent/internal/subagent-report`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Platos-Internal-Auth": adminToken },
            body: JSON.stringify(reportBody),
            signal: AbortSignal.timeout(590_000),
          });
          reportDelivered = res.ok;
          if (!res.ok) {
            const errText = await res.text().catch(() => "");
            logger.warn("agent-subrun: subagent-report non-ok", { status: res.status, body: errText.slice(0, 200) });
          }
        } catch (err: any) {
          logger.error("agent-subrun: subagent-report failed", { error: err?.message ?? String(err) });
        }
      }
    }

    logger.info("agent-subrun complete", {
      parentThreadId,
      childThreadId,
      turnsUsed,
      totalCostCents,
      finalStatus,
      reportDelivered,
      attempt: ctx?.attempt?.number ?? 1,
    });

    return {
      status: finalStatus === "failed" ? "failed" : "ok",
      childThreadId,
      turnsUsed,
      totalCostCents,
      done,
      finalStatus,
      result: lastText,
      reportDelivered,
    };
  },
});
