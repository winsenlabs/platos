import { Injectable, Inject, Logger } from "@nestjs/common";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { REDIS_TOKEN } from "../shared/redis.provider";
import type Redis from "ioredis";
import type { RequestScope } from "../auth/scope.guard";
import {
  calculateCanonicalModelCost,
  PlatosModelPricing,
  type CanonicalModelPriceSnapshot,
  type LiteLLMModelCatalog,
  type PricedModelUsage,
} from "@platos/tenancy-database";
import { assertCredibleLiteLLMCatalog } from "./litellm-catalog-validation";
import {
  addLanes,
  addUsage,
  billableCostFromRollup,
  EMPTY_USAGE,
  freshInputTokens,
  isCompletedTask,
  laneCostsFromRollup,
  laneRollupField,
  laneForAuxiliaryKind,
  roundCents,
  roundLanes,
  ROLLUP_FIELD,
  usageFromRollup,
  usageFromStep,
  USAGE_LANES,
  type RollupHash,
  type UsageLane,
  type UsageWindow,
} from "./usage-ledger";

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

interface UsageRecord {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  /** Theme E.9 — the agent that the cost attributes to (the billing agent).
   * For nested sub-agent runs this is still the parent agent (the "current
   * agent's turn"), ensuring sub-agent cost rolls up into the owning turn. */
  agentId: string;
  /**
   * SM.1 — cost-event discriminator. `"llm"` for token-based LLM turns
   * (default, backwards-compatible) · `"skill"` for every skill-tool
   * invocation recorded through `recordSkillUsage`. Every consumer that
   * aggregates historical cost should treat absence as `"llm"`.
   */
  tier?: "llm" | "skill";
  /** MC.1/MC.2 — Anthropic prompt-cache telemetry. `cacheCreationInputTokens`
   * are billed at 1.25× input (first write, cached for 5 minutes);
   * `cacheReadInputTokens` are billed at 0.1× input (90% discount when
   * subsequent requests within the cache window hit the same prefix).
   * Zero on non-Anthropic providers / non-cached turns. `costWithCacheCents`
   * is the cache-adjusted version of `costCents` — UI surfaces prefer this
   * for "true spend" while keeping naive `costCents` around for A/B. */
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  costWithCacheCents?: number;
}

type ModelCostBucket = {
  costCents: number;
  costWithCacheCents: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** Completed turns. This counted model calls and was labelled "messages". */
  tasks: number;
};

type AgentCostBucket = Omit<ModelCostBucket, "tasks"> & {
  tasks: number;
  threads: Set<string>;
};

type UserCostBucket = {
  costCents: number;
  turns: Set<string>;
  threads: Set<string>;
  tasks: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens: number;
};

/**
 * SM.1 — Skill-tier usage event.
 *
 * Every skill tool invocation is recorded as a SkillUsageEvent by
 * `SkillRuntimeService.invokeTool` after the handler returns. Shape mirrors
 * {@link UsageRecord} but carries skill-specific fields that LLM usage
 * doesn't need (skill slug, tool name, provider, I/O units).
 *
 * Cost estimation:
 * - If the skill handler returns `{ _usage: {...} }` alongside its tool
 *   result, the runtime strips `_usage` before returning to the LLM and
 *   forwards it here.
 * - Otherwise `estimatedCostCents` is 0 — SM.5 will fill in per-skill
 *   estimators later. SM.1 just plumbs the path.
 *
 * Persistence: we reuse the Redis aggregation that `recordAuxiliaryCost`
 * uses — there's no dedicated ClickHouse `cost_events` table today; the
 * authoritative cost record for LLM spend is
 * the clean Turn/Step ledger plus full-fidelity Redis counters. For
 * skill spend we fan out to:
 *   - `cost:scope:<s>:<day>` — bump `cost_cents:tier:skill` breakdown
 *   - `cost:agent:<s>:<agentId>:<day>` — per-agent rollup
 *   - `cost:skill:<s>:<skillSlug>:<day>` — per-skill rollup
 *   - `cost:skill_tool:<s>:<skillSlug>:<toolName>:<day>` — per-tool rollup
 *
 * See also: `docs/themes/THEME_S.md` SM.1 acceptance criteria. When
 * ClickHouse `cost_events` is introduced (post-K, alongside the
 * spans-store pattern), extend this event shape into a JSONEachRow
 * payload and dual-write — column set:
 *   organization_id, project_id, environment_id, tier, model, skill_slug,
 *   tool_name, provider, input_units, output_units, cost_cents,
 *   agent_id, thread_id, latency_ms, inserted_at.
 */
export interface SkillUsageEvent {
  skillSlug: string;
  toolName: string;
  /** Primary required_env var name (e.g. "TAVILY_API_KEY") or explicit
   *  `provider` field from the manifest. Used for provider-side spend
   *  attribution dashboards. */
  provider: string;
  /** Abstract input size (tokens · characters · requests · whatever the
   *  skill defines). Zero when the handler doesn't return `_usage`. */
  inputUnits: number;
  /** Abstract output size — same semantics as inputUnits. */
  outputUnits: number;
  /** Cost in US cents for this single invocation. 0 until SM.5's
   *  per-skill estimators land OR the handler returns `_usage.costCents`. */
  estimatedCostCents: number;
  /** Wall-clock latency of the handler call, Date.now() delta in ms. */
  latencyMs: number;
  /** Billing agent (same semantics as UsageRecord.agentId). */
  agentId?: string | null;
  /** Owning thread id — surfaces on per-turn breakdowns. */
  threadId?: string | null;
}

/** SM.1 — optional `_usage` override a skill handler may attach to its tool
 *  result. The runtime strips this key before returning to the LLM so the
 *  model never sees bookkeeping; see `SkillRuntimeService.invokeTool`. */
export interface SkillUsageOverride {
  inputUnits?: number;
  outputUnits?: number;
  costCents?: number;
}

function scopeKey(scope: ScopeTuple): string {
  return `${scope.organizationId}:${scope.projectId}:${scope.environmentId}`;
}

/** Canonical pricing lives in @platos/tenancy-database. Redis below is rollup-only. */
@Injectable()
export class CostService {
  /** Nest logger — added with the lazy catalog load so a cold/failed fetch is
   *  visible in the deployment logs rather than silently degrading rates. */
  private readonly logger = new Logger(CostService.name);
  private readonly prisma: any;
  private readonly modelPricing: PlatosModelPricing;
  private cleanStepCostFallbackWarned = false;

  constructor(
    @Inject(PRISMA_TOKEN) prisma: any,
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
  ) {
    this.prisma = prisma;
    this.modelPricing = new PlatosModelPricing(prisma);
  }

  private warnOnUnpricedStepFallback(): void {
    if (this.cleanStepCostFallbackWarned) return;
    this.cleanStepCostFallbackWarned = true;
    this.logger.warn(
      "[cost] rebuilding expired Redis rollups from immutable Step cost and rate snapshots",
    );
  }

  private async scanHashes(
    pattern: string,
  ): Promise<Array<{ key: string; values: Record<string, string> }>> {
    if (typeof (this.redis as any).scan !== "function") return [];
    const keys: string[] = [];
    let cursor = "0";
    try {
      do {
        const [next, page] = (await (this.redis as any).scan(
          cursor,
          "MATCH",
          pattern,
          "COUNT",
          200,
        )) as [string, string[]];
        cursor = next;
        keys.push(...page);
      } while (cursor !== "0");
      if (keys.length === 0) return [];
      const pipeline = this.redis.pipeline();
      for (const key of keys) pipeline.hgetall(key);
      const results = await pipeline.exec();
      return keys.map((key, index) => ({
        key,
        values: (results?.[index]?.[1] as Record<string, string>) ?? {},
      }));
    } catch (err: any) {
      this.logger.warn(
        `[cost] exact Redis cost scan failed for ${pattern}: ${err?.message ?? err}`,
      );
      return [];
    }
  }

  /** Persist a fetched LiteLLM baseline as append-only canonical price cards. */
  async ingestCatalog(
    catalog: LiteLLMModelCatalog,
    fetchedAt: Date,
  ): Promise<{ modelsSeen: number; pricesCreated: number; unchanged: number }> {
    assertCredibleLiteLLMCatalog(catalog);
    return this.modelPricing.ingestLiteLLMCatalog(catalog, fetchedAt);
  }

  async resolvePrice(model: string): Promise<CanonicalModelPriceSnapshot> {
    return this.modelPricing.resolvePrice(model);
  }

  priceUsageFromSnapshot(
    model: string,
    price: CanonicalModelPriceSnapshot,
    inputTokens: number,
    outputTokens: number,
    cacheCreationInputTokens = 0,
    cacheReadInputTokens = 0,
  ): PricedModelUsage {
    return {
      price,
      costCents: calculateCanonicalModelCost(model, price, {
        inputTokens,
        outputTokens,
        cacheWriteInputTokens: cacheCreationInputTokens,
        cacheReadInputTokens,
      }),
    };
  }

  /** Resolve one canonical card and compute the exact four-rate cost once. */
  async priceUsage(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheCreationInputTokens = 0,
    cacheReadInputTokens = 0,
    at = new Date(),
  ): Promise<PricedModelUsage> {
    return this.modelPricing.priceUsage(
      model,
      {
        inputTokens,
        outputTokens,
        cacheWriteInputTokens: cacheCreationInputTokens,
        cacheReadInputTokens,
      },
      at,
    );
  }

  async calculateCost(
    model: string,
    inputTokens: number,
    outputTokens: number,
  ): Promise<number> {
    return (await this.priceUsage(model, inputTokens, outputTokens)).costCents;
  }

  async resolveInputCentsPerMillion(model: string): Promise<number> {
    const resolved = await this.modelPricing.resolvePrice(model);
    return resolved.input.usdPerToken * 100_000_000;
  }

  async resolveEffectiveRates(model: string): Promise<{
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    source: "canonical";
  }> {
    const resolved = await this.modelPricing.resolvePrice(model);
    return {
      input: resolved.input.usdPerToken * 100_000_000,
      output: resolved.output.usdPerToken * 100_000_000,
      cacheRead: resolved.cacheRead.usdPerToken * 100_000_000,
      cacheWrite: resolved.cacheWrite.usdPerToken * 100_000_000,
      source: "canonical",
    };
  }

  async calculateCostWithCache(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheCreationInputTokens: number,
    cacheReadInputTokens: number,
    _providerId?: string | null,
  ): Promise<number> {
    return (
      await this.priceUsage(
        model,
        inputTokens,
        outputTokens,
        cacheCreationInputTokens,
        cacheReadInputTokens,
      )
    ).costCents;
  }

  /**
   * Record a usage event and update running totals.
   *
   * Theme E.9 — per-agent cost attribution. In addition to the per-thread
   * and per-scope Redis hashes, we now maintain:
   *   - `cost:agent:<scopeKey>:<agentId>:<day>` — per-agent daily rollup
   *   - `cost:agent:<scopeKey>:<agentId>:<model>:<day>` — per-agent × per-model
   *     daily rollup (so the model dimension survives the Redis hashes)
   *
   * `agentId` is the **billing agent** — the agent owning the turn. For
   * nested sub-agent runs, the caller must pass the parent's agentId so
   * sub-agent cost attributes to the enclosing turn (per THEME_E §E.9).
   * The `subAgentLabel` option lets callers tag a sub-agent run without
   * changing the billing target (optional diagnostic only).
   *
   * Idempotency: `hincrby` / `hincrbyfloat` are append-only. Re-running a
   * turn will double-count in Redis unless callers provide `idempotencyKey`.
   * The clean Step row durably stores model + token usage; Redis preserves the
   * exact historical price/cache breakdown that has no lossless Step column.
   */
  async recordUsage(
    scope: ScopeTuple,
    threadId: string,
    agentId: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    options: {
      subAgentLabel?: string | null;
      /** MC.1 — Anthropic prompt-cache telemetry. Plumbed from the
       * streamText/generateText provider metadata by agent-task.service.
       * Zero on non-Anthropic providers. */
      cacheCreationInputTokens?: number;
      cacheReadInputTokens?: number;
      /** End-user id (scope.userId). Fans-out to cost:user:<s>:<userId>:<day>. */
      userId?: string | null;
      /**
       * PRELAUNCH-A1-2 — explicit provider override. Defaults to the
       * provider segment of the model string (e.g. "anthropic" for
       * "anthropic:claude-sonnet-4-6"). Determines the cache rate row used
       * for cost-with-cache math.
       */
      providerId?: string | null;
      /**
       * PRELAUNCH-A3-13 — idempotency key for retry-safe cost recording.
       * Caller passes a deterministic key (e.g. `<messageId>:cost`) and we
       * SETNX `cost:idem:<key>` with TTL 1h before applying the Redis
       * fan-out. A duplicate fire within the window is a no-op — closes
       * the EOBD.28 retry-double-charge gap.
       */
      idempotencyKey?: string | null;
      /**
       * PRELAUNCH-A1-3 / A1-13 — reasoning-tokens telemetry from
       * `outputTokenDetails.reasoningTokens` (canonical v6) plus provider
       * fallbacks. When > 0, fans out to the per-thread / per-scope /
       * per-agent / per-user Redis hashes as `reasoning_tokens` so the
       * dashboards can attribute reasoning spend back to the originating
       * turn/agent/user. Fans the same way `cache_*_input_tokens` already
       * does.
       */
      reasoningTokens?: number;
      /** Exact canonical card/cost already resolved for the persisted Step. */
      pricedUsage?: PricedModelUsage;
    } = {},
  ): Promise<UsageRecord> {
    const cacheCreation = Math.max(0, Number(options.cacheCreationInputTokens ?? 0) || 0);
    const cacheRead = Math.max(0, Number(options.cacheReadInputTokens ?? 0) || 0);
    const reasoning = Math.max(0, Number(options.reasoningTokens ?? 0) || 0);
    const pricedUsage = options.pricedUsage ?? await this.priceUsage(
      model,
      inputTokens,
      outputTokens,
      cacheCreation,
      cacheRead,
    );
    const costCents = pricedUsage.costCents;
    const costWithCacheCents = costCents;

    // PRELAUNCH-A3-13 — idempotency guard. When a deterministic key is
    // supplied (e.g. `<messageId>:cost`), SETNX a sentinel with 1h TTL
    // before applying the Redis fan-out. A duplicate call within the
    // window short-circuits — the function still returns a UsageRecord
    // (caller might use it for logging) but the Redis counters aren't
    // double-bumped. This closes the EOBD.28 retry-window double-charge.
    if (options.idempotencyKey) {
      try {
        const idemKey = `cost:idem:${options.idempotencyKey}`;
        const acquired = await (this.redis as any).set(idemKey, "1", "EX", 3600, "NX");
        if (!acquired) {
          // Already recorded — return the same persisted computation without bumping.
          return {
            model,
            inputTokens,
            outputTokens,
            costCents,
            agentId,
            cacheCreationInputTokens: cacheCreation,
            cacheReadInputTokens: cacheRead,
            costWithCacheCents: costCents,
          };
        }
      } catch {
        // Fail-open: if the idempotency check itself errors, record
        // normally (we'd rather double-charge once than silently drop
        // the spend).
      }
    }
    const record: UsageRecord = {
      model,
      inputTokens,
      outputTokens,
      costCents,
      agentId,
      cacheCreationInputTokens: cacheCreation,
      cacheReadInputTokens: cacheRead,
      costWithCacheCents,
    };

    // Update running totals in Redis (real-time dashboard)
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const s = scopeKey(scope);
    const pipeline = this.redis.pipeline();
    // WIN-134 — A TASK IS ONE COMPLETED TURN, and `recordUsage` has two call
    // sites, not one. The second is `runSubAgent`, reached from the
    // `delegate_to_sub_agent` TOOL the parent model calls — once per
    // delegation, any number of times inside a single turn, against the same
    // thread and the same (parent) agentId. Bumping `tasks` there reported a
    // turn that delegated three times as four tasks on the summary card, on the
    // per-agent and per-model rollups, and as four runs against a turns-limit
    // budget cap. That is the "322 tasks" bug in its exact original shape: a
    // per-model-call increment read as a billable-unit count.
    //
    // `subAgentLabel` is the marker for "this is a model call inside somebody
    // else's turn". Those bump `calls` — the raw model-invocation counter — and
    // never `tasks`. It still does not change the BILLING attribution: that
    // remains the parent's agentId, per THEME_E §E.9.
    const countsAsTask = !options.subAgentLabel;
    const bumpTasks = (key: string) => {
      if (countsAsTask) pipeline.hincrby(key, ROLLUP_FIELD.tasks, 1);
    };
    // thread-level rollup
    bumpTasks(`cost:thread:${threadId}`);
    pipeline.hincrby(`cost:thread:${threadId}`, "input_tokens", inputTokens);
    pipeline.hincrby(`cost:thread:${threadId}`, "output_tokens", outputTokens);
    pipeline.hincrbyfloat(`cost:thread:${threadId}`, "cost_cents", costCents);
    if (cacheCreation > 0) pipeline.hincrby(`cost:thread:${threadId}`, "cache_creation_input_tokens", cacheCreation);
    if (cacheRead > 0) pipeline.hincrby(`cost:thread:${threadId}`, "cache_read_input_tokens", cacheRead);
    if (reasoning > 0) pipeline.hincrby(`cost:thread:${threadId}`, "reasoning_tokens", reasoning);
    if (costWithCacheCents !== costCents) {
      pipeline.hincrbyfloat(`cost:thread:${threadId}`, "cost_with_cache_cents", costWithCacheCents);
    } else {
      pipeline.hincrbyfloat(`cost:thread:${threadId}`, "cost_with_cache_cents", costCents);
    }
    pipeline.expire(`cost:thread:${threadId}`, 86400 * 30); // 30 day TTL
    // scope-level daily rollup
    const scopeKeyStr = `cost:scope:${s}:${today}`;
    bumpTasks(scopeKeyStr);
    pipeline.hincrby(scopeKeyStr, "input_tokens", inputTokens);
    pipeline.hincrby(scopeKeyStr, "output_tokens", outputTokens);
    pipeline.hincrbyfloat(scopeKeyStr, "cost_cents", costCents);
    if (cacheCreation > 0) pipeline.hincrby(scopeKeyStr, "cache_creation_input_tokens", cacheCreation);
    if (cacheRead > 0) pipeline.hincrby(scopeKeyStr, "cache_read_input_tokens", cacheRead);
    if (reasoning > 0) pipeline.hincrby(scopeKeyStr, "reasoning_tokens", reasoning);
    pipeline.hincrbyfloat(scopeKeyStr, "cost_with_cache_cents", costWithCacheCents);
    pipeline.expire(scopeKeyStr, 86400 * 90); // 90 day TTL
    // Exact per-model attribution. Step preserves model + total tokens, while
    // this hash preserves the historical priced/cache breakdown.
    const scopeModelKey = `cost:model:${s}:${model}:${today}`;
    bumpTasks(scopeModelKey);
    pipeline.hincrby(scopeModelKey, "input_tokens", inputTokens);
    pipeline.hincrby(scopeModelKey, "output_tokens", outputTokens);
    if (cacheCreation > 0) {
      pipeline.hincrby(
        scopeModelKey,
        "cache_creation_input_tokens",
        cacheCreation,
      );
    }
    if (cacheRead > 0) {
      pipeline.hincrby(scopeModelKey, "cache_read_input_tokens", cacheRead);
    }
    if (reasoning > 0) {
      pipeline.hincrby(scopeModelKey, "reasoning_tokens", reasoning);
    }
    pipeline.hincrbyfloat(scopeModelKey, "cost_cents", costCents);
    pipeline.hincrbyfloat(
      scopeModelKey,
      "cost_with_cache_cents",
      costWithCacheCents,
    );
    pipeline.hincrby(scopeModelKey, "calls", 1);
    pipeline.hset(scopeModelKey, "attribution_source", "exact");
    pipeline.expire(scopeModelKey, 86400 * 90);
    // per-agent daily rollup (E.9)
    if (agentId) {
      const agentKey = `cost:agent:${s}:${agentId}:${today}`;
      bumpTasks(agentKey);
      pipeline.hincrby(agentKey, "input_tokens", inputTokens);
      pipeline.hincrby(agentKey, "output_tokens", outputTokens);
      pipeline.hincrbyfloat(agentKey, "cost_cents", costCents);
      if (cacheCreation > 0) pipeline.hincrby(agentKey, "cache_creation_input_tokens", cacheCreation);
      if (cacheRead > 0) pipeline.hincrby(agentKey, "cache_read_input_tokens", cacheRead);
      if (reasoning > 0) pipeline.hincrby(agentKey, "reasoning_tokens", reasoning);
      pipeline.hincrbyfloat(agentKey, "cost_with_cache_cents", costWithCacheCents);
      pipeline.hincrby(agentKey, "calls", 1);
      pipeline.hset(agentKey, "attribution_source", "exact");
      pipeline.expire(agentKey, 86400 * 90);
      // per-agent × per-model daily rollup (E.9). Keeps the model dimension
      // alive on the Redis side so a live dashboard can show "agent X burned
      // $Y on Haiku today" without hitting Postgres.
      const modelKey = `cost:agent:${s}:${agentId}:${model}:${today}`;
      pipeline.hincrby(modelKey, "input_tokens", inputTokens);
      pipeline.hincrby(modelKey, "output_tokens", outputTokens);
      pipeline.hincrbyfloat(modelKey, "cost_cents", costCents);
      if (cacheCreation > 0) pipeline.hincrby(modelKey, "cache_creation_input_tokens", cacheCreation);
      if (cacheRead > 0) pipeline.hincrby(modelKey, "cache_read_input_tokens", cacheRead);
      if (reasoning > 0) pipeline.hincrby(modelKey, "reasoning_tokens", reasoning);
      pipeline.hincrbyfloat(modelKey, "cost_with_cache_cents", costWithCacheCents);
      pipeline.hincrby(modelKey, "calls", 1);
      pipeline.expire(modelKey, 86400 * 90);
    }
    // Per-end-user daily rollup. Pattern: cost:user:<s>:<userId>:<day>
    if (options.userId) {
      const userKey = `cost:user:${s}:${options.userId}:${today}`;
      bumpTasks(userKey);
      pipeline.hincrbyfloat(userKey, "cost_cents", costCents);
      pipeline.hincrbyfloat(userKey, "cost_with_cache_cents", costWithCacheCents);
      pipeline.hincrby(userKey, "input_tokens", inputTokens);
      pipeline.hincrby(userKey, "output_tokens", outputTokens);
      if (cacheCreation > 0) pipeline.hincrby(userKey, "cache_creation_input_tokens", cacheCreation);
      if (cacheRead > 0) pipeline.hincrby(userKey, "cache_read_input_tokens", cacheRead);
      if (reasoning > 0) pipeline.hincrby(userKey, "reasoning_tokens", reasoning);
      pipeline.hincrby(userKey, "calls", 1);
      pipeline.hset(userKey, "attribution_source", "exact");
      pipeline.expire(userKey, 86400 * 90);
    }
    await pipeline.exec();

    return record;
  }

  /**
   * Theme E.9 — read back the per-agent daily cost counter for a given day.
   * Scope-gated via the composite key. Returns zeros when nothing has been
   * recorded yet (cold start, or the day hasn't seen traffic).
   */
  async getAgentDailyCost(
    scope: ScopeTuple,
    agentId: string,
    date?: string,
  ): Promise<{
    inputTokens: number;
    outputTokens: number;
    costCents: number;
    calls: number;
    tasks: number;
  }> {
    const day = date || new Date().toISOString().slice(0, 10);
    const data = await this.redis.hgetall(`cost:agent:${scopeKey(scope)}:${agentId}:${day}`);
    // WIN-134 — one ledger owns the arithmetic. `costCents` is the cache-aware
    // figure on every surface; `calls` stays the raw counter this endpoint has
    // always returned.
    const usage = usageFromRollup(data as RollupHash);
    return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costCents: roundCents(usage.costCents),
      // `calls` counts model invocations, `tasks` counts completed turns. They
      // are different numbers and this endpoint now says which is which rather
      // than letting a caller read one as the other.
      calls: parseInt(data[ROLLUP_FIELD.calls] || "0", 10) || 0,
      tasks: usage.tasks,
    };
  }

  /**
   * Per-end-user daily cost — reads the `cost:user:<scope>:<userId>:<day>`
   * rollup that recordUsage already fans out to (see the `options.userId`
   * branch). The write side existed but had no reader, so per-user spend was
   * un-surfaceable; this pairs with the `GET /monitoring/cost/user/:userId`
   * endpoint. Mirrors getAgentDailyCost.
   */
  async getUserDailyCost(
    scope: ScopeTuple,
    userId: string,
    date?: string,
  ): Promise<{
    inputTokens: number;
    outputTokens: number;
    costCents: number;
    costWithCacheCents: number;
    calls: number;
    tasks: number;
  }> {
    const day = date || new Date().toISOString().slice(0, 10);
    const data = await this.redis.hgetall(`cost:user:${scopeKey(scope)}:${userId}:${day}`);
    const usage = usageFromRollup(data as RollupHash);
    return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costCents: roundCents(usage.costCents),
      // Retained for callers that still read the old field name. It is the
      // same number: there is one billable cost and this is it.
      costWithCacheCents: roundCents(usage.costCents),
      calls: parseInt(data[ROLLUP_FIELD.calls] || "0", 10) || 0,
      tasks: usage.tasks,
    };
  }

  /**
   * PPR-24 — Redis ↔ Postgres cost reconcile.
   *
   * Clean Step rows are the durable model/input/output ledger, while Redis is
   * the only full-fidelity historical price/cache/reasoning ledger. The
   * pipeline-based recordUsage path can drop writes during Redis restarts or
   * eviction, so this periodic reconciler backfills missing daily hashes from
   * immutable Step costs without overwriting exact Redis attribution.
   *
   * Strategy:
   *   1. For each day in the reconcile window, pull every Step whose
   *      `createdAt` lands in that day (per turn -> thread -> scope join).
   *   2. Group by (scope, day) and (scope, agentId, day) to build fresh
   *      totals for `cost:scope:<scope>:<day>` +
   *      `cost:agent:<scope>:<agentId>:<day>`.
   *   3. Write only hashes that do not already exist. Existing hashes may
   *      contain exact historical or auxiliary attribution that Step cannot
   *      reconstruct and must never be overwritten.
   *   4. Preserve 90-day TTL semantics.
   *
   * `daysBack` defaults to 2 — enough to smooth over yesterday's tail. Longer
   * windows can be requested by the admin endpoint.
   */
  /**
   * EOBD.32 / 33 / 34 — record cost for auxiliary LLM calls
   * (embeddings, memory extraction judge, eval judge LLM) that
   * don't have a user-facing turn but still draw on the provider
   * budget. Bumps the scope daily + optional agent daily rollups in
   * Redis so the dashboard doesn't undercount spend.
   *
   * Postgres is NOT written — these calls don't have an owning Step row. The
   * PPR-24 reconcile job backfills missing Redis turn-cost hashes from Step;
   * auxiliary costs live in Redis only (90d TTL), matching dashboard retention.
   */
  async recordAuxiliaryCost(input: {
    scope: ScopeTuple;
    kind: "embedding" | "extraction" | "eval-judge" | string;
    model: string;
    costCents: number;
    inputTokens?: number;
    outputTokens?: number;
    /**
     * PRELAUNCH-A1-7 — preserve full token breakdown for auxiliary calls
     * so dashboards can attribute cache hit + reasoning spend back to
     * the originating embedding/extraction/eval-judge/reflection. All
     * default to 0 — back-compat for existing callers.
     */
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    reasoningTokens?: number;
    agentId?: string | null;
    userId?: string | null;
  }): Promise<void> {
    if (input.costCents <= 0) return;
    const today = new Date().toISOString().slice(0, 10);
    const s = scopeKey(input.scope);
    // WIN-134 — the lane field the ledger reads back. The three named lanes
    // resolve to a shared constant; every other auxiliary kind keeps its
    // per-kind diagnostic field and lands in the `inference` residual, which is
    // where a compaction or an auto-name belongs.
    const laneField =
      laneRollupField(laneForAuxiliaryKind(input.kind)) ?? `cost_cents:${input.kind}`;
    const pipeline = this.redis.pipeline();
    const scopeDayKey = `cost:scope:${s}:${today}`;
    pipeline.hincrby(scopeDayKey, "input_tokens", input.inputTokens ?? 0);
    pipeline.hincrby(scopeDayKey, "output_tokens", input.outputTokens ?? 0);
    // PRELAUNCH-A1-7 — fold the full breakdown onto the scope-day rollup
    // so the cache hit rate / reasoning spend slices for auxiliary calls
    // are visible on the dashboard.
    if ((input.cacheReadInputTokens ?? 0) > 0) {
      pipeline.hincrby(scopeDayKey, "cache_read_input_tokens", input.cacheReadInputTokens!);
    }
    if ((input.cacheCreationInputTokens ?? 0) > 0) {
      pipeline.hincrby(scopeDayKey, "cache_creation_input_tokens", input.cacheCreationInputTokens!);
    }
    if ((input.reasoningTokens ?? 0) > 0) {
      pipeline.hincrby(scopeDayKey, "reasoning_tokens", input.reasoningTokens!);
    }
    pipeline.hincrbyfloat(scopeDayKey, "cost_cents", input.costCents);
    // WIN-134 — auxiliary spend used to bump only the naive field, so the
    // cache-aware total that budgets and dashboards read was missing every
    // embedding, extraction and judge call. Both fields carry the same
    // four-rate figure; writing one and not the other is how they diverged.
    pipeline.hincrbyfloat(scopeDayKey, "cost_with_cache_cents", input.costCents);
    pipeline.hincrbyfloat(scopeDayKey, laneField, input.costCents);
    pipeline.hset(scopeDayKey, "attribution_source", "exact");
    pipeline.expire(scopeDayKey, 86400 * 90);
    if (input.agentId) {
      const agentKey = `cost:agent:${s}:${input.agentId}:${today}`;
      pipeline.hincrby(agentKey, "input_tokens", input.inputTokens ?? 0);
      pipeline.hincrby(agentKey, "output_tokens", input.outputTokens ?? 0);
      if ((input.cacheReadInputTokens ?? 0) > 0) {
        pipeline.hincrby(
          agentKey,
          "cache_read_input_tokens",
          input.cacheReadInputTokens!,
        );
      }
      if ((input.cacheCreationInputTokens ?? 0) > 0) {
        pipeline.hincrby(
          agentKey,
          "cache_creation_input_tokens",
          input.cacheCreationInputTokens!,
        );
      }
      if ((input.reasoningTokens ?? 0) > 0) {
        pipeline.hincrby(agentKey, "reasoning_tokens", input.reasoningTokens!);
      }
      pipeline.hincrbyfloat(agentKey, "cost_cents", input.costCents);
      pipeline.hincrbyfloat(agentKey, "cost_with_cache_cents", input.costCents);
      pipeline.hincrbyfloat(agentKey, laneField, input.costCents);
      pipeline.hincrby(agentKey, "calls", 1);
      pipeline.hset(agentKey, "attribution_source", "exact");
      pipeline.expire(agentKey, 86400 * 90);
    }
    // Breakdown-by-kind for cost-by-model dashboard slice.
    const modelKey = `cost:model:${s}:${input.model}:${today}`;
    pipeline.hincrby(modelKey, "input_tokens", input.inputTokens ?? 0);
    pipeline.hincrby(modelKey, "output_tokens", input.outputTokens ?? 0);
    if ((input.cacheReadInputTokens ?? 0) > 0) {
      pipeline.hincrby(
        modelKey,
        "cache_read_input_tokens",
        input.cacheReadInputTokens!,
      );
    }
    if ((input.cacheCreationInputTokens ?? 0) > 0) {
      pipeline.hincrby(
        modelKey,
        "cache_creation_input_tokens",
        input.cacheCreationInputTokens!,
      );
    }
    if ((input.reasoningTokens ?? 0) > 0) {
      pipeline.hincrby(modelKey, "reasoning_tokens", input.reasoningTokens!);
    }
    pipeline.hincrbyfloat(modelKey, "cost_cents", input.costCents);
    pipeline.hincrbyfloat(modelKey, "cost_with_cache_cents", input.costCents);
    pipeline.hincrbyfloat(modelKey, `cost_cents:${input.kind}`, input.costCents);
    pipeline.hincrby(modelKey, "calls", 1);
    pipeline.hset(modelKey, "attribution_source", "exact");
    pipeline.expire(modelKey, 86400 * 90);
    if (input.userId) {
      const userKey = `cost:user:${s}:${input.userId}:${today}`;
      pipeline.hincrby(userKey, "input_tokens", input.inputTokens ?? 0);
      pipeline.hincrby(userKey, "output_tokens", input.outputTokens ?? 0);
      if ((input.cacheReadInputTokens ?? 0) > 0) {
        pipeline.hincrby(
          userKey,
          "cache_read_input_tokens",
          input.cacheReadInputTokens!,
        );
      }
      if ((input.cacheCreationInputTokens ?? 0) > 0) {
        pipeline.hincrby(
          userKey,
          "cache_creation_input_tokens",
          input.cacheCreationInputTokens!,
        );
      }
      if ((input.reasoningTokens ?? 0) > 0) {
        pipeline.hincrby(userKey, "reasoning_tokens", input.reasoningTokens!);
      }
      pipeline.hincrbyfloat(userKey, "cost_cents", input.costCents);
      pipeline.hincrbyfloat(userKey, "cost_with_cache_cents", input.costCents);
      pipeline.hincrby(userKey, "calls", 1);
      pipeline.hset(userKey, "attribution_source", "exact");
      pipeline.expire(userKey, 86400 * 90);
    }
    try {
      await pipeline.exec();
    } catch {
      // Fail-open — cost recording must never break the originating call.
    }
  }

  /**
   * SM.1 — record a skill-tier cost event.
   *
   * Called from `SkillRuntimeService.invokeTool` after every skill-tool
   * handler returns (success OR error — the caller still passes
   * `estimatedCostCents: 0` on error since no provider spend occurred).
   *
   * Fan-out:
   *   - `cost:scope:<s>:<day>` +=
   *       cost_cents (total), cost_cents:tier:skill (discriminator breakdown)
   *   - `cost:agent:<s>:<agentId>:<day>` += cost_cents, cost_cents:tier:skill
   *   - `cost:skill:<s>:<skillSlug>:<day>` += cost_cents, calls, input_units,
   *     output_units
   *   - `cost:skill_tool:<s>:<skillSlug>:<toolName>:<day>` += calls, latency
   *   - `cost:provider:<s>:<provider>:<day>` += cost_cents (so provider-side
   *     spend dashboards can answer "how much did Tavily cost us today").
   *
   * Fails open — telemetry errors are swallowed, never propagated. Skill
   * invocation must never break because the stats pipe is down.
   *
   * Returns the event (including the tier discriminator) so the caller can
   * forward it to a trace event / metric counter in the same call site.
   */
  async recordSkillUsage(
    scope: ScopeTuple,
    event: SkillUsageEvent,
  ): Promise<SkillUsageEvent & { tier: "skill" }> {
    const today = new Date().toISOString().slice(0, 10);
    const s = scopeKey(scope);
    const costCents = Number.isFinite(event.estimatedCostCents)
      ? Math.max(0, event.estimatedCostCents)
      : 0;
    const inputUnits = Number.isFinite(event.inputUnits) ? Math.max(0, event.inputUnits) : 0;
    const outputUnits = Number.isFinite(event.outputUnits) ? Math.max(0, event.outputUnits) : 0;

    try {
      const pipeline = this.redis.pipeline();

      // Scope-daily rollup — always bump `cost_cents` (zero-safe) + the
      // `tier:skill` breakdown so dashboards can split LLM vs skill spend.
      const scopeDayKey = `cost:scope:${s}:${today}`;
      pipeline.hincrby(scopeDayKey, "skill_calls", 1);
      if (costCents > 0) {
        pipeline.hincrbyfloat(scopeDayKey, "cost_cents", costCents);
        // WIN-134 — the billable field must carry skill spend too, or the
        // cache-aware total budgets read silently excludes every skill call.
        pipeline.hincrbyfloat(scopeDayKey, "cost_with_cache_cents", costCents);
        pipeline.hincrbyfloat(scopeDayKey, laneRollupField("skill")!, costCents);
      }
      pipeline.expire(scopeDayKey, 86400 * 90);

      // Per-agent rollup (when attributed).
      if (event.agentId) {
        const agentKey = `cost:agent:${s}:${event.agentId}:${today}`;
        pipeline.hincrby(agentKey, "skill_calls", 1);
        if (costCents > 0) {
          pipeline.hincrbyfloat(agentKey, "cost_cents", costCents);
          pipeline.hincrbyfloat(agentKey, "cost_with_cache_cents", costCents);
          pipeline.hincrbyfloat(agentKey, laneRollupField("skill")!, costCents);
        }
        pipeline.expire(agentKey, 86400 * 90);
      }

      // Per-skill daily counter — powers the Skills usage tab in the dashboard.
      const skillKey = `cost:skill:${s}:${event.skillSlug}:${today}`;
      pipeline.hincrby(skillKey, "calls", 1);
      pipeline.hincrby(skillKey, "input_units", inputUnits);
      pipeline.hincrby(skillKey, "output_units", outputUnits);
      if (costCents > 0) pipeline.hincrbyfloat(skillKey, "cost_cents", costCents);
      pipeline.hincrbyfloat(skillKey, "latency_ms_total", event.latencyMs);
      pipeline.expire(skillKey, 86400 * 90);

      // SM.3 Phase-2 fix — tier=skill cap lookup keys.
      // `BudgetService.readTierWindow` reads:
      //   `cost:skill:<scope>:<slug|"">:<agent|"">:<day>` → `cost_cents`
      // For the 4-slot ladder (slug+agent, slug-only, agent-only, tier-only)
      // we fan-out into all four shapes so every ladder rung sees real spend.
      // Missing dimension is encoded as an empty segment (":<day>" with "")
      // which matches the BudgetService side after the companion patch.
      if (costCents > 0) {
        const agentSeg = event.agentId ?? "";
        const skillSeg = event.skillSlug ?? "";
        const capKeys = [
          // slug + agent → most specific
          `cost:skill:${s}:${skillSeg}:${agentSeg}:${today}`,
          // slug only
          `cost:skill:${s}:${skillSeg}::${today}`,
          // agent only
          `cost:skill:${s}::${agentSeg}:${today}`,
          // scope-wide tier=skill total
          `cost:skill:${s}:::${today}`,
        ];
        for (const k of capKeys) {
          pipeline.hincrbyfloat(k, "cost_cents", costCents);
          pipeline.expire(k, 86400 * 90);
        }
      }

      // Per-tool rollup — narrow slice for spotting hot paths.
      const toolKey = `cost:skill_tool:${s}:${event.skillSlug}:${event.toolName}:${today}`;
      pipeline.hincrby(toolKey, "calls", 1);
      pipeline.hincrbyfloat(toolKey, "latency_ms_total", event.latencyMs);
      pipeline.expire(toolKey, 86400 * 90);

      // Per-provider rollup — lets the UI answer "what did we spend on
      // Tavily / BFL / Parallel this month".
      if (event.provider) {
        const providerKey = `cost:provider:${s}:${event.provider}:${today}`;
        pipeline.hincrby(providerKey, "calls", 1);
        if (costCents > 0) pipeline.hincrbyfloat(providerKey, "cost_cents", costCents);
        pipeline.expire(providerKey, 86400 * 90);
      }

      await pipeline.exec();
    } catch {
      // Fail-open — see method docstring.
    }

    return { ...event, tier: "skill" };
  }

  /**
   * EOBD.35 — reserve + settle pattern to close the concurrent-turn
   * budget over-run. `evaluate()` in BudgetService currently reads
   * `cost:scope:{scope}:{day}` counter, compares to cap, returns OK —
   * but the actual spend isn't recorded until AFTER the LLM call, so
   * two concurrent turns both see "under cap" + both proceed.
   *
   * This primitive lets a caller:
   *   1. `beginReservation(scope, estimateCents)` — INCRBYFLOAT
   *      `cost:scope:{scope}:{day}:reserved`. Budget evaluator reads
   *      reserved + spent when comparing to cap.
   *   2. `settleReservation(scope, estimateCents, actualCents)` —
   *      DECRBYFLOAT reserved by estimate; the normal recordUsage
   *      path bumps spent by actual.
   *
   * Caller supplies the estimate (e.g. median recent turn cost).
   * Over-estimate is self-healing: the decrement releases exactly
   * what was reserved, the spent increment records the real number.
   */
  async beginReservation(
    scope: ScopeTuple,
    estimateCents: number,
    /**
     * PRELAUNCH-A3-7 — when set, reserve against the per-user counter too
     * so concurrent turns from the same user across different threads
     * can't both see "under cap" + both proceed (the per-thread mutex
     * doesn't serialize across threads).
     */
    userId?: string | null,
  ): Promise<void> {
    if (estimateCents <= 0) return;
    const today = new Date().toISOString().slice(0, 10);
    const s = scopeKey(scope);
    const key = `cost:scope:${s}:${today}:reserved`;
    // PRELAUNCH-A3-7 — per-user reservation key for concurrent-turn race.
    const userKey = userId ? `cost:user:${s}:${userId}:${today}:reserved` : null;
    try {
      const pipe = this.redis.pipeline()
        .hincrbyfloat(key, "cost_cents", estimateCents)
        .expire(key, 86400 * 90);
      if (userKey) {
        pipe.hincrbyfloat(userKey, "cost_cents", estimateCents).expire(userKey, 86400 * 90);
      }
      await pipe.exec();
    } catch {
      // Fail-open: availability over strict budget enforcement.
    }
  }

  async settleReservation(
    scope: ScopeTuple,
    estimateCents: number,
    /** PRELAUNCH-A3-7 — pair with the userId passed to beginReservation. */
    userId?: string | null,
  ): Promise<void> {
    if (estimateCents <= 0) return;
    const today = new Date().toISOString().slice(0, 10);
    const s = scopeKey(scope);
    const key = `cost:scope:${s}:${today}:reserved`;
    const userKey = userId ? `cost:user:${s}:${userId}:${today}:reserved` : null;
    try {
      const pipe = this.redis.pipeline().hincrbyfloat(key, "cost_cents", -estimateCents);
      if (userKey) pipe.hincrbyfloat(userKey, "cost_cents", -estimateCents);
      await pipe.exec();
    } catch {
      // Fail-open.
    }
  }

  /**
   * PRELAUNCH-A3-7 — read the per-user reserved amount. Clamped to >=0
   * for the same reason getReservedCents (scope-level) is.
   */
  async getUserReservedCents(
    scope: ScopeTuple,
    userId: string,
    day?: string,
  ): Promise<number> {
    if (!userId) return 0;
    const d = day ?? new Date().toISOString().slice(0, 10);
    const s = scopeKey(scope);
    try {
      const raw = await this.redis.hget(`cost:user:${s}:${userId}:${d}:reserved`, "cost_cents");
      const v = raw ? parseFloat(raw) || 0 : 0;
      return v > 0 ? v : 0;
    } catch {
      return 0;
    }
  }

  /** Read the current reserved-but-not-yet-settled amount for a scope+day.
   *  Wave 11b — clamp to >= 0 so an over-settlement race (settleReservation
   *  called twice for the same turn, or called before begin) can't drive
   *  the counter negative and hide real spend from budget evaluation. */
  async getReservedCents(scope: ScopeTuple, day?: string): Promise<number> {
    const d = day ?? new Date().toISOString().slice(0, 10);
    const s = scopeKey(scope);
    try {
      const raw = await this.redis.hget(`cost:scope:${s}:${d}:reserved`, "cost_cents");
      const v = raw ? parseFloat(raw) || 0 : 0;
      return v > 0 ? v : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Wave 11b — sweep stale reservation counters. A settle call that lands
   * in a Redis crash window leaks its reserved amount until TTL (90d),
   * slowly poisoning the cap. Reservations should settle within the turn
   * timeout (≤5 min); anything whose YYYY-MM-DD day-component is ≥2 days
   * old is leaked and safe to zero.
   *
   * Called by the same scheduled cost-reconcile trigger.dev task that
   * runs reconcileFromPostgres.
   */
  async sweepStaleReservations(): Promise<{ zeroed: number }> {
    const today = new Date();
    const cutoff = new Date(today.getTime() - 2 * 86400 * 1000);
    const cutoffIso = cutoff.toISOString().slice(0, 10);
    let zeroed = 0;
    let cursor = "0";
    try {
      do {
        const [next, keys] = (await (this.redis as any).scan(
          cursor,
          "MATCH",
          "cost:scope:*:reserved",
          "COUNT",
          200,
        )) as [string, string[]];
        cursor = next;
        for (const key of keys) {
          const m = /:(\d{4}-\d{2}-\d{2}):reserved$/.exec(key);
          if (!m) continue;
          if (m[1]! < cutoffIso) {
            await this.redis.del(key).catch(() => undefined);
            zeroed += 1;
          }
        }
      } while (cursor !== "0");
    } catch {
      // Fail-open; a sweep miss just delays reclaim until next run.
    }
    return { zeroed };
  }

  async reconcileFromPostgres(options: { daysBack?: number } = {}): Promise<{
    daysReconciled: number;
    scopesReconciled: number;
    agentsReconciled: number;
  }> {
    const daysBack = Math.max(1, Math.min(30, options.daysBack ?? 2));
    const now = new Date();
    const windowStart = new Date(now.getTime() - daysBack * 86400 * 1000);

    // The clean durable ledger is one Step per model invocation. Step stores
    // model + token totals directly; canonical scope is derived through its
    // Turn -> Thread -> Environment -> Project ancestry.
    const rows = await this.prisma.step.findMany({
      where: {
        createdAt: { gte: windowStart },
      },
      select: {
        createdAt: true,
        model: true,
        inputTokens: true,
        outputTokens: true,
        costCents: true,
        turn: {
          select: {
            id: true,
            status: true,
            thread: {
              select: {
                environmentId: true,
                agentId: true,
                environment: {
                  select: {
                    projectId: true,
                    project: { select: { organizationId: true } },
                  },
                },
              },
            },
          },
        },
      },
    });

    // Group in memory. Keys are string-interned for the hash writes below.
    //
    // WIN-134 — `tasks` is a set of Turn ids, not a counter. A rebuilt hash
    // that carried real cost and `tasks = 0` made the "Tasks completed" card,
    // `monitoring.cost.daily`/`.range` and a turns-limit budget cap all
    // under-report for every reconciled day — which, since the task runs
    // nightly over the trailing two days, is the normal post-Redis-loss state
    // rather than a corner case. `calls` counts Step rows and `tasks` counts
    // the Turns they belong to; a multi-step turn is where the two diverge, and
    // reading one as the other is the "322 tasks" bug.
    type Bucket = {
      input_tokens: number;
      output_tokens: number;
      cost_cents: number;
      calls: number;
      turns: Set<string>;
    };
    const mkBucket = (): Bucket => ({
      input_tokens: 0,
      output_tokens: 0,
      cost_cents: 0,
      calls: 0,
      turns: new Set<string>(),
    });
    const scopeKeys = new Map<string, Bucket>();
    const agentKeys = new Map<string, Bucket>();

    for (const row of rows as Array<{
      createdAt: Date;
      model: string;
      inputTokens: number | null;
      outputTokens: number | null;
      costCents: unknown;
      turn: {
        id: string;
        status: string | null;
        thread: {
          environmentId: string;
          agentId: string;
          environment: {
            projectId: string;
            project: { organizationId: string };
          };
        };
      } | null;
    }>) {
      const thread = row.turn?.thread;
      if (!thread) continue;
      const inputTokens = Number(row.inputTokens ?? 0);
      const outputTokens = Number(row.outputTokens ?? 0);
      const costCents = Number(row.costCents ?? 0);
      if (costCents <= 0 && inputTokens <= 0 && outputTokens <= 0) continue;
      const day = row.createdAt.toISOString().slice(0, 10);
      const s = scopeKey({
        organizationId: thread.environment.project.organizationId,
        projectId: thread.environment.projectId,
        environmentId: thread.environmentId,
      });
      const agentId = thread.agentId;
      // The ledger owns "is this a completed task", so the reconciler and the
      // live rollups cannot disagree about which Turns count.
      const completed = isCompletedTask({
        status: row.turn?.status,
        steps: [{ inputTokens, outputTokens }],
      });

      const scopeKeyStr = `cost:scope:${s}:${day}`;
      let scopeBucket = scopeKeys.get(scopeKeyStr);
      if (!scopeBucket) { scopeBucket = mkBucket(); scopeKeys.set(scopeKeyStr, scopeBucket); }
      scopeBucket.input_tokens += inputTokens;
      scopeBucket.output_tokens += outputTokens;
      scopeBucket.cost_cents += costCents;
      scopeBucket.calls += 1;
      if (completed && row.turn) scopeBucket.turns.add(row.turn.id);

      if (agentId) {
        const agentKeyStr = `cost:agent:${s}:${agentId}:${day}`;
        let agentBucket = agentKeys.get(agentKeyStr);
        if (!agentBucket) { agentBucket = mkBucket(); agentKeys.set(agentKeyStr, agentBucket); }
        agentBucket.input_tokens += inputTokens;
        agentBucket.output_tokens += outputTokens;
        agentBucket.cost_cents += costCents;
        agentBucket.calls += 1;
        if (completed && row.turn) agentBucket.turns.add(row.turn.id);
      }
    }

    // Preserve any existing hash: it may contain exact cache/reasoning rates
    // or auxiliary spend that the clean Step model cannot reconstruct.
    const candidates = [
      ...Array.from(scopeKeys.entries()).map(([key, bucket]) => ({
        key,
        bucket,
        kind: "scope" as const,
      })),
      ...Array.from(agentKeys.entries()).map(([key, bucket]) => ({
        key,
        bucket,
        kind: "agent" as const,
      })),
    ];
    // The existence check and fallback write must be atomic: recordUsage may
    // create an exact hash while reconcile is running, and that exact write
    // must win rather than being overwritten by a stale current-price estimate.
    const writeMissingHash = `
      if redis.call("EXISTS", KEYS[1]) == 1 then
        return 0
      end
      redis.call(
        "HSET", KEYS[1],
        "input_tokens", ARGV[1],
        "output_tokens", ARGV[2],
        "cost_cents", ARGV[3],
        "cost_with_cache_cents", ARGV[3],
        "calls", ARGV[4],
        "tasks", ARGV[5],
        "attribution_source", "step_fallback"
      )
      redis.call("EXPIRE", KEYS[1], 7776000)
      return 1
    `;
    const pipeline = this.redis.pipeline();
    for (const { key, bucket: b } of candidates) {
      pipeline.eval(
        writeMissingHash,
        1,
        key,
        String(b.input_tokens),
        String(b.output_tokens),
        String(b.cost_cents),
        String(b.calls),
        String(b.turns.size),
      );
    }
    const results = candidates.length > 0 ? await pipeline.exec() : [];
    const failed = results?.find(([err]) => err);
    if (failed?.[0]) throw failed[0];
    const written = candidates.filter(
      (_candidate, index) => Number(results?.[index]?.[1] ?? 0) === 1,
    );
    if (written.length > 0) {
      this.warnOnUnpricedStepFallback();
    }

    return {
      daysReconciled: daysBack,
      scopesReconciled: written.filter((entry) => entry.kind === "scope").length,
      agentsReconciled: written.filter((entry) => entry.kind === "agent").length,
    };
  }

  /**
   * Get cost summary for a thread.
   */
  async getThreadCost(threadId: string): Promise<{
    inputTokens: number;
    outputTokens: number;
    costCents: number;
    tasks: number;
  }> {
    const data = await this.redis.hgetall(`cost:thread:${threadId}`);
    // WIN-134 — this returned the naive figure while the cost-by-model panel
    // returned the cache-aware one, so a trace and a dashboard disagreed about
    // the same thread by up to 10x. One ledger, one number.
    const usage = usageFromRollup(data as RollupHash);
    return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costCents: roundCents(usage.costCents),
      tasks: usage.tasks,
    };
  }

  /**
   * Get cost summary for a scope (today or specific date).
   */
  async getScopeDailyCost(
    scope: ScopeTuple,
    date?: string,
  ): Promise<{
    inputTokens: number;
    outputTokens: number;
    costCents: number;
    tasks: number;
    byLane: Record<UsageLane, number>;
  }> {
    const day = date || new Date().toISOString().slice(0, 10);
    const data = await this.redis.hgetall(`cost:scope:${scopeKey(scope)}:${day}`);
    const usage = usageFromRollup(data as RollupHash);
    return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costCents: roundCents(usage.costCents),
      tasks: usage.tasks,
      byLane: roundLanes(laneCostsFromRollup(data as RollupHash)),
    };
  }

  /**
   * WIN-134 — THE canonical usage read.
   *
   * Every surface that reports "what happened in this window" goes through
   * here: the summary cards, the MCP monitoring tools, the usage page. It
   * returns the task count, the token lanes and the cache-aware cost, plus the
   * spend split that sums back to that cost by construction.
   *
   * Redis holds the per-day rollups; the Turn/Step ledger in Postgres is the
   * durable record and repairs them (see `reconcileFromPostgres`). Reads that
   * find nothing return zeros rather than throwing — a dashboard with no data
   * is a legitimate state and must not be reported as a failure.
   */
  async getScopeUsageWindow(
    scope: ScopeTuple,
    days: number = 7,
  ): Promise<UsageWindow & { perDay: Array<UsageWindow & { date: string }> }> {
    const dates = this.recentDates(days);
    const pipeline = this.redis.pipeline();
    for (const d of dates) pipeline.hgetall(`cost:scope:${scopeKey(scope)}:${d}`);
    let results: Array<[Error | null, unknown]> | null = null;
    try {
      results = (await pipeline.exec()) as any;
    } catch {
      // Fail-graceful — an unavailable rollup reads as an empty window.
    }
    const perDay = dates.map((date, i) => {
      const raw = ((results?.[i]?.[1] as RollupHash | undefined) ?? {}) as RollupHash;
      const usage = usageFromRollup(raw);
      return { date, ...usage, byLane: laneCostsFromRollup(raw) };
    });
    let totals = { ...EMPTY_USAGE };
    let byLane: Record<UsageLane, number> = {
      inference: 0,
      embedding: 0,
      extraction: 0,
      judge: 0,
      skill: 0,
    };
    for (const day of perDay) {
      totals = addUsage(totals, day);
      byLane = addLanes(byLane, day.byLane);
    }
    return {
      ...totals,
      costCents: roundCents(totals.costCents),
      byLane: roundLanes(byLane),
      perDay: perDay.map((day) => ({
        ...day,
        costCents: roundCents(day.costCents),
        byLane: roundLanes(day.byLane),
      })),
    };
  }

  /** The last `days` calendar days, newest first. Shared by every range read. */
  private recentDates(days: number): string[] {
    const todayMs = Date.now();
    const dates: string[] = [];
    for (let i = 0; i < days; i++) {
      dates.push(new Date(todayMs - i * 86400_000).toISOString().slice(0, 10));
    }
    return dates;
  }

  /**
   * Cost rollup by model from clean Step rows. Exact cache-adjusted cost is
   * also fanned out to `cost:model:*` by recordUsage; Step is the durable
   * model/token fallback when Redis has expired or restarted. Theme E.3.
   */
  async getCostByModel(
    scope: ScopeTuple,
    options: { days?: number; limit?: number } = {},
  ): Promise<Array<{
    model: string;
    costCents: number;
    costWithCacheCents: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    tasks: number;
  }>> {
    const days = options.days ?? 30;
    const limit = options.limit ?? 20;
    const since = new Date(Date.now() - days * 86400_000);

    const modelPrefix = `cost:model:${scopeKey(scope)}:`;
    const exactRows = await this.scanHashes(`${modelPrefix}*`);
    const exactByModel = new Map<string, ModelCostBucket>();
    const redisDaysByModel = new Map<string, Set<string>>();
    let usedStepFallback = false;
    for (const row of exactRows) {
      const dateMatch = /:(\d{4}-\d{2}-\d{2})$/.exec(row.key);
      if (!dateMatch || new Date(`${dateMatch[1]}T23:59:59.999Z`) < since) {
        continue;
      }
      const model = row.key.slice(
        modelPrefix.length,
        row.key.length - dateMatch[0].length,
      );
      if (!model) continue;
      const bucket = exactByModel.get(model) ?? {
        costCents: 0,
        costWithCacheCents: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        tasks: 0,
      };
      const usage = usageFromRollup(row.values as RollupHash);
      bucket.costCents += usage.costCents;
      bucket.costWithCacheCents += usage.costCents;
      bucket.inputTokens += usage.inputTokens;
      bucket.outputTokens += usage.outputTokens;
      bucket.cacheCreationInputTokens += usage.cacheWriteTokens;
      bucket.cacheReadInputTokens += usage.cacheReadTokens;
      bucket.tasks += usage.tasks;
      exactByModel.set(model, bucket);
      const redisDays = redisDaysByModel.get(model) ?? new Set<string>();
      redisDays.add(dateMatch[1]);
      redisDaysByModel.set(model, redisDays);
      if (row.values.attribution_source === "step_fallback") {
        usedStepFallback = true;
      }
    }

    const rows: Array<{
      createdAt: Date;
      model: string;
      inputTokens: number | null;
      outputTokens: number | null;
      cacheCreationInputTokens: number | null;
      cacheReadInputTokens: number | null;
      reasoningTokens: number | null;
      costCents: unknown;
      turnId: string;
    }> = await this.prisma.step.findMany({
      where: {
        createdAt: { gte: since },
        turn: {
          thread: {
            environmentId: scope.environmentId,
            environment: {
              project: {
                id: scope.projectId,
                organizationId: scope.organizationId,
              },
            },
          },
        },
      },
      select: {
        createdAt: true,
        model: true,
        inputTokens: true,
        outputTokens: true,
        cacheCreationInputTokens: true,
        cacheReadInputTokens: true,
        reasoningTokens: true,
        costCents: true,
        turnId: true,
      },
    });

    const byModel = new Map<string, ModelCostBucket>(exactByModel);
    // WIN-134 — a task is a completed Turn, so the fallback counts DISTINCT
    // turns rather than Step rows. Today a turn writes one Step and the two
    // agree; the moment a multi-step turn is persisted properly they stop
    // agreeing, and a per-row increment is how "322 tasks" happened.
    const fallbackTurnsByModel = new Map<string, Set<string>>();
    for (const row of rows) {
      const day = row.createdAt.toISOString().slice(0, 10);
      if (redisDaysByModel.get(row.model)?.has(day)) continue;
      usedStepFallback = true;
      const bucket = byModel.get(row.model) ?? {
        costCents: 0,
        costWithCacheCents: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        tasks: 0,
      };
      const usage = usageFromStep(row);
      bucket.costCents += usage.costCents;
      bucket.costWithCacheCents += usage.costCents;
      bucket.inputTokens += usage.inputTokens;
      bucket.outputTokens += usage.outputTokens;
      bucket.cacheCreationInputTokens += usage.cacheWriteTokens;
      bucket.cacheReadInputTokens += usage.cacheReadTokens;
      byModel.set(row.model, bucket);
      const turns = fallbackTurnsByModel.get(row.model) ?? new Set<string>();
      turns.add(row.turnId);
      fallbackTurnsByModel.set(row.model, turns);
    }
    for (const [model, turns] of fallbackTurnsByModel) {
      const bucket = byModel.get(model);
      if (bucket) bucket.tasks += turns.size;
    }
    if (usedStepFallback) this.warnOnUnpricedStepFallback();

    return Array.from(byModel.entries())
      .map(([model, b]) => ({
        model,
        ...b,
        // WIN-134 — the ledger rounds ONCE, at the end, at 0.0001c. Rounding
        // here at 0.01c reported a real sub-cent window as 0.00 on this panel
        // while the scope card showed the number, which is precisely the
        // sub-cent loss `roundCents` exists to prevent.
        costCents: roundCents(b.costCents),
        costWithCacheCents: roundCents(b.costWithCacheCents),
      }))
      .sort((a, b) => b.costCents - a.costCents || a.model.localeCompare(b.model))
      .slice(0, limit);
  }

  /**
   * Cost rollup by agent — joins Step → Turn → Thread → Agent. Theme E.3.
   */
  async getCostByAgent(
    scope: ScopeTuple,
    options: { days?: number; limit?: number } = {},
  ): Promise<Array<{
    agentId: string;
    agentName: string | null;
    costCents: number;
    costWithCacheCents: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    tasks: number;
    threads: number;
  }>> {
    const days = options.days ?? 30;
    const limit = options.limit ?? 20;
    const since = new Date(Date.now() - days * 86400_000);

    const agentPrefix = `cost:agent:${scopeKey(scope)}:`;
    const exactAgentRows = await this.scanHashes(`${agentPrefix}*`);
    const exactByAgent = new Map<string, AgentCostBucket>();
    const redisDaysByAgent = new Map<string, Set<string>>();
    let usedStepFallback = false;
    for (const row of exactAgentRows) {
      const dateMatch = /:(\d{4}-\d{2}-\d{2})$/.exec(row.key);
      if (!dateMatch || new Date(`${dateMatch[1]}T23:59:59.999Z`) < since) {
        continue;
      }
      const agentId = row.key.slice(
        agentPrefix.length,
        row.key.length - dateMatch[0].length,
      );
      // Per-agent × model hashes share this prefix. Only the UUID-only daily
      // hash is an agent total.
      if (!agentId || agentId.includes(":")) continue;
      const bucket = exactByAgent.get(agentId) ?? {
        costCents: 0,
        costWithCacheCents: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        tasks: 0,
        threads: new Set<string>(),
      };
      const usage = usageFromRollup(row.values as RollupHash);
      bucket.costCents += usage.costCents;
      bucket.costWithCacheCents += usage.costCents;
      bucket.inputTokens += usage.inputTokens;
      bucket.outputTokens += usage.outputTokens;
      bucket.cacheCreationInputTokens += usage.cacheWriteTokens;
      bucket.cacheReadInputTokens += usage.cacheReadTokens;
      bucket.tasks += usage.tasks;
      exactByAgent.set(agentId, bucket);
      const redisDays = redisDaysByAgent.get(agentId) ?? new Set<string>();
      redisDays.add(dateMatch[1]);
      redisDaysByAgent.set(agentId, redisDays);
      if (row.values.attribution_source === "step_fallback") {
        usedStepFallback = true;
      }
    }

    const rows: Array<{
      createdAt: Date;
      model: string;
      inputTokens: number | null;
      outputTokens: number | null;
      cacheCreationInputTokens: number | null;
      cacheReadInputTokens: number | null;
      reasoningTokens: number | null;
      costCents: unknown;
      turnId: string;
      turn: { thread: { agentId: string; id: string } } | null;
    }> =
      await this.prisma.step.findMany({
        where: {
          createdAt: { gte: since },
          turn: {
            thread: {
              environmentId: scope.environmentId,
              environment: {
                project: {
                  id: scope.projectId,
                  organizationId: scope.organizationId,
                },
              },
            },
          },
        },
        select: {
          createdAt: true,
          model: true,
          inputTokens: true,
          outputTokens: true,
          cacheCreationInputTokens: true,
          cacheReadInputTokens: true,
          reasoningTokens: true,
          costCents: true,
          turnId: true,
          turn: { select: { thread: { select: { agentId: true, id: true } } } },
        },
      });

    const byAgent = new Map<string, AgentCostBucket>(exactByAgent);
    const fallbackTurnsByAgent = new Map<string, Set<string>>();
    for (const r of rows) {
      const agentId = r.turn?.thread.agentId;
      if (!agentId) continue;
      const bucket = byAgent.get(agentId) ?? {
        costCents: 0,
        costWithCacheCents: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        tasks: 0,
        threads: new Set<string>(),
      };
      const day = r.createdAt.toISOString().slice(0, 10);
      if (!redisDaysByAgent.get(agentId)?.has(day)) {
        usedStepFallback = true;
        const usage = usageFromStep(r);
        bucket.costCents += usage.costCents;
        bucket.costWithCacheCents += usage.costCents;
        bucket.inputTokens += usage.inputTokens;
        bucket.outputTokens += usage.outputTokens;
        bucket.cacheCreationInputTokens += usage.cacheWriteTokens;
        bucket.cacheReadInputTokens += usage.cacheReadTokens;
        const turns = fallbackTurnsByAgent.get(agentId) ?? new Set<string>();
        turns.add(r.turnId);
        fallbackTurnsByAgent.set(agentId, turns);
      }
      if (r.turn?.thread.id) bucket.threads.add(r.turn.thread.id);
      byAgent.set(agentId, bucket);
    }
    for (const [agentId, turns] of fallbackTurnsByAgent) {
      const bucket = byAgent.get(agentId);
      if (bucket) bucket.tasks += turns.size;
    }
    if (usedStepFallback) this.warnOnUnpricedStepFallback();

    // Resolve agent names in a single query.
    const agentIds = Array.from(byAgent.keys());
    const agents: Array<{ id: string; name: string }> = agentIds.length
      ? await this.prisma.agent.findMany({
          where: {
            id: { in: agentIds },
            projectId: scope.projectId,
            project: { organizationId: scope.organizationId },
            bindings: { some: { environmentId: scope.environmentId } },
          },
          select: { id: true, name: true },
        })
      : [];
    const nameById = new Map(agents.map((a) => [a.id, a.name]));

    return Array.from(byAgent.entries())
      .map(([agentId, b]) => ({
        agentId,
        agentName: nameById.get(agentId) ?? null,
        // WIN-134 — the ledger rounds ONCE, at the end, at 0.0001c. Rounding
        // here at 0.01c reported a real sub-cent window as 0.00 on this panel
        // while the scope card showed the number, which is precisely the
        // sub-cent loss `roundCents` exists to prevent.
        costCents: roundCents(b.costCents),
        costWithCacheCents: roundCents(b.costWithCacheCents),
        inputTokens: b.inputTokens,
        outputTokens: b.outputTokens,
        cacheCreationInputTokens: b.cacheCreationInputTokens,
        cacheReadInputTokens: b.cacheReadInputTokens,
        tasks: b.tasks,
        threads: b.threads.size,
      }))
      .sort((a, b) => b.costCents - a.costCents || a.agentId.localeCompare(b.agentId))
      .slice(0, limit);
  }

  /**
   * Cost rollup by user. Theme E.3 + E.4.
   *
   * PRELAUNCH-A1-10 — payload extended with the full token breakdown
   * (input / output / cache_read / cache_creation / reasoning) so
   * monitoring dashboards can sort + filter by reasoning spend or cache
   * hit rate per user. Clean Step stores only `inputTokens` + `outputTokens`;
   * cache/reasoning values come from exact Redis attribution and remain zero
   * only when a warned Step fallback is required.
   */
  async getCostByUser(
    scope: ScopeTuple,
    options: { days?: number; limit?: number } = {},
  ): Promise<
    Array<{
      userId: string;
      costCents: number;
      /** Completed turns. Was `messages`, and was read as a task count. */
      tasks: number;
      threads: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      reasoningTokens: number;
      /** Input tokens neither read from nor written to cache. Derived once. */
      noCacheInputTokens: number;
    }>
  > {
    const days = options.days ?? 30;
    const limit = options.limit ?? 20;
    const since = new Date(Date.now() - days * 86400_000);

    const userPrefix = `cost:user:${scopeKey(scope)}:`;
    const exactUserRows = await this.scanHashes(`${userPrefix}*`);
    const exactByUser = new Map<string, UserCostBucket>();
    const redisDaysByUser = new Map<string, Set<string>>();
    let usedStepFallback = false;
    for (const row of exactUserRows) {
      const dateMatch = /:(\d{4}-\d{2}-\d{2})$/.exec(row.key);
      if (!dateMatch || new Date(`${dateMatch[1]}T23:59:59.999Z`) < since) {
        continue;
      }
      const userId = row.key.slice(
        userPrefix.length,
        row.key.length - dateMatch[0].length,
      );
      if (!userId) continue;
      const bucket = exactByUser.get(userId) ?? {
        costCents: 0,
        turns: new Set<string>(),
        threads: new Set<string>(),
        tasks: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningTokens: 0,
      };
      // WIN-134 — the per-user rollup was read as `cost_cents`, which the
      // budget path bumped a SECOND time for the same charge. The billable
      // field was only ever written once, so reading it is both the
      // cache-aware number and the un-doubled one.
      const usage = usageFromRollup(row.values as RollupHash);
      bucket.costCents += usage.costCents;
      bucket.inputTokens += usage.inputTokens;
      bucket.outputTokens += usage.outputTokens;
      bucket.cacheReadInputTokens += usage.cacheReadTokens;
      bucket.cacheCreationInputTokens += usage.cacheWriteTokens;
      bucket.reasoningTokens += usage.reasoningTokens;
      bucket.tasks += usage.tasks;
      exactByUser.set(userId, bucket);
      const redisDays = redisDaysByUser.get(userId) ?? new Set<string>();
      redisDays.add(dateMatch[1]);
      redisDaysByUser.set(userId, redisDays);
      if (row.values.attribution_source === "step_fallback") {
        usedStepFallback = true;
      }
    }

    const rows: Array<{
      createdAt: Date;
      model: string;
      inputTokens: number | null;
      outputTokens: number | null;
      cacheCreationInputTokens: number | null;
      cacheReadInputTokens: number | null;
      reasoningTokens: number | null;
      costCents: unknown;
      turn: { id: string; thread: { endUserId: string; id: string } } | null;
    }> =
      await this.prisma.step.findMany({
        where: {
          createdAt: { gte: since },
          turn: {
            thread: {
              environmentId: scope.environmentId,
              environment: {
                project: {
                  id: scope.projectId,
                  organizationId: scope.organizationId,
                },
              },
            },
          },
        },
        select: {
          createdAt: true,
          model: true,
          inputTokens: true,
          outputTokens: true,
          cacheCreationInputTokens: true,
          cacheReadInputTokens: true,
          reasoningTokens: true,
          costCents: true,
          turn: {
            select: {
              id: true,
              thread: { select: { endUserId: true, id: true } },
            },
          },
        },
      });

    const byUser = new Map<string, UserCostBucket>(exactByUser);
    const fallbackTurnsByUser = new Map<string, Set<string>>();
    for (const r of rows) {
      const userId = r.turn?.thread.endUserId;
      if (!userId) continue;
      const bucket = byUser.get(userId) ?? {
        costCents: 0,
        turns: new Set<string>(),
        threads: new Set<string>(),
        tasks: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningTokens: 0,
      };
      const day = r.createdAt.toISOString().slice(0, 10);
      if (!redisDaysByUser.get(userId)?.has(day)) {
        usedStepFallback = true;
        const usage = usageFromStep(r);
        bucket.costCents += usage.costCents;
        bucket.inputTokens += usage.inputTokens;
        bucket.outputTokens += usage.outputTokens;
        bucket.cacheCreationInputTokens += usage.cacheWriteTokens;
        bucket.cacheReadInputTokens += usage.cacheReadTokens;
        bucket.reasoningTokens += usage.reasoningTokens;
        if (r.turn?.id) fallbackTurnsByUser.set(userId, (fallbackTurnsByUser.get(userId) ?? new Set<string>()).add(r.turn.id));
      }
      if (r.turn?.id) bucket.turns.add(r.turn.id);
      if (r.turn?.thread.id) bucket.threads.add(r.turn.thread.id);
      byUser.set(userId, bucket);
    }
    for (const [userId, turns] of fallbackTurnsByUser) {
      const bucket = byUser.get(userId);
      if (bucket) bucket.tasks += turns.size;
    }
    if (usedStepFallback) this.warnOnUnpricedStepFallback();

    return Array.from(byUser.entries())
      .map(([userId, b]) => ({
        userId,
        // Rounded once, at the ledger's 0.0001c, like every other surface.
        costCents: roundCents(b.costCents),
        tasks: b.tasks,
        threads: b.threads.size,
        inputTokens: b.inputTokens,
        outputTokens: b.outputTokens,
        cacheReadInputTokens: b.cacheReadInputTokens,
        cacheCreationInputTokens: b.cacheCreationInputTokens,
        reasoningTokens: b.reasoningTokens,
        noCacheInputTokens: freshInputTokens(
          b.inputTokens,
          b.cacheReadInputTokens,
          b.cacheCreationInputTokens,
        ),
      }))
      .sort((a, b) => b.costCents - a.costCents)
      .slice(0, limit);
  }

  /**
   * SM.2 — skill usage breakdown for a single day.
   *
   * Reads the SM.1 fan-out keys under `cost:skill:<scope>:*:<day>`,
   * `cost:skill_tool:<scope>:*:*:<day>`, and `cost:agent:<scope>:*:<day>`
   * (for the `cost_cents:tier:skill` slice). Fail-graceful: if the scope
   * has zero recorded skill events the returned arrays are empty — the
   * UI renders an empty state, not a 500.
   *
   * Scope isolation is the composite-key prefix itself — we always SCAN
   * with a `MATCH cost:skill*:<scopeKey>:*:<day>` pattern so cross-env
   * leakage is impossible even if the caller's scope guard misfires.
   */
  async getSkillCostDaily(
    scope: ScopeTuple,
    date?: string,
  ): Promise<{
    date: string;
    totalCostCents: number;
    totalCalls: number;
    bySkill: Array<{ slug: string; totalCents: number; calls: number; inputUnits: number; outputUnits: number; latencyMsTotal: number }>;
    byTool: Array<{ slug: string; tool: string; calls: number; latencyMsTotal: number }>;
    byAgent: Array<{ agentId: string; agentName: string | null; totalCents: number; calls: number }>;
    byProvider: Array<{ provider: string; totalCents: number; calls: number }>;
  }> {
    const day = date || new Date().toISOString().slice(0, 10);
    const s = scopeKey(scope);

    // Defensive: all Redis SCAN / hgetall operations are wrapped — a Redis
    // hiccup must never crash the dashboard loader. Return empty shape on
    // any failure; the UI handles the empty state.
    const scanKeys = async (pattern: string): Promise<string[]> => {
      const collected: string[] = [];
      let cursor = "0";
      try {
        do {
          const [next, keys] = (await (this.redis as any).scan(
            cursor,
            "MATCH",
            pattern,
            "COUNT",
            200,
          )) as [string, string[]];
          cursor = next;
          for (const k of keys) collected.push(k);
        } while (cursor !== "0");
      } catch {
        return collected;
      }
      return collected;
    };

    const [skillKeys, toolKeys, agentKeys, providerKeys] = await Promise.all([
      scanKeys(`cost:skill:${s}:*:${day}`),
      scanKeys(`cost:skill_tool:${s}:*:*:${day}`),
      scanKeys(`cost:agent:${s}:*:${day}`),
      scanKeys(`cost:provider:${s}:*:${day}`),
    ]);

    const hgetMany = async (keys: string[]): Promise<Array<Record<string, string>>> => {
      if (keys.length === 0) return [];
      const pipeline = this.redis.pipeline();
      for (const k of keys) pipeline.hgetall(k);
      try {
        const results = await pipeline.exec();
        return (results ?? []).map((r) => (r?.[1] as Record<string, string>) ?? {});
      } catch {
        return keys.map(() => ({}));
      }
    };

    const [skillHashes, toolHashes, agentHashes, providerHashes] = await Promise.all([
      hgetMany(skillKeys),
      hgetMany(toolKeys),
      hgetMany(agentKeys),
      hgetMany(providerKeys),
    ]);

    // `cost:skill:<s>:<slug>:<day>`
    const bySkill = skillKeys.map((k, i) => {
      const h = skillHashes[i] ?? {};
      // slug lives between the scope and the day; pull it by trimming known
      // prefix + suffix rather than splitting on ":" (slugs never contain ":"
      // but be defensive).
      const prefix = `cost:skill:${s}:`;
      const slug = k.startsWith(prefix) ? k.slice(prefix.length, k.length - (day.length + 1)) : k;
      return {
        slug,
        totalCents: Math.round(parseFloat(h.cost_cents || "0") * 100) / 100,
        calls: parseInt(h.calls || "0", 10),
        inputUnits: parseInt(h.input_units || "0", 10),
        outputUnits: parseInt(h.output_units || "0", 10),
        latencyMsTotal: parseFloat(h.latency_ms_total || "0"),
      };
    }).sort((a, b) => b.totalCents - a.totalCents || b.calls - a.calls);

    // `cost:skill_tool:<s>:<slug>:<tool>:<day>`
    const byTool = toolKeys.map((k, i) => {
      const h = toolHashes[i] ?? {};
      const prefix = `cost:skill_tool:${s}:`;
      const middle = k.startsWith(prefix) ? k.slice(prefix.length, k.length - (day.length + 1)) : k;
      const [slug, ...rest] = middle.split(":");
      return {
        slug: slug ?? "unknown",
        tool: rest.join(":") || "unknown",
        calls: parseInt(h.calls || "0", 10),
        latencyMsTotal: parseFloat(h.latency_ms_total || "0"),
      };
    }).sort((a, b) => b.calls - a.calls);

    // `cost:agent:<s>:<agentId>:<day>` — only keep ones with a skill-tier
    // breakdown; the hash also carries LLM totals we don't want here.
    const skillAgentRows: Array<{ agentId: string; totalCents: number; calls: number }> = [];
    agentKeys.forEach((k, i) => {
      const h = agentHashes[i] ?? {};
      const skillCents = parseFloat(h["cost_cents:tier:skill"] || "0");
      const skillCalls = parseInt(h.skill_calls || "0", 10);
      if (skillCents <= 0 && skillCalls <= 0) return;
      const prefix = `cost:agent:${s}:`;
      const agentId = k.startsWith(prefix) ? k.slice(prefix.length, k.length - (day.length + 1)) : k;
      // Per-agent × per-model keys (`cost:agent:<s>:<agentId>:<model>:<day>`)
      // share the same prefix — skip those. agentId segment must not
      // contain `:` (uuid/slug). Trust the scope key has exactly one
      // colon-bounded id.
      if (agentId.includes(":")) return;
      skillAgentRows.push({ agentId, totalCents: Math.round(skillCents * 100) / 100, calls: skillCalls });
    });
    // Resolve agent names in one query (reuse the pattern from getCostByAgent).
    const agentIds = skillAgentRows.map((r) => r.agentId);
    const agentNameById = new Map<string, string>();
    if (agentIds.length > 0) {
      try {
        const agents: Array<{ id: string; name: string }> = await this.prisma.agent.findMany({
          where: {
            id: { in: agentIds },
            projectId: scope.projectId,
            project: { organizationId: scope.organizationId },
            bindings: { some: { environmentId: scope.environmentId } },
          },
          select: { id: true, name: true },
        });
        for (const a of agents) agentNameById.set(a.id, a.name);
      } catch {
        // Name resolution is best-effort; ids-only is still useful.
      }
    }
    const byAgent = skillAgentRows
      .map((r) => ({ ...r, agentName: agentNameById.get(r.agentId) ?? null }))
      .sort((a, b) => b.totalCents - a.totalCents || b.calls - a.calls);

    // `cost:provider:<s>:<provider>:<day>`
    const byProvider = providerKeys.map((k, i) => {
      const h = providerHashes[i] ?? {};
      const prefix = `cost:provider:${s}:`;
      const provider = k.startsWith(prefix) ? k.slice(prefix.length, k.length - (day.length + 1)) : k;
      return {
        provider,
        totalCents: Math.round(parseFloat(h.cost_cents || "0") * 100) / 100,
        calls: parseInt(h.calls || "0", 10),
      };
    }).sort((a, b) => b.totalCents - a.totalCents || b.calls - a.calls);

    const totalCostCents = Math.round(bySkill.reduce((acc, r) => acc + r.totalCents, 0) * 100) / 100;
    const totalCalls = bySkill.reduce((acc, r) => acc + r.calls, 0);

    return { date: day, totalCostCents, totalCalls, bySkill, byTool, byAgent, byProvider };
  }

  /**
   * SM.2 — skill usage breakdown over a date range.
   *
   * `from`/`to` are inclusive YYYY-MM-DD strings. Fetches per-day summaries
   * via `getSkillCostDaily` and merges them. Output carries per-day totals
   * (for a time-series chart) alongside aggregated skill / tool / agent /
   * provider breakdowns. Hard cap at 92 days to bound fan-out (90d TTL +
   * 2d slack) — longer windows return a clamped result.
   */
  async getSkillCostRange(
    scope: ScopeTuple,
    from: string,
    to: string,
  ): Promise<{
    from: string;
    to: string;
    totalCostCents: number;
    totalCalls: number;
    perDay: Array<{ date: string; totalCostCents: number; totalCalls: number }>;
    bySkill: Array<{ slug: string; totalCents: number; calls: number; inputUnits: number; outputUnits: number; latencyMsTotal: number }>;
    byTool: Array<{ slug: string; tool: string; calls: number; latencyMsTotal: number }>;
    byAgent: Array<{ agentId: string; agentName: string | null; totalCents: number; calls: number }>;
    byProvider: Array<{ provider: string; totalCents: number; calls: number }>;
  }> {
    const start = from;
    const end = to;
    // Validate + clamp window. Silently coerce bad input to today for
    // fail-graceful behaviour.
    const todayIso = new Date().toISOString().slice(0, 10);
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(start) ? new Date(start + "T00:00:00Z") : new Date(todayIso + "T00:00:00Z");
    const endDate = /^\d{4}-\d{2}-\d{2}$/.test(end) ? new Date(end + "T00:00:00Z") : new Date(todayIso + "T00:00:00Z");
    if (endDate.getTime() < startDate.getTime()) {
      return { from: start, to: end, totalCostCents: 0, totalCalls: 0, perDay: [], bySkill: [], byTool: [], byAgent: [], byProvider: [] };
    }
    const spanDays = Math.min(
      92,
      Math.floor((endDate.getTime() - startDate.getTime()) / 86400_000) + 1,
    );

    const days: string[] = [];
    for (let i = 0; i < spanDays; i++) {
      days.push(new Date(startDate.getTime() + i * 86400_000).toISOString().slice(0, 10));
    }

    const perDayResults = await Promise.all(days.map((d) => this.getSkillCostDaily(scope, d)));

    // Merge per-day breakdowns.
    const skillAcc = new Map<string, { slug: string; totalCents: number; calls: number; inputUnits: number; outputUnits: number; latencyMsTotal: number }>();
    const toolAcc = new Map<string, { slug: string; tool: string; calls: number; latencyMsTotal: number }>();
    const agentAcc = new Map<string, { agentId: string; agentName: string | null; totalCents: number; calls: number }>();
    const providerAcc = new Map<string, { provider: string; totalCents: number; calls: number }>();
    const perDay: Array<{ date: string; totalCostCents: number; totalCalls: number }> = [];
    let totalCostCents = 0;
    let totalCalls = 0;

    for (const dayResult of perDayResults) {
      perDay.push({ date: dayResult.date, totalCostCents: dayResult.totalCostCents, totalCalls: dayResult.totalCalls });
      totalCostCents += dayResult.totalCostCents;
      totalCalls += dayResult.totalCalls;
      for (const row of dayResult.bySkill) {
        const existing = skillAcc.get(row.slug);
        if (!existing) skillAcc.set(row.slug, { ...row });
        else {
          existing.totalCents += row.totalCents;
          existing.calls += row.calls;
          existing.inputUnits += row.inputUnits;
          existing.outputUnits += row.outputUnits;
          existing.latencyMsTotal += row.latencyMsTotal;
        }
      }
      for (const row of dayResult.byTool) {
        const key = `${row.slug}::${row.tool}`;
        const existing = toolAcc.get(key);
        if (!existing) toolAcc.set(key, { ...row });
        else {
          existing.calls += row.calls;
          existing.latencyMsTotal += row.latencyMsTotal;
        }
      }
      for (const row of dayResult.byAgent) {
        const existing = agentAcc.get(row.agentId);
        if (!existing) agentAcc.set(row.agentId, { ...row });
        else {
          existing.totalCents += row.totalCents;
          existing.calls += row.calls;
          existing.agentName = existing.agentName ?? row.agentName;
        }
      }
      for (const row of dayResult.byProvider) {
        const existing = providerAcc.get(row.provider);
        if (!existing) providerAcc.set(row.provider, { ...row });
        else {
          existing.totalCents += row.totalCents;
          existing.calls += row.calls;
        }
      }
    }

    const round = (n: number) => Math.round(n * 100) / 100;
    return {
      from: start,
      to: end,
      totalCostCents: round(totalCostCents),
      totalCalls,
      perDay,
      bySkill: Array.from(skillAcc.values())
        .map((r) => ({ ...r, totalCents: round(r.totalCents) }))
        .sort((a, b) => b.totalCents - a.totalCents || b.calls - a.calls),
      byTool: Array.from(toolAcc.values()).sort((a, b) => b.calls - a.calls),
      byAgent: Array.from(agentAcc.values())
        .map((r) => ({ ...r, totalCents: round(r.totalCents) }))
        .sort((a, b) => b.totalCents - a.totalCents || b.calls - a.calls),
      byProvider: Array.from(providerAcc.values())
        .map((r) => ({ ...r, totalCents: round(r.totalCents) }))
        .sort((a, b) => b.totalCents - a.totalCents || b.calls - a.calls),
    };
  }

  /**
   * Aggregate the last N days of per-scope Redis cost counters.
   *
   * MC.2 — surfaces both naive `costCents` (input + output only) and
   * cache-adjusted `costWithCacheCents` (1.25× cache writes + 0.1× reads).
   * Plus the two cache token totals so the dashboard can render "cached
   * tokens written / read / savings" tiles.
   */
  async getScopeCostRange(
    scope: ScopeTuple,
    days: number = 7,
  ): Promise<{
    inputTokens: number;
    outputTokens: number;
    costCents: number;
    costWithCacheCents: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    noCacheInputTokens: number;
    tasks: number;
    byLane: Record<UsageLane, number>;
    perDay: Array<{
      date: string;
      inputTokens: number;
      outputTokens: number;
      costCents: number;
      costWithCacheCents: number;
      cacheCreationInputTokens: number;
      cacheReadInputTokens: number;
      noCacheInputTokens: number;
      tasks: number;
      byLane: Record<UsageLane, number>;
    }>;
  }> {
    const window = await this.getScopeUsageWindow(scope, days);
    const project = (row: { date?: string } & typeof window) => ({
      ...(row.date ? { date: row.date } : {}),
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      costCents: row.costCents,
      // Both names carry the SAME cache-aware figure. The page used to sum
      // them into a "naive vs with-cache" comparison, which was a fourth
      // independent arithmetic over data that already agreed.
      costWithCacheCents: row.costCents,
      cacheCreationInputTokens: row.cacheWriteTokens,
      cacheReadInputTokens: row.cacheReadTokens,
      noCacheInputTokens: row.freshInputTokens,
      tasks: row.tasks,
      byLane: row.byLane,
    });
    return {
      ...project(window),
      perDay: window.perDay.map((day) => project(day as any) as any),
    };
  }

  /**
   * MC.4 — per-agent cache usage over a window. Reads the per-agent daily
   * Redis hashes (`cost:agent:<scope>:<agentId>:<day>`) written by
   * `recordUsage`, and returns both the cumulative totals and a per-day
   * series suitable for a sparkline. Cache hit rate is computed at the
   * consumer — this method just surfaces the raw tokens.
   *
   * Returns an empty-shape payload (all zeros) when the agent has no
   * recorded traffic in the window; callers render an empty-state tile
   * rather than a 500.
   */
  async getAgentCacheRange(
    scope: ScopeTuple,
    agentId: string,
    days: number = 7,
  ): Promise<{
    inputTokens: number;
    outputTokens: number;
    costCents: number;
    costWithCacheCents: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    noCacheInputTokens: number;
    tasks: number;
    perDay: Array<{
      date: string;
      inputTokens: number;
      outputTokens: number;
      cacheCreationInputTokens: number;
      cacheReadInputTokens: number;
      noCacheInputTokens: number;
      costCents: number;
      costWithCacheCents: number;
      tasks: number;
    }>;
  }> {
    const dates = this.recentDates(days);
    const s = scopeKey(scope);
    const pipeline = this.redis.pipeline();
    for (const d of dates) pipeline.hgetall(`cost:agent:${s}:${agentId}:${d}`);
    let results: Array<[Error | null, unknown]> | null = null;
    try {
      results = (await pipeline.exec()) as any;
    } catch {
      // Fail-graceful — return empty-shape.
    }
    const perDay = dates.map((date, i) => {
      const raw = ((results?.[i]?.[1] as RollupHash | undefined) ?? {}) as RollupHash;
      const usage = usageFromRollup(raw);
      return {
        date,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheCreationInputTokens: usage.cacheWriteTokens,
        cacheReadInputTokens: usage.cacheReadTokens,
        noCacheInputTokens: usage.freshInputTokens,
        costCents: roundCents(usage.costCents),
        costWithCacheCents: roundCents(usage.costCents),
        tasks: usage.tasks,
      };
    });
    const totals = perDay.reduce(
      (acc, r) => ({
        inputTokens: acc.inputTokens + r.inputTokens,
        outputTokens: acc.outputTokens + r.outputTokens,
        costCents: acc.costCents + r.costCents,
        costWithCacheCents: acc.costWithCacheCents + r.costWithCacheCents,
        cacheCreationInputTokens: acc.cacheCreationInputTokens + r.cacheCreationInputTokens,
        cacheReadInputTokens: acc.cacheReadInputTokens + r.cacheReadInputTokens,
        noCacheInputTokens: acc.noCacheInputTokens + r.noCacheInputTokens,
        tasks: acc.tasks + r.tasks,
      }),
      {
        inputTokens: 0,
        outputTokens: 0,
        costCents: 0,
        costWithCacheCents: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        noCacheInputTokens: 0,
        tasks: 0,
      },
    );
    return {
      ...totals,
      costCents: roundCents(totals.costCents),
      costWithCacheCents: roundCents(totals.costWithCacheCents),
      perDay,
    };
  }
}
