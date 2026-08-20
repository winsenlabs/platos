import { describe, expect, it } from "vitest";
import {
  assertCredibleLiteLLMCatalog,
  LITELLM_CATALOG_MIN_MODEL_COUNT,
  LITELLM_CATALOG_SENTINELS,
} from "./litellm-catalog-validation";
import { createCredibleLiteLLMCatalog } from "./litellm-catalog-validation.test-fixture";

describe("assertCredibleLiteLLMCatalog", () => {
  it("rejects an empty object", () => {
    expect(() => assertCredibleLiteLLMCatalog({})).toThrow("catalog is truncated");
  });

  it("rejects a catalog below the explicit credible minimum", () => {
    const catalog = Object.fromEntries(
      Array.from({ length: LITELLM_CATALOG_MIN_MODEL_COUNT - 1 }, (_, index) => [
        `model-${index}`,
        { input_cost_per_token: 1e-7, output_cost_per_token: 2e-7 },
      ]),
    );
    expect(() => assertCredibleLiteLLMCatalog(catalog)).toThrow(
      `expected at least ${LITELLM_CATALOG_MIN_MODEL_COUNT} rows`,
    );
  });

  it("rejects a credible-sized catalog with a missing sentinel", () => {
    const catalog = createCredibleLiteLLMCatalog();
    delete catalog[LITELLM_CATALOG_SENTINELS[0].keys[0]];
    catalog["replacement-row"] = {
      litellm_provider: "fixture",
      mode: "chat",
      input_cost_per_token: 1e-7,
      output_cost_per_token: 2e-7,
    };
    expect(() => assertCredibleLiteLLMCatalog(catalog)).toThrow("missing sentinel");
  });

  it.each(["input_cost_per_token", "output_cost_per_token"] as const)(
    "rejects a sentinel with a malformed %s",
    (field) => {
      const catalog = createCredibleLiteLLMCatalog();
      catalog[LITELLM_CATALOG_SENTINELS[0].keys[0]][field] = Number.NaN;
      expect(() => assertCredibleLiteLLMCatalog(catalog)).toThrow(
        "has invalid input/output rates",
      );
    },
  );

  it("accepts a credible fixture", () => {
    expect(() => assertCredibleLiteLLMCatalog(createCredibleLiteLLMCatalog())).not.toThrow();
  });
});
