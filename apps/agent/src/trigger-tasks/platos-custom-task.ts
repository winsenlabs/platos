import { task, metadata, logger } from "@trigger.dev/sdk";
import { postInternalCallback, type InternalCallbackFailureCode } from "./internal-callback";

/**
 * PIFSP-12 / WIN-123 — callback-only Platos custom task shell.
 *
 * Trigger receives only identifiers, canonical scope, invocation metadata, and
 * the operator-supplied task input. Handler source, database credentials, and
 * Platos authentication never appear in the Trigger payload. The Platos agent
 * owns task lookup, scope enforcement, handler execution, and last-run writes.
 */
export interface PlatosCustomTaskPayload {
  taskRowId: string;
  payload?: Record<string, unknown>;
  scope: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    userId?: string;
  };
  invokedBy: "agent" | "manual" | "schedule" | "webhook";
  agentId?: string;
}

export interface PlatosCustomTaskOutput {
  status: "completed" | "failed";
  result?: unknown;
  error?: PlatosCustomTaskError;
  durationMs: number;
}

export type PlatosCustomTaskError =
  | InternalCallbackFailureCode
  | "CALLBACK_EXECUTION_FAILED";

interface CallbackOutput {
  status: "completed" | "failed";
  result?: unknown;
}

const CALLBACK_PATH = "/api/v1/agent/internal/platos-tasks/execute";
const CALLBACK_TIMEOUT_MS = 590_000;

export const platosCustomTask = task({
  id: "platos-custom-task",
  queue: {
    concurrencyLimit: parseInt(process.env.PLATOS_CUSTOM_TASK_CONCURRENCY ?? "10", 10),
  },
  maxDuration: 600,
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 10000,
  },
  run: async (payload: PlatosCustomTaskPayload): Promise<PlatosCustomTaskOutput> => {
    const startMs = Date.now();
    await metadata.set("stage", "dispatching");
    await metadata.set("taskId", payload.taskRowId);

    const callback = await postInternalCallback<CallbackOutput>({
      path: CALLBACK_PATH,
      timeoutMs: CALLBACK_TIMEOUT_MS,
      body: {
        taskRowId: payload.taskRowId,
        payload: payload.payload ?? {},
        scope: payload.scope,
        invokedBy: payload.invokedBy,
        ...(payload.agentId ? { agentId: payload.agentId } : {}),
      },
    });

    if (!callback.ok) {
      logger.error("[platos-custom-task] Internal callback failed", {
        code: callback.code,
        ...(callback.httpStatus ? { httpStatus: callback.httpStatus } : {}),
      });
      await metadata.set("stage", "failed");
      return {
        status: "failed",
        error: callback.code,
        durationMs: Date.now() - startMs,
      };
    }

    if (callback.value.status !== "completed") {
      logger.error("[platos-custom-task] Internal execution failed", {
        code: "CALLBACK_EXECUTION_FAILED",
      });
      await metadata.set("stage", "failed");
      return {
        status: "failed",
        error: "CALLBACK_EXECUTION_FAILED",
        durationMs: Date.now() - startMs,
      };
    }

    await metadata.set("stage", "completed");
    return {
      status: "completed",
      result: callback.value.result,
      durationMs: Date.now() - startMs,
    };
  },
});
