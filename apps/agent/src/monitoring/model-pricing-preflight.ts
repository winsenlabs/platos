import {
  ModelRateSource,
  type CanonicalModelPriceSnapshot,
} from "@platos/tenancy-database";
import { ProviderRuntimeError } from "../providers/provider-runtime.error";
import type { CostService } from "./cost.service";

/** Resolve a usable input/output card before any provider can incur spend. */
export async function preflightModelPricing(
  costService: Pick<CostService, "resolvePrice"> | null | undefined,
  model: string,
): Promise<CanonicalModelPriceSnapshot> {
  if (!costService) throw new ProviderRuntimeError("model_pricing_unavailable");
  try {
    const price = await costService.resolvePrice(model);
    if (
      price.input.source === ModelRateSource.UNAVAILABLE ||
      price.output.source === ModelRateSource.UNAVAILABLE
    ) {
      throw new Error("input/output rate unavailable");
    }
    return price;
  } catch {
    throw new ProviderRuntimeError("model_pricing_unavailable");
  }
}
