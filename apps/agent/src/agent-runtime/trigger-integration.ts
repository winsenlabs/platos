/**
 * Trigger.dev Integration for Platos Agent Runtime
 *
 * This module defines how agent conversations run as durable trigger.dev tasks.
 * The integration provides:
 *
 * 1. DURABLE EXECUTION — if the server restarts mid-conversation, the task
 *    resumes from the last checkpoint. No lost messages, no broken streams.
 *
 * 2. QUEUE CONCURRENCY — one agent task per thread at a time. No interleaved
 *    writes, no 409 errors. The trigger.dev queue handles it.
 *
 * 3. RETRY ON FAILURE — if an LLM API call fails (429, 500), trigger.dev
 *    retries with exponential backoff. The user doesn't need to re-send.
 *
 * 4. LONG-RUNNING SUPPORT — research tasks that take 2-3 minutes run as
 *    trigger.dev tasks with no timeout. Heartbeats keep the connection alive.
 *
 * 5. HUMAN-IN-THE-LOOP — when the agent needs approval for a tool call,
 *    the task uses wait.forToken(). The task pauses (zero compute cost)
 *    and resumes when the user clicks Approve.
 *
 * 6. OBSERVABILITY — every agent conversation shows up in the trigger.dev
 *    dashboard alongside regular tasks. Full trace, timing, cost data.
 *
 * INTEGRATION PATTERN:
 * The NestJS agent service handles real-time WebSocket streaming.
 * For operations that need durability (tool execution, long research,
 * approval flows), it delegates to trigger.dev tasks.
 *
 * The trigger.dev task definitions below are registered with the platform
 * service (apps/webapp) and executed by the supervisor infrastructure.
 *
 * NOTE: These task definitions use the @platos/sdk API. They would
 * be defined in a Platos project that connects to the platform.
 * For the NestJS service, we call these tasks via the Platos API
 * using tasks.trigger() or tasks.triggerAndWait().
 */

// ═══════════════════════════════════════════════════════
// Task Definitions (for reference — deployed as trigger.dev tasks)
// ═══════════════════════════════════════════════════════

/**
 * Example task definition for a durable agent conversation:
 *
 * ```typescript
 * import { task, wait } from "@platos/sdk";
 *
 * export const agentConversation = task({
 *   id: "platos-agent-conversation",
 *   queue: {
 *     // One conversation at a time per thread
 *     concurrencyLimit: 1,
 *     concurrencyKey: "thread-${payload.threadId}",
 *   },
 *   retry: {
 *     maxAttempts: 3,
 *     factor: 2,
 *     minTimeoutInMs: 1000,
 *     maxTimeoutInMs: 10000,
 *   },
 *   run: async (payload: {
 *     message: string;
 *     threadId: string;
 *     orgId: string;
 *     userId: string;
 *     agentId: string;
 *   }) => {
 *     // 1. Load conversation history
 *     const history = await loadHistory(payload.threadId);
 *
 *     // 2. Call the agent (this is the LLM call)
 *     const result = await callAgent(payload.message, history, payload.agentId);
 *
 *     // 3. If approval needed, wait for user
 *     if (result.approvalNeeded) {
 *       const approval = await wait.forToken({
 *         id: `approval-${result.actionId}`,
 *         timeout: "5m",
 *       });
 *       // Task is PAUSED here — zero compute cost
 *       // Resumes when user clicks Approve
 *       if (approval.ok) {
 *         await executeApprovedTool(result.actionId, approval.output);
 *       }
 *     }
 *
 *     // 4. Store result
 *     await storeMessage(payload.threadId, result);
 *
 *     return result;
 *   },
 * });
 * ```
 */

import { env } from "../shared/env";

// ═══════════════════════════════════════════════════════
// NestJS Integration — calling trigger.dev tasks from the agent service
// ═══════════════════════════════════════════════════════

/**
 * TriggerIntegrationService — bridges NestJS agent runtime with trigger.dev.
 *
 * For operations that need durability:
 * - Calls trigger.dev tasks via the REST API
 * - Listens for task completion/streaming events
 * - Maps trigger.dev run states to agent stream events
 *
 * For real-time streaming (most conversations):
 * - The NestJS service handles it directly
 * - Only delegates to trigger.dev for long-running/approval tasks
 */
export interface TriggerConfig {
  apiUrl: string;     // trigger.dev webapp URL (e.g., http://localhost:3030)
  apiKey: string;     // API key for the trigger.dev project
  projectRef: string; // Project reference for task execution
}

export function getTriggerConfig(): TriggerConfig | null {
  const apiUrl = env.PLATOS_TRIGGER_API_URL;
  const apiKey = env.PLATOS_TRIGGER_API_KEY;
  const projectRef = env.PLATOS_TRIGGER_PROJECT_REF;

  if (!apiUrl || !apiKey || !projectRef) return null;

  return { apiUrl, apiKey, projectRef };
}

/**
 * Trigger a durable agent task via the trigger.dev API.
 * Returns the run ID for tracking.
 */
export async function triggerAgentTask(
  config: TriggerConfig,
  payload: {
    message: string;
    threadId: string;
    organizationId: string;
    projectId: string;
    environmentId: string;
    userId: string;
    agentId: string;
  },
): Promise<{ runId: string }> {
  const response = await fetch(`${config.apiUrl}/api/v1/tasks/platos-agent-conversation/trigger`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      payload,
      options: {
        // Trigger v4: `queue` must be a string queue name; concurrencyKey is
        // a top-level option (partitions the task's queue per thread).
        concurrencyKey: `thread-${payload.threadId}`,
        tags: [
          `org:${payload.organizationId}`,
          `project:${payload.projectId}`,
          `env:${payload.environmentId}`,
          `agent:${payload.agentId}`,
        ],
        metadata: {
          organizationId: payload.organizationId,
          projectId: payload.projectId,
          environmentId: payload.environmentId,
          userId: payload.userId,
          threadId: payload.threadId,
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Trigger API error: ${response.status}`);
  }

  const data = await response.json() as { id: string };
  return { runId: data.id };
}

/**
 * Complete a waitpoint token (for approval flows).
 * Called when the user clicks Approve on a pending tool call.
 */
export async function completeWaitToken(
  config: TriggerConfig,
  tokenId: string,
  output: Record<string, unknown> = {},
): Promise<void> {
  await fetch(`${config.apiUrl}/api/v1/waitpoints/tokens/${tokenId}/complete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({ output }),
  });
}
