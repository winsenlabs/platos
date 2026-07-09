import { task, metadata, logger } from "@trigger.dev/sdk";

/**
 * One unit of a batch operation.
 *
 * Spawned by the agent via `spawn_batch` meta-tool using `tasks.batchTrigger()`.
 * Used for AI-employee bulk ops (e.g., process 500 records, send 1000 emails).
 *
 * Each instance runs independently with its own retries/checkpoints.
 * The parent batch is observable via `runs.subscribeToBatch(batchId)`.
 *
 * Implementation is a skeleton — full logic lands in BLOCK 2 execution.
 */
export interface AgentBatchOpPayload {
  organizationId: string;
  projectId: string;
  environmentId: string;
  agentId: string;
  threadId: string;
  userId: string;
  operation: string;           // e.g., "send_email", "enrich_contact"
  input: Record<string, unknown>; // per-item input
  idempotencyKey?: string;
}

export interface AgentBatchOpOutput {
  status: "success" | "failed" | "skipped";
  result?: unknown;
  error?: string;
}

export const agentBatchOp = task({
  id: "platos-agent-batch-op",
  description: "One unit of a batch operation. Idempotent, retriable.",
  queue: { concurrencyLimit: 50 }, // parallelism across a batch
  maxDuration: 120,
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1000 },
  run: async (payload: AgentBatchOpPayload): Promise<AgentBatchOpOutput> => {
    logger.info("agent-batch-op", { operation: payload.operation, idempotencyKey: payload.idempotencyKey });

    metadata.set("organizationId", payload.organizationId);
    metadata.set("projectId", payload.projectId);
    metadata.set("environmentId", payload.environmentId);
    metadata.set("operation", payload.operation);

    // BLOCK 2: call back to /internal/execute-tool to run the operation,
    // handle idempotency, return result.

    return { status: "success", result: { placeholder: "BLOCK 2 will implement" } };
  },
});
