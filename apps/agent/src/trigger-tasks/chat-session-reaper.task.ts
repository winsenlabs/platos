import { schedules, logger, metadata } from "@trigger.dev/sdk";
const env = process.env;

/**
 * Durable chat session reaper.
 *
 * A durable chat thread maps 1:1 to a Trigger session (externalId === threadId,
 * task `platos.chat.session`). Trigger never closes these on its own, so without
 * a sweep they accumulate "Active" forever — one per chat thread, indefinitely.
 *
 * Every 30 minutes this pings the agent's admin endpoint
 * `POST /api/v1/agent/internal/chat/reap-sessions`, which invokes
 * `ConversationService.reapChatSessions()`. The service closes any session
 * whose conversation is done — thread archived/completed, idle past
 * `PLATOS_CHAT_SESSION_IDLE_MINUTES` (default 1440 = 24h), orphaned, or past
 * `PLATOS_CHAT_SESSION_MAX_AGE_HOURS` (default 168), skipping any session with a
 * live in-flight run. Resume-safe: a returning user to a closed thread hits
 * "Session is closed" on sessions.start and the gateway falls through to the
 * durable-turn / direct path, so the conversation still works.
 *
 * Why the indirection? This task runs inside trigger.dev's worker process — it
 * has no NestJS DI container, Prisma client, or Redis handle. The admin
 * endpoint owns the DB + Redis + scope. Mirrors the same admin-token dance as
 * the approvals-expiry-sweep / attachment-retention tasks.
 *
 * Failure policy: never hard-fail. A missed sweep just defers the close by ≤30
 * minutes; the next run re-derives everything from durable state.
 */
export const chatSessionReaper = schedules.task({
  id: "platos.chat.session_reaper",
  description:
    "Every 30 minutes, close durable chat sessions whose conversation is done (archived, idle, orphaned, or past max age).",
  cron: "*/30 * * * *",
  maxDuration: 120,
  // Singleton — two reapers racing is idempotent but wastes the admin budget.
  queue: { concurrencyLimit: 1 },
  run: async () => {
    const AGENT_API_URL =
      env.PLATOS_AGENT_HTTP_URL || env.PLATOS_AGENT_API_URL || "http://localhost:3100";
    const adminToken = env.PLATOS_INTERNAL_AUTH_TOKEN;

    if (!adminToken) {
      logger.warn("chat-session-reaper: PLATOS_INTERNAL_AUTH_TOKEN not set — skipping");
      metadata.set("status", "skipped");
      return { status: "skipped", reason: "PLATOS_INTERNAL_AUTH_TOKEN unset" };
    }

    try {
      const res = await fetch(`${AGENT_API_URL}/api/v1/agent/internal/chat/reap-sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Platos-Internal-Auth": adminToken,
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(110_000),
      });
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        logger.error("chat-session-reaper: agent endpoint failed", { httpStatus: res.status, json });
        metadata.set("status", "error");
        return { status: "error", httpStatus: res.status, body: json };
      }
      logger.info("chat-session-reaper: swept", json);
      metadata.set("status", "ok");
      metadata.set("closed", json?.closed ?? 0);
      return { status: "ok", ...json };
    } catch (e: any) {
      logger.error("chat-session-reaper: threw", { error: e?.message ?? String(e) });
      metadata.set("status", "error");
      return { status: "error", error: e?.message ?? String(e) };
    }
  },
});
