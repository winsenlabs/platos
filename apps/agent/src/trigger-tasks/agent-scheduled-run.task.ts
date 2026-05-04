import { schedules, metadata, logger } from "@platos/sdk/v3";

/**
 * Agent execution on a cron schedule.
 *
 * Registered via `schedules.task()`. Users attach specific cron expressions
 * via the UI, which calls `schedules.create({ task, cron, externalId })`.
 *
 * The task triggers a full agent turn using the agent's default system prompt
 * and a synthetic "scheduled trigger" user message.
 *
 * Implementation is a skeleton — full logic lands in BLOCK 2 execution.
 */
export const agentScheduledRun = schedules.task({
  id: "platos-agent-scheduled-run",
  description: "Scheduled agent execution (cron-triggered).",
  maxDuration: 600,
  // No static cron — schedules are created per-agent via schedules.create()
  run: async (payload: { timestamp: Date; externalId?: string }) => {
    logger.info("agent-scheduled-run", { scheduledTime: payload.timestamp, externalId: payload.externalId });

    metadata.set("scheduledTime", payload.timestamp.toISOString());
    metadata.set("externalId", payload.externalId ?? null);

    // BLOCK 2: look up agent by externalId → call agent service
    // POST /internal/scheduled-run with { agentId, systemMessage: "scheduled trigger" }

    return { executed: true, agentId: payload.externalId };
  },
});
