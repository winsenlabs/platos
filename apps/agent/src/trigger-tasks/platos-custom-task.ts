import { task, metadata, logger } from "@trigger.dev/sdk";
import { postInternalCallback, type InternalCallbackFailureCode } from "./internal-callback";

/**
 * PIFSP-12 / WIN-132 — callback-only Platos custom task shell.
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
  status: "completed";
  result?: unknown;
  durationMs: number;
}

export type PlatosCustomTaskError =
  | InternalCallbackFailureCode
  | "CALLBACK_INVALID_CONTEXT"
  | "CALLBACK_EXECUTION_FAILED";

interface CallbackOutput {
  status: "completed" | "failed";
  result?: unknown;
}

const CALLBACK_PATH = "/api/v1/agent/internal/platos-tasks/execute";
const CALLBACK_TIMEOUT_MS = 590_000;

async function failRun(error: PlatosCustomTaskError): Promise<never> {
  await metadata.set("stage", "failed");
  throw new Error(error);
}

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
  run: async (payload: PlatosCustomTaskPayload, context): Promise<PlatosCustomTaskOutput> => {
    const startMs = Date.now();
    await metadata.set("stage", "dispatching");
    await metadata.set("taskId", payload.taskRowId);

    const requestId = context?.ctx?.run?.id;
    if (typeof requestId !== "string" || requestId.length === 0) {
      return failRun("CALLBACK_INVALID_CONTEXT");
    }

    const callback = await postInternalCallback<CallbackOutput>({
      path: CALLBACK_PATH,
      timeoutMs: CALLBACK_TIMEOUT_MS,
      body: {
        requestId,
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
      return failRun(callback.code);
    }

    if (callback.value.status !== "completed") {
      logger.error("[platos-custom-task] Internal execution failed", {
        code: "CALLBACK_EXECUTION_FAILED",
      });
      return failRun("CALLBACK_EXECUTION_FAILED");
    }

    await metadata.set("stage", "completed");
    return {
      status: "completed",
      result: callback.value.result,
      durationMs: Date.now() - startMs,
    };
  },
});
