/**
 * Theme SM.5 — Per-skill cost estimators.
 *
 * Pure functions that return `{ inputUnits?, outputUnits?, costCents }` for a
 * given skill-tool invocation. The SkillRuntimeService calls an estimator
 * when the handler result does not carry an explicit `_usage` override so
 * we still get a non-zero, roughly-accurate skill-tier spend number even
 * when a handler doesn't self-report.
 *
 * Pricing below is frozen at 2026-04-22 from each vendor's public pricing
 * page. It is intentionally static — this file is pure CPU, never does I/O.
 * Drift between these constants and live vendor pricing is acceptable at
 * the skill-tier (the authoritative LLM spend lives in CostService's live
 * LiteLLM catalog). If a vendor changes pricing materially, bump the
 * constants here and log the update in `docs/themes/THEME_S.md` follow-up.
 *
 * All amounts are **US cents** (CostService's canonical unit).
 *
 * Lookup key precedence (see `estimate()`):
 *   1. Exact manifest id (e.g. "platos.parallel_web").
 *   2. Short alias matching the manifest suffix after `platos.` (e.g.
 *      "parallel_web") — spec'd in THEME_S W.5.
 *   3. Fallback: `{ costCents: 0 }` (same behaviour as pre-W.5).
 */

export interface SkillEstimatorResult {
  inputUnits?: number;
  outputUnits?: number;
  costCents: number;
}

export type SkillEstimator = (
  toolName: string,
  input: unknown,
  output: unknown,
) => SkillEstimatorResult;

// ---------------------------------------------------------------------------
// Parallel.ai — https://parallel.ai/pricing (verified 2026-04-22)
// All tools priced per call. `parallel_deep_research` varies by processor
// tier; see `PARALLEL_DEEP_RESEARCH_BY_PROCESSOR`.
// ---------------------------------------------------------------------------

/** Flat per-call price in US cents for non-deep-research Parallel tools. */
const PARALLEL_FLAT_CENTS: Record<string, number> = {
  parallel_search: 0.4,
  parallel_extract: 0.4,
  // findall + monitor_create are expensive structured-dataset / recurring runs.
  parallel_findall: 10,
  parallel_monitor_create: 10,
};

/**
 * Deep-research price by processor tier. Base rate when processor is omitted
 * is `base` (5¢). `ultra8x` is the most expensive at $2.40/call (240¢).
 */
const PARALLEL_DEEP_RESEARCH_BY_PROCESSOR: Record<string, number> = {
  lite: 2,
  base: 5,
  core: 20,
  pro: 60,
  ultra: 120,
  ultra8x: 240,
};

export function estimateParallelWeb(
  toolName: string,
  input: unknown,
  _output: unknown,
): SkillEstimatorResult {
  if (toolName === "parallel_deep_research") {
    const processor = readStringField(input, "processor") ?? "base";
    const cents =
      PARALLEL_DEEP_RESEARCH_BY_PROCESSOR[processor] ??
      PARALLEL_DEEP_RESEARCH_BY_PROCESSOR.base;
    return { costCents: cents };
  }
  return { costCents: PARALLEL_FLAT_CENTS[toolName] ?? 0 };
}

// ---------------------------------------------------------------------------
// Platos built-in web_search — Tavily (default), Exa, Brave.
// Tavily: $0.008/search on basic, $0.02/search on advanced.
// Exa:    $0.005/search (keyword), $0.025/search (neural).
// Brave:  $0.005/search on Base, up to $0.015 on Pro.
// We don't know which provider fired at estimator time (that's a runtime
// choice in skill-handlers.ts), so we charge the Tavily default — slightly
// conservative vs. the cheapest tier, slightly optimistic vs. Tavily advanced.
// fetch_url is priced equivalent to one web_search call (same HTTP shape).
// ---------------------------------------------------------------------------

const WEB_SEARCH_CENTS_PER_CALL = 0.8; // Tavily basic default
const WEB_FETCH_URL_CENTS_PER_CALL = 0.8;

export function estimateWebSearch(
  toolName: string,
  input: unknown,
  _output: unknown,
): SkillEstimatorResult {
  if (toolName === "fetch_url") {
    return { inputUnits: 1, costCents: WEB_FETCH_URL_CENTS_PER_CALL };
  }
  if (toolName === "web_search") {
    const maxResults = readNumberField(input, "maxResults") ?? 5;
    return {
      inputUnits: 1,
      outputUnits: Math.max(1, Math.floor(maxResults)),
      costCents: WEB_SEARCH_CENTS_PER_CALL,
    };
  }
  return { costCents: 0 };
}

// ---------------------------------------------------------------------------
// Image generation — BFL Flux (default) + OpenAI DALL-E (alternate).
// BFL Flux: ~4¢/image (flux-pro) at 1024² + size multipliers.
// DALL-E 3: 4¢/image at 1024², 8¢ at 1024x1792/1792x1024.
// We derive cost from model + size so the estimator tracks the common
// toggle points even without handler `_usage`.
// ---------------------------------------------------------------------------

const IMAGE_GEN_CENTS_BY_MODEL_SIZE: Record<string, Record<string, number>> = {
  flux: {
    "1024x1024": 4,
    "1024x1792": 7,
    "1792x1024": 7,
  },
  dalle: {
    "1024x1024": 4,
    "1024x1792": 8,
    "1792x1024": 8,
  },
};

export function estimateImageGeneration(
  toolName: string,
  input: unknown,
  _output: unknown,
): SkillEstimatorResult {
  if (toolName !== "generate_image") return { costCents: 0 };
  const model = readStringField(input, "model") ?? "flux";
  const size = readStringField(input, "size") ?? "1024x1024";
  const byModel = IMAGE_GEN_CENTS_BY_MODEL_SIZE[model] ?? IMAGE_GEN_CENTS_BY_MODEL_SIZE.flux;
  const cents = byModel[size] ?? byModel["1024x1024"] ?? 4;
  return { outputUnits: 1, costCents: cents };
}

// ---------------------------------------------------------------------------
// Local-CPU skills — no vendor spend.
// ---------------------------------------------------------------------------

export function estimateZero(): SkillEstimatorResult {
  return { costCents: 0 };
}

// ---------------------------------------------------------------------------
// Platos RAG — RG.1.
//
// Flat per-call baseline. Real cost scales with chunk count on ingest +
      // reindex (each chunk causes one OpenAI embedding call, priced in
// EmbeddingService's own telemetry path). The skill-tier number here is
// deliberately a conservative flat — it keeps budget caps meaningful
// without double-counting the embedding spend that CostService already
// records separately.
// ---------------------------------------------------------------------------

const PLATOS_RAG_CENTS: Record<string, number> = {
  rag_ingest_document: 0.2,
  rag_retrieve: 0.05,
  rag_delete_source: 0,
  rag_list_sources: 0,
  rag_reindex: 0.2,
};

export function estimatePlatosRag(
  toolName: string,
  _input: unknown,
  _output: unknown,
): SkillEstimatorResult {
  return { costCents: PLATOS_RAG_CENTS[toolName] ?? 0 };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Keyed by **manifest id**. The SkillRuntime passes `tool.skillSlug` which is
 * the manifest `id` (e.g. `platos.parallel_web`). See
 * `official-skills.ts:OFFICIAL_SKILL_SOURCES` for the canonical list.
 */
export const ESTIMATORS: Record<string, SkillEstimator> = {
  "platos.parallel_web": estimateParallelWeb,
  "platos.web_search": estimateWebSearch,
  "platos.image_generation": estimateImageGeneration,
  "platos.code_execution": estimateZero,
  "platos.file_operations": estimateZero,
  "platos.csv_ops": estimateZero,
  "platos.platos_rag": estimatePlatosRag,
};

/**
 * Short-alias map — mirrors the THEME_S W.5 spec which keys estimators by the
 * suffix of the manifest id (e.g. `"parallel-web"` / `"parallel_web"`).
 * Supports both hyphenated and underscored forms so call sites that pass a
 * slug in either style resolve correctly.
 */
const ALIAS_MAP: Record<string, string> = {
  // canonical suffixes
  parallel_web: "platos.parallel_web",
  "parallel-web": "platos.parallel_web",
  web_search: "platos.web_search",
  "web-search": "platos.web_search",
  image_generation: "platos.image_generation",
  "image-generation": "platos.image_generation",
  image_gen: "platos.image_generation",
  code_execution: "platos.code_execution",
  "code-execution": "platos.code_execution",
  file_operations: "platos.file_operations",
  "file-operations": "platos.file_operations",
  csv_ops: "platos.csv_ops",
  "csv-ops": "platos.csv_ops",
  platos_rag: "platos.platos_rag",
  "platos-rag": "platos.platos_rag",
  rag: "platos.platos_rag",
};

/**
 * Main entry point. Called from `SkillRuntimeService.invokeTool` when the
 * handler did not return a `_usage` override. Never throws — falls back to
 * zero cost for unknown skills (same behaviour as pre-W.5).
 */
export function estimate(
  skillSlug: string,
  toolName: string,
  input: unknown,
  output: unknown,
): SkillEstimatorResult {
  // 1. Exact manifest id
  const direct = ESTIMATORS[skillSlug];
  if (direct) return direct(toolName, input, output);
  // 2. Short alias
  const mapped = ALIAS_MAP[skillSlug];
  if (mapped && ESTIMATORS[mapped]) {
    return ESTIMATORS[mapped](toolName, input, output);
  }
  // 3. Unknown skill — zero cost (same as pre-W.5 fallthrough)
  return { costCents: 0 };
}

// ---------------------------------------------------------------------------
// Helpers — pure record accessors. Exported for unit tests (W.R).
// ---------------------------------------------------------------------------

export function readStringField(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

export function readNumberField(input: unknown, key: string): number | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
