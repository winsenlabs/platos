import { task, metadata, logger } from "@trigger.dev/sdk";
import { createHmac } from "node:crypto";
const env = process.env;

/**
 * W.1 — `agent_batch` durable executor.
 *
 * Fires when the LLM calls the `agent_batch` meta-tool (registered in
 * agent.service.ts next to `spawn_bgo`). The handler picks up
 * `{ scope, parentThreadId, parentAgentId, items, perItemInstructions,
 *   allowedTools, maxConcurrency, label }` and loops over each item:
 *
 *   1. Bumps `metadata.progress` to `{ type: "batch_progress", index, total,
 *      status: "running" }` — RunsBridgeService forwards these into the
 *      parent thread's Socket.IO room as `run_update` events carrying the
 *      metadata object verbatim.
 *   2. Calls `POST /internal/batch-turn` on the agent HTTP server with an
 *      HMAC-signed payload. That endpoint invokes
 *      `AgentTaskService.executeNonStreamingTurn` with
 *      `perItemInstructions + item` as the message + the allowedTools
 *      whitelist.
 *   3. On completion/error, emits `{ type: "batch_progress", ..., status:
 *      "success"|"failed", output?, error? }` via `metadata.set`.
 *   4. At the end, emits `{ type: "batch_complete", successCount,
 *      failureCount, totalCost }` once.
 *
 * Sequential (maxConcurrency=1) for v1 — see TODO below.
 * TODO(W.1.1): honor maxConcurrency > 1 (cap at 5) via
 * `tasks.batchTrigger` fan-out or a p-limit pool.
 */
export interface AgentBatchPayload {
  batchRunId: string;
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
   * Origin of the batch call — the parent thread that the LLM spawned this
   * batch from. Per-item progress events are routed to this thread's Socket.IO
   * room via RunsBridgeService.
   */
  parentThreadId: string;
  parentAgentId: string;
  parentMessageId?: string;
  items: unknown[];
  perItemInstructions: string;
  allowedTools?: string[];
  maxConcurrency?: number;
  label?: string;
  /**
   * IDENTITY-CORE §B.3 (G3) — the end-user EXTERNAL id ({{endUserId}}),
   * resolved ONCE by the parent (agent_batch handler, post-§C-gate) and
   * carried here. `null` = the origin thread gated closed (a signal, NOT an
   * absence). Forwarded UNCONDITIONALLY into each `/internal/batch-turn` body
   * (null-preserving), where it is stamped onto the rebuilt scope so the
   * fresh-per-item thread NEVER re-resolves a live walleId (fail-OPEN hazard
   * G3).
   */
  endUserId?: string | null;
}

export interface AgentBatchItemResult {
  index: number;
  status: "success" | "failed";
  output?: string;
  error?: string;
  costCents?: number;
  durationMs: number;
}

export interface AgentBatchOutput {
  batchRunId: string;
  successCount: number;
  failureCount: number;
  totalCostCents: number;
  results: AgentBatchItemResult[];
}

export const agentBatch = task({
  id: "platos-agent-batch",
  description:
    "Durable loop — runs a per-item agent turn with a restricted tool subset for each element in a supplied list. Streams per-item progress back to the spawning thread.",
  queue: { concurrencyLimit: parseInt(process.env.PLATOS_BATCH_CONCURRENCY ?? "20", 10) },
  maxDuration: 3600, // 1h — long enough for meaningful batches.
  retry: { maxAttempts: 1 }, // The inner per-item turn handles its own retries.
  run: async (payload: AgentBatchPayload, { ctx }): Promise<AgentBatchOutput> => {
    const {
      batchRunId,
      scope,
      parentThreadId,
      parentAgentId,
      items,
      perItemInstructions,
      allowedTools,
      label,
    } = payload;

    const total = items.length;

    // Publish a canonical header so subscribers can bucket progress events
    // back against the spawning thread without guessing.
    metadata.set("organizationId", scope.organizationId);
    metadata.set("projectId", scope.projectId);
    metadata.set("environmentId", scope.environmentId);
    metadata.set("agentId", parentAgentId);
    metadata.set("threadId", parentThreadId);
    metadata.set("batchRunId", batchRunId);
    metadata.set("label", label ?? null);
    metadata.set("total", total);

    logger.info("agent-batch start", {
      batchRunId,
      total,
      allowedTools: allowedTools?.length ?? 0,
      parentThreadId,
    });

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

    const results: AgentBatchItemResult[] = new Array(total);
    let successCount = 0;
    let failureCount = 0;
    let totalCostCents = 0;

    // W.1.1 — honor maxConcurrency > 1 via chunk-parallel execution.
    // Cap at PLATOS_BATCH_ITEM_CONCURRENCY (default 5) to avoid flooding
    // the agent's /internal/batch-turn endpoint. Items within a chunk
    // run concurrently; chunks execute sequentially so we don't start
    // chunk N+1 until all of chunk N has settled.
    const concurrency = Math.min(
      payload.maxConcurrency ?? 5,
      parseInt(process.env.PLATOS_BATCH_ITEM_CONCURRENCY ?? "5", 10),
    );

    const runSingleItem = async (item: unknown, index: number): Promise<AgentBatchItemResult> => {
      // Emit "running" progress frame. RunsBridgeService forwards the
      // whole `metadata` blob inside the `run_update` event, so any field
      // under `metadata.progress` lands on the thread Socket.IO room.
      metadata.set("progress", {
        type: "batch_progress",
        batchRunId,
        index,
        total,
        status: "running",
      });

      const itemStartedAt = Date.now();
      // Phase 1 review follow-up — cap the per-item stringified body at
      // 32 000 chars. Prevents a single oversized entry (e.g. a full
      // contact record with embedded logs) from dominating the LLM
      // prompt budget, and keeps the outer 1 MB items-payload cap from
      // being the only line of defence.
      const PER_ITEM_MAX_CHARS = 32_000;
      const itemRaw = typeof item === "string" ? item : JSON.stringify(item, null, 2);
      const itemBody =
        itemRaw.length > PER_ITEM_MAX_CHARS
          ? `${itemRaw.slice(0, PER_ITEM_MAX_CHARS)}\n[…truncated]`
          : itemRaw;
      const message = `${perItemInstructions}\n\nItem (${index + 1}/${total}):\n${itemBody}`;

      const body = {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        userId: scope.userId,
        agentId: parentAgentId,
        message,
        allowedTools: allowedTools ?? null,
        // IDENTITY-CORE §B.3 (G3) — forward the resolved end user
        // UNCONDITIONALLY (null-preserving). `?? null` coerces a missing key to
        // the fail-closed signal; a real `null` from the parent is preserved
        // verbatim. NEVER conditionally spread this key — `/internal/batch-turn`
        // stamps it onto the rebuilt scope, and a dropped `null` would fall
        // through to the fresh-per-item thread path and resolve a live walleId.
        endUserId: payload.endUserId ?? null,
        batch: {
          batchRunId,
          index,
          total,
          parentThreadId,
          parentMessageId: payload.parentMessageId ?? null,
        },
        scopeExtras: {
          sessionId: scope.sessionId,
          userToken: scope.userToken,
          entityId: scope.entityId,
          traceId: scope.traceId,
          parentSpanId: scope.parentSpanId,
        },
      };
      const bodyStr = JSON.stringify(body);
      const timestamp = new Date().toISOString();
      const signature = createHmac("sha256", resolvedInternalSecret)
        .update(bodyStr + timestamp)
        .digest("hex");

      let itemResult: AgentBatchItemResult;
      try {
        const res = await fetch(`${agentUrl}/internal/batch-turn`, {
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
          throw new Error(
            `/internal/batch-turn ${res.status}: ${errText.slice(0, 200)}`,
          );
        }
        const json = (await res.json()) as {
          status: "success" | "failed";
          text?: string;
          error?: string;
          costCents?: number;
        };
        if (json.status !== "success") {
          itemResult = {
            index,
            status: "failed",
            error: json.error ?? "agent returned non-success",
            costCents: json.costCents ?? 0,
            durationMs: Date.now() - itemStartedAt,
          };
        } else {
          itemResult = {
            index,
            status: "success",
            output: json.text ?? "",
            costCents: json.costCents ?? 0,
            durationMs: Date.now() - itemStartedAt,
          };
        }
      } catch (err: any) {
        itemResult = {
          index,
          status: "failed",
          error: err?.message ?? String(err),
          durationMs: Date.now() - itemStartedAt,
        };
        logger.warn("agent-batch item failed", {
          batchRunId,
          index,
          error: err?.message ?? String(err),
        });
      }

      // Emit terminal-state progress frame for this item.
      metadata.set("progress", {
        type: "batch_progress",
        batchRunId,
        index,
        total,
        status: itemResult.status,
        ...(itemResult.output ? { output: itemResult.output } : {}),
        ...(itemResult.error ? { error: itemResult.error } : {}),
      });

      return itemResult;
    };

    // Process items in parallel chunks. Each chunk runs up to `concurrency`
    // items at once; the next chunk starts only after the current one settles.
    for (let chunkStart = 0; chunkStart < total; chunkStart += concurrency) {
      const chunkEnd = Math.min(chunkStart + concurrency, total);
      const chunkItems = items.slice(chunkStart, chunkEnd);

      const chunkResults = await Promise.allSettled(
        chunkItems.map((item, chunkIdx) => runSingleItem(item, chunkStart + chunkIdx)),
      );

      for (const settled of chunkResults) {
        const itemResult = settled.status === "fulfilled"
          ? settled.value
          : {
              index: -1, // will be overridden by results array position
              status: "failed" as const,
              error: (settled as PromiseRejectedResult).reason?.message ?? "unknown error",
              durationMs: 0,
            };
        results[itemResult.index] = itemResult;
        if (itemResult.status === "success") {
          successCount += 1;
          totalCostCents += itemResult.costCents ?? 0;
        } else {
          failureCount += 1;
        }
      }
    }

    // Final summary frame.
    metadata.set("progress", {
      type: "batch_complete",
      batchRunId,
      successCount,
      failureCount,
      totalCost: totalCostCents,
    });

    logger.info("agent-batch complete", {
      batchRunId,
      successCount,
      failureCount,
      totalCostCents,
      attempt: ctx?.attempt?.number ?? 1,
    });

    return {
      batchRunId,
      successCount,
      failureCount,
      totalCostCents,
      results,
    };
  },
});
