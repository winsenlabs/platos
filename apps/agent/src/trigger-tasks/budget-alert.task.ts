import { task, logger, metadata } from "@trigger.dev/sdk";
import type {
  BudgetAlertDeliverySummary,
  BudgetAlertPayload,
} from "../monitoring/budget-alert.types";
import { postInternalCallback } from "./internal-callback";

export type { BudgetAlertPayload } from "../monitoring/budget-alert.types";

const CALLBACK_PATH = "/api/v1/agent/internal/budget-alert";
const CALLBACK_TIMEOUT_MS = 55_000;

/**
 * Callback-only Trigger shell for durable budget delivery.
 *
 * PostgreSQL claims, Credential reads, and external channel delivery remain in
 * the agent process. A non-2xx callback fails this Trigger run so retry state is
 * visible, while the durable ledger lets the callback skip successful rows.
 */
export const budgetAlert = task({
  id: "platos.budget.alert",
  maxDuration: 60,
  retry: {
    maxAttempts: 5,
    factor: 2,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 30_000,
  },
  run: async (payload: BudgetAlertPayload) => {
    const startedAt = Date.now();
    await metadata.set("eventId", payload.eventId);
    await metadata.set("capId", payload.capId);
    await metadata.set("threshold", payload.threshold);
    await metadata.set("scopeType", payload.scopeType);

    const callback = await postInternalCallback<BudgetAlertDeliverySummary>({
      path: CALLBACK_PATH,
      body: payload,
      timeoutMs: CALLBACK_TIMEOUT_MS,
    });
    if (!callback.ok) {
      logger.error("budget-alert: internal callback failed", {
        code: callback.code,
        ...(callback.httpStatus ? { httpStatus: callback.httpStatus } : {}),
      });
      await metadata.set("stage", "failed");
      throw new Error(`budget_alert_callback_failed:${callback.code}`);
    }

    const elapsedMs = Date.now() - startedAt;
    await metadata.set("stage", "completed");
    await metadata.set("elapsedMs", elapsedMs);
    await metadata.set("delivered", callback.value.delivered);
    await metadata.set("failed", callback.value.failed);
    logger.info("budget-alert: delivery callback completed", {
      delivered: callback.value.delivered,
      failed: callback.value.failed,
      skipped: callback.value.skipped,
      elapsedMs,
    });
    return { ...callback.value, elapsedMs };
  },
});
