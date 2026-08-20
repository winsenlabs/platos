import { modelPricingLookupKeys } from "@platos/tenancy-database";
import { describe, expect, it } from "vitest";
import { PROVIDER_MANIFESTS } from "./manifests";

/**
 * Current credible LiteLLM keys for curated models. This is intentionally a
 * committed inventory: manifest changes must either add a priced key here or
 * explicitly declare that runtime preflight will reject the model.
 */
const REPRESENTATIVE_PRICED_KEYS = new Set([
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-haiku-4-5-20251001",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4o",
  "gpt-4o-mini",
  "gemini/gemini-2.5-pro",
  "gemini/gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "vertex_ai/gemini-3-flash-preview",
  "vertex_ai/zai-org/glm-5-maas",
  "groq/llama-3.3-70b-versatile",
  "groq/llama-3.1-8b-instant",
  "mistral/mistral-large-latest",
  "mistral/mistral-small-latest",
  "mistral/codestral-latest",
  "mistral/pixtral-large-latest",
  "mistral/ministral-8b-latest",
  "xai/grok-2-latest",
  "xai/grok-2-vision-latest",
  "xai/grok-beta",
  "deepseek/deepseek-chat",
  "deepseek/deepseek-reasoner",
  "cerebras/llama-3.3-70b",
  "cerebras/llama3.1-70b",
  "perplexity/sonar",
  "perplexity/sonar-pro",
  "perplexity/sonar-reasoning",
  "perplexity/sonar-reasoning-pro",
  "perplexity/sonar-deep-research",
  "together_ai/meta-llama/Llama-3.3-70B-Instruct-Turbo",
  "together_ai/meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
  "together_ai/deepseek-ai/DeepSeek-R1",
  "together_ai/openai/gpt-oss-120b",
  "together_ai/openai/gpt-oss-20b",
  "fireworks_ai/accounts/fireworks/models/llama-v3p3-70b-instruct",
  "fireworks_ai/accounts/fireworks/models/deepseek-v3",
  "fireworks_ai/accounts/fireworks/models/deepseek-r1",
  "fireworks_ai/accounts/fireworks/models/qwen2p5-72b-instruct",
  "azure/gpt-4o",
  "azure/gpt-4o-mini",
  "azure/gpt-4.1",
  "text-embedding-3-small",
  "voyage/voyage-large-2",
]);

export const PREFLIGHT_REJECTED_MODELS = new Set([
  "groq:qwen-2.5-72b",
  "groq:deepseek-r1-distill-llama-70b",
  "groq:mixtral-8x7b-32768",
  "cerebras:llama-3.1-8b",
  "together:Qwen/Qwen2.5-72B-Instruct-Turbo",
  "sakana:fugu",
  "sakana:fugu-ultra",
]);

const REQUIRED_DEFAULT_MODELS = [
  "anthropic:claude-sonnet-4-6",
  "anthropic:claude-haiku-4-5-20251001",
  "openai:text-embedding-3-small",
  "voyage:voyage-large-2",
] as const;

describe("provider model pricing coverage", () => {
  it("accounts for every advertised model as priced or explicitly preflight-rejected", () => {
    for (const model of PROVIDER_MANIFESTS.flatMap((manifest) => manifest.models)) {
      const priced = modelPricingLookupKeys(model).some((key) =>
        REPRESENTATIVE_PRICED_KEYS.has(key),
      );
      expect(
        priced || PREFLIGHT_REJECTED_MODELS.has(model),
        `${model} has neither a representative canonical price nor an explicit rejection policy`,
      ).toBe(true);
    }
  });

  it("resolves every main and auxiliary default against representative pricing", () => {
    for (const model of REQUIRED_DEFAULT_MODELS) {
      expect(
        modelPricingLookupKeys(model).some((key) => REPRESENTATIVE_PRICED_KEYS.has(key)),
        `${model} default is not canonically priced`,
      ).toBe(true);
    }
  });

  it("keeps unsupported Sakana models explicitly rejected", () => {
    expect([...PREFLIGHT_REJECTED_MODELS]).toEqual(
      expect.arrayContaining(["sakana:fugu", "sakana:fugu-ultra"]),
    );
  });
});
