import { createHmac, randomUUID } from "node:crypto";
import { Injectable, Inject, Logger, Optional } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import {
  CredentialKind,
  authorizeEnvironmentRuntime,
  type Budget,
  type PlatosSecretStore,
  type Prisma,
} from "@platos/tenancy-database";
import {
  type ControlDatabaseClient,
  environmentScopeWhere,
  PLATOS_SECRET_STORE_TOKEN,
  PRISMA_TOKEN,
} from "../shared/database.provider";
import { REDIS_TOKEN } from "../shared/redis.provider";
import type Redis from "ioredis";
import type { RequestScope } from "../auth/scope.guard";
import {
  validatePublicUrl,
  describeUrlValidationError,
  fetchWithValidatedRedirects,
} from "../shared/url-validator";
import { RateLimitService } from "./rate-limit.service";
import type {
  BudgetAlertDeliverySummary,
  BudgetAlertPayload,
} from "./budget-alert.types";
import { ScopedEnvService } from "../providers/scoped-env.service";
import { sendAlertEmail } from "./alert-email-delivery";
import {
  billableCostFromRollup,
  ROLLUP_FIELD,
  usageFromRollup,
  type RollupHash,
} from "./usage-ledger";

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

export type BudgetScopeType = "scope" | "agent" | "user";
export type BudgetPeriod = "day" | "week" | "month";
/**
 * Theme SM.3 — Which spend bucket a cap governs.
 *   - "llm"   : model inference tokens/cost (default; preserves pre-SM.3 rows).
 *   - "skill" : skill-tool dispatches (SkillRuntimeService.checkSkillBudget).
 */
export type BudgetTier = "llm" | "skill";

export interface BudgetCap {
  id: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  scopeType: BudgetScopeType;
  targetId: string;
  period: BudgetPeriod;
  limitCents: number;
  runsLimit: number;
  alertThresholds: number[];
  alertWebhookUrl: string | null;
  alertEmails: string | null;
  overrideUntil: Date | null;
  overrideBy: string | null;
  enabled: boolean;
  /** Theme SM.3 — "llm" (default) | "skill". */
  tier: BudgetTier;
  /** Theme SM.3 — Skill-slug filter (null = all skills). Only meaningful when tier="skill". */
  skillSlug: string | null;
  /** Theme SM.3 — Agent-id filter (null = all agents). Composes with tier+skillSlug. */
  agentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Theme SM.3 — Result of a pre-dispatch spend check. */
export interface BudgetCheckResult {
  allowed: boolean;
  capHit?: {
    id: string;
    name: string;
    limitCents: number;
    currentCents: number;
    tier: BudgetTier;
    skillSlug: string | null;
    agentId: string | null;
  };
}

export interface BudgetStatus {
  cap: BudgetCap;
  windowKey: string;
  spentCents: number;
  runs: number;
  percent: number;
  runsPercent: number;
  blocked: boolean;
  overrideActive: boolean;
}

interface PersistedBudgetScope {
  scopeType: BudgetScopeType;
  targetId: string;
  tier: BudgetTier;
  skillSlug: string | null;
  alertWebhookUrl: string | null;
  alertEmails: string | null;
  overrideBy: string | null;
}

/**
 * Theme H.5 + H.6 + H.7 — Budget caps.
 *
 * CRUD + enforcement + alert-threshold tracking.
 *
 * Cost counters are sourced from the existing per-scope / per-agent cost
 * hashes the CostService maintains in Redis. This service adds:
 *   1. Per-user daily counter (`cost:user:<scopeKey>:<userId>:<day>`) —
 *      written from `recordCharge` alongside the existing scope/agent
 *      counters so user-level budgets have something to read.
 *   2. Window aggregation for week/month periods.
 *   3. Durable threshold events and per-channel delivery rows in PostgreSQL,
 *      so retries cannot create duplicate recipient deliveries.
 */
@Injectable()
export class BudgetService {
  private readonly logger = new Logger(BudgetService.name);
  private reconcilingDeliveries = false;

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient,
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
    @Optional() private readonly rateLimitService?: RateLimitService,
    @Optional()
    @Inject(PLATOS_SECRET_STORE_TOKEN)
    private readonly secretStore?: PlatosSecretStore,
    @Optional() private readonly scopedEnv?: ScopedEnvService,
  ) {}

  // ═══════════════════════════════════════════════════════
  // CRUD
  // ═══════════════════════════════════════════════════════

  async list(scope: ScopeTuple): Promise<BudgetCap[]> {
    const rows = await this.prisma.budget.findMany({
      where: {
        ...environmentScopeWhere(scope),
        deletedAt: null,
      },
      orderBy: [{ scope: "asc" }, { period: "asc" }],
    });
    return rows.map((row) => this.row(scope, row));
  }

  async getById(scope: ScopeTuple, id: string): Promise<BudgetCap | null> {
    const row = await this.prisma.budget.findFirst({
      where: {
        id,
        ...environmentScopeWhere(scope),
        deletedAt: null,
      },
    });
    return row ? this.row(scope, row) : null;
  }

  async upsert(
    scope: ScopeTuple,
    data: {
      scopeType: BudgetScopeType;
      /**
       * Target entity for this cap.
       *   - scopeType="scope"  → leave empty/blank — applies to everyone.
       *   - scopeType="agent"  → agentId string.
       *   - scopeType="user"   → specific userId string  OR  "*" (wildcard).
       *
       * When targetId="*" and scopeType="user" the cap becomes a
       * **default per-user cap**: it applies independently to every end-user
       * that sends a turn through this scope. Each user's spend is tracked
       * against their own Redis window — they cannot exhaust each other's
       * allowance.  This is the canonical way for an operator to say
       * "every user gets max $X/day" without knowing user IDs in advance.
       */
      targetId?: string;
      period: BudgetPeriod;
      limitCents: number;
      runsLimit?: number;
      alertThresholds?: number[];
      alertWebhookUrl?: string | null;
      alertEmails?: string | null;
      enabled?: boolean;
      /** Theme SM.3 — tier (defaults to "llm"). */
      tier?: BudgetTier;
      /** Theme SM.3 — only when tier="skill". */
      skillSlug?: string | null;
      /** Theme SM.3 — optional per-agent filter. */
      agentId?: string | null;
    },
  ): Promise<BudgetCap> {
    this.validate(data);
    // Wildcard "*" is the default per-user sentinel.  Only valid on user caps.
    if (data.targetId === "*" && data.scopeType !== "user") {
      throw new Error('targetId="*" wildcard is only valid for scopeType="user"');
    }
    // EOBD.9 — SSRF defence. If an admin sets alertWebhookUrl, refuse
    // to persist anything that resolves to a private / loopback /
    // link-local / cloud-metadata IP. Re-checked at fetch time in the
    // budget-alert trigger.dev task (defence-in-depth vs. DNS rebind).
    if (data.alertWebhookUrl != null && data.alertWebhookUrl.length > 0) {
      const check = await validatePublicUrl(data.alertWebhookUrl);
      if (!check.ok) {
        throw new Error(
          `alertWebhookUrl rejected: ${describeUrlValidationError(check.error)}`,
        );
      }
    }
    const targetId = data.targetId ?? "";
    // Use updateMany + create fallback to respect the composite unique
    // index without relying on compound upsert quirks.
    //
    // SM.3 Phase-2 fix — tier / skillSlug / agentId must be part of the
    // collision key. Without them, an LLM scope-wide cap and a skill
    // scope-wide cap at the same (scopeType, targetId, period) would alias
    // onto the same findFirst row — the second upsert would silently
    // overwrite the first. Tightening the where-clause lets tier/slug/agent
    // combinations coexist without touching the DB-level unique index.
    const tier = data.tier ?? "llm";
    const skillSlug = data.skillSlug ?? null;
    const agentId = data.agentId ?? null;
    const existing = (await this.list(scope)).find(
      (cap) =>
        cap.scopeType === data.scopeType &&
        cap.targetId === targetId &&
        cap.period === data.period &&
        cap.tier === tier &&
        cap.skillSlug === skillSlug &&
        cap.agentId === agentId,
    );
    const persistedScope: PersistedBudgetScope = {
      scopeType: data.scopeType,
      targetId,
      tier,
      skillSlug,
      alertWebhookUrl: data.alertWebhookUrl ?? null,
      alertEmails: data.alertEmails ?? null,
      overrideBy: existing?.overrideBy ?? null,
    };
    const payload: Prisma.BudgetUncheckedUpdateInput = {
      scope: this.encodeScope(persistedScope),
      limitCents: data.limitCents,
      turnsLimit: data.runsLimit ?? 0,
      alertThresholds: (data.alertThresholds ?? [50, 80, 100]) as Prisma.InputJsonValue,
      enabled: data.enabled ?? true,
      agentId,
    };
    if (existing) {
      const updated = await this.prisma.budget.update({
        where: { id: existing.id },
        data: payload,
      });
      return this.row(scope, updated);
    }
    const created = await this.prisma.budget.create({
      data: {
        environmentId: scope.environmentId,
        scope: this.encodeScope(persistedScope),
        period: data.period,
        limitCents: data.limitCents,
        turnsLimit: data.runsLimit ?? 0,
        alertThresholds: (data.alertThresholds ?? [50, 80, 100]) as Prisma.InputJsonValue,
        enabled: data.enabled ?? true,
        agentId,
      },
    });
    return this.row(scope, created);
  }

  async delete(scope: ScopeTuple, id: string): Promise<boolean> {
    const res = await this.prisma.budget.updateMany({
      where: {
        id,
        ...environmentScopeWhere(scope),
        deletedAt: null,
      },
      data: { enabled: false, deletedAt: new Date() },
    });
    return res.count > 0;
  }

  /**
   * Admin override — temporarily bump past-100% caps for N minutes. Records
   * who authorised it for audit. Re-calling with minutes=0 clears.
   */
  async override(
    scope: ScopeTuple,
    id: string,
    options: { minutes: number; userId: string },
  ): Promise<BudgetCap | null> {
    const cap = await this.getById(scope, id);
    if (!cap) return null;
    const until = options.minutes > 0 ? new Date(Date.now() + options.minutes * 60_000) : null;
    const metadata: PersistedBudgetScope = {
      scopeType: cap.scopeType,
      targetId: cap.targetId,
      tier: cap.tier,
      skillSlug: cap.skillSlug,
      alertWebhookUrl: cap.alertWebhookUrl,
      alertEmails: cap.alertEmails,
      overrideBy: cap.overrideBy,
    };
    const updated = await this.prisma.budget.update({
      where: { id },
      data: {
        overrideUntil: until,
        scope: this.encodeScope({
          ...metadata,
          overrideBy: until ? options.userId : null,
        }),
      },
    });
    return this.row(scope, updated);
  }

  // ═══════════════════════════════════════════════════════
  // Enforcement / status
  // ═══════════════════════════════════════════════════════

  /**
   * Record one completed turn against the per-user counter. Called right after
   * CostService.recordUsage so user-level budgets have a live source.
   *
   * WIN-134 — this used to ALSO bump `cost_cents` on the very key
   * `CostService.recordUsage` had just bumped with the same charge, so the
   * per-user naive total ran at exactly 2x while the cache-aware total ran at
   * 1x. Two writers, one field, and every per-user cost surface reading the
   * doubled one. CostService is now the sole writer of user cost; this method
   * owns the turn counter and nothing else.
   *
   * Idempotency: append-only like CostService — a rerun of a turn
   * double-counts. The Turn/Step ledger in Postgres remains the durable
   * source; this Redis counter is the fast path for budget checks.
   */
  async recordUserSpend(
    scope: ScopeTuple,
    userId: string,
    costCents: number,
  ): Promise<void> {
    if (!userId || costCents <= 0) return;
    const s = this.scopeKey(scope);
    const today = new Date().toISOString().slice(0, 10);
    const key = `cost:user:${s}:${userId}:${today}`;
    const pipeline = this.redis.pipeline();
    pipeline.hincrby(key, ROLLUP_FIELD.legacyTasks, 1);
    pipeline.expire(key, 86400 * 90);
    await pipeline.exec();
  }

  /**
   * Evaluate every active cap for a scope + agent + user and return the
   * maximum-utilisation rollup. The hard-stop check uses
   * `anyBlocked = caps.some(c => c.blocked)`. Fail-open on query errors —
   * this call is in the hot path and must not stall a turn on a Redis blip.
   */
  async evaluate(
    scope: ScopeTuple,
    ctx: { agentId?: string; userId?: string },
  ): Promise<{ caps: BudgetStatus[]; blocked: boolean; reason?: string }> {
    let caps: BudgetCap[];
    try {
      caps = await this.list(scope);
    } catch {
      return { caps: [], blocked: false };
    }
    const statuses: BudgetStatus[] = [];
    for (const cap of caps) {
      if (!cap.enabled) continue;
      // Skip caps whose target doesn't match the request context.
      if (cap.scopeType === "agent" && cap.targetId !== (ctx.agentId ?? "")) continue;
      if (cap.scopeType === "user") {
        const isWildcard = cap.targetId === "*";
        // Wildcard: applies to every user — don't skip, but we need userId to
        // read the correct per-user window below.  Specific: must match caller.
        if (!isWildcard && cap.targetId !== (ctx.userId ?? "")) continue;
        // No userId in context means we can't evaluate a wildcard per-user cap.
        if (isWildcard && !ctx.userId) continue;
      }

      const { spentCents, runs } = await this.readWindow(scope, cap, ctx);
      const pct = cap.limitCents > 0 ? (spentCents / cap.limitCents) * 100 : 0;
      const runsPct = cap.runsLimit > 0 ? (runs / cap.runsLimit) * 100 : 0;
      const overrideActive =
        !!cap.overrideUntil && cap.overrideUntil.getTime() > Date.now();
      const costHard = cap.limitCents > 0 && spentCents >= cap.limitCents;
      const runsHard = cap.runsLimit > 0 && runs >= cap.runsLimit;
      const blocked = (costHard || runsHard) && !overrideActive;
      statuses.push({
        cap,
        windowKey: this.windowKey(cap.period),
        spentCents,
        runs,
        percent: Number(pct.toFixed(2)),
        runsPercent: Number(runsPct.toFixed(2)),
        blocked,
        overrideActive,
      });
    }
    const blocker = statuses.find((s) => s.blocked);
    return {
      caps: statuses,
      blocked: !!blocker,
      reason: blocker
        ? `Budget cap exceeded: ${blocker.cap.scopeType}/${blocker.cap.period} — ${blocker.spentCents.toFixed(2)}¢ of ${blocker.cap.limitCents}¢`
        : undefined,
    };
  }

  /**
   * Evaluate pending threshold crossings for a cap × window. Returns the
   * list of thresholds that just crossed (i.e. were not crossed on a prior
   * call and are crossed now). Threshold-crossed state is persisted in a
   * PostgreSQL event per (capId, windowKey, threshold), so alerts fire exactly
   * once per transition even after Redis expiry or process restart.
   */
  async detectThresholdCrossings(
    scope: ScopeTuple,
    status: BudgetStatus,
  ): Promise<Array<{ id: string; threshold: number }>> {
    const crossed: Array<{ id: string; threshold: number }> = [];
    const thresholds = [...(status.cap.alertThresholds ?? [50, 80, 100])].sort((a, b) => a - b);
    for (const threshold of thresholds) {
      if (status.percent >= threshold || status.runsPercent >= threshold) {
        try {
          const event = await this.prisma.$transaction(async (tx) => {
            const created = await tx.budgetThresholdEvent.create({
              data: {
                environmentId: scope.environmentId,
                budgetId: status.cap.id,
                windowKey: status.windowKey,
                threshold,
                spentCents: status.spentCents,
                runs: status.runs,
              },
            });
            const channels = await tx.alertChannel.findMany({
              where: {
                environmentId: scope.environmentId,
                enabled: true,
                deletedAt: null,
                alertTypes: { has: "BUDGET" },
              },
              select: { id: true },
            });
            if (channels.length > 0) {
              await tx.alertDelivery.createMany({
                data: channels.map((channel) => ({
                  environmentId: scope.environmentId,
                  channelId: channel.id,
                  budgetThresholdEventId: created.id,
                  kind: "BUDGET",
                  idempotencyKey: `budget:${created.id}:${channel.id}`,
                })),
                skipDuplicates: true,
              });
            }
            return created;
          });
          crossed.push({ id: event.id, threshold });
        } catch (error: unknown) {
          if ((error as { code?: string })?.code !== "P2002") throw error;
        }
      }
    }
    return crossed;
  }

  /**
   * Claims and delivers every canonical channel row for one durable threshold
   * event. Successful rows are immutable from the dispatcher's perspective and
   * are skipped on retry; failed rows remain visible and make the callback fail.
   */
  async deliverThresholdEvent(payload: BudgetAlertPayload): Promise<BudgetAlertDeliverySummary> {
    const event = await this.prisma.budgetThresholdEvent.findFirst({
      where: {
        id: payload.eventId,
        environmentId: payload.environmentId,
        budgetId: payload.capId,
        budget: {
          environment: {
            projectId: payload.projectId,
            project: { organizationId: payload.organizationId },
          },
        },
      },
      select: { id: true },
    });
    if (!event) throw new Error("budget_threshold_event_unavailable");

    const deliveries = await this.prisma.alertDelivery.findMany({
      where: {
        budgetThresholdEventId: event.id,
        environmentId: payload.environmentId,
      },
      orderBy: { createdAt: "asc" },
      include: { channel: { include: { configuration: true } } },
    });
    const summary: BudgetAlertDeliverySummary = {
      delivered: 0,
      failed: 0,
      skipped: 0,
      attempts: [],
    };

    for (const delivery of deliveries) {
      if (delivery.status === "SUCCEEDED") {
        summary.skipped += 1;
        summary.attempts.push({
          deliveryId: delivery.id,
          channelId: delivery.channelId,
          type: delivery.channel.type,
          status: "SKIPPED",
          statusCode: delivery.lastStatusCode,
          errorCode: null,
        });
        continue;
      }

      const now = new Date();
      const claimToken = randomUUID();
      const claimed = await this.prisma.alertDelivery.updateMany({
        where: {
          id: delivery.id,
          environmentId: payload.environmentId,
          OR: [
            { status: "PENDING", availableAt: { lte: now } },
            { status: "FAILED", availableAt: { lte: now } },
            { status: "PROCESSING", availableAt: { lte: now } },
          ],
        },
        data: {
          status: "PROCESSING",
          availableAt: new Date(now.getTime() + 2 * 60_000),
          lastAttemptAt: now,
          claimToken,
          claimGeneration: { increment: 1 },
          attemptCount: { increment: 1 },
        },
      });
      if (claimed.count !== 1) {
        summary.skipped += 1;
        summary.attempts.push({
          deliveryId: delivery.id,
          channelId: delivery.channelId,
          type: delivery.channel.type,
          status: "SKIPPED",
          statusCode: delivery.lastStatusCode,
          errorCode: "delivery_unavailable",
        });
        continue;
      }

      const claim = await this.prisma.alertDelivery.findFirstOrThrow({
        where: { id: delivery.id, environmentId: payload.environmentId, claimToken },
        select: { attemptCount: true, claimGeneration: true },
      });
      const result = await this.deliverChannel(delivery.id, delivery.channel, payload);
      const finalized = await this.finishDeliveryAttempt(
        delivery.id,
        payload.environmentId,
        claimToken,
        claim.claimGeneration,
        claim.attemptCount,
        result,
      );
      if (!finalized) {
        summary.skipped += 1;
        summary.attempts.push({
          deliveryId: delivery.id,
          channelId: delivery.channelId,
          type: delivery.channel.type,
          status: "SKIPPED",
          statusCode: null,
          errorCode: "stale_claim",
        });
        continue;
      }
      summary.attempts.push({
        deliveryId: delivery.id,
        channelId: delivery.channelId,
        type: delivery.channel.type,
        status: result.ok ? "SUCCEEDED" : "FAILED",
        statusCode: result.statusCode,
        errorCode: result.errorCode,
      });
      if (result.ok) summary.delivered += 1;
      else summary.failed += 1;
    }

    if (summary.failed > 0) {
      throw new BudgetAlertDeliveryError(summary);
    }
    return summary;
  }

  private async deliverChannel(
    deliveryId: string,
    channel: any,
    payload: BudgetAlertPayload,
  ): Promise<AlertDeliveryResult> {
    const config = channel.configuration;
    if (!channel.enabled) return deliveryFailed("channel_disabled", "Channel is disabled");
    if (!config) return deliveryFailed("missing_configuration", "Channel configuration is unavailable");

    if (channel.type === "EMAIL") {
      if (!config.email || !this.scopedEnv) {
        return deliveryFailed("missing_configuration", "Email configuration is incomplete");
      }
      return sendAlertEmail({
        resolveVariable: (name) => this.scopedEnv!.get({
          organizationId: payload.organizationId,
          projectId: payload.projectId,
          environmentId: payload.environmentId,
        }, name),
        to: config.email,
        subject: `Platos budget alert: ${payload.threshold}% threshold crossed`,
        text: budgetAlertText(payload),
        idempotencyKey: deliveryId,
      });
    }

    if (channel.type === "WEBHOOK") {
      if (!config.webhookUrl || !config.credentialId || !this.secretStore) {
        return deliveryFailed("missing_configuration", "Webhook configuration is incomplete");
      }
      const checked = await validatePublicUrl(config.webhookUrl);
      if (!checked.ok) {
        return deliveryFailed("url_blocked", describeUrlValidationError(checked.error));
      }
      try {
        const runtime = await authorizeEnvironmentRuntime(this.prisma, {
          actorId: `budget-alert:${payload.eventId}`,
          environmentId: payload.environmentId,
        });
        const secret = await this.secretStore.readForRuntime({
          authorization: runtime,
          credentialId: config.credentialId,
          kind: CredentialKind.CHANNEL_SECRET,
        });
        const body = JSON.stringify({
          event: "platos.budget.threshold_crossed",
          eventId: payload.eventId,
          deliveryId,
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
        });
        const response = await fetchWithValidatedRedirects(config.webhookUrl, 3, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "platos-budget-alert/2.0",
            "Idempotency-Key": deliveryId,
            "x-trigger-signature-hmacsha256": createHmac("sha256", secret.reveal())
              .update(body)
              .digest("hex"),
          },
          body,
          signal: AbortSignal.timeout(15_000),
        });
        return response.ok
          ? { ok: true, statusCode: response.status, errorCode: null, errorMessage: null }
          : deliveryFailed("webhook_http_error", `status ${response.status}`, response.status);
      } catch {
        return deliveryFailed("webhook_fetch_failed", "Webhook request failed");
      }
    }

    if (!config.credentialId || !config.slackChannelId || !this.secretStore) {
      return deliveryFailed("missing_configuration", "Slack token or channel is missing");
    }
    try {
      const runtime = await authorizeEnvironmentRuntime(this.prisma, {
        actorId: `budget-alert:${payload.eventId}`,
        environmentId: payload.environmentId,
      });
      const token = await this.secretStore.readForRuntime({
        authorization: runtime,
        credentialId: config.credentialId,
        kind: CredentialKind.CHANNEL_SECRET,
      });
      const response = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.reveal()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel: config.slackChannelId,
          text: budgetAlertText(payload),
          client_msg_id: deliveryId,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const responseBody = (await response.json()) as { ok?: boolean; error?: string };
      return response.ok && responseBody.ok
        ? { ok: true, statusCode: response.status, errorCode: null, errorMessage: null }
        : deliveryFailed("slack_api_error", responseBody.error ?? `status ${response.status}`, response.status);
    } catch {
      return deliveryFailed("slack_fetch_failed", "Slack request failed");
    }
  }

  private async finishDeliveryAttempt(
    deliveryId: string,
    environmentId: string,
    claimToken: string,
    claimGeneration: number,
    attemptNumber: number,
    result: AlertDeliveryResult,
  ): Promise<boolean> {
    const finishedAt = new Date();
    return this.prisma.$transaction(async (tx) => {
      const finalized = await tx.alertDelivery.updateMany({
        where: {
          id: deliveryId,
          environmentId,
          status: "PROCESSING",
          claimToken,
          claimGeneration,
          attemptCount: attemptNumber,
        },
        data: {
          status: result.ok ? "SUCCEEDED" : "FAILED",
          claimToken: null,
          availableAt: result.ok ? finishedAt : new Date(finishedAt.getTime() + 30_000),
          lastAttemptAt: finishedAt,
          deliveredAt: result.ok ? finishedAt : null,
          lastStatusCode: result.statusCode,
          lastErrorCode: result.errorCode,
          lastErrorMessage: result.errorMessage,
        },
      });
      if (finalized.count !== 1) return false;
      await tx.alertDeliveryAttempt.create({
        data: {
          environmentId,
          deliveryId,
          attemptNumber,
          status: result.ok ? "SUCCEEDED" : "FAILED",
          responseStatus: result.statusCode,
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
          finishedAt,
        },
      });
      return true;
    });
  }

  /** PostgreSQL-backed delivery reconciler; independent of threshold detection and Trigger availability. */
  @Cron("*/10 * * * * *")
  async reconcileDueDeliveries(options: { eventIds?: string[]; limit?: number } = {}): Promise<{
    processed: number;
    failed: number;
  }> {
    if (this.reconcilingDeliveries) return { processed: 0, failed: 0 };
    this.reconcilingDeliveries = true;
    try {
      const due = await this.prisma.alertDelivery.findMany({
        where: {
          kind: "BUDGET",
          budgetThresholdEventId: options.eventIds ? { in: options.eventIds } : { not: null },
          status: { in: ["PENDING", "FAILED", "PROCESSING"] },
          availableAt: { lte: new Date() },
        },
        distinct: ["budgetThresholdEventId"],
        orderBy: { availableAt: "asc" },
        take: options.limit ?? 50,
        select: {
          thresholdEvent: {
            select: {
              id: true,
              threshold: true,
              spentCents: true,
              runs: true,
              windowKey: true,
              budget: {
                select: {
                  id: true,
                  scope: true,
                  period: true,
                  limitCents: true,
                  turnsLimit: true,
                  environment: {
                    select: { id: true, project: { select: { id: true, organizationId: true } } },
                  },
                },
              },
            },
          },
        },
      });
      let processed = 0;
      let failed = 0;
      for (const row of due) {
        const event = row.thresholdEvent;
        if (!event) continue;
        const budget = event.budget;
        const metadata = this.decodeScope(budget);
        try {
          await this.deliverThresholdEvent({
            eventId: event.id,
            capId: budget.id,
            organizationId: budget.environment.project.organizationId,
            projectId: budget.environment.project.id,
            environmentId: budget.environment.id,
            scopeType: metadata.scopeType,
            targetId: metadata.targetId,
            period: budget.period as BudgetPeriod,
            threshold: event.threshold,
            limitCents: budget.limitCents,
            spentCents: event.spentCents,
            runs: event.runs,
            runsLimit: budget.turnsLimit ?? 0,
            windowKey: event.windowKey,
            subjectLabel: metadata.scopeType === "agent"
              ? `Agent: ${metadata.targetId}`
              : metadata.scopeType === "user"
                ? `User: ${metadata.targetId}`
                : "Scope-wide",
          });
          processed += 1;
        } catch (error) {
          failed += 1;
          this.logger.error(
            `budget alert reconciliation failed event=${event.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return { processed, failed };
    } finally {
      this.reconcilingDeliveries = false;
    }
  }

  // ═══════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════

  private async readWindow(
    scope: ScopeTuple,
    cap: BudgetCap,
    ctx: { agentId?: string; userId?: string },
  ): Promise<{ spentCents: number; runs: number }> {
    const s = this.scopeKey(scope);
    const dates = this.windowDates(cap.period);
    const keys = dates.map((d) => {
      if (cap.scopeType === "agent") {
        return `cost:agent:${s}:${cap.targetId}:${d}`;
      }
      if (cap.scopeType === "user") {
        // Wildcard caps ("*") track each user independently using their own
        // Redis key.  Specific caps use the stored targetId directly.
        const userId = cap.targetId === "*" ? (ctx.userId ?? "") : cap.targetId;
        return `cost:user:${s}:${userId}:${d}`;
      }
      return `cost:scope:${s}:${d}`;
    });
    // PRELAUNCH-A3-7 — also read the matching :reserved keys so the budget
    // evaluator includes in-flight (reserved-but-not-yet-settled) spend
    // when comparing to the cap. Without this, two concurrent turns from
    // the same user across different threads both see "under cap" + both
    // proceed past the gate.
    const reservedKeys = keys.map((k) => `${k}:reserved`);

    const pipeline = this.redis.pipeline();
    for (const k of keys) pipeline.hgetall(k);
    for (const k of reservedKeys) pipeline.hgetall(k);
    const results = await pipeline.exec();
    let spentCents = 0;
    let runs = 0;
    const spentEntries = results?.slice(0, keys.length) ?? [];
    const reservedEntries = results?.slice(keys.length) ?? [];
    for (const entry of spentEntries) {
      const raw = (entry?.[1] as RollupHash | undefined) ?? {};
      // WIN-134 — enforcement reads the CACHE-AWARE figure. It read
      // `cost_cents` directly, which prices fresh input and output only:
      // measured 2.47c against 25.70c actual, so a cap could not trip. The
      // ledger owns the preference so this cannot drift back.
      spentCents += billableCostFromRollup(raw);
      // A run limit counts completed turns, not model calls. `calls` is bumped
      // by embeddings, compaction and thread auto-naming too, so reading it
      // here made a runs-cap trip on work the user never asked for.
      runs += usageFromRollup(raw).tasks;
    }
    let reservedCents = 0;
    for (const entry of reservedEntries) {
      const raw = (entry?.[1] as RollupHash | undefined) ?? {};
      const r = billableCostFromRollup(raw);
      // Clamp negatives — over-settlement bug shouldn't drive the counter
      // negative and hide real spend from the cap evaluation.
      if (r > 0) reservedCents += r;
    }
    return { spentCents: spentCents + reservedCents, runs };
  }

  private windowDates(period: BudgetPeriod): string[] {
    const today = new Date();
    const dates: string[] = [];
    if (period === "day") {
      dates.push(today.toISOString().slice(0, 10));
      return dates;
    }
    if (period === "week") {
      // Rolling 7-day window
      for (let i = 0; i < 7; i++) {
        const d = new Date(today.getTime() - i * 86400_000);
        dates.push(d.toISOString().slice(0, 10));
      }
      return dates;
    }
    // month: calendar month so overrides align with billing expectation
    const year = today.getUTCFullYear();
    const month = today.getUTCMonth();
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    for (let day = 1; day <= daysInMonth; day++) {
      const d = new Date(Date.UTC(year, month, day));
      if (d.getTime() > today.getTime()) break;
      dates.push(d.toISOString().slice(0, 10));
    }
    return dates;
  }

  private windowKey(period: BudgetPeriod): string {
    const today = new Date();
    if (period === "day") return today.toISOString().slice(0, 10);
    if (period === "week") {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - d.getUTCDay());
      return `W${d.toISOString().slice(0, 10)}`;
    }
    return `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  private scopeKey(scope: ScopeTuple): string {
    return `${scope.organizationId}:${scope.projectId}:${scope.environmentId}`;
  }

  private validate(data: {
    scopeType: string;
    period: string;
    limitCents: number;
    alertThresholds?: number[];
    tier?: string;
    skillSlug?: string | null;
  }) {
    if (!["scope", "agent", "user"].includes(data.scopeType)) {
      throw new Error(`invalid scopeType: ${data.scopeType}`);
    }
    if (!["day", "week", "month"].includes(data.period)) {
      throw new Error(`invalid period: ${data.period}`);
    }
    if (!Number.isFinite(data.limitCents) || data.limitCents < 0) {
      throw new Error(`invalid limitCents: ${data.limitCents}`);
    }
    if (data.alertThresholds) {
      for (const t of data.alertThresholds) {
        if (!Number.isFinite(t) || t <= 0 || t > 200) {
          throw new Error(`invalid alert threshold: ${t}`);
        }
      }
    }
    // Theme SM.3 — tier validation. Unset defaults to "llm" at the
    // persistence layer; reject anything else.
    if (data.tier !== undefined && !["llm", "skill"].includes(data.tier)) {
      throw new Error(`invalid tier: ${data.tier}`);
    }
    // Theme SM.3 — skillSlug only meaningful for tier="skill". If someone
    // sets it on a tier="llm" cap that's almost certainly a mistake; reject
    // rather than silently ignore.
    if (
      data.skillSlug &&
      data.tier !== undefined &&
      data.tier !== "skill"
    ) {
      throw new Error(
        `skillSlug only valid on tier="skill" caps (got tier=${data.tier})`,
      );
    }
  }

  private row(scope: ScopeTuple, r: Budget): BudgetCap {
    const metadata = this.decodeScope(r);
    return {
      id: r.id,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: r.environmentId,
      scopeType: metadata.scopeType,
      targetId: metadata.targetId,
      period: r.period as BudgetPeriod,
      limitCents: r.limitCents,
      runsLimit: r.turnsLimit ?? 0,
      alertThresholds: Array.isArray(r.alertThresholds)
        ? r.alertThresholds.filter(
            (threshold): threshold is number => typeof threshold === "number",
          )
        : [50, 80, 100],
      alertWebhookUrl: metadata.alertWebhookUrl,
      alertEmails: metadata.alertEmails,
      overrideUntil: r.overrideUntil,
      overrideBy: metadata.overrideBy,
      enabled: r.enabled,
      // Theme SM.3 — new columns default at the schema level but we handle
      // pre-migration reads defensively so unit tests running against an
      // older DB don't blow up.
      tier: metadata.tier,
      skillSlug: metadata.skillSlug,
      agentId: r.agentId ?? null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  private encodeScope(scope: PersistedBudgetScope): string {
    return JSON.stringify(scope);
  }

  private decodeScope(row: Pick<Budget, "scope">): PersistedBudgetScope {
    try {
      const parsed = JSON.parse(row.scope) as Partial<PersistedBudgetScope>;
      if (
        parsed.scopeType === "scope" ||
        parsed.scopeType === "agent" ||
        parsed.scopeType === "user"
      ) {
        return {
          scopeType: parsed.scopeType,
          targetId: parsed.targetId ?? "",
          tier: parsed.tier === "skill" ? "skill" : "llm",
          skillSlug: parsed.skillSlug ?? null,
          alertWebhookUrl: parsed.alertWebhookUrl ?? null,
          alertEmails: parsed.alertEmails ?? null,
          overrideBy: parsed.overrideBy ?? null,
        };
      }
    } catch {
      // Canonical rows written outside this adapter use the scope string itself.
    }
    return {
      scopeType: "scope",
      targetId: "",
      tier: "llm",
      skillSlug: null,
      alertWebhookUrl: null,
      alertEmails: null,
      overrideBy: null,
    };
  }

  // ═══════════════════════════════════════════════════════
  // Theme SM.3 — pre-dispatch tier-aware cap check
  // ═══════════════════════════════════════════════════════

  /**
   * Evaluate whether an upcoming spend event is allowed under the most
   * specific matching cap. Used by:
   *   - SkillRuntimeService before firing a skill tool (tier="skill").
   *   - Future tiers (bgo, tool) plug in with no further schema work.
   *
   * Resolution order — first match wins (most specific → least specific):
   *   1. tier + skillSlug + agentId
   *   2. tier + skillSlug  (any agent)
   *   3. tier              (any skill, any agent)  — skillSlug=null,
   *                                                   agentId=null
   *   4. tier + agentId    (any skill)
   *   5. (legacy) scope-wide fallback — handled by caller, not here.
   *
   * Checks only the specified tier. Callers asking for tier="skill" will
   * never be blocked by a tier="llm" cap, and vice versa.
   *
   * Fail-open — any query error returns `allowed: true`. This call sits in
   * the hot path; a Redis/Postgres blip must not lock tool dispatch.
   */
  async checkCap(
    scope: ScopeTuple,
    filters: { tier: BudgetTier; skillSlug?: string | null; agentId?: string | null },
    amountCents: number,
  ): Promise<BudgetCheckResult> {
    try {
      const rows = await this.prisma.budget.findMany({
        where: {
          ...environmentScopeWhere(scope),
          enabled: true,
        },
      });
      const caps = rows
        .map((row) => this.row(scope, row))
        .filter((cap) => cap.tier === filters.tier);
      const agentId = filters.agentId ?? null;
      const skillSlug = filters.skillSlug ?? null;

      // Build the candidate ladder in order of most specific → least
      // specific. Each predicate filters the `caps` pool; first non-empty
      // level wins the "most specific" tier and we pick the first cap there
      // whose current spend + amountCents would exceed the limit.
      const ladder: Array<(c: BudgetCap) => boolean> = [
        (c) =>
          c.skillSlug === skillSlug &&
          skillSlug !== null &&
          c.agentId === agentId &&
          agentId !== null,
        (c) => c.skillSlug === skillSlug && skillSlug !== null && c.agentId === null,
        (c) => c.skillSlug === null && c.agentId === agentId && agentId !== null,
        (c) => c.skillSlug === null && c.agentId === null,
      ];

      for (const pred of ladder) {
        const matches = caps.filter(pred);
        if (matches.length === 0) continue;
        for (const cap of matches) {
          const overrideActive =
            !!cap.overrideUntil && cap.overrideUntil.getTime() > Date.now();
          if (overrideActive) continue;
          const currentCents = await this.readTierWindow(scope, cap);
          const projected = currentCents + Math.max(0, amountCents);
          if (cap.limitCents > 0 && projected >= cap.limitCents) {
            return {
              allowed: false,
              capHit: {
                id: cap.id,
                name: this.capLabel(cap),
                limitCents: cap.limitCents,
                currentCents,
                tier: cap.tier,
                skillSlug: cap.skillSlug,
                agentId: cap.agentId,
              },
            };
          }
        }
        // Most-specific tier evaluated and nothing blocked — stop.
        // "First match wins" for resolution: we don't cascade to the next
        // level when this one has non-blocking caps. This keeps the
        // mental model predictable ("the most specific cap governs").
        return { allowed: true };
      }
      return { allowed: true };
    } catch (err: any) {
      // Fail-open. Log at warn via the NestJS logger once Logger wiring lands
      // — today BudgetService has no Logger field. Callers should also log
      // on their side since they know the context (e.g. which skill/tool).
      void err;
      return { allowed: true };
    }
  }

  /**
   * Read the per-tier running spend total for a cap's current window.
   *
   * Keys match the writer in `CostService.recordSkillUsage`:
   *   `cost:<tier>:<scope>:<skillSlug|"">:<agentId|"">:<day>` → `cost_cents`
   *
   * Empty-segment placeholder (not `_any`) is used for the missing dimension
   * so the key shape the writer fans out to is identical to the one the
   * ladder looks up here. An LLM-tier read falls back to 0 (LLM spend still
   * rolls up via the pre-existing per-scope keys — this tier-aware reader is
   * only meaningful for skill-tier caps today).
   */
  private async readTierWindow(scope: ScopeTuple, cap: BudgetCap): Promise<number> {
    if (cap.tier !== "skill") return 0;
    const s = this.scopeKey(scope);
    const dates = this.windowDates(cap.period);
    const slug = cap.skillSlug ?? "";
    const agent = cap.agentId ?? "";
    const keys = dates.map((d) => `cost:skill:${s}:${slug}:${agent}:${d}`);
    const pipeline = this.redis.pipeline();
    for (const k of keys) pipeline.hgetall(k);
    const results = await pipeline.exec();
    let spentCents = 0;
    for (const entry of results ?? []) {
      const raw = (entry?.[1] as RollupHash | undefined) ?? {};
      spentCents += billableCostFromRollup(raw);
    }
    return spentCents;
  }

  private capLabel(cap: BudgetCap): string {
    const parts: string[] = [`${cap.tier}`];
    if (cap.skillSlug) parts.push(`skill=${cap.skillSlug}`);
    if (cap.agentId) parts.push(`agent=${cap.agentId}`);
    parts.push(`${cap.period}/${cap.limitCents}¢`);
    return parts.join(" ");
  }

  // ═══════════════════════════════════════════════════════
  // PRELAUNCH-A3-1 — per-user consumption summary
  // ═══════════════════════════════════════════════════════

  /**
   * Aggregate every cap that applies to (scope, userId) into a single
   * payload the Users monitoring tab can render as a drawer of progress
   * bars + breached badges. Also folds in the live rate-limit counters
   * (PRELAUNCH-A3-15 — wires up the previously-dead RateLimitService.peek).
   *
   * Includes:
   *   - User-scope wildcard caps (`scopeType="user"`, `targetId="*"`).
   *   - User-specific caps (`scopeType="user"`, `targetId=<userId>`).
   *   - Org-wide caps (`scopeType="scope"`) — surfaced for context even
   *     though they apply to everyone (helpful when an admin is trying
   *     to figure out why a single user is being throttled).
   *
   * Fail-graceful: any storage hiccup returns a structurally valid result
   * with `caps: []` + `rateLimit: null` rather than throwing.
   */
  async getUserConsumptionSummary(
    scope: ScopeTuple,
    userId: string,
  ): Promise<{
    userId: string;
    blocked: boolean;
    reason: string | null;
    caps: BudgetStatus[];
    rateLimit: { minute: number; hour: number; day: number } | null;
    rateLimited: boolean;
    fetchedAt: string;
  }> {
    const fetchedAt = new Date().toISOString();
    let caps: BudgetCap[] = [];
    try {
      caps = await this.list(scope);
    } catch {
      caps = [];
    }
    const statuses: BudgetStatus[] = [];
    for (const cap of caps) {
      if (!cap.enabled) continue;
      // Skill / non-LLM tiers are computed per-skill; we surface them
      // only when they're scope-wide (no skillSlug filter) so the user
      // drawer doesn't drown in per-skill rows.
      if (cap.tier !== "llm" && cap.skillSlug) continue;
      // Filter to caps that meaningfully apply to this user:
      //   - scope-wide caps (every user inherits)
      //   - user-wildcard caps
      //   - user-specific caps that match userId
      const isUserCap = cap.scopeType === "user";
      const isScopeWide = cap.scopeType === "scope";
      const isAgentCap = cap.scopeType === "agent";
      if (!isScopeWide && !isUserCap && !isAgentCap) continue;
      if (isUserCap) {
        const isWildcard = cap.targetId === "*";
        if (!isWildcard && cap.targetId !== userId) continue;
      }

      const ctx = isUserCap || isScopeWide ? { userId } : { agentId: cap.targetId, userId };
      let spentCents = 0;
      let runs = 0;
      try {
        ({ spentCents, runs } = await this.readWindow(scope, cap, ctx));
      } catch {
        // Skip the cap on read failure; consumer should still see the
        // other caps without an outright error.
        continue;
      }
      const pct = cap.limitCents > 0 ? (spentCents / cap.limitCents) * 100 : 0;
      const runsPct = cap.runsLimit > 0 ? (runs / cap.runsLimit) * 100 : 0;
      const overrideActive =
        !!cap.overrideUntil && cap.overrideUntil.getTime() > Date.now();
      const costHard = cap.limitCents > 0 && spentCents >= cap.limitCents;
      const runsHard = cap.runsLimit > 0 && runs >= cap.runsLimit;
      const blocked = (costHard || runsHard) && !overrideActive;
      statuses.push({
        cap,
        windowKey: this.windowKey(cap.period),
        spentCents,
        runs,
        percent: Number(pct.toFixed(2)),
        runsPercent: Number(runsPct.toFixed(2)),
        blocked,
        overrideActive,
      });
    }
    const blocker = statuses.find((s) => s.blocked);

    // PRELAUNCH-A3-15 — fold in the live rate-limit peek so the drawer
    // shows "minute/hour/day" alongside cap progress. RateLimitService is
    // optional in the constructor for unit-test ergonomics; default to
    // null when absent.
    let rateLimit: { minute: number; hour: number; day: number } | null = null;
    let rateLimited = false;
    if (this.rateLimitService) {
      try {
        rateLimit = await this.rateLimitService.peek(scope, userId);
        const defaults = (this.rateLimitService as any).defaults as {
          perUserPerMinute?: number;
          perUserPerHour?: number;
          perUserPerDay?: number;
        };
        rateLimited =
          (defaults?.perUserPerMinute && rateLimit.minute >= defaults.perUserPerMinute) ||
          (defaults?.perUserPerHour && rateLimit.hour >= defaults.perUserPerHour) ||
          (defaults?.perUserPerDay && rateLimit.day >= defaults.perUserPerDay) ||
          false;
      } catch {
        rateLimit = null;
        rateLimited = false;
      }
    }

    return {
      userId,
      blocked: !!blocker,
      reason: blocker
        ? `Budget cap exceeded: ${blocker.cap.scopeType}/${blocker.cap.period} — ${blocker.spentCents.toFixed(2)}¢ of ${blocker.cap.limitCents}¢`
        : null,
      caps: statuses,
      rateLimit,
      rateLimited,
      fetchedAt,
    };
  }

  /**
   * PRELAUNCH-A3-3 — list every (cap, userId) combination currently >= 100%.
   * Iterates `list()` for the scope, evaluates each user-scoped cap against
   * every active userId in the period (via `getCostByUser`), and returns the
   * breached set. Wildcard user caps fan out per-user; user-specific caps
   * just check that one user. Agent + org-wide caps get a single
   * `userId="*"` entry when breached.
   */
  async listBreachedUsers(
    scope: ScopeTuple,
    activeUserIds: string[],
  ): Promise<Array<{ userId: string; capId: string; percent: number; period: BudgetPeriod }>> {
    let caps: BudgetCap[] = [];
    try {
      caps = await this.list(scope);
    } catch {
      return [];
    }
    const result: Array<{ userId: string; capId: string; percent: number; period: BudgetPeriod }> = [];

    for (const cap of caps) {
      if (!cap.enabled) continue;
      const overrideActive =
        !!cap.overrideUntil && cap.overrideUntil.getTime() > Date.now();
      if (overrideActive) continue;

      const userIds: string[] =
        cap.scopeType === "user"
          ? cap.targetId === "*"
            ? activeUserIds
            : [cap.targetId]
          : ["*"]; // org/agent caps — single composite row

      for (const u of userIds) {
        const ctx =
          cap.scopeType === "user"
            ? { userId: u }
            : cap.scopeType === "agent"
              ? { agentId: cap.targetId }
              : {};
        let spentCents = 0;
        try {
          ({ spentCents } = await this.readWindow(scope, cap, ctx));
        } catch {
          continue;
        }
        if (cap.limitCents <= 0) continue;
        const pct = (spentCents / cap.limitCents) * 100;
        if (pct >= 100) {
          result.push({
            userId: u,
            capId: cap.id,
            percent: Number(pct.toFixed(2)),
            period: cap.period,
          });
        }
      }
    }
    return result;
  }
}

type AlertDeliveryResult = {
  ok: boolean;
  statusCode: number | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export class BudgetAlertDeliveryError extends Error {
  constructor(public readonly summary: BudgetAlertDeliverySummary) {
    super(`budget_alert_delivery_failed:${summary.failed}`);
    this.name = "BudgetAlertDeliveryError";
  }
}

function deliveryFailed(
  errorCode: string,
  errorMessage: string,
  statusCode: number | null = null,
): AlertDeliveryResult {
  return { ok: false, statusCode, errorCode, errorMessage };
}

function budgetAlertText(payload: BudgetAlertPayload): string {
  return [
    "Platos budget alert",
    "",
    `${payload.subjectLabel} crossed ${payload.threshold}% of its ${payload.period}ly cap.`,
    `Spent so far: ${(payload.spentCents / 100).toFixed(2)} USD of ${(payload.limitCents / 100).toFixed(2)} USD`,
    payload.runsLimit > 0 ? `Runs this window: ${payload.runs} of ${payload.runsLimit}` : null,
    `Window: ${payload.windowKey}`,
  ]
    .filter(Boolean)
    .join("\n");
}
