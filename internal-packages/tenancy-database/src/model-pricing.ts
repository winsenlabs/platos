import {
  ModelRateSource,
  Prisma,
  type PrismaClient,
} from "../generated/control";

export const LITELLM_MODEL_CATALOG_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export type CanonicalRateName = "input" | "output" | "cacheRead" | "cacheWrite";

export interface LiteLLMModelEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  litellm_provider?: string;
  max_tokens?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  mode?: string;
  supports_function_calling?: boolean;
  supports_parallel_function_calling?: boolean;
  supports_vision?: boolean;
  supports_reasoning?: boolean;
  supports_tool_choice?: boolean;
  model_name?: string;
  description?: string;
  release_date?: string;
  deprecation_date?: string;
}

export type LiteLLMModelCatalog = Record<string, LiteLLMModelEntry>;

export interface VerifiedModelPriceOverride {
  model: string;
  provider: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  source: string;
  verifiedOn: string;
  providerQuote: string;
  catalogSaid?: string;
  notes?: string;
}

/**
 * Provider-published prices committed alongside their evidence. Values are USD
 * per token, matching LiteLLM's public map. Each field overrides only that
 * field; omitted fields continue to come from LiteLLM.
 */
export const VERIFIED_MODEL_PRICE_OVERRIDES: readonly VerifiedModelPriceOverride[] = [
  {
    model: "openai:gpt-5.6-luna",
    provider: "openai",
    input: 2e-7,
    cacheRead: 2e-8,
    cacheWrite: 5e-7,
    output: 1.2e-6,
    source: "https://developers.openai.com/api/docs/pricing",
    verifiedOn: "2026-07-31",
    providerQuote:
      'gpt-5.6-luna standard: Input "$0.20", Cached input "$0.02", Cache writes "$0.50", Output "$1.20" per 1M tokens',
    catalogSaid:
      "LiteLLM: input 1e-6, output 6e-6, cache_read 1e-7, cache_write 1.25e-6 — input/output/read all 5x high, cache_write 2x high even after correcting the 5x scale error",
    notes:
      "Sibling gpt-5.6-sol was checked at the same time and LiteLLM has it exactly right ($5.00/$0.50/$30.00), so this is a per-row error rather than family-wide staleness.",
  },
] as const;

const LITELLM_PROVIDER_PREFIX: Readonly<Record<string, string>> = {
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
  voyage: "voyage",
};

const MODEL_PRICING_KEY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "together:meta-llama/Llama-3.1-8B-Instruct-Turbo": [
    "together_ai/meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
  ],
};

const PLATOS_PROVIDER_BY_LITELLM: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(LITELLM_PROVIDER_PREFIX).map(([platos, litellm]) => [litellm, platos])
);

const VERIFIED_BY_QUALIFIED_MODEL = new Map(
  VERIFIED_MODEL_PRICE_OVERRIDES.map((entry) => [entry.model, entry] as const)
);

function overrideModelName(entry: VerifiedModelPriceOverride): string {
  const separator = entry.model.indexOf(":");
  return separator > 0 ? entry.model.slice(separator + 1) : entry.model;
}

export function modelPricingLookupKeys(model: string): string[] {
  const value = model.trim();
  if (!value) return [];

  const keys = [value];
  const colon = value.indexOf(":");
  const provider = colon > 0 ? value.slice(0, colon) : null;
  const bare = colon > 0 ? value.slice(colon + 1) : value;

  if (provider) {
    const prefix = LITELLM_PROVIDER_PREFIX[provider];
    if (prefix) keys.push(`${prefix}/${bare}`);
  }
  keys.push(...(MODEL_PRICING_KEY_ALIASES[value] ?? []));
  if (!provider && /^voyage(?:-|$)/i.test(bare)) keys.push(`voyage/${bare}`);
  if (bare !== value) keys.push(bare);

  const lastSlash = bare.lastIndexOf("/");
  if (lastSlash > 0) keys.push(bare.slice(lastSlash + 1));

  return [...new Set(keys.filter(Boolean))];
}

export function verifiedModelPriceFor(
  lookupKeys: readonly string[],
  catalogProvider: string,
): VerifiedModelPriceOverride | null {
  const provider = catalogProvider.trim().toLowerCase();
  if (!provider) return null;
  for (const key of lookupKeys) {
    const colon = key.indexOf(":");
    if (colon > 0) {
      if (key.slice(0, colon).toLowerCase() !== provider) continue;
      const entry = VERIFIED_BY_QUALIFIED_MODEL.get(`${provider}:${key.slice(colon + 1)}`);
      if (entry?.provider === provider) return entry;
      continue;
    }
    const providerPrefix = LITELLM_PROVIDER_PREFIX[provider] ?? provider;
    const slashPrefix = `${providerPrefix}/`;
    const bare = key.startsWith(slashPrefix) ? key.slice(slashPrefix.length) : key;
    const entry = VERIFIED_BY_QUALIFIED_MODEL.get(`${provider}:${bare}`);
    if (entry?.provider === provider) return entry;
  }
  return null;
}

export class ModelPricingUnavailableError extends Error {
  readonly code = "MODEL_PRICING_UNAVAILABLE";

  constructor(
    readonly model: string,
    readonly rate?: CanonicalRateName
  ) {
    super(
      rate
        ? `No ${rate} price is available for model ${model}`
        : `No canonical price is available for model ${model}`
    );
    this.name = "ModelPricingUnavailableError";
  }
}

export interface CanonicalModelRate {
  usdPerToken: number;
  source: ModelRateSource;
  observedAt: Date;
  sourceRef: string | null;
}

export interface CanonicalModelPriceSnapshot {
  modelPriceId: string;
  modelId: string;
  modelKey: string;
  provider: string;
  modelName: string;
  effectiveFrom: Date;
  input: CanonicalModelRate;
  output: CanonicalModelRate;
  cacheRead: CanonicalModelRate;
  cacheWrite: CanonicalModelRate;
}

export interface CanonicalTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
}

export interface PricedModelUsage {
  price: CanonicalModelPriceSnapshot;
  costCents: number;
}

interface PriceCardInput {
  input: CanonicalModelRate;
  output: CanonicalModelRate;
  cacheRead: CanonicalModelRate;
  cacheWrite: CanonicalModelRate;
}

function validRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function dateOrNull(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Token counts arrive from parsed JSON, so the declared `number` on
 * LiteLlmEntry is an assertion rather than a guarantee — some upstream entries
 * carry these as strings. Prisma then rejects the write with `Expected Int or
 * Null, provided String`, which crashes the bootstrap and takes the whole agent
 * down on boot.
 *
 * Coerce at the boundary: accept a number or a numeric string, and treat
 * anything else — a float, an empty string, "unlimited" — as absent rather than
 * guessing.
 */
export function tokenCountOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function verifiedObservedAt(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function providerForCatalogEntry(key: string, entry: LiteLLMModelEntry): string {
  if (entry.litellm_provider) {
    return PLATOS_PROVIDER_BY_LITELLM[entry.litellm_provider] ?? entry.litellm_provider;
  }
  const slash = key.indexOf("/");
  if (slash > 0) {
    const prefix = key.slice(0, slash);
    return PLATOS_PROVIDER_BY_LITELLM[prefix] ?? prefix;
  }
  return "unknown";
}

function capabilitiesFor(entry: LiteLLMModelEntry): string[] {
  return [
    entry.mode ? `mode:${entry.mode}` : null,
    entry.supports_function_calling ? "function_calling" : null,
    entry.supports_parallel_function_calling ? "parallel_function_calling" : null,
    entry.supports_vision ? "vision" : null,
    entry.supports_reasoning ? "reasoning" : null,
    entry.supports_tool_choice ? "tool_choice" : null,
  ].filter((value): value is string => value !== null);
}

function rate(
  baseline: unknown,
  override: number | undefined,
  fetchedAt: Date,
  verified: VerifiedModelPriceOverride | null
): CanonicalModelRate {
  if (verified && override !== undefined) {
    if (!validRate(override)) {
      throw new Error(`Invalid verified price for ${verified.model}`);
    }
    return {
      usdPerToken: override,
      source: ModelRateSource.VERIFIED_PROVIDER,
      observedAt: verifiedObservedAt(verified.verifiedOn),
      sourceRef: verified.source,
    };
  }
  if (validRate(baseline)) {
    return {
      usdPerToken: baseline,
      source: ModelRateSource.LITELLM,
      observedAt: fetchedAt,
      sourceRef: LITELLM_MODEL_CATALOG_URL,
    };
  }
  return {
    usdPerToken: 0,
    source: ModelRateSource.UNAVAILABLE,
    observedAt: fetchedAt,
    sourceRef: null,
  };
}

function priceCard(
  entry: LiteLLMModelEntry,
  fetchedAt: Date,
  verified: VerifiedModelPriceOverride | null
): PriceCardInput {
  return {
    input: rate(entry.input_cost_per_token, verified?.input, fetchedAt, verified),
    output: rate(entry.output_cost_per_token, verified?.output, fetchedAt, verified),
    cacheRead: rate(
      entry.cache_read_input_token_cost,
      verified?.cacheRead,
      fetchedAt,
      verified
    ),
    cacheWrite: rate(
      entry.cache_creation_input_token_cost,
      verified?.cacheWrite,
      fetchedAt,
      verified
    ),
  };
}

function decimalEquals(decimal: Prisma.Decimal, value: number): boolean {
  return decimal.equals(new Prisma.Decimal(value));
}

function persistedCardEquals(
  persisted: {
    inputRate: Prisma.Decimal;
    outputRate: Prisma.Decimal;
    cacheReadRate: Prisma.Decimal;
    cacheWriteRate: Prisma.Decimal;
    inputSource: ModelRateSource;
    outputSource: ModelRateSource;
    cacheReadSource: ModelRateSource;
    cacheWriteSource: ModelRateSource;
    inputObservedAt: Date;
    outputObservedAt: Date;
    cacheReadObservedAt: Date;
    cacheWriteObservedAt: Date;
    inputSourceRef: string | null;
    outputSourceRef: string | null;
    cacheReadSourceRef: string | null;
    cacheWriteSourceRef: string | null;
  },
  card: PriceCardInput
): boolean {
  const sameRate = (
    name: CanonicalRateName,
    persistedRate: Prisma.Decimal,
    persistedSource: ModelRateSource,
    persistedObservedAt: Date,
    persistedSourceRef: string | null
  ) => {
    const candidate = card[name];
    return (
      decimalEquals(persistedRate, candidate.usdPerToken) &&
      persistedSource === candidate.source &&
      persistedSourceRef === candidate.sourceRef &&
      (candidate.source !== ModelRateSource.VERIFIED_PROVIDER ||
        persistedObservedAt.getTime() === candidate.observedAt.getTime())
    );
  };

  return (
    sameRate(
      "input",
      persisted.inputRate,
      persisted.inputSource,
      persisted.inputObservedAt,
      persisted.inputSourceRef
    ) &&
    sameRate(
      "output",
      persisted.outputRate,
      persisted.outputSource,
      persisted.outputObservedAt,
      persisted.outputSourceRef
    ) &&
    sameRate(
      "cacheRead",
      persisted.cacheReadRate,
      persisted.cacheReadSource,
      persisted.cacheReadObservedAt,
      persisted.cacheReadSourceRef
    ) &&
    sameRate(
      "cacheWrite",
      persisted.cacheWriteRate,
      persisted.cacheWriteSource,
      persisted.cacheWriteObservedAt,
      persisted.cacheWriteSourceRef
    )
  );
}

function modelPriceCreateData(modelId: string, effectiveFrom: Date, card: PriceCardInput) {
  return {
    modelId,
    effectiveFrom,
    inputRate: card.input.usdPerToken,
    outputRate: card.output.usdPerToken,
    cacheReadRate: card.cacheRead.usdPerToken,
    cacheWriteRate: card.cacheWrite.usdPerToken,
    inputSource: card.input.source,
    outputSource: card.output.source,
    cacheReadSource: card.cacheRead.source,
    cacheWriteSource: card.cacheWrite.source,
    inputObservedAt: card.input.observedAt,
    outputObservedAt: card.output.observedAt,
    cacheReadObservedAt: card.cacheRead.observedAt,
    cacheWriteObservedAt: card.cacheWrite.observedAt,
    inputSourceRef: card.input.sourceRef,
    outputSourceRef: card.output.sourceRef,
    cacheReadSourceRef: card.cacheRead.sourceRef,
    cacheWriteSourceRef: card.cacheWrite.sourceRef,
  };
}

function toSnapshot(row: {
  id: string;
  modelId: string;
  effectiveFrom: Date;
  inputRate: Prisma.Decimal;
  outputRate: Prisma.Decimal;
  cacheReadRate: Prisma.Decimal;
  cacheWriteRate: Prisma.Decimal;
  inputSource: ModelRateSource;
  outputSource: ModelRateSource;
  cacheReadSource: ModelRateSource;
  cacheWriteSource: ModelRateSource;
  inputObservedAt: Date;
  outputObservedAt: Date;
  cacheReadObservedAt: Date;
  cacheWriteObservedAt: Date;
  inputSourceRef: string | null;
  outputSourceRef: string | null;
  cacheReadSourceRef: string | null;
  cacheWriteSourceRef: string | null;
  model: { key: string; provider: string; name: string };
}): CanonicalModelPriceSnapshot {
  const modelRate = (
    value: Prisma.Decimal,
    source: ModelRateSource,
    observedAt: Date,
    sourceRef: string | null
  ): CanonicalModelRate => ({
    usdPerToken: value.toNumber(),
    source,
    observedAt,
    sourceRef,
  });

  return {
    modelPriceId: row.id,
    modelId: row.modelId,
    modelKey: row.model.key,
    provider: row.model.provider,
    modelName: row.model.name,
    effectiveFrom: row.effectiveFrom,
    input: modelRate(
      row.inputRate,
      row.inputSource,
      row.inputObservedAt,
      row.inputSourceRef
    ),
    output: modelRate(
      row.outputRate,
      row.outputSource,
      row.outputObservedAt,
      row.outputSourceRef
    ),
    cacheRead: modelRate(
      row.cacheReadRate,
      row.cacheReadSource,
      row.cacheReadObservedAt,
      row.cacheReadSourceRef
    ),
    cacheWrite: modelRate(
      row.cacheWriteRate,
      row.cacheWriteSource,
      row.cacheWriteObservedAt,
      row.cacheWriteSourceRef
    ),
  };
}

function tokenCount(value: number | undefined, name: string): number {
  const count = value ?? 0;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return count;
}

function requireRate(
  model: string,
  name: CanonicalRateName,
  tokens: number,
  modelRate: CanonicalModelRate
): number {
  if (tokens > 0 && modelRate.source === ModelRateSource.UNAVAILABLE) {
    throw new ModelPricingUnavailableError(model, name);
  }
  return modelRate.usdPerToken;
}

export function calculateCanonicalModelCost(
  model: string,
  price: CanonicalModelPriceSnapshot,
  usage: CanonicalTokenUsage
): number {
  const inputTokens = tokenCount(usage.inputTokens, "inputTokens");
  const outputTokens = tokenCount(usage.outputTokens, "outputTokens");
  const cacheReadTokens = tokenCount(usage.cacheReadInputTokens, "cacheReadInputTokens");
  const cacheWriteTokens = tokenCount(
    usage.cacheWriteInputTokens,
    "cacheWriteInputTokens"
  );
  if (cacheReadTokens + cacheWriteTokens > inputTokens) {
    throw new Error("Cache token counts cannot exceed inputTokens");
  }

  const freshInputTokens = inputTokens - cacheReadTokens - cacheWriteTokens;
  const cents =
    freshInputTokens * requireRate(model, "input", freshInputTokens, price.input) * 100 +
    outputTokens * requireRate(model, "output", outputTokens, price.output) * 100 +
    cacheReadTokens * requireRate(model, "cacheRead", cacheReadTokens, price.cacheRead) * 100 +
    cacheWriteTokens *
      requireRate(model, "cacheWrite", cacheWriteTokens, price.cacheWrite) *
      100;

  return Math.round(cents * 1_000_000) / 1_000_000;
}

export function modelPriceSnapshotStepData(price: CanonicalModelPriceSnapshot) {
  return {
    modelPriceId: price.modelPriceId,
    inputRate: price.input.usdPerToken,
    outputRate: price.output.usdPerToken,
    cacheReadRate: price.cacheRead.usdPerToken,
    cacheWriteRate: price.cacheWrite.usdPerToken,
    inputRateSource: price.input.source,
    outputRateSource: price.output.source,
    cacheReadRateSource: price.cacheRead.source,
    cacheWriteRateSource: price.cacheWrite.source,
    inputRateObservedAt: price.input.observedAt,
    outputRateObservedAt: price.output.observedAt,
    cacheReadRateObservedAt: price.cacheRead.observedAt,
    cacheWriteRateObservedAt: price.cacheWrite.observedAt,
    inputRateSourceRef: price.input.sourceRef,
    outputRateSourceRef: price.output.sourceRef,
    cacheReadRateSourceRef: price.cacheRead.sourceRef,
    cacheWriteRateSourceRef: price.cacheWrite.sourceRef,
  };
}

export class PlatosModelPricing {
  constructor(private readonly prisma: PrismaClient) {}

  async ingestLiteLLMCatalog(
    catalog: LiteLLMModelCatalog,
    fetchedAt: Date
  ): Promise<{ modelsSeen: number; pricesCreated: number; unchanged: number }> {
    if (!(fetchedAt instanceof Date) || Number.isNaN(fetchedAt.getTime())) {
      throw new Error("fetchedAt must be a valid Date");
    }
    if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
      throw new Error("LiteLLM catalog must be an object");
    }

    const entries = Object.entries(catalog).filter(
      ([key, entry]) => key.trim().length > 0 && entry && typeof entry === "object"
    );
    const coveredOverrides = new Set<string>();
    for (const [key, entry] of entries) {
      const provider = providerForCatalogEntry(key, entry);
      const verified = verifiedModelPriceFor(modelPricingLookupKeys(key), provider);
      if (verified) coveredOverrides.add(verified.model);
    }
    for (const verified of VERIFIED_MODEL_PRICE_OVERRIDES) {
      if (!coveredOverrides.has(verified.model)) {
        entries.push([
          overrideModelName(verified),
          { litellm_provider: LITELLM_PROVIDER_PREFIX[verified.provider] ?? verified.provider },
        ]);
      }
    }

    return this.prisma.$transaction(
      async (tx) => {
        let pricesCreated = 0;
        let unchanged = 0;

        for (const [key, entry] of entries) {
          const provider = providerForCatalogEntry(key, entry);
          const verified = verifiedModelPriceFor(modelPricingLookupKeys(key), provider);
          const model = await tx.model.upsert({
            where: { key },
            create: {
              key,
              provider,
              name: key,
              displayName: entry.model_name ?? null,
              description: entry.description ?? null,
              contextWindow: tokenCountOrNull(entry.max_input_tokens) ?? tokenCountOrNull(entry.max_tokens),
              maxOutputTokens: tokenCountOrNull(entry.max_output_tokens),
              capabilities: capabilitiesFor(entry),
              releaseDate: dateOrNull(entry.release_date),
              deprecationDate: dateOrNull(entry.deprecation_date),
              sourceUpdatedAt: fetchedAt,
            },
            update: {
              provider,
              displayName: entry.model_name ?? null,
              description: entry.description ?? null,
              contextWindow: tokenCountOrNull(entry.max_input_tokens) ?? tokenCountOrNull(entry.max_tokens),
              maxOutputTokens: tokenCountOrNull(entry.max_output_tokens),
              capabilities: capabilitiesFor(entry),
              releaseDate: dateOrNull(entry.release_date),
              deprecationDate: dateOrNull(entry.deprecation_date),
              sourceUpdatedAt: fetchedAt,
            },
          });
          const card = priceCard(entry, fetchedAt, verified);
          const latest = await tx.modelPrice.findFirst({
            where: { modelId: model.id },
            orderBy: { effectiveFrom: "desc" },
          });
          if (latest && persistedCardEquals(latest, card)) {
            unchanged += 1;
            continue;
          }
          await tx.modelPrice.create({
            data: modelPriceCreateData(model.id, fetchedAt, card),
          });
          pricesCreated += 1;
        }

        return { modelsSeen: entries.length, pricesCreated, unchanged };
      },
      { maxWait: 10_000, timeout: 120_000 }
    );
  }

  async resolvePrice(
    model: string,
    at: Date = new Date()
  ): Promise<CanonicalModelPriceSnapshot> {
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
      throw new Error("at must be a valid Date");
    }
    const keys = modelPricingLookupKeys(model);
    if (keys.length === 0) throw new ModelPricingUnavailableError(model);

    const rows = await this.prisma.modelPrice.findMany({
      where: {
        effectiveFrom: { lte: at },
        model: { key: { in: keys } },
      },
      include: { model: { select: { key: true, provider: true, name: true } } },
      orderBy: { effectiveFrom: "desc" },
    });
    const newestByKey = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (!newestByKey.has(row.model.key)) newestByKey.set(row.model.key, row);
    }
    for (const key of keys) {
      const row = newestByKey.get(key);
      if (row) return toSnapshot(row);
    }
    throw new ModelPricingUnavailableError(model);
  }

  async priceUsage(
    model: string,
    usage: CanonicalTokenUsage,
    at: Date = new Date()
  ): Promise<PricedModelUsage> {
    const price = await this.resolvePrice(model, at);
    return {
      price,
      costCents: calculateCanonicalModelCost(model, price, usage),
    };
  }
}
