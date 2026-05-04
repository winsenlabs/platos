import { schedules, logger, metadata } from "@platos/sdk/v3";
import { env } from "../shared/env";

/**
 * Daily attachment retention sweep (Theme D.8).
 *
 * Flow mirrors the LiteLLM cost catalog refresh:
 *   1. Scheduled task fires once per day.
 *   2. We call the webapp's admin endpoint
 *      `POST /api/v1/agent/attachments/retention` with the shared admin
 *      token. The webapp owns the MinIO client + PlatosMessageAttachment
 *      table, so the actual sweep logic lives there.
 *   3. The webapp deletes every row whose `expiresAt` has elapsed and
 *      best-effort-deletes the MinIO object. Transient unattached uploads
 *      default to a 7-day grace period; attached ones default to 30 days.
 *
 * Failure policy: never hard-fail. If the webapp is briefly down, we log
 * the error and emit a "stale" metric; the next run picks up what was
 * missed because `expiresAt` doesn't move.
 */

export const attachmentRetention = schedules.task({
  id: "platos.attachments.retention",
  description:
    "Sweeps expired multimodal attachments: deletes the MinIO object + PlatosMessageAttachment row.",
  cron: "17 3 * * *", // daily at 03:17 UTC (off-hours vs. cost refresh)
  maxDuration: 300,
  // EOBD.45 — singleton.
  queue: { concurrencyLimit: 1 },
  run: async () => {
    const WEBAPP_URL =
      env.PLATOS_WEBAPP_ADMIN_URL ||
      env.APP_ORIGIN ||
      "http://webapp:3000";
    const adminToken = env.PLATOS_ADMIN_TOKEN;

    if (!adminToken) {
      logger.warn("attachment-retention: PLATOS_ADMIN_TOKEN not set — skipping");
      metadata.set("status", "skipped");
      return { status: "skipped", reason: "PLATOS_ADMIN_TOKEN unset" };
    }

    try {
      const res = await fetch(
        `${WEBAPP_URL}/api/v1/agent/attachments/retention`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Platos-Admin-Token": adminToken,
          },
          body: JSON.stringify({ limit: 1000 }),
          signal: AbortSignal.timeout(60000),
        }
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`retention sweep failed: ${res.status} ${body.slice(0, 200)}`);
      }
      const result = (await res.json()) as {
        scanned?: number;
        deletedRows?: number;
        storageFailures?: number;
      };
      logger.info("attachment-retention: swept", result);
      metadata.set("status", "ok");
      metadata.set("scanned", result.scanned ?? 0);
      metadata.set("deletedRows", result.deletedRows ?? 0);
      metadata.set("storageFailures", result.storageFailures ?? 0);
      return { status: "ok", ...result };
    } catch (err: any) {
      logger.error("attachment-retention: failed", { error: err?.message });
      metadata.set("status", "error");
      metadata.set("error", err?.message);
      return { status: "error", error: err?.message };
    }
  },
});
