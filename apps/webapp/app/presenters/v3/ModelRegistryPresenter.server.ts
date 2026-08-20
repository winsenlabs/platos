import { ClickHouse } from "@internal/clickhouse";
import { PrismaClientOrTransaction } from "~/db.server";
import { platosControlDatabase } from "~/services/platosControlDatabase.server";
import { BasePresenter } from "./basePresenter.server";
import { z } from "zod";

/** Format a Date for ClickHouse DateTime64 string params. */
function formatDateForCH(date: Date): string {
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

// --- Helpers ---

/** Format a model as provider:name (e.g. "openai:gpt-5"). */
export function formatModelId(provider: string, modelName: string): string {
  return `${provider}:${modelName}`;
}

// --- Types ---

export type ModelCatalogItem = {
  friendlyId: string;
  modelName: string;
  /** Always resolved — from DB, inferred from name, or "unknown". */
  provider: string;
  /** Display identifier in provider:name format (e.g. "openai:gpt-5"). */
  displayId: string;
  description: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  /** Combined capabilities (from DB) and boolean feature flags (from catalog) as slug strings. */
  features: string[];
  inputPrice: number | null;
  outputPrice: number | null;
  cacheReadPrice: number | null;
  cacheWritePrice: number | null;
  priceEffectiveFrom: string | null;
  priceProvenance: ModelPriceProvenance | null;
  /** When the model was publicly released. */
  releaseDate: string | null;
  /** Dated variants of this model (only populated on base models). */
  variants: ModelVariant[];
};

export type ModelRateProvenance = {
  source: string;
  observedAt: string;
  sourceRef: string | null;
};

export type ModelPriceProvenance = {
  input: ModelRateProvenance;
  output: ModelRateProvenance;
  cacheRead: ModelRateProvenance;
  cacheWrite: ModelRateProvenance;
};

export type ModelVariant = {
  friendlyId: string;
  modelName: string;
  displayId: string;
  releaseDate: string | null;
};

export type ModelCatalogGroup = {
  provider: string;
  models: ModelCatalogItem[];
};

export type ModelDetail = ModelCatalogItem & {
  matchPattern: string;
  source: string;
  pricingTiers: Array<{
    name: string;
    isDefault: boolean;
    prices: Record<string, number>;
    provenance: ModelPriceProvenance;
  }>;
};

function buildFeatures(capabilities: string[]): string[] {
  return Array.from(new Set(capabilities));
}

type CanonicalPriceForDisplay = {
  inputSource: string;
  outputSource: string;
  cacheReadSource: string;
  cacheWriteSource: string;
  inputObservedAt: Date;
  outputObservedAt: Date;
  cacheReadObservedAt: Date;
  cacheWriteObservedAt: Date;
  inputSourceRef: string | null;
  outputSourceRef: string | null;
  cacheReadSourceRef: string | null;
  cacheWriteSourceRef: string | null;
};

function priceProvenance(price: CanonicalPriceForDisplay): ModelPriceProvenance {
  return {
    input: {
      source: price.inputSource,
      observedAt: price.inputObservedAt.toISOString(),
      sourceRef: price.inputSourceRef,
    },
    output: {
      source: price.outputSource,
      observedAt: price.outputObservedAt.toISOString(),
      sourceRef: price.outputSourceRef,
    },
    cacheRead: {
      source: price.cacheReadSource,
      observedAt: price.cacheReadObservedAt.toISOString(),
      sourceRef: price.cacheReadSourceRef,
    },
    cacheWrite: {
      source: price.cacheWriteSource,
      observedAt: price.cacheWriteObservedAt.toISOString(),
      sourceRef: price.cacheWriteSourceRef,
    },
  };
}

export type ModelMetricsPoint = {
  minute: string;
  callCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  ttfcP50: number;
  ttfcP90: number;
  ttfcP95: number;
  ttfcP99: number;
  tpsP50: number;
  tpsP90: number;
  tpsP95: number;
  tpsP99: number;
  durationP50: number;
  durationP90: number;
  durationP95: number;
  durationP99: number;
};

export type UserModelMetrics = {
  totalCalls: number;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgTtfc: number;
  avgTps: number;
  taskBreakdown: Array<{
    taskIdentifier: string;
    calls: number;
    cost: number;
  }>;
};

export type ModelComparisonItem = {
  responseModel: string;
  genAiSystem: string;
  callCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  ttfcP50: number;
  ttfcP90: number;
  tpsP50: number;
  tpsP90: number;
};

export type PopularModel = {
  responseModel: string;
  genAiSystem: string;
  callCount: number;
  totalCost: number;
  ttfcP50: number;
};

// --- ClickHouse schemas for user metrics ---

const UserMetricsSummaryRow = z.object({
  total_calls: z.coerce.number(),
  total_cost: z.coerce.number(),
  total_input_tokens: z.coerce.number(),
  total_output_tokens: z.coerce.number(),
  avg_ttfc: z.coerce.number(),
  avg_tps: z.coerce.number(),
});

const UserTaskBreakdownRow = z.object({
  task_identifier: z.string(),
  calls: z.coerce.number(),
  cost: z.coerce.number(),
});

// --- Presenter ---

export class ModelRegistryPresenter extends BasePresenter {
  private readonly clickhouse: ClickHouse;

  constructor(clickhouse: ClickHouse, replica?: PrismaClientOrTransaction) {
    super(undefined, replica);
    this.clickhouse = clickhouse;
  }

  /** List all visible canonical models with their current four-rate card. */
  async getModelCatalog(): Promise<ModelCatalogGroup[]> {
    const models = await platosControlDatabase.model.findMany({
      where: { isHidden: false },
      include: { prices: { orderBy: { effectiveFrom: "desc" }, take: 1 } },
      orderBy: { name: "asc" },
    });

    type CatalogItemWithBase = ModelCatalogItem & { _baseModelName: string | null };
    const items: CatalogItemWithBase[] = models.map((model) => {
      const price = model.prices[0];
      return {
        friendlyId: model.id,
        modelName: model.name,
        provider: model.provider,
        displayId: formatModelId(model.provider, model.name),
        description: model.description,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
        features: buildFeatures(model.capabilities),
        inputPrice: price ? Number(price.inputRate) : null,
        outputPrice: price ? Number(price.outputRate) : null,
        cacheReadPrice: price ? Number(price.cacheReadRate) : null,
        cacheWritePrice: price ? Number(price.cacheWriteRate) : null,
        priceEffectiveFrom: price?.effectiveFrom.toISOString() ?? null,
        priceProvenance: price ? priceProvenance(price) : null,
        releaseDate: model.releaseDate?.toISOString().split("T")[0] ?? null,
        variants: [],
        _baseModelName: model.baseModelName,
      };
    });

    const normalizeForGrouping = (name: string) => name.replace(/(\d)\.(\d)/g, "$1-$2");
    const variantGroups = new Map<string, CatalogItemWithBase[]>();
    for (const item of items) {
      const key = normalizeForGrouping(item._baseModelName ?? item.modelName);
      variantGroups.set(key, [...(variantGroups.get(key) ?? []), item]);
    }

    const baseModels: ModelCatalogItem[] = [];
    for (const group of variantGroups.values()) {
      const representative = group.find((model) => !model._baseModelName)
        ?? group.find((model) => model.modelName.endsWith("-latest"))
        ?? group[0];
      if (!representative) continue;
      representative.variants = group
        .filter((model) => model !== representative)
        .map((model) => ({
          friendlyId: model.friendlyId,
          modelName: model.modelName,
          displayId: model.displayId,
          releaseDate: model.releaseDate,
        }));
      baseModels.push(representative);
    }

    const groups = new Map<string, ModelCatalogItem[]>();
    for (const model of baseModels) {
      groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, groupedModels]) => ({ provider, models: groupedModels }));
  }

  /** Get one canonical model and its complete append-only price history. */
  async getModelDetail(friendlyId: string): Promise<ModelDetail | null> {
    const model = await platosControlDatabase.model.findUnique({
      where: { id: friendlyId },
      include: { prices: { orderBy: { effectiveFrom: "desc" } } },
    });
    if (!model) return null;
    const current = model.prices[0];
    return {
      friendlyId: model.id,
      modelName: model.name,
      provider: model.provider,
      displayId: formatModelId(model.provider, model.name),
      description: model.description,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      features: buildFeatures(model.capabilities),
      inputPrice: current ? Number(current.inputRate) : null,
      outputPrice: current ? Number(current.outputRate) : null,
      cacheReadPrice: current ? Number(current.cacheReadRate) : null,
      cacheWritePrice: current ? Number(current.cacheWriteRate) : null,
      priceEffectiveFrom: current?.effectiveFrom.toISOString() ?? null,
      priceProvenance: current ? priceProvenance(current) : null,
      releaseDate: model.releaseDate?.toISOString().split("T")[0] ?? null,
      variants: [],
      matchPattern: model.key,
      source: "canonical",
      pricingTiers: model.prices.map((price) => ({
        name: price.effectiveFrom.toISOString(),
        isDefault: price.id === current?.id,
        prices: {
          input: Number(price.inputRate),
          output: Number(price.outputRate),
          cacheRead: Number(price.cacheReadRate),
          cacheWrite: Number(price.cacheWriteRate),
        },
        provenance: priceProvenance(price),
      })),
    };
  }

  /** Get global aggregate metrics for a model (no tenant info). */
  async getGlobalMetrics(
    responseModel: string,
    startTime: Date,
    endTime: Date
  ): Promise<ModelMetricsPoint[]> {
    const [error, rows] = await this.clickhouse.llmModelAggregates.globalMetrics
      .setParams({
        responseModel,
        startTime: formatDateForCH(startTime),
        endTime: formatDateForCH(endTime),
      })
      .execute();

    if (error || !rows) return [];

    return rows.map((r) => ({
      minute: r.minute,
      callCount: r.call_count,
      totalInputTokens: r.total_input_tokens,
      totalOutputTokens: r.total_output_tokens,
      totalCost: r.total_cost,
      ttfcP50: r.ttfc_p50,
      ttfcP90: r.ttfc_p90,
      ttfcP95: r.ttfc_p95,
      ttfcP99: r.ttfc_p99,
      tpsP50: r.tps_p50,
      tpsP90: r.tps_p90,
      tpsP95: 0,
      tpsP99: 0,
      durationP50: r.duration_p50,
      durationP90: r.duration_p90,
      durationP95: 0,
      durationP99: 0,
    }));
  }

  /** Get per-project usage metrics for a model. */
  async getUserMetrics(
    responseModel: string,
    projectId: string,
    environmentId: string,
    startTime: Date,
    endTime: Date
  ): Promise<UserModelMetrics> {
    const summaryQuery = this.clickhouse.reader.query({
      name: "modelRegistryUserSummary",
      query: `
        SELECT
          count() AS total_calls,
          sum(total_cost) AS total_cost,
          sum(input_tokens) AS total_input_tokens,
          sum(output_tokens) AS total_output_tokens,
          round(avg(ms_to_first_chunk), 1) AS avg_ttfc,
          round(avg(tokens_per_second), 1) AS avg_tps
        FROM trigger_dev.llm_metrics_v1
        WHERE response_model = {responseModel: String}
          AND project_id = {projectId: String}
          AND environment_id = {environmentId: String}
          AND start_time >= {startTime: String}
          AND start_time <= {endTime: String}
      `,
      params: z.object({
        responseModel: z.string(),
        projectId: z.string(),
        environmentId: z.string(),
        startTime: z.string(),
        endTime: z.string(),
      }),
      schema: UserMetricsSummaryRow,
    });

    const taskQuery = this.clickhouse.reader.query({
      name: "modelRegistryUserTasks",
      query: `
        SELECT
          task_identifier,
          count() AS calls,
          sum(total_cost) AS cost
        FROM trigger_dev.llm_metrics_v1
        WHERE response_model = {responseModel: String}
          AND project_id = {projectId: String}
          AND environment_id = {environmentId: String}
          AND start_time >= {startTime: String}
          AND start_time <= {endTime: String}
        GROUP BY task_identifier
        ORDER BY cost DESC
        LIMIT 20
      `,
      params: z.object({
        responseModel: z.string(),
        projectId: z.string(),
        environmentId: z.string(),
        startTime: z.string(),
        endTime: z.string(),
      }),
      schema: UserTaskBreakdownRow,
    });

    const queryParams = {
      responseModel,
      projectId,
      environmentId,
      startTime: formatDateForCH(startTime),
      endTime: formatDateForCH(endTime),
    };

    const [summaryResult, taskResult] = await Promise.all([
      summaryQuery(queryParams),
      taskQuery(queryParams),
    ]);

    const [summaryError, summaryRows] = summaryResult;
    const [taskError, taskRows] = taskResult;

    const defaultSummary = {
      total_calls: 0,
      total_cost: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      avg_ttfc: 0,
      avg_tps: 0,
    };

    const summary = !summaryError && summaryRows?.[0] ? summaryRows[0] : defaultSummary;

    return {
      totalCalls: summary.total_calls,
      totalCost: summary.total_cost,
      totalInputTokens: summary.total_input_tokens,
      totalOutputTokens: summary.total_output_tokens,
      avgTtfc: summary.avg_ttfc,
      avgTps: summary.avg_tps,
      taskBreakdown: !taskError && taskRows
        ? taskRows.map((r) => ({
            taskIdentifier: r.task_identifier,
            calls: r.calls,
            cost: r.cost,
          }))
        : [],
    };
  }

  /** Get comparison data for 2-4 models. */
  async getModelComparison(
    responseModels: string[],
    startTime: Date,
    endTime: Date
  ): Promise<ModelComparisonItem[]> {
    const [error, rows] = await this.clickhouse.llmModelAggregates.comparison
      .setParams({
        responseModels,
        startTime: formatDateForCH(startTime),
        endTime: formatDateForCH(endTime),
      })
      .execute();

    if (error || !rows) return [];

    return rows.map((r) => ({
      responseModel: r.response_model,
      genAiSystem: r.gen_ai_system,
      callCount: r.call_count,
      totalInputTokens: r.total_input_tokens,
      totalOutputTokens: r.total_output_tokens,
      totalCost: r.total_cost,
      ttfcP50: r.ttfc_p50,
      ttfcP90: r.ttfc_p90,
      tpsP50: r.tps_p50,
      tpsP90: r.tps_p90,
    }));
  }

  /** Get the most popular models by call count. */
  async getPopularModels(
    startTime: Date,
    endTime: Date,
    limit: number = 20
  ): Promise<PopularModel[]> {
    const [error, rows] = await this.clickhouse.llmModelAggregates.popular
      .setParams({
        startTime: formatDateForCH(startTime),
        endTime: formatDateForCH(endTime),
        limit,
      })
      .execute();

    if (error || !rows) return [];

    return rows.map((r) => ({
      responseModel: r.response_model,
      genAiSystem: r.gen_ai_system,
      callCount: r.call_count,
      totalCost: r.total_cost,
      ttfcP50: r.ttfc_p50,
    }));
  }
}
