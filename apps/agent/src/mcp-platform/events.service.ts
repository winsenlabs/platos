import { Inject, Injectable, Logger, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import type Redis from "ioredis";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { REDIS_TOKEN } from "../shared/redis.provider";
import { validatePublicUrl, describeUrlValidationError } from "../shared/url-validator";

/**
 * Theme K.15 — Platform event bus + persistent notification router.
 *
 * Responsibilities:
 *
 *   1. emit(scope, eventType, subjectId?, payload)
 *      - Inserts a row into `PlatosEvent` (scoped, immutable log).
 *      - Publishes a JSON frame on Redis pub/sub channel
 *        `mcp:events:<org>:<project>:<env>` for live SSE subscribers.
 *      - Enqueues matching `PlatosNotificationRule` deliveries onto
 *        Redis list `mcp:notifications:pending`.
 *      - Fail-open everywhere — an emitter that throws never bricks the
 *        calling business path.
 *
 *   2. Dispatch loop
 *      - A single worker pops from `mcp:notifications:pending` (BRPOP)
 *        and fires outbound HTTP / webhook / Slack / email calls. Email
 *        + PagerDuty are stubbed for K.15 scope; Slack + webhook are
 *        real.
 *
 *   3. CRUD for `PlatosNotificationRule`
 *      - Register / list / get / update / delete / test.
 *
 * Scope invariant: every read + write narrows to the `(org, project, env)`
 * tuple of the MCP token. No cross-scope data leak via filters.
 *
 * Deps constraint: uses only ioredis (already in tree) + node global
 * fetch (Node 20+ ships built-in). No new npm deps.
 */

export type EventScope = {
  organizationId: string;
  projectId: string;
  environmentId: string;
};

export interface RuleFilters {
  /** `run.*`, `run.completed`, etc. Empty array = match nothing. */
  eventTypes: string[];
  /** Optional subject (runId / approvalId) allowlist. */
  subjectIds?: string[];
}

export type RuleDelivery =
  | { type: "slack"; url: string }
  | { type: "webhook"; url: string }
  | { type: "email"; email: string }
  | { type: "pagerduty"; integrationKey: string };

export interface PendingDelivery {
  ruleId: string;
  ruleName: string;
  scope: EventScope;
  eventId: string;
  eventType: string;
  subjectId: string | null;
  payload: unknown;
  delivery: RuleDelivery;
  attempt: number;
}

const PENDING_LIST_KEY = "mcp:notifications:pending";
const MAX_ATTEMPTS = 3;

function scopeChannel(scope: EventScope): string {
  return `mcp:events:${scope.organizationId}:${scope.projectId}:${scope.environmentId}`;
}

function matchesFilters(
  filters: RuleFilters,
  eventType: string,
  subjectId: string | null,
): boolean {
  if (!Array.isArray(filters.eventTypes) || filters.eventTypes.length === 0) {
    return false;
  }
  const typeMatch = filters.eventTypes.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern === eventType) return true;
    if (pattern.endsWith(".*")) {
      const prefix = pattern.slice(0, -2);
      return eventType.startsWith(`${prefix}.`) || eventType === prefix;
    }
    return false;
  });
  if (!typeMatch) return false;
  if (filters.subjectIds && filters.subjectIds.length > 0) {
    if (!subjectId) return false;
    if (!filters.subjectIds.includes(subjectId)) return false;
  }
  return true;
}

function isRuleDelivery(raw: unknown): raw is RuleDelivery {
  if (!raw || typeof raw !== "object") return false;
  const d = raw as Record<string, unknown>;
  switch (d["type"]) {
    case "slack":
    case "webhook":
      return typeof d["url"] === "string" && (d["url"] as string).length > 0;
    case "email":
      return typeof d["email"] === "string" && (d["email"] as string).includes("@");
    case "pagerduty":
      return typeof d["integrationKey"] === "string" && (d["integrationKey"] as string).length > 0;
    default:
      return false;
  }
}

@Injectable()
export class McpEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(McpEventsService.name);
  private dispatchLoopRunning = false;
  private dispatchAbort = false;
  /** Dedicated subscriber client for the dispatch-loop BRPOP so we don't
   *  starve the main command client. ioredis requires a separate
   *  connection when a client has issued a blocking command. */
  private blockingRedis: Redis | null = null;

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
  ) {}

  async onModuleInit(): Promise<void> {
    // Duplicate ioredis client for BRPOP so regular commands on the
    // shared client aren't blocked.
    try {
      this.blockingRedis = this.redis.duplicate();
      this.startDispatchLoop();
    } catch (err) {
      this.logger.warn(
        `[K.15] failed to start notification dispatch loop — events will persist but deliveries will not fire: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.dispatchAbort = true;
    try {
      await this.blockingRedis?.quit();
    } catch {
      /* already closed */
    }
  }

  /**
   * Write an event to Postgres + publish to Redis pub/sub + enqueue rule
   * deliveries. Fail-open: any error is logged and swallowed.
   */
  async emit(
    scope: EventScope,
    eventType: string,
    subjectId: string | null,
    payload: unknown,
  ): Promise<void> {
    try {
      const row = await this.prisma.platosEvent.create({
        data: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          eventType,
          subjectId,
          payload: (payload ?? {}) as any,
        },
        select: { id: true, createdAt: true },
      });

      const frame = JSON.stringify({
        id: row.id,
        eventType,
        subjectId,
        payload,
        createdAt: row.createdAt.toISOString(),
      });
      try {
        await this.redis.publish(scopeChannel(scope), frame);
      } catch (err) {
        this.logger.warn(
          `[K.15] redis.publish failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Evaluate persistent rules. Fail-open on any per-rule error.
      try {
        const rules = await this.prisma.platosNotificationRule.findMany({
          where: {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            enabled: true,
          },
        });
        for (const rule of rules) {
          const filters = rule.filters as RuleFilters | null;
          if (!filters || !matchesFilters(filters, eventType, subjectId)) continue;
          if (!isRuleDelivery(rule.delivery)) continue;
          const pending: PendingDelivery = {
            ruleId: rule.id,
            ruleName: rule.name,
            scope,
            eventId: row.id,
            eventType,
            subjectId,
            payload,
            delivery: rule.delivery as RuleDelivery,
            attempt: 0,
          };
          try {
            await this.redis.rpush(PENDING_LIST_KEY, JSON.stringify(pending));
          } catch (err) {
            this.logger.warn(
              `[K.15] rpush pending delivery failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      } catch (err) {
        this.logger.warn(
          `[K.15] rule evaluation failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `[K.15] emit failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Catch-up + listing reads.
  // ─────────────────────────────────────────────────────────────────

  async recent(
    scope: EventScope,
    opts: { eventTypes?: string[]; subjectIds?: string[]; limit?: number },
  ): Promise<Array<{
    id: string;
    eventType: string;
    subjectId: string | null;
    payload: unknown;
    createdAt: string;
  }>> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const where: Record<string, unknown> = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    };
    if (opts.eventTypes && opts.eventTypes.length > 0) {
      where["eventType"] = { in: opts.eventTypes };
    }
    if (opts.subjectIds && opts.subjectIds.length > 0) {
      where["subjectId"] = { in: opts.subjectIds };
    }
    const rows = await this.prisma.platosEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map((r: any) => ({
      id: r.id,
      eventType: r.eventType,
      subjectId: r.subjectId ?? null,
      payload: r.payload,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  // ─────────────────────────────────────────────────────────────────
  // PlatosNotificationRule CRUD.
  // ─────────────────────────────────────────────────────────────────

  async registerRule(
    scope: EventScope,
    createdBy: string,
    input: { name: string; filters: RuleFilters; delivery: RuleDelivery },
  ) {
    if (!input.name || input.name.length < 1 || input.name.length > 120) {
      throw new Error("name must be 1–120 chars");
    }
    if (
      !input.filters ||
      !Array.isArray(input.filters.eventTypes) ||
      input.filters.eventTypes.length === 0
    ) {
      throw new Error("filters.eventTypes must be a non-empty array");
    }
    if (!isRuleDelivery(input.delivery)) {
      throw new Error("delivery must be { type: slack|webhook|email|pagerduty, ... }");
    }
    // SSRF defence for URL-bearing deliveries. Validate now; we
    // re-validate at dispatch time per defence-in-depth.
    if (input.delivery.type === "slack" || input.delivery.type === "webhook") {
      const check = await validatePublicUrl(input.delivery.url);
      if (!check.ok) {
        throw new Error(`delivery.url rejected: ${describeUrlValidationError(check.error)}`);
      }
    }
    return this.prisma.platosNotificationRule.create({
      data: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        name: input.name,
        filters: input.filters as any,
        delivery: input.delivery as any,
        enabled: true,
        createdBy,
      },
    });
  }

  async listRules(scope: EventScope) {
    return this.prisma.platosNotificationRule.findMany({
      where: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async getRule(scope: EventScope, id: string) {
    return this.prisma.platosNotificationRule.findFirst({
      where: {
        id,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
    });
  }

  async updateRule(
    scope: EventScope,
    id: string,
    input: {
      name?: string;
      filters?: RuleFilters;
      delivery?: RuleDelivery;
      enabled?: boolean;
    },
  ) {
    const existing = await this.getRule(scope, id);
    if (!existing) throw new Error(`rule ${id} not found in scope`);
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) {
      if (input.name.length < 1 || input.name.length > 120) {
        throw new Error("name must be 1–120 chars");
      }
      data["name"] = input.name;
    }
    if (input.filters !== undefined) {
      if (!Array.isArray(input.filters.eventTypes) || input.filters.eventTypes.length === 0) {
        throw new Error("filters.eventTypes must be a non-empty array");
      }
      data["filters"] = input.filters as any;
    }
    if (input.delivery !== undefined) {
      if (!isRuleDelivery(input.delivery)) {
        throw new Error("delivery invalid");
      }
      if (input.delivery.type === "slack" || input.delivery.type === "webhook") {
        const check = await validatePublicUrl(input.delivery.url);
        if (!check.ok) {
          throw new Error(`delivery.url rejected: ${describeUrlValidationError(check.error)}`);
        }
      }
      data["delivery"] = input.delivery as any;
    }
    if (input.enabled !== undefined) {
      data["enabled"] = input.enabled;
    }
    return this.prisma.platosNotificationRule.update({ where: { id }, data });
  }

  async deleteRule(scope: EventScope, id: string): Promise<boolean> {
    const existing = await this.getRule(scope, id);
    if (!existing) return false;
    await this.prisma.platosNotificationRule.delete({ where: { id } });
    return true;
  }

  /**
   * Synthetic end-to-end test — fires a `notifications.test_fired`
   * event through the matcher so the operator can verify delivery
   * wiring without waiting for a real event.
   */
  async testRule(
    scope: EventScope,
    ruleId: string,
  ): Promise<{ ok: boolean; enqueued: boolean; note?: string }> {
    const rule = await this.getRule(scope, ruleId);
    if (!rule) return { ok: false, enqueued: false, note: "rule not found in scope" };
    if (!rule.enabled) {
      return { ok: false, enqueued: false, note: "rule is disabled — enable first" };
    }
    if (!isRuleDelivery(rule.delivery)) {
      return { ok: false, enqueued: false, note: "rule delivery malformed" };
    }
    const pending: PendingDelivery = {
      ruleId: rule.id,
      ruleName: rule.name,
      scope,
      eventId: `synthetic-${Date.now()}`,
      eventType: "notifications.test_fired",
      subjectId: null,
      payload: { ruleId: rule.id, ruleName: rule.name, synthetic: true },
      delivery: rule.delivery as RuleDelivery,
      attempt: 0,
    };
    try {
      await this.redis.rpush(PENDING_LIST_KEY, JSON.stringify(pending));
      return { ok: true, enqueued: true };
    } catch (err) {
      return {
        ok: false,
        enqueued: false,
        note: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Dispatch loop.
  // ─────────────────────────────────────────────────────────────────

  private startDispatchLoop(): void {
    if (this.dispatchLoopRunning) return;
    this.dispatchLoopRunning = true;
    void this.dispatchLoop();
  }

  private async dispatchLoop(): Promise<void> {
    while (!this.dispatchAbort) {
      try {
        const client = this.blockingRedis ?? this.redis;
        // BRPOP returns [key, value] or null on timeout.
        // ioredis with keyPrefix prepends "platos:" to the key — both
        // rpush and brpop go through the same client so the prefix is
        // consistent across enqueue + dequeue.
        const popped = (await client.brpop(PENDING_LIST_KEY, 5)) as
          | [string, string]
          | null;
        if (!popped) continue;
        const raw = popped[1];
        let pending: PendingDelivery;
        try {
          pending = JSON.parse(raw) as PendingDelivery;
        } catch {
          this.logger.warn(`[K.15] could not parse pending delivery`);
          continue;
        }
        await this.dispatchOne(pending);
      } catch (err) {
        // Errors in BRPOP itself — don't tight-loop on a dead redis.
        this.logger.warn(
          `[K.15] dispatch loop error: ${err instanceof Error ? err.message : String(err)}`,
        );
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
    this.dispatchLoopRunning = false;
  }

  private async dispatchOne(p: PendingDelivery): Promise<void> {
    try {
      switch (p.delivery.type) {
        case "slack":
          await this.deliverSlack(p);
          break;
        case "webhook":
          await this.deliverWebhook(p);
          break;
        case "email":
          // Stub — wire real SMTP / ses later. Logged so operators see
          // that the rule matched.
          this.logger.log(
            `[K.15] email delivery (stub) rule=${p.ruleId} event=${p.eventType} → ${
              (p.delivery as { email: string }).email
            }`,
          );
          break;
        case "pagerduty":
          this.logger.log(
            `[K.15] pagerduty delivery (stub) rule=${p.ruleId} event=${p.eventType}`,
          );
          break;
      }
    } catch (err) {
      const attempt = (p.attempt ?? 0) + 1;
      if (attempt >= MAX_ATTEMPTS) {
        this.logger.warn(
          `[K.15] delivery failed permanently rule=${p.ruleId} event=${p.eventType} attempt=${attempt}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      // Phase-3 N2 — exponential backoff before re-enqueue. Without this
      // a transient webhook failure tight-loops through MAX_ATTEMPTS in
      // milliseconds. Formula: min(2^attempt * 1000 ms, 30 000 ms).
      const backoffMs = Math.min(2 ** attempt * 1000, 30000);
      this.logger.warn(
        `[K.15] delivery failed (will retry in ${backoffMs}ms) rule=${p.ruleId} event=${p.eventType} attempt=${attempt}: ${err instanceof Error ? err.message : String(err)}`,
      );
      setTimeout(() => {
        this.redis
          .rpush(PENDING_LIST_KEY, JSON.stringify({ ...p, attempt }))
          .catch(() => {
            /* bounded — if redis is down we drop */
          });
      }, backoffMs);
    }
  }

  private summarize(p: PendingDelivery): string {
    const subj = p.subjectId ? ` subject=${p.subjectId}` : "";
    return `[platos] ${p.eventType}${subj} (rule: ${p.ruleName})`;
  }

  private async deliverSlack(p: PendingDelivery): Promise<void> {
    const url = (p.delivery as { url: string }).url;
    const check = await validatePublicUrl(url);
    if (!check.ok) {
      throw new Error(`url rejected at dispatch: ${describeUrlValidationError(check.error)}`);
    }
    const body = {
      text: this.summarize(p),
      attachments: [
        {
          color: p.eventType.endsWith(".failed") || p.eventType.endsWith(".exceeded")
            ? "danger"
            : "good",
          fields: [
            { title: "eventType", value: p.eventType, short: true },
            { title: "subjectId", value: p.subjectId ?? "—", short: true },
          ],
          text: "```" + JSON.stringify(p.payload, null, 2).slice(0, 2_000) + "```",
        },
      ],
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`slack webhook ${res.status}`);
    }
  }

  private async deliverWebhook(p: PendingDelivery): Promise<void> {
    const url = (p.delivery as { url: string }).url;
    const check = await validatePublicUrl(url);
    if (!check.ok) {
      throw new Error(`url rejected at dispatch: ${describeUrlValidationError(check.error)}`);
    }
    const body = {
      ruleId: p.ruleId,
      ruleName: p.ruleName,
      scope: p.scope,
      eventId: p.eventId,
      eventType: p.eventType,
      subjectId: p.subjectId,
      payload: p.payload,
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`webhook ${res.status}`);
    }
  }
}
