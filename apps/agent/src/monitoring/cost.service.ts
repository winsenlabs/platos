import { Injectable, Inject, Logger } from "@nestjs/common";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { REDIS_TOKEN } from "../shared/redis.provider";
import type Redis from "ioredis";
import type { RequestScope } from "../auth/scope.guard";

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
 * `PlatosAgentMessage.responseJson.cost_cents` (write-once per row). For
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

/**
 * Last-known-good fallback prices (cents per 1M tokens). Used only when the
 * LiteLLM live catalog hasn't been fetched yet or the cache is empty. Kept
 * intentionally small — the authoritative prices live in Redis under
 * `cost:model_catalog`, refreshed daily by the `platos.cost.refresh_model_prices`
 * trigger task (see Theme B.10).
 */
const FALLBACK_PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic / OpenAI / Google (legacy keys + provider-prefixed copies).
  "claude-sonnet-4-6": { input: 300, output: 1500 },
  "claude-opus-4-6": { input: 1500, output: 7500 },
  "claude-haiku-4-5-20251001": { input: 80, output: 400 },
  "claude-sonnet-4-20250514": { input: 300, output: 1500 },
  "claude-opus-4-20250514": { input: 1500, output: 7500 },
  "gpt-4o": { input: 250, output: 1000 },
  "gpt-4o-mini": { input: 15, output: 60 },
  "gpt-4.1": { input: 200, output: 800 },
  "gpt-4.1-mini": { input: 40, output: 160 },
  "gemini-2.5-pro": { input: 125, output: 1000 },
  "gemini-2.5-flash": { input: 15, output: 60 },
  "gemini-2.0-flash": { input: 10, output: 40 },

  // Together AI — verified against https://www.together.ai/pricing 2026-05-13.
  // `openai/gpt-oss-120b`: $0.15/M in, $0.60/M out → 15/60 cents/M.
  // The old `gpt-oss-120b: { 4, 19 }` row had bogus numbers AND a bare key
  // that never matched `together:openai/gpt-oss-120b` (the actual model
  // string in agent configs), so cost fell through to the conservative
  // 100/300 estimator and overcharged by ~500×.
  "together:openai/gpt-oss-120b": { input: 15, output: 60 },
  "together:openai/gpt-oss-20b": { input: 5, output: 20 },
  "together:meta-llama/Llama-3.3-70B-Instruct-Turbo": { input: 88, output: 88 },
  "together:meta-llama/Llama-3.1-8B-Instruct-Turbo": { input: 18, output: 18 },
  "together:Qwen/Qwen2.5-72B-Instruct-Turbo": { input: 120, output: 120 },
  "together:deepseek-ai/DeepSeek-R1": { input: 300, output: 700 },

  // Groq — verified against https://console.groq.com/docs/models 2026-05-13.
  "groq:llama-3.3-70b-versatile": { input: 59, output: 79 },
  "groq:llama-3.1-8b-instant": { input: 5, output: 8 },
  "groq:qwen-2.5-72b": { input: 90, output: 90 },
  "groq:deepseek-r1-distill-llama-70b": { input: 75, output: 99 },
  "groq:openai/gpt-oss-120b": { input: 15, output: 75 },
  "groq:openai/gpt-oss-20b": { input: 10, output: 50 },
  "groq:mixtral-8x7b-32768": { input: 24, output: 24 },

  // Cerebras — verified against https://inference-docs.cerebras.ai/api-reference/models.
  "cerebras:llama-3.3-70b": { input: 60, output: 80 },
  "cerebras:llama-3.1-8b": { input: 10, output: 10 },
  "cerebras:llama3.1-70b": { input: 60, output: 80 },
  "cerebras:gpt-oss-120b": { input: 25, output: 25 },

  // Fireworks AI — approximate serverless rates.
  "fireworks:accounts/fireworks/models/llama-v3p3-70b-instruct": { input: 90, output: 90 },
  "fireworks:accounts/fireworks/models/deepseek-v3": { input: 90, output: 90 },
  "fireworks:accounts/fireworks/models/deepseek-r1": { input: 300, output: 800 },
  "fireworks:accounts/fireworks/models/qwen2p5-72b-instruct": { input: 90, output: 90 },

  // Mistral — verified against https://mistral.ai/news/.
  "mistral:mistral-large-latest": { input: 200, output: 600 },
  "mistral:mistral-small-latest": { input: 20, output: 60 },
  "mistral:codestral-latest": { input: 30, output: 90 },
  "mistral:pixtral-large-latest": { input: 200, output: 600 },
  "mistral:ministral-8b-latest": { input: 10, output: 10 },

  // xAI — verified against https://docs.x.ai/.
  "xai:grok-2-latest": { input: 200, output: 1000 },
  "xai:grok-2-vision-latest": { input: 200, output: 1000 },
  "xai:grok-beta": { input: 500, output: 1500 },

  // DeepSeek direct API (much cheaper than reseller pricing).
  "deepseek:deepseek-chat": { input: 27, output: 110 },
  "deepseek:deepseek-reasoner": { input: 55, output: 219 },

  // Perplexity Sonar (search-grounded; output includes retrieval).
  "perplexity:sonar": { input: 100, output: 100 },
  "perplexity:sonar-pro": { input: 300, output: 1500 },
  "perplexity:sonar-reasoning": { input: 100, output: 500 },
  "perplexity:sonar-reasoning-pro": { input: 200, output: 800 },
  "perplexity:sonar-deep-research": { input: 200, output: 800 },

  // Sakana Fugu — verified against https://console.sakana.ai/pricing 2026-07-16.
  // fugu-ultra: $5/M in, $30/M out → 500/3000 cents/M (standard ≤272K tier;
  // above 272K input it rises to $10/$45 — not modeled, fixed-tier fallback).
  // Cached input ($0.50/M, 90% off) is applied via CACHE_RATES `sakana`.
  // `fugu` has no published fixed rate (blended/underlying-model pricing); we
  // default it to the fugu-ultra ceiling so the ledger never under-prices.
  // CAVEAT: Fugu bills hidden orchestration tokens (~1.3K/request floor) that
  // may be additive and are reported under usage._details — if the AI SDK does
  // not surface them, this fallback under-counts real spend. Follow-up: read
  // prompt_tokens_details / completion_tokens_details orchestration fields.
  "sakana:fugu-ultra": { input: 500, output: 3000 },
  "sakana:fugu": { input: 500, output: 3000 },
};

/**
 * Maps Platos provider ids to LiteLLM's `model_prices_and_context_window.json`
 * key prefixes. LiteLLM uses different prefixes for several OpenAI-compatible
 * providers, so we have to translate before probing the live catalog.
 * Mismatched entries here were the second cause of cost mis-billing on
 * Together (no entry could ever match `together:<id>` against LiteLLM's
 * `together_ai/<id>` keys).
 */
const LITELLM_PROVIDER_PREFIX: Record<string, string> = {
  together: "together_ai",
  groq: "groq",
  mistral: "mistral",
  xai: "xai",
  deepseek: "deepseek",
  cerebras: "cerebras",
  perplexity: "perplexity",
  fireworks: "fireworks_ai",
  openai: "openai",
  anthropic: "anthropic",
  google: "gemini",
  "google-vertex": "vertex_ai",
  azure: "azure",
};

/**
 * Build the priority-ordered list of lookup keys for a Platos model string.
 * Both FALLBACK_PRICING and the LiteLLM live catalog are probed against
 * every entry in order; first hit wins. Tries:
 *   1. Full `<provider>:<model>` — matches our FALLBACK_PRICING new rows
 *   2. Bare `<model>` — preserves legacy lookups
 *   3. Trailing slash segment — handles HF-style `org/name` ids
 *   4. LiteLLM-prefixed `<litellm_prefix>/<model>` — taps the live catalog
 */
function modelLookupKeys(model: string): string[] {
  if (!model) return [];
  const keys: string[] = [model];
  const colon = model.indexOf(":");
  const provider = colon > 0 ? model.slice(0, colon) : null;
  const bare = colon > 0 ? model.slice(colon + 1) : model;
  if (bare !== model) keys.push(bare);
  const lastSlash = bare.lastIndexOf("/");
  if (lastSlash > 0) {
    const tail = bare.slice(lastSlash + 1);
    if (tail && tail !== bare) keys.push(tail);
  }
  if (provider) {
    const liteLLMPrefix = LITELLM_PROVIDER_PREFIX[provider];
    if (liteLLMPrefix) keys.push(`${liteLLMPrefix}/${bare}`);
  }
  return keys;
}

/**
 * Last-resort conservative estimator. Returns provider-aware defaults so
 * unknown models on cheap OSS-host providers don't get billed at the
 * Anthropic-tier rate. Used only when both the live catalog and
 * FALLBACK_PRICING miss every lookup key for the model.
 *
 * Numbers are intentionally rough — they're a safety net, not a price list.
 * Adding an entry to FALLBACK_PRICING is the correct fix for any model that
 * shows up here in practice.
 */
/**
 * Resolve per-1M-token rates (in cents) for a model string. Single source of
 * truth used by every cost-math entrypoint on CostService — guarantees the
 * same lookup priority everywhere:
 *
 *   1. LiteLLM live catalog — probed with every key from `modelLookupKeys`
 *      so provider-prefixed Platos ids match LiteLLM's `together_ai/...`
 *      style keys too.
 *   2. Hardcoded FALLBACK_PRICING — same multi-key probe.
 *   3. Provider-aware conservative estimator — caps OSS-host overcharge.
 *
 * Returns raw (unrounded) rates so callers can do their own precision math
 * (calculateCost rounds at 0.01¢, calculateCostWithCache at 0.0001¢).
 */
export interface ResolvedRates {
  /** Cents per 1M tokens. */
  input: number;
  output: number;
  /**
   * Cents per 1M CACHE-READ tokens, when the price source states it per model.
   * `undefined` means "not known for this model" and the caller falls back to
   * the coarse per-provider multiplier in CACHE_RATES.
   */
  cacheRead?: number;
  /** Cents per 1M CACHE-WRITE tokens; same fallback semantics. */
  cacheWrite?: number;
  /** Where the numbers came from — stamped onto the turn for auditability. */
  source: "verified" | "catalog" | "fallback-table" | "conservative";
}

/**
 * PRECISION (2026-07-31) — resolve cache rates PER MODEL, not per provider.
 *
 * The catalog has always carried `cache_read_input_token_cost` /
 * `cache_creation_input_token_cost`, and this function has always thrown them
 * away, leaving `calculateCostWithCache` to apply a per-PROVIDER multiplier
 * (`CACHE_RATES`) instead. Those multipliers are a blunt instrument and were
 * measurably wrong:
 *
 *   CACHE_RATES.openai = { read: 0.5, write: 1.0 }
 *   gpt-5.6-luna actual =  read 0.1x,  write 2.5x
 *
 * Cache writes on that model cost 2.5x fresh input — more, not less — while
 * reads cost a fifth of what we assumed. On a turn that is 70-95% cache reads
 * those two errors do not cancel; they compound. Per-model figures remove the
 * guess entirely wherever the source states them, and the multiplier survives
 * only as the fallback for models that do not.
 */
function resolveRates(model: string, catalog: LiteLLMCatalog | null): ResolvedRates {
  const keys = modelLookupKeys(model);
  const perMillionCents = (perToken: number | undefined): number | undefined =>
    perToken === undefined || perToken === null ? undefined : perToken * 1_000_000 * 100;

  // Verified provider figures outrank the catalog — see verified-prices.ts for
  // why the catalog alone is not trustworthy on a per-row basis.
  const verified = verifiedPriceFor(keys);

  if (catalog || verified) {
    for (const k of keys) {
      const merged = applyVerifiedPrice(catalog?.[k], verified);
      if (!merged) continue;
      const inputCents = perMillionCents(merged.input_cost_per_token) ?? 0;
      const outputCents = perMillionCents(merged.output_cost_per_token) ?? 0;
      if (inputCents > 0 || outputCents > 0) {
        return {
          input: inputCents,
          output: outputCents,
          cacheRead: perMillionCents(merged.cache_read_input_token_cost),
          cacheWrite: perMillionCents(merged.cache_creation_input_token_cost),
          source: verified ? "verified" : "catalog",
        };
      }
    }
    // A verified entry with no catalog row at all still prices the model.
    if (verified && (verified.input !== undefined || verified.output !== undefined)) {
      return {
        input: perMillionCents(verified.input) ?? 0,
        output: perMillionCents(verified.output) ?? 0,
        cacheRead: perMillionCents(verified.cacheRead),
        cacheWrite: perMillionCents(verified.cacheWrite),
        source: "verified",
      };
    }
  }
  for (const k of keys) {
    const pricing = FALLBACK_PRICING[k];
    if (pricing) return { ...pricing, source: "fallback-table" };
  }
  return { ...conservativeFallbackRates(model), source: "conservative" };
}

function conservativeFallbackRates(model: string): { input: number; output: number } {
  const colon = model.indexOf(":");
  const provider = colon > 0 ? model.slice(0, colon) : "";
  switch (provider) {
    case "groq":
    case "cerebras":
    case "deepseek":
      return { input: 25, output: 100 }; // ultra-cheap OSS hosts
    case "together":
    case "fireworks":
    case "perplexity":
    case "mistral":
      return { input: 50, output: 200 }; // mid-tier OSS hosts
    case "google":
      return { input: 40, output: 160 }; // Gemini cheapest tier
    case "xai":
      return { input: 200, output: 1000 }; // Grok pricier
    case "anthropic":
    case "openai":
    case "google-vertex":
    case "azure":
    default:
      return { input: 100, output: 300 }; // historical conservative tier
  }
}

const CATALOG_KEY = "cost:model_catalog";
const CATALOG_CACHE_TTL_MS = 60_000; // in-process memo for one minute
/** Upstream price catalog — same source the daily refresh task uses. */
const LITELLM_CATALOG_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
/** After a failed lazy fetch, don't retry for this long (upstream outage guard). */
const CATALOG_FETCH_BACKOFF_MS = 300_000; // 5 minutes

interface LiteLLMCatalogEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  /** Per-model cache-WRITE price. Present for Anthropic + newer OpenAI rows. */
  cache_creation_input_token_cost?: number;
  litellm_provider?: string;
}
type LiteLLMCatalog = Record<string, LiteLLMCatalogEntry>;

function scopeKey(scope: ScopeTuple): string {
  return `${scope.organizationId}:${scope.projectId}:${scope.environmentId}`;
}

/**
 * PRELAUNCH-A1-2 / A1-8 — provider-aware cache surcharge factors.
 *
 * Anomaly-3 follow-up (2026-05-04): the table + helpers were extracted to
 * `@internal/cost-rates` so agent + webapp share a single source of truth
 * (the parallel files used to drift). We re-export here for back-compat
 * with existing imports of `CostService` consumers + the regression tests.
 */
export {
  CACHE_RATES,
  providerForModel,
  cacheRatesFor,
  cacheDiscountLabel,
} from "@internal/cost-rates";
import {
  cacheRatesFor,
  providerForModel,
} from "@internal/cost-rates";
// PRECISION — provider-verified overrides layered on top of the upstream
// catalog, because LiteLLM is wrong on a per-row basis (see verified-prices.ts).
import { applyVerifiedPrice, verifiedPriceFor } from "./verified-prices";

/**
 * CostService — tracks LLM token usage and cost per conversation, per scope.
 *
 * Uses trigger.dev's existing LLM model catalog (LlmModel + LlmPrice tables)
 * for accurate pricing. Falls back to hardcoded rates for unknown models.
 *
 * Costs are recorded:
 * - Per message (stored in PlatosAgentMessage.responseJson.cost_cents)
 * - Per thread (aggregated in Redis for real-time dashboard)
 * - Per (org, project, env) (aggregated daily for billing)
 */
@Injectable()
export class CostService {
  /** Nest logger — added with the lazy catalog load so a cold/failed fetch is
   *  visible in the deployment logs rather than silently degrading rates. */
  private readonly logger = new Logger(CostService.name);
  private prisma: any;
  private catalogMemo: { catalog: LiteLLMCatalog | null; loadedAt: number } = {
    catalog: null,
    loadedAt: 0,
  };
  private lastKnownCatalog: LiteLLMCatalog | null = null;

  constructor(
    @Inject(PRISMA_TOKEN) prisma: any,
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
  ) {
    this.prisma = prisma;
  }

  /**
   * Store a refreshed LiteLLM catalog into Redis + in-process memo.
   * Called by the admin endpoint that the daily refresh task posts to.
   */
  async ingestCatalog(catalog: LiteLLMCatalog): Promise<void> {
    await this.redis.set(CATALOG_KEY, JSON.stringify(catalog), "EX", 86400);
    this.catalogMemo = { catalog, loadedAt: Date.now() };
    this.lastKnownCatalog = catalog;
  }

  /**
   * Read the cached LiteLLM catalog. Returns the in-process memo when fresh,
   * otherwise loads from Redis, otherwise from the process's
   * `lastKnownCatalog`, otherwise `null` (triggers FALLBACK_PRICING path).
   *
   * This function never throws — a stale cache is always preferable to a
   * broken cost tracker.
   */
  async getCatalog(): Promise<LiteLLMCatalog | null> {
    if (
      this.catalogMemo.catalog &&
      Date.now() - this.catalogMemo.loadedAt < CATALOG_CACHE_TTL_MS
    ) {
      return this.catalogMemo.catalog;
    }
    try {
      const raw = await this.redis.get(CATALOG_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as LiteLLMCatalog;
        this.catalogMemo = { catalog: parsed, loadedAt: Date.now() };
        this.lastKnownCatalog = parsed;
        return parsed;
      }
    } catch {
      // fall through
    }
    // SELF-HEAL (2026-07-31) — a cold catalog used to stay cold forever.
    //
    // The catalog is populated by the daily `litellm-cost-refresh` Trigger task,
    // which POSTs it back to this service. That task resolves the agent URL as
    // `PLATOS_AGENT_HTTP_URL || PLATOS_AGENT_API_URL || "http://localhost:3100"`,
    // and the task runs on Trigger Cloud — where localhost is the Trigger worker,
    // not this process. With neither var set the write never arrived, Redis stayed
    // empty, and EVERY modern model silently fell through to the conservative
    // 100/300 cents-per-million estimator. Verified empty on the live deployment.
    //
    // Rather than depend on that callback being configured correctly, fetch the
    // catalog directly on a miss. The scheduled task stays as the freshness
    // mechanism; this is the floor that stops a misconfiguration turning into
    // months of quietly wrong billing.
    return this.lazyLoadCatalog();
  }

  /** In-flight dedupe so a burst of turns triggers exactly one upstream fetch. */
  private catalogFetchInFlight: Promise<LiteLLMCatalog | null> | null = null;
  private catalogFetchFailedAt = 0;

  private async lazyLoadCatalog(): Promise<LiteLLMCatalog | null> {
    // Never reach the network from a unit test. Without this, stubbing Redis to
    // return null (which every cost test does) silently turns a hermetic test
    // into a live fetch of a 1.6 MB catalog — non-deterministic, slow, and
    // failing offline. Opt back in explicitly if a test wants the real thing.
    if (
      process.env.NODE_ENV === "test" &&
      process.env.PLATOS_ALLOW_LIVE_PRICE_FETCH !== "1"
    ) {
      return this.lastKnownCatalog;
    }
    // Back off after a failure so an upstream outage cannot turn every turn
    // into a 20s stall. Serving `lastKnownCatalog` (or null → fallback table)
    // is always better than blocking a user's turn on GitHub being reachable.
    if (Date.now() - this.catalogFetchFailedAt < CATALOG_FETCH_BACKOFF_MS) {
      return this.lastKnownCatalog;
    }
    if (this.catalogFetchInFlight) return this.catalogFetchInFlight;

    this.catalogFetchInFlight = (async () => {
      try {
        const res = await fetch(LITELLM_CATALOG_URL, {
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const parsed = (await res.json()) as LiteLLMCatalog;
        if (!parsed || typeof parsed !== "object" || Object.keys(parsed).length < 100) {
          throw new Error("catalog payload looks truncated");
        }
        this.catalogMemo = { catalog: parsed, loadedAt: Date.now() };
        this.lastKnownCatalog = parsed;
        // Share it with every other replica, and survive our own restart.
        // Best-effort: a Redis write failure must not fail the turn.
        try {
          await this.redis.set(CATALOG_KEY, JSON.stringify(parsed), "EX", 86_400);
        } catch {
          /* in-process memo still serves this replica */
        }
        this.logger.log(
          `[cost] lazily loaded price catalog (${Object.keys(parsed).length} models) — Redis was cold`,
        );
        return parsed;
      } catch (err: any) {
        this.catalogFetchFailedAt = Date.now();
        this.logger.warn(
          `[cost] lazy catalog load failed (${err?.message ?? err}); using last-known/fallback rates`,
        );
        return this.lastKnownCatalog;
      } finally {
        this.catalogFetchInFlight = null;
      }
    })();
    return this.catalogFetchInFlight;
  }

  /**
   * Calculate cost for a model usage event.
   *
   * Lookup order:
   *   1. LiteLLM live catalog (Redis / in-process memo) — probed against
   *      every `modelLookupKeys` variant so `together:openai/gpt-oss-120b`
   *      can match LiteLLM's `together_ai/openai/gpt-oss-120b` key too.
   *   2. Hardcoded FALLBACK_PRICING (last-known-good) — same multi-key probe.
   *   3. Provider-aware conservative estimator (cheap OSS hosts no longer
   *      get billed at the Anthropic-tier 100/300 cents/M rate).
   */
  async calculateCost(model: string, inputTokens: number, outputTokens: number): Promise<number> {
    const catalog = await this.getCatalog();
    const rates = resolveRates(model, catalog);
    const inputCost = (inputTokens / 1_000_000) * rates.input;
    const outputCost = (outputTokens / 1_000_000) * rates.output;
    return Math.round((inputCost + outputCost) * 100) / 100;
  }

  /**
   * MC.2 — resolve the per-model *input-cents-per-1M-tokens* rate. Returns
   * the same number the fallback table carries (`pricing.input`) or the
   * equivalent scalar from LiteLLM live catalog. Used for cache math because
   * cache tokens are billed as a multiple of the input rate (1.25× write,
   * 0.1× read) — we need the base rate, not the blended cost.
   */
  async resolveInputCentsPerMillion(model: string): Promise<number> {
    const catalog = await this.getCatalog();
    return resolveRates(model, catalog).input;
  }

  /**
   * PRELAUNCH-A1-2 — provider-specific cache surcharge factors.
   *
   * Anthropic, OpenAI, and Google all bill cache reads + cache writes
   * differently. The historical hard-coded `1.25× / 0.1×` was Anthropic-only
   * and silently mis-billed every other provider. Resolution:
   *
   *   - Anthropic: write 1.25× input, read 0.10× input (90% off).
   *   - OpenAI:   write 1.00× input (no surcharge), read 0.50× input (50% off).
   *   - Google:   write 1.00× input (no surcharge), read 0.25× input (75% off
   *               for 2.5-series implicit cache).
   *
   * Provider id is sourced from the manifest (`google-vertex` is treated as
   * `google` for cache pricing purposes since the underlying Gemini billing
   * shape matches). Unknown providers default to Anthropic semantics — the
   * historical default — so behavior is unchanged on legacy paths.
   */
  // PRELAUNCH-A1-2 — see cacheRatesFor() / providerForModel() below.

  /**
   * PRELAUNCH-A1-1, A1-14 — compute cache-adjusted cost.
   *
   * v6 of the AI SDK reports `usage.inputTokens` as the FULL prompt total
   * INCLUDING any cache-creation + cache-read tokens. The previous comment
   * (which claimed inputTokens already EXCLUDED cache) is wrong under v6.
   *
   * Cost decomposition under v6:
   *
   *   bill = (inputTokens − cacheCreation − cacheRead) × inputRate          // fresh tokens
   *        +  cacheCreation × inputRate × <provider write multiplier>      // cache writes
   *        +  cacheRead     × inputRate × <provider read multiplier>       // cache reads
   *        +  outputTokens × outputRate
   *
   * Callers must therefore pass `inputTokens` as the v6 total. We strip the
   * cache slice off to get the fresh-token component before applying the
   * write/read multipliers. Zero cache fields → identical to `calculateCost`.
   */
  /**
   * Resolve the EFFECTIVE per-1M-token rates for a model, in cents.
   *
   * "Effective" means post-fallback: `cacheRead`/`cacheWrite` are the numbers
   * actually used in the billing math, whether they came from a per-model price
   * or from the per-provider multiplier. Stamping these onto the turn makes the
   * row self-describing — the cost can be re-derived later without knowing which
   * catalog version or which fallback tier was live at the time, which is the
   * whole point of keeping a historical rate.
   */
  async resolveEffectiveRates(
    model: string,
    providerId?: string | null,
  ): Promise<{
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    source: ResolvedRates["source"];
  }> {
    const resolved = resolveRates(model, await this.getCatalog());
    const multipliers = cacheRatesFor(providerId ?? providerForModel(model));
    return {
      input: resolved.input,
      output: resolved.output,
      cacheRead: resolved.cacheRead ?? resolved.input * multipliers.read,
      cacheWrite: resolved.cacheWrite ?? resolved.input * multipliers.write,
      source: resolved.source,
    };
  }

  async calculateCostWithCache(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheCreationInputTokens: number,
    cacheReadInputTokens: number,
    providerId?: string | null,
  ): Promise<number> {
    if (cacheCreationInputTokens <= 0 && cacheReadInputTokens <= 0) {
      return this.calculateCost(model, inputTokens, outputTokens);
    }
    // PRELAUNCH-A1-1 — v6 inputTokens is INCLUSIVE of cache. Strip the cache
    // slice to recover the fresh-token portion before billing it at 1.0×.
    //
    // Follow-up (review 2026-05-04): inline the fresh + output math so the
    // sum is rounded ONCE at the end. The previous version called
    // `calculateCost` (which itself rounds to 0.01¢ precision) and then
    // rounded the sum again, propagating a 0.005-0.0075¢ error on tiny
    // totals (e.g. Google rate test 0.0825¢ was rounding to 0.09¢).
    const catalog = await this.getCatalog();
    const resolved = resolveRates(model, catalog);
    const { input: inputCentsPerMillion, output: outputCentsPerMillion } = resolved;

    const freshInputTokens = Math.max(
      0,
      inputTokens - cacheCreationInputTokens - cacheReadInputTokens,
    );
    const freshCost = (freshInputTokens / 1_000_000) * inputCentsPerMillion;
    const outputCost = (outputTokens / 1_000_000) * outputCentsPerMillion;
    // PRECISION — prefer the PER-MODEL cache rate when the price source states
    // it; the per-provider multiplier is now only the fallback. See resolveRates
    // for the measured case (gpt-5.6-luna: real 0.1x read / 2.5x write against
    // an assumed 0.5x / 1.0x) that motivated this.
    const multipliers = cacheRatesFor(providerId ?? providerForModel(model));
    const writeCentsPerMillion =
      resolved.cacheWrite ?? inputCentsPerMillion * multipliers.write;
    const readCentsPerMillion =
      resolved.cacheRead ?? inputCentsPerMillion * multipliers.read;
    const writeCost = (cacheCreationInputTokens / 1_000_000) * writeCentsPerMillion;
    const readCost = (cacheReadInputTokens / 1_000_000) * readCentsPerMillion;
    // Single round at the end, at 0.0001¢ precision to preserve tiny
    // totals (sub-cent costs on cheap models like gemini-2.5-flash).
    return Math.round((freshCost + outputCost + writeCost + readCost) * 10_000) / 10_000;
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
   * turn will double-count in Redis; per-message cost lives authoritatively
   * in `PlatosAgentMessage.responseJson.cost_cents` (write-once per row).
   * Redis is the real-time dashboard; Postgres is the durable source.
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
    } = {},
  ): Promise<UsageRecord> {
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
          // Already recorded — return the computed record without bumping.
          const cacheCreation = Math.max(0, Number(options.cacheCreationInputTokens ?? 0) || 0);
          const cacheRead = Math.max(0, Number(options.cacheReadInputTokens ?? 0) || 0);
          const freshInputTokens = Math.max(0, inputTokens - cacheCreation - cacheRead);
          const costCents = await this.calculateCost(model, freshInputTokens, outputTokens);
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
    const cacheCreation = Math.max(0, Number(options.cacheCreationInputTokens ?? 0) || 0);
    const cacheRead = Math.max(0, Number(options.cacheReadInputTokens ?? 0) || 0);
    const reasoning = Math.max(0, Number(options.reasoningTokens ?? 0) || 0);
    // PRELAUNCH-A1-1 — agent-task.service derives `inputTokens` as the v6
    // total (which INCLUDES cache tokens). When cache is present we pass the
    // total to calculateCostWithCache (which strips the cache slice itself);
    // for the naive `costCents` we strip up-front so the row's own
    // `cost_cents` field reflects fresh-token + cache-token breakdown
    // instead of double-billing fresh on top of cache.
    const freshInputTokens = Math.max(0, inputTokens - cacheCreation - cacheRead);
    const costCents = await this.calculateCost(model, freshInputTokens, outputTokens);
    // PRELAUNCH-A1-2 — cache-adjusted cost is provider-aware. When cache
    // fields are zero this equals `costCents` exactly (round-trip safe).
    const costWithCacheCents = cacheCreation > 0 || cacheRead > 0
      ? await this.calculateCostWithCache(
          model,
          inputTokens,
          outputTokens,
          cacheCreation,
          cacheRead,
          options.providerId ?? providerForModel(model),
        )
      : costCents;
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
    // thread-level rollup
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
    pipeline.hincrby(scopeKeyStr, "input_tokens", inputTokens);
    pipeline.hincrby(scopeKeyStr, "output_tokens", outputTokens);
    pipeline.hincrbyfloat(scopeKeyStr, "cost_cents", costCents);
    if (cacheCreation > 0) pipeline.hincrby(scopeKeyStr, "cache_creation_input_tokens", cacheCreation);
    if (cacheRead > 0) pipeline.hincrby(scopeKeyStr, "cache_read_input_tokens", cacheRead);
    if (reasoning > 0) pipeline.hincrby(scopeKeyStr, "reasoning_tokens", reasoning);
    pipeline.hincrbyfloat(scopeKeyStr, "cost_with_cache_cents", costWithCacheCents);
    pipeline.expire(scopeKeyStr, 86400 * 90); // 90 day TTL
    // per-agent daily rollup (E.9)
    if (agentId) {
      const agentKey = `cost:agent:${s}:${agentId}:${today}`;
      pipeline.hincrby(agentKey, "input_tokens", inputTokens);
      pipeline.hincrby(agentKey, "output_tokens", outputTokens);
      pipeline.hincrbyfloat(agentKey, "cost_cents", costCents);
      if (cacheCreation > 0) pipeline.hincrby(agentKey, "cache_creation_input_tokens", cacheCreation);
      if (cacheRead > 0) pipeline.hincrby(agentKey, "cache_read_input_tokens", cacheRead);
      if (reasoning > 0) pipeline.hincrby(agentKey, "reasoning_tokens", reasoning);
      pipeline.hincrbyfloat(agentKey, "cost_with_cache_cents", costWithCacheCents);
      pipeline.hincrby(agentKey, "calls", 1);
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
      pipeline.hincrbyfloat(userKey, "cost_cents", costCents);
      pipeline.hincrbyfloat(userKey, "cost_with_cache_cents", costWithCacheCents);
      pipeline.hincrby(userKey, "input_tokens", inputTokens);
      pipeline.hincrby(userKey, "output_tokens", outputTokens);
      if (cacheCreation > 0) pipeline.hincrby(userKey, "cache_creation_input_tokens", cacheCreation);
      if (cacheRead > 0) pipeline.hincrby(userKey, "cache_read_input_tokens", cacheRead);
      if (reasoning > 0) pipeline.hincrby(userKey, "reasoning_tokens", reasoning);
      pipeline.hincrby(userKey, "calls", 1);
      pipeline.expire(userKey, 86400 * 90);
    }
    await pipeline.exec();

    // subAgentLabel is a diagnostic tag only — the billing attribution
    // (agentId) is the parent's id. Referenced to keep the type check honest.
    void options.subAgentLabel;

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
  ): Promise<{ inputTokens: number; outputTokens: number; costCents: number; calls: number }> {
    const day = date || new Date().toISOString().slice(0, 10);
    const data = await this.redis.hgetall(`cost:agent:${scopeKey(scope)}:${agentId}:${day}`);
    return {
      inputTokens: parseInt(data.input_tokens || "0", 10),
      outputTokens: parseInt(data.output_tokens || "0", 10),
      costCents: parseFloat(data.cost_cents || "0"),
      calls: parseInt(data.calls || "0", 10),
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
  }> {
    const day = date || new Date().toISOString().slice(0, 10);
    const data = await this.redis.hgetall(`cost:user:${scopeKey(scope)}:${userId}:${day}`);
    return {
      inputTokens: parseInt(data.input_tokens || "0", 10),
      outputTokens: parseInt(data.output_tokens || "0", 10),
      costCents: parseFloat(data.cost_cents || "0"),
      costWithCacheCents: parseFloat(data.cost_with_cache_cents || "0"),
      calls: parseInt(data.calls || "0", 10),
    };
  }

  /**
   * PPR-24 — Redis ↔ Postgres cost reconcile.
   *
   * Postgres (`PlatosAgentMessage.responseJson.cost_cents` + `agent_id` + `usage`
   * written write-once-per-row in `agent-task.service.ts`) is the authoritative
   * source of truth; the Redis `cost:scope:*` + `cost:agent:*` hashes are a
   * real-time dashboard mirror. The pipeline-based recordUsage path can drop
   * writes during Redis restarts/evictions, so this periodic reconciler
   * rebuilds the Redis hashes by day from the durable store.
   *
   * Strategy:
   *   1. For each day in the reconcile window, pull every message whose
   *      `createdAt` lands in that day (per thread -> scope join).
   *   2. Group by (scope, day) and (scope, agentId, day) to build fresh
   *      totals for `cost:scope:<scope>:<day>` +
   *      `cost:agent:<scope>:<agentId>:<day>`.
   *   3. Use `hset` (not `hincrby`) to OVERWRITE the Redis entries atomically —
   *      this is the whole point of reconcile: Redis becomes authoritative-
   *      from-Postgres for every tracked key.
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
   * Postgres is NOT written — these calls don't have an owning
   * PlatosAgentMessage row. The PPR-24 reconcile job rebuilds Redis
   * from Postgres for the LLM-turn surface; auxiliary costs live in
   * Redis only (90d TTL) which matches the dashboard retention.
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
    pipeline.hincrbyfloat(scopeDayKey, `cost_cents:${input.kind}`, input.costCents);
    pipeline.expire(scopeDayKey, 86400 * 90);
    if (input.agentId) {
      const agentKey = `cost:agent:${s}:${input.agentId}:${today}`;
      pipeline.hincrbyfloat(agentKey, "cost_cents", input.costCents);
      pipeline.hincrbyfloat(agentKey, `cost_cents:${input.kind}`, input.costCents);
      pipeline.expire(agentKey, 86400 * 90);
    }
    // Breakdown-by-kind for cost-by-model dashboard slice.
    const modelKey = `cost:model:${s}:${input.model}:${today}`;
    pipeline.hincrbyfloat(modelKey, "cost_cents", input.costCents);
    pipeline.hincrbyfloat(modelKey, `cost_cents:${input.kind}`, input.costCents);
    pipeline.expire(modelKey, 86400 * 90);
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
        pipeline.hincrbyfloat(scopeDayKey, "cost_cents:tier:skill", costCents);
      }
      pipeline.expire(scopeDayKey, 86400 * 90);

      // Per-agent rollup (when attributed).
      if (event.agentId) {
        const agentKey = `cost:agent:${s}:${event.agentId}:${today}`;
        pipeline.hincrby(agentKey, "skill_calls", 1);
        if (costCents > 0) {
          pipeline.hincrbyfloat(agentKey, "cost_cents", costCents);
          pipeline.hincrbyfloat(agentKey, "cost_cents:tier:skill", costCents);
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

    // Pull the relevant messages in one query. We need:
    //  - thread.{organizationId, projectId, environmentId} (scope)
    //  - responseJson.cost_cents, .usage.inputTokens/outputTokens, .agent_id
    //  - createdAt (to bucket into YYYY-MM-DD)
    // `responseJson` is a JSON column; we pull the whole row and read in JS
    // because Postgres-side aggregation on JSON is fiddly + breaks portability.
    const rows = await this.prisma.platosAgentMessage.findMany({
      where: {
        role: "assistant",
        createdAt: { gte: windowStart },
      },
      select: {
        createdAt: true,
        responseJson: true,
        thread: {
          select: {
            organizationId: true,
            projectId: true,
            environmentId: true,
            agentId: true,
          },
        },
      },
    });

    // Group in memory. Keys are string-interned for the hash writes below.
    // Bucket shape: { input_tokens, output_tokens, cost_cents, calls }.
    type Bucket = { input_tokens: number; output_tokens: number; cost_cents: number; calls: number };
    const mkBucket = (): Bucket => ({ input_tokens: 0, output_tokens: 0, cost_cents: 0, calls: 0 });
    const scopeKeys = new Map<string, Bucket>();
    const agentKeys = new Map<string, Bucket>();

    for (const row of rows as Array<{
      createdAt: Date;
      responseJson: { usage?: { inputTokens?: number; outputTokens?: number }; cost_cents?: number; agent_id?: string } | null;
      thread: { organizationId: string; projectId: string; environmentId: string; agentId: string } | null;
    }>) {
      if (!row.thread) continue;
      const rj = row.responseJson;
      if (!rj) continue;
      const costCents = Number(rj.cost_cents ?? 0);
      const inputTokens = Number(rj.usage?.inputTokens ?? 0);
      const outputTokens = Number(rj.usage?.outputTokens ?? 0);
      if (costCents <= 0 && inputTokens <= 0 && outputTokens <= 0) continue;
      const day = row.createdAt.toISOString().slice(0, 10);
      const s = scopeKey({
        organizationId: row.thread.organizationId,
        projectId: row.thread.projectId,
        environmentId: row.thread.environmentId,
      });
      const agentId = rj.agent_id || row.thread.agentId;

      const scopeKeyStr = `cost:scope:${s}:${day}`;
      let scopeBucket = scopeKeys.get(scopeKeyStr);
      if (!scopeBucket) { scopeBucket = mkBucket(); scopeKeys.set(scopeKeyStr, scopeBucket); }
      scopeBucket.input_tokens += inputTokens;
      scopeBucket.output_tokens += outputTokens;
      scopeBucket.cost_cents += costCents;
      scopeBucket.calls += 1;

      if (agentId) {
        const agentKeyStr = `cost:agent:${s}:${agentId}:${day}`;
        let agentBucket = agentKeys.get(agentKeyStr);
        if (!agentBucket) { agentBucket = mkBucket(); agentKeys.set(agentKeyStr, agentBucket); }
        agentBucket.input_tokens += inputTokens;
        agentBucket.output_tokens += outputTokens;
        agentBucket.cost_cents += costCents;
        agentBucket.calls += 1;
      }
    }

    // Overwrite Redis hashes in one pipeline. Use `hset` (not hincrby) to
    // make the reconciled values authoritative, then re-arm the TTL.
    const pipeline = this.redis.pipeline();
    for (const [key, b] of scopeKeys) {
      pipeline.hset(key, {
        input_tokens: String(b.input_tokens),
        output_tokens: String(b.output_tokens),
        cost_cents: String(b.cost_cents),
      });
      pipeline.expire(key, 86400 * 90);
    }
    for (const [key, b] of agentKeys) {
      pipeline.hset(key, {
        input_tokens: String(b.input_tokens),
        output_tokens: String(b.output_tokens),
        cost_cents: String(b.cost_cents),
        calls: String(b.calls),
      });
      pipeline.expire(key, 86400 * 90);
    }
    if (scopeKeys.size + agentKeys.size > 0) {
      await pipeline.exec();
    }

    return {
      daysReconciled: daysBack,
      scopesReconciled: scopeKeys.size,
      agentsReconciled: agentKeys.size,
    };
  }

  /**
   * Get cost summary for a thread.
   */
  async getThreadCost(threadId: string): Promise<{ inputTokens: number; outputTokens: number; costCents: number }> {
    const data = await this.redis.hgetall(`cost:thread:${threadId}`);
    return {
      inputTokens: parseInt(data.input_tokens || "0", 10),
      outputTokens: parseInt(data.output_tokens || "0", 10),
      costCents: parseFloat(data.cost_cents || "0"),
    };
  }

  /**
   * Get cost summary for a scope (today or specific date).
   */
  async getScopeDailyCost(
    scope: ScopeTuple,
    date?: string,
  ): Promise<{ inputTokens: number; outputTokens: number; costCents: number }> {
    const day = date || new Date().toISOString().slice(0, 10);
    const data = await this.redis.hgetall(`cost:scope:${scopeKey(scope)}:${day}`);
    return {
      inputTokens: parseInt(data.input_tokens || "0", 10),
      outputTokens: parseInt(data.output_tokens || "0", 10),
      costCents: parseFloat(data.cost_cents || "0"),
    };
  }

  /**
   * Cost rollup by model — pulls from PlatosAgentMessage.responseJson. Redis
   * hashes don't carry model dimension (they're scope-aggregated), so we
   * fall back to the durable store. This is authoritative; the Redis hashes
   * are used for live dashboard totals. Theme E.3.
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
    messages: number;
  }>> {
    const days = options.days ?? 30;
    const limit = options.limit ?? 20;
    const since = new Date(Date.now() - days * 86400_000);

    // Pull every message's responseJson for threads in this scope. The
    // thread-level scope filter IS the leakage gate — we never join across
    // environments.
    const rows: Array<{ responseJson: any }> = await this.prisma.platosAgentMessage.findMany({
      where: {
        role: "assistant",
        createdAt: { gte: since },
        thread: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        },
      },
      select: { responseJson: true },
    });

    type ModelBucket = {
      costCents: number;
      costWithCacheCents: number;
      inputTokens: number;
      outputTokens: number;
      cacheCreationInputTokens: number;
      cacheReadInputTokens: number;
      messages: number;
    };
    const byModel = new Map<string, ModelBucket>();
    for (const r of rows) {
      const rj = r.responseJson as {
        model?: string;
        usage?: {
          inputTokens?: number;
          outputTokens?: number;
          cacheCreationInputTokens?: number;
          cacheReadInputTokens?: number;
        };
        cost_cents?: number;
        cost_with_cache_cents?: number;
      } | null;
      if (!rj?.model) continue;
      const bucket = byModel.get(rj.model) ?? {
        costCents: 0,
        costWithCacheCents: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        messages: 0,
      };
      const naive = Number(rj.cost_cents ?? 0);
      bucket.costCents += naive;
      // MC.2 — cache-adjusted cost falls back to naive when absent (pre-MC
      // rows), so historical data keeps showing a sensible number.
      bucket.costWithCacheCents += Number(rj.cost_with_cache_cents ?? naive);
      bucket.inputTokens += rj.usage?.inputTokens ?? 0;
      bucket.outputTokens += rj.usage?.outputTokens ?? 0;
      bucket.cacheCreationInputTokens += rj.usage?.cacheCreationInputTokens ?? 0;
      bucket.cacheReadInputTokens += rj.usage?.cacheReadInputTokens ?? 0;
      bucket.messages += 1;
      byModel.set(rj.model, bucket);
    }

    return Array.from(byModel.entries())
      .map(([model, b]) => ({
        model,
        ...b,
        costCents: Math.round(b.costCents * 100) / 100,
        costWithCacheCents: Math.round(b.costWithCacheCents * 100) / 100,
      }))
      .sort((a, b) => b.costCents - a.costCents)
      .slice(0, limit);
  }

  /**
   * Cost rollup by agent — joins messages → threads → agentId. Theme E.3.
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
    threads: number;
  }>> {
    const days = options.days ?? 30;
    const limit = options.limit ?? 20;
    const since = new Date(Date.now() - days * 86400_000);

    const rows: Array<{ thread: { agentId: string; id: string } | null; responseJson: any }> =
      await this.prisma.platosAgentMessage.findMany({
        where: {
          role: "assistant",
          createdAt: { gte: since },
          thread: {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
          },
        },
        select: {
          responseJson: true,
          thread: { select: { agentId: true, id: true } },
        },
      });

    type AgentBucket = {
      costCents: number;
      costWithCacheCents: number;
      inputTokens: number;
      outputTokens: number;
      cacheCreationInputTokens: number;
      cacheReadInputTokens: number;
      threads: Set<string>;
    };
    const byAgent = new Map<string, AgentBucket>();
    for (const r of rows) {
      const rj = r.responseJson as {
        usage?: {
          inputTokens?: number;
          outputTokens?: number;
          cacheCreationInputTokens?: number;
          cacheReadInputTokens?: number;
        };
        cost_cents?: number;
        cost_with_cache_cents?: number;
        agent_id?: string;
      } | null;
      // Theme E.9 — prefer the explicit `agent_id` stamped on the message row
      // over the thread's `agentId`. These normally match; they diverge when
      // a sub-agent turn is billed separately (future), or when migration
      // rewrites attribution. Fall back to thread.agentId for legacy rows.
      const agentId = rj?.agent_id ?? r.thread?.agentId;
      if (!agentId) continue;
      const bucket = byAgent.get(agentId) ?? {
        costCents: 0,
        costWithCacheCents: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        threads: new Set<string>(),
      };
      const naive = Number(rj?.cost_cents ?? 0);
      bucket.costCents += naive;
      // MC.2 — fall back to naive cost for pre-MC rows.
      bucket.costWithCacheCents += Number(rj?.cost_with_cache_cents ?? naive);
      bucket.inputTokens += rj?.usage?.inputTokens ?? 0;
      bucket.outputTokens += rj?.usage?.outputTokens ?? 0;
      bucket.cacheCreationInputTokens += rj?.usage?.cacheCreationInputTokens ?? 0;
      bucket.cacheReadInputTokens += rj?.usage?.cacheReadInputTokens ?? 0;
      if (r.thread?.id) bucket.threads.add(r.thread.id);
      byAgent.set(agentId, bucket);
    }

    // Resolve agent names in a single query.
    const agentIds = Array.from(byAgent.keys());
    const agents: Array<{ id: string; name: string }> = agentIds.length
      ? await this.prisma.platosAgent.findMany({
          where: {
            id: { in: agentIds },
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
          },
          select: { id: true, name: true },
        })
      : [];
    const nameById = new Map(agents.map((a) => [a.id, a.name]));

    return Array.from(byAgent.entries())
      .map(([agentId, b]) => ({
        agentId,
        agentName: nameById.get(agentId) ?? null,
        costCents: Math.round(b.costCents * 100) / 100,
        costWithCacheCents: Math.round(b.costWithCacheCents * 100) / 100,
        inputTokens: b.inputTokens,
        outputTokens: b.outputTokens,
        cacheCreationInputTokens: b.cacheCreationInputTokens,
        cacheReadInputTokens: b.cacheReadInputTokens,
        threads: b.threads.size,
      }))
      .sort((a, b) => b.costCents - a.costCents)
      .slice(0, limit);
  }

  /**
   * Cost rollup by user. Theme E.3 + E.4.
   *
   * PRELAUNCH-A1-10 — payload extended with the full token breakdown
   * (input / output / cache_read / cache_creation / reasoning) so
   * monitoring dashboards can sort + filter by reasoning spend or cache
   * hit rate per user. All token fields default to 0 — pre-A1 messages
   * stored only `inputTokens` + `outputTokens` so reasoning/cache values
   * legitimately show 0 on legacy traffic.
   */
  async getCostByUser(
    scope: ScopeTuple,
    options: { days?: number; limit?: number } = {},
  ): Promise<
    Array<{
      userId: string;
      costCents: number;
      messages: number;
      threads: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      reasoningTokens: number;
    }>
  > {
    const days = options.days ?? 30;
    const limit = options.limit ?? 20;
    const since = new Date(Date.now() - days * 86400_000);

    const rows: Array<{ thread: { userId: string; id: string } | null; responseJson: any }> =
      await this.prisma.platosAgentMessage.findMany({
        where: {
          role: "assistant",
          createdAt: { gte: since },
          thread: {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
          },
        },
        select: {
          responseJson: true,
          thread: { select: { userId: true, id: true } },
        },
      });

    type UserRow = {
      costCents: number;
      messages: number;
      threads: Set<string>;
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      reasoningTokens: number;
    };
    const byUser = new Map<string, UserRow>();
    for (const r of rows) {
      const userId = r.thread?.userId;
      if (!userId) continue;
      const rj = (r.responseJson ?? {}) as {
        cost_cents?: number;
        usage?: {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadInputTokens?: number;
          cacheCreationInputTokens?: number;
          reasoningTokens?: number;
        };
      };
      const usage = rj.usage ?? {};
      const bucket: UserRow = byUser.get(userId) ?? {
        costCents: 0,
        messages: 0,
        threads: new Set<string>(),
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningTokens: 0,
      };
      bucket.costCents += Number(rj.cost_cents ?? 0);
      bucket.messages += 1;
      bucket.inputTokens += Number(usage.inputTokens ?? 0) || 0;
      bucket.outputTokens += Number(usage.outputTokens ?? 0) || 0;
      bucket.cacheReadInputTokens += Number(usage.cacheReadInputTokens ?? 0) || 0;
      bucket.cacheCreationInputTokens += Number(usage.cacheCreationInputTokens ?? 0) || 0;
      bucket.reasoningTokens += Number(usage.reasoningTokens ?? 0) || 0;
      if (r.thread?.id) bucket.threads.add(r.thread.id);
      byUser.set(userId, bucket);
    }

    return Array.from(byUser.entries())
      .map(([userId, b]) => ({
        userId,
        costCents: Math.round(b.costCents * 100) / 100,
        messages: b.messages,
        threads: b.threads.size,
        inputTokens: b.inputTokens,
        outputTokens: b.outputTokens,
        cacheReadInputTokens: b.cacheReadInputTokens,
        cacheCreationInputTokens: b.cacheCreationInputTokens,
        reasoningTokens: b.reasoningTokens,
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
        const agents: Array<{ id: string; name: string }> = await this.prisma.platosAgent.findMany({
          where: {
            id: { in: agentIds },
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
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
    perDay: Array<{
      date: string;
      inputTokens: number;
      outputTokens: number;
      costCents: number;
      costWithCacheCents: number;
      cacheCreationInputTokens: number;
      cacheReadInputTokens: number;
    }>;
  }> {
    const todayMs = Date.now();
    const dates: string[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(todayMs - i * 86400_000);
      dates.push(d.toISOString().slice(0, 10));
    }
    const pipeline = this.redis.pipeline();
    for (const d of dates) pipeline.hgetall(`cost:scope:${scopeKey(scope)}:${d}`);
    const results = await pipeline.exec();
    const perDay = dates.map((d, i) => {
      const raw = ((results?.[i]?.[1] as Record<string, string> | undefined) ?? {});
      const costCents = parseFloat(raw.cost_cents || "0");
      // MC.2 — if cost_with_cache_cents is absent (pre-MC rows) fall back to
      // the naive cost so dashboards don't show $0 for historical data.
      const costWithCacheCents = raw.cost_with_cache_cents
        ? parseFloat(raw.cost_with_cache_cents)
        : costCents;
      return {
        date: d,
        inputTokens: parseInt(raw.input_tokens || "0", 10),
        outputTokens: parseInt(raw.output_tokens || "0", 10),
        costCents,
        costWithCacheCents,
        cacheCreationInputTokens: parseInt(raw.cache_creation_input_tokens || "0", 10),
        cacheReadInputTokens: parseInt(raw.cache_read_input_tokens || "0", 10),
      };
    });
    const totals = perDay.reduce(
      (acc, row) => ({
        inputTokens: acc.inputTokens + row.inputTokens,
        outputTokens: acc.outputTokens + row.outputTokens,
        costCents: acc.costCents + row.costCents,
        costWithCacheCents: acc.costWithCacheCents + row.costWithCacheCents,
        cacheCreationInputTokens: acc.cacheCreationInputTokens + row.cacheCreationInputTokens,
        cacheReadInputTokens: acc.cacheReadInputTokens + row.cacheReadInputTokens,
      }),
      {
        inputTokens: 0,
        outputTokens: 0,
        costCents: 0,
        costWithCacheCents: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
    );
    return { ...totals, perDay };
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
    perDay: Array<{
      date: string;
      inputTokens: number;
      outputTokens: number;
      cacheCreationInputTokens: number;
      cacheReadInputTokens: number;
      costCents: number;
      costWithCacheCents: number;
    }>;
  }> {
    const todayMs = Date.now();
    const dates: string[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(todayMs - i * 86400_000);
      dates.push(d.toISOString().slice(0, 10));
    }
    const s = scopeKey(scope);
    const pipeline = this.redis.pipeline();
    for (const d of dates) pipeline.hgetall(`cost:agent:${s}:${agentId}:${d}`);
    let results: Array<[Error | null, unknown]> | null = null;
    try {
      results = (await pipeline.exec()) as any;
    } catch {
      // Fail-graceful — return empty-shape.
    }
    const perDay = dates.map((d, i) => {
      const raw = ((results?.[i]?.[1] as Record<string, string> | undefined) ?? {});
      const costCents = parseFloat(raw.cost_cents || "0");
      const costWithCacheCents = raw.cost_with_cache_cents
        ? parseFloat(raw.cost_with_cache_cents)
        : costCents;
      return {
        date: d,
        inputTokens: parseInt(raw.input_tokens || "0", 10),
        outputTokens: parseInt(raw.output_tokens || "0", 10),
        cacheCreationInputTokens: parseInt(raw.cache_creation_input_tokens || "0", 10),
        cacheReadInputTokens: parseInt(raw.cache_read_input_tokens || "0", 10),
        costCents,
        costWithCacheCents,
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
      }),
      {
        inputTokens: 0,
        outputTokens: 0,
        costCents: 0,
        costWithCacheCents: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
    );
    return { ...totals, perDay };
  }
}
