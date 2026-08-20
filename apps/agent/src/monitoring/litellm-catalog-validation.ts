/**
 * Guardrails for the raw public LiteLLM baseline. The upstream currently has
 * more than 3,000 rows; 1,000 leaves ample room for normal cleanup while
 * rejecting empty, partial, or accidentally truncated downloads.
 */
export const LITELLM_CATALOG_MIN_MODEL_COUNT = 1_000;

export const LITELLM_CATALOG_SENTINELS = [
  { name: "OpenAI GPT-4o mini", keys: ["gpt-4o-mini"] },
  {
    name: "Anthropic Claude Haiku 4.5",
    keys: ["claude-haiku-4-5-20251001", "claude-haiku-4-5"],
  },
  { name: "Google Gemini 2.5 Flash", keys: ["gemini/gemini-2.5-flash"] },
] as const;

type LiteLLMRateEntry = {
  input_cost_per_token?: unknown;
  output_cost_per_token?: unknown;
};

function positiveFiniteRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Validate the raw baseline before any committed override can augment it. */
export function assertCredibleLiteLLMCatalog(
  value: unknown,
): asserts value is Record<string, LiteLLMRateEntry> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("LiteLLM catalog must be a JSON object");
  }

  const catalog = value as Record<string, LiteLLMRateEntry>;
  const rowCount = Object.keys(catalog).length;
  if (rowCount < LITELLM_CATALOG_MIN_MODEL_COUNT) {
    throw new Error(
      `LiteLLM catalog is truncated: expected at least ${LITELLM_CATALOG_MIN_MODEL_COUNT} rows, received ${rowCount}`,
    );
  }

  for (const sentinel of LITELLM_CATALOG_SENTINELS) {
    const key = sentinel.keys.find((candidate) => candidate in catalog);
    if (!key) {
      throw new Error(
        `LiteLLM catalog is missing sentinel ${sentinel.name} (${sentinel.keys.join(" or ")})`,
      );
    }
    const entry = catalog[key];
    if (
      !entry ||
      typeof entry !== "object" ||
      !positiveFiniteRate(entry.input_cost_per_token) ||
      !positiveFiniteRate(entry.output_cost_per_token)
    ) {
      throw new Error(`LiteLLM catalog sentinel ${key} has invalid input/output rates`);
    }
  }
}
