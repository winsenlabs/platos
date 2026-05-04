/**
 * POST /api/v1/agent/attachments/retention
 *
 * Admin-only endpoint that runs one pass of the attachment retention sweep.
 * Called by the daily trigger.dev scheduled task (platos.attachments.retention).
 * Gated by `X-Platos-Admin-Token` — same pattern as the cost-catalog ingest
 * (see `apps/agent/src/agent-runtime/agent.controller.ts#ingestCostCatalog`).
 *
 * Response:
 *   200 { scanned, deletedRows, storageFailures }
 *   412 when admin token is unset in config (precondition failed — operator
 *       must configure the secret; silent-skip was masking unbounded growth).
 *   401 when the admin token is missing or wrong.
 */
import * as crypto from "node:crypto";
import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { runRetentionSweep } from "~/services/platosAttachments.server";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  // PPR-16: previously returned HTTP 200 {status: "skipped"} when
  // PLATOS_ADMIN_TOKEN was unset — the scheduled trigger.dev task saw
  // res.ok === true, logged status: ok, and the MinIO bucket filled
  // unbounded while monitoring looked healthy. Surface a real 412 so the
  // task logs an error and the operator notices.
  const expected = env.PLATOS_ADMIN_TOKEN;
  if (!expected) {
    logger.error(
      "PLATOS_ADMIN_TOKEN not configured — attachment retention sweep refusing to run. Set the env var on the webapp container.",
    );
    return json(
      {
        status: "error",
        code: "admin_token_unset",
        message:
          "PLATOS_ADMIN_TOKEN not configured on webapp. Retention sweep disabled until set.",
      },
      { status: 412 }
    );
  }

  // PPR-14: timing-safe compare.
  const provided = request.headers.get("x-platos-admin-token");
  const isValid =
    typeof provided === "string" &&
    provided.length === expected.length &&
    (() => {
      try {
        return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
      } catch {
        return false;
      }
    })();
  if (!isValid) {
    return json({ error: "forbidden" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { limit?: number };
  try {
    const result = await runRetentionSweep({ limit: body.limit });
    logger.info("Platos attachment retention sweep complete", result);
    return json({ status: "ok", ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Retention sweep failed";
    logger.error("Platos attachment retention sweep failed", { message });
    return json({ status: "error", error: message }, { status: 500 });
  }
}
