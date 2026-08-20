import {
  LITELLM_CATALOG_MIN_MODEL_COUNT,
  LITELLM_CATALOG_SENTINELS,
} from "./litellm-catalog-validation";

export type LiteLLMTestCatalog = Record<
  string,
  {
    litellm_provider: string;
    mode: string;
    input_cost_per_token: number;
    output_cost_per_token: number;
  }
>;

/** Small-in-source, credible-at-runtime catalog for boundary tests. */
export function createCredibleLiteLLMCatalog(): LiteLLMTestCatalog {
  const catalog: LiteLLMTestCatalog = {};
  for (const [index, sentinel] of LITELLM_CATALOG_SENTINELS.entries()) {
    const key = sentinel.keys[0];
    catalog[key] = {
      litellm_provider: index === 0 ? "openai" : index === 1 ? "anthropic" : "gemini",
      mode: "chat",
      input_cost_per_token: 1e-7,
      output_cost_per_token: 2e-7,
    };
  }
  for (
    let index = 0;
    Object.keys(catalog).length < LITELLM_CATALOG_MIN_MODEL_COUNT;
    index += 1
  ) {
    catalog[`fixture/model-${index}`] = {
      litellm_provider: "fixture",
      mode: "chat",
      input_cost_per_token: 1e-7,
      output_cost_per_token: 2e-7,
    };
  }
  return catalog;
}
