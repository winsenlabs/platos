import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import {
  LITELLM_MODEL_CATALOG_URL,
  type LiteLLMModelCatalog,
} from "@platos/tenancy-database";
import {
  PRISMA_TOKEN,
  type ControlDatabaseClient,
} from "../shared/database.provider";
import { CostService } from "./cost.service";
import { assertCredibleLiteLLMCatalog } from "./litellm-catalog-validation";

export type ModelPricingBootstrapResult =
  | { status: "already_ready" }
  | { status: "bootstrapped"; modelsSeen: number; pricesCreated: number; unchanged: number }
  | { status: "bootstrapped_by_peer" };

/**
 * Fail-closed startup owner for a fresh canonical catalogue. Nest runs this
 * hook before app.listen() begins accepting normal turn traffic.
 */
@Injectable()
export class ModelPricingBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ModelPricingBootstrapService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient,
    private readonly costService: CostService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bootstrapIfEmpty();
  }

  async bootstrapIfEmpty(
    fetchImpl: typeof fetch = fetch,
    fetchedAt: Date = new Date(),
  ): Promise<ModelPricingBootstrapResult> {
    const existing = await this.prisma.modelPrice.findFirst({ select: { id: true } });
    if (existing) return { status: "already_ready" };

    this.logger.log("[cost] canonical model catalogue empty; bootstrapping from LiteLLM");
    try {
      const response = await fetchImpl(LITELLM_MODEL_CATALOG_URL, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        throw new Error(`LiteLLM bootstrap failed with HTTP ${response.status}`);
      }
      const catalog = (await response.json()) as LiteLLMModelCatalog;
      if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
        throw new Error("LiteLLM bootstrap response is not a catalog object");
      }
      assertCredibleLiteLLMCatalog(catalog);
      const result = await this.costService.ingestCatalog(catalog, fetchedAt);
      if (result.modelsSeen <= 0) {
        throw new Error("LiteLLM bootstrap created no canonical models");
      }
      this.logger.log(
        `[cost] canonical model catalogue bootstrapped (${result.modelsSeen} models, ${result.pricesCreated} price cards)`,
      );
      return { status: "bootstrapped", ...result };
    } catch (error) {
      // A concurrently starting replica may have completed the same idempotent
      // bootstrap while this one was fetching or ingesting.
      const peerResult = await this.prisma.modelPrice.findFirst({ select: { id: true } });
      if (peerResult) {
        this.logger.log("[cost] canonical model catalogue bootstrapped by another replica");
        return { status: "bootstrapped_by_peer" };
      }
      throw error;
    }
  }
}
