import { task, logger, metadata } from "@trigger.dev/sdk";
import {
  validatePublicUrl,
  describeUrlValidationError,
  fetchWithValidatedRedirects,
} from "../shared/url-validator";
const env = process.env;

/**
 * Theme H.7 — Budget alert delivery.
 *
 * Fired by the enforcement layer (BudgetService.detectThresholdCrossings)
 * the moment a budget cap's spend crosses a configured threshold. Each
 * invocation delivers:
 *   - A webhook POST to `alertWebhookUrl` (when configured).
 *   - An email to every entry in `alertEmails` (comma-separated).
 *
 * Trigger.dev chosen over a synchronous path so enforcement never blocks
 * on network flakiness or email outages — the agent turn continues
 * uninterrupted while alerts drain in the background.
 *
 * Idempotency: threshold-crossed state is persisted in Redis by the caller
 * (one SET per (capId, windowKey)), so this task is only invoked on the
 * first crossing. Re-running the task manually is safe — downstream
 * recipients may see duplicate alerts but the budget state is unaffected.
 */

export interface BudgetAlertPayload {
  capId: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  scopeType: "scope" | "agent" | "user";
  targetId: string;
  period: "day" | "week" | "month";
  threshold: number;
  limitCents: number;
  spentCents: number;
  runs: number;
  runsLimit: number;
  windowKey: string;
  alertWebhookUrl: string | null;
  alertEmails: string | null;
  /** Human label e.g. "Agent: support-bot" / "User: u_123" / "Scope-wide". */
  subjectLabel: string;
}

export const budgetAlert = task({
  id: "platos.budget.alert",
  maxDuration: 60,
  run: async (payload: BudgetAlertPayload) => {
    const startedAt = Date.now();
    const summary = {
      webhookDelivered: false,
      webhookStatus: null as number | null,
      webhookError: null as string | null,
      emailCount: 0,
      emailError: null as string | null,
    };

    metadata.set("capId", payload.capId);
    metadata.set("threshold", payload.threshold);
    metadata.set("scopeType", payload.scopeType);

    // Webhook delivery — best effort, swallow errors into metadata.
    if (payload.alertWebhookUrl) {
      // EOBD.9 — re-validate at fetch time to catch DNS rebinding
      // (same hostname, different resolved IP). The URL was also
      // validated on persist inside BudgetService.upsert, but that
      // was an earlier snapshot.
      const urlCheck = await validatePublicUrl(payload.alertWebhookUrl);
      if (!urlCheck.ok) {
        summary.webhookError = `blocked at dispatch: ${describeUrlValidationError(urlCheck.error)}`;
        summary.webhookDelivered = false;
        return summary;
      }
      try {
        const body = {
          event: "platos.budget.threshold_crossed",
          capId: payload.capId,
          scope: {
            organizationId: payload.organizationId,
            projectId: payload.projectId,
            environmentId: payload.environmentId,
          },
          scopeType: payload.scopeType,
          targetId: payload.targetId,
          period: payload.period,
          threshold: payload.threshold,
          spentCents: payload.spentCents,
          limitCents: payload.limitCents,
          runs: payload.runs,
          runsLimit: payload.runsLimit,
          windowKey: payload.windowKey,
          subjectLabel: payload.subjectLabel,
          firedAt: new Date().toISOString(),
        };
        // SECURITY (H11) — pin the validated IP into the socket. The webhook
        // URL is user-settable; a bare fetch re-resolves DNS and is rebindable
        // to IMDS/private space in the window after validatePublicUrl (above).
        const res = await fetchWithValidatedRedirects(payload.alertWebhookUrl, 3, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "platos-budget-alert/1.0",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
        summary.webhookDelivered = res.ok;
        summary.webhookStatus = res.status;
        if (!res.ok) {
          summary.webhookError = `status ${res.status}`;
        }
      } catch (err: any) {
        summary.webhookError = err?.message ?? String(err);
      }
    }

    // Email delivery — Platos does not itself ship an email transport;
    // rely on the trigger.dev runtime's standard email env vars. We POST
    // a structured email spec to the agent admin endpoint and let the
    // existing email infra handle transport. When EMAIL is not configured
    // we log + skip (no hard failure).
    if (payload.alertEmails) {
      const recipients = payload.alertEmails
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean);
      if (recipients.length > 0) {
        try {
          const subject = `[Platos] Budget ${payload.threshold}% — ${payload.subjectLabel}`;
          const lines = [
            `Platos budget alert`,
            ``,
            `${payload.subjectLabel} crossed ${payload.threshold}% of its ${payload.period}ly cap.`,
            `Spent so far: ${(payload.spentCents / 100).toFixed(2)} USD of ${(payload.limitCents / 100).toFixed(2)} USD`,
            payload.runsLimit > 0
              ? `Runs this window: ${payload.runs} of ${payload.runsLimit}`
              : null,
            ``,
            `Scope: org=${payload.organizationId}  project=${payload.projectId}  env=${payload.environmentId}`,
            `Window: ${payload.windowKey}`,
          ]
            .filter(Boolean)
            .join("\n");

          // Delegate to the agent admin email-send endpoint. If the
          // endpoint isn't wired, this surfaces as 404 — fine; we log
          // and move on.
          const AGENT_API_URL =
            env.PLATOS_AGENT_HTTP_URL ||
            env.PLATOS_AGENT_API_URL ||
            "http://localhost:3100";
          const adminToken = env.PLATOS_ADMIN_TOKEN;
          if (adminToken) {
            const res = await fetch(
              `${AGENT_API_URL}/api/v1/agent/monitoring/budget/email`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-Platos-Admin-Token": adminToken,
                },
                body: JSON.stringify({ recipients, subject, body: lines }),
                signal: AbortSignal.timeout(15_000),
              },
            );
            if (res.ok) {
              summary.emailCount = recipients.length;
            } else {
              summary.emailError = `email endpoint ${res.status}`;
            }
          } else {
            summary.emailError = "PLATOS_ADMIN_TOKEN unset";
          }
        } catch (err: any) {
          summary.emailError = err?.message ?? String(err);
        }
      }
    }

    const elapsed = Date.now() - startedAt;
    logger.info("budget-alert: delivered", { ...summary, elapsedMs: elapsed });
    metadata.set("elapsedMs", elapsed);
    return { ...summary, elapsedMs: elapsed };
  },
});
