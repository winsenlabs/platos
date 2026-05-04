/**
 * Provider manifests.
 *
 * Each manifest declares:
 *  - id           — stable identifier used by the UI, DB, and model strings
 *  - displayName  — human-readable label
 *  - requiredEnv  — env var names that must be present for the provider to work
 *  - optionalEnv  — env var names that refine behavior but are not required
 *  - models       — models exposed in the model picker when enabled
 *  - healthCheck  — minimal API call descriptor used by ProviderHealthService
 *
 * Per Theme B + PLATOS_SPEC §4.4: provider API keys live **only** in the
 * trigger.dev Environment Variables table. We never store them in a
 * Platos-owned row or Redis cache. The `/agent-providers` UI is a
 * "link-env" checklist — the webapp reads the env var presence for the
 * current scope and shows each provider as `Set | Not set`.
 */

export interface ProviderManifest {
  id: string;
  displayName: string;
  description: string;
  /** Env vars that MUST be present. Provider is ready only when all are set. */
  requiredEnv: string[];
  /** Env vars that refine behavior (e.g. region, baseURL). */
  optionalEnv: string[];
  /** Models exposed when the provider is enabled. */
  models: string[];
  /** Minimal probe for the health endpoint (fetches against the live API). */
  healthCheck: {
    /** Dispatch key for the probe implementation. */
    kind: "anthropic" | "openai" | "google" | "vertex-file" | "openai-compat";
    /** Tiny model to smoke-test with. */
    probeModel: string;
    /**
     * For `kind: "openai-compat"` — the upstream's OpenAI-shape base URL.
     * Mistral / Groq / xAI / DeepSeek / Cerebras / Perplexity / Together /
     * Fireworks all expose a /v1/chat/completions endpoint compatible with
     * the OpenAI SDK; one probe handles them all.
     */
    baseURL?: string;
  };
}

export const PROVIDER_MANIFESTS: ProviderManifest[] = [
  {
    id: "anthropic",
    displayName: "Anthropic Claude",
    description: "Claude Sonnet / Opus / Haiku via Anthropic's API.",
    requiredEnv: ["ANTHROPIC_API_KEY"],
    optionalEnv: [],
    models: [
      "anthropic:claude-sonnet-4-6",
      "anthropic:claude-opus-4-6",
      "anthropic:claude-haiku-4-5-20251001",
    ],
    healthCheck: { kind: "anthropic", probeModel: "claude-haiku-4-5-20251001" },
  },
  {
    id: "openai",
    displayName: "OpenAI",
    description: "GPT-4.1, GPT-4o and GPT-OSS models via OpenAI's API.",
    requiredEnv: ["OPENAI_API_KEY"],
    optionalEnv: ["OPENAI_BASE_URL"],
    models: [
      "openai:gpt-4.1",
      "openai:gpt-4.1-mini",
      "openai:gpt-4o",
      "openai:gpt-oss-120b",
    ],
    healthCheck: { kind: "openai", probeModel: "gpt-4.1-mini" },
  },
  {
    id: "google",
    displayName: "Google AI (Gemini)",
    description: "Gemini 2.5 Pro / Flash via Google AI's generative API.",
    requiredEnv: ["GOOGLE_GENERATIVE_AI_API_KEY"],
    optionalEnv: [],
    models: [
      "google:gemini-2.5-pro",
      "google:gemini-2.5-flash",
    ],
    healthCheck: { kind: "google", probeModel: "gemini-2.0-flash" },
  },
  {
    id: "google-vertex",
    displayName: "Google Vertex AI (GCP)",
    description:
      "Gemini + GLM models on Vertex AI. Paste the full contents of a GCP service account JSON file as GOOGLE_VERTEX_CREDENTIALS. " +
      "Download from GCP Console → IAM → Service Accounts → Keys → Create key (JSON).",
    requiredEnv: ["GOOGLE_VERTEX_CREDENTIALS"],
    optionalEnv: ["GOOGLE_VERTEX_LOCATION"],
    models: [
      "google-vertex:gemini-2.5-pro",
      "google-vertex:gemini-2.5-flash",
      "google-vertex:gemini-3-flash-preview",
      "google-vertex:zai-org/glm-5-maas",
    ],
    healthCheck: { kind: "vertex-file", probeModel: "gemini-2.5-flash" },
  },
  {
    id: "groq",
    displayName: "Groq",
    description: "Llama, Qwen, DeepSeek, Mixtral on Groq's LPU at 600+ tok/s. OpenAI-compatible API.",
    requiredEnv: ["GROQ_API_KEY"],
    optionalEnv: [],
    models: [
      "groq:llama-3.3-70b-versatile",
      "groq:llama-3.1-8b-instant",
      "groq:qwen-2.5-72b",
      "groq:deepseek-r1-distill-llama-70b",
      "groq:mixtral-8x7b-32768",
    ],
    healthCheck: {
      kind: "openai-compat",
      probeModel: "llama-3.1-8b-instant",
      baseURL: "https://api.groq.com/openai/v1",
    },
  },
  {
    id: "mistral",
    displayName: "Mistral",
    description: "Mistral Large, Codestral, Pixtral, Ministral via Mistral's API. OpenAI-compatible.",
    requiredEnv: ["MISTRAL_API_KEY"],
    optionalEnv: [],
    models: [
      "mistral:mistral-large-latest",
      "mistral:mistral-small-latest",
      "mistral:codestral-latest",
      "mistral:pixtral-large-latest",
      "mistral:ministral-8b-latest",
    ],
    healthCheck: {
      kind: "openai-compat",
      probeModel: "ministral-8b-latest",
      baseURL: "https://api.mistral.ai/v1",
    },
  },
  {
    id: "xai",
    displayName: "xAI (Grok)",
    description: "Grok-2 / Grok-2 Vision / Grok-Beta via xAI's API. OpenAI-compatible.",
    requiredEnv: ["XAI_API_KEY"],
    optionalEnv: [],
    models: [
      "xai:grok-2-latest",
      "xai:grok-2-vision-latest",
      "xai:grok-beta",
    ],
    healthCheck: {
      kind: "openai-compat",
      probeModel: "grok-2-latest",
      baseURL: "https://api.x.ai/v1",
    },
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    description: "DeepSeek-V3 + R1 reasoning via the DeepSeek platform. OpenAI-compatible.",
    requiredEnv: ["DEEPSEEK_API_KEY"],
    optionalEnv: [],
    models: [
      "deepseek:deepseek-chat",
      "deepseek:deepseek-reasoner",
    ],
    healthCheck: {
      kind: "openai-compat",
      probeModel: "deepseek-chat",
      baseURL: "https://api.deepseek.com/v1",
    },
  },
  {
    id: "cerebras",
    displayName: "Cerebras",
    description: "Llama 3.3 70B / 3.1 8B at 2200+ tok/s on Cerebras inference. OpenAI-compatible.",
    requiredEnv: ["CEREBRAS_API_KEY"],
    optionalEnv: [],
    models: [
      "cerebras:llama-3.3-70b",
      "cerebras:llama-3.1-8b",
      "cerebras:llama3.1-70b",
    ],
    healthCheck: {
      kind: "openai-compat",
      probeModel: "llama-3.1-8b",
      baseURL: "https://api.cerebras.ai/v1",
    },
  },
  {
    id: "perplexity",
    displayName: "Perplexity",
    description: "Sonar online-search models with built-in retrieval. OpenAI-compatible.",
    requiredEnv: ["PERPLEXITY_API_KEY"],
    optionalEnv: [],
    models: [
      "perplexity:sonar",
      "perplexity:sonar-pro",
      "perplexity:sonar-reasoning",
      "perplexity:sonar-reasoning-pro",
    ],
    healthCheck: {
      kind: "openai-compat",
      probeModel: "sonar",
      baseURL: "https://api.perplexity.ai",
    },
  },
  {
    id: "together",
    displayName: "Together AI",
    description: "Llama 3.x, Qwen 2.5, Mixtral, DeepSeek-R1 + 200 OSS models. OpenAI-compatible.",
    requiredEnv: ["TOGETHER_API_KEY"],
    optionalEnv: [],
    models: [
      "together:meta-llama/Llama-3.3-70B-Instruct-Turbo",
      "together:meta-llama/Llama-3.1-8B-Instruct-Turbo",
      "together:Qwen/Qwen2.5-72B-Instruct-Turbo",
      "together:deepseek-ai/DeepSeek-R1",
    ],
    healthCheck: {
      kind: "openai-compat",
      probeModel: "meta-llama/Llama-3.1-8B-Instruct-Turbo",
      baseURL: "https://api.together.xyz/v1",
    },
  },
  {
    id: "fireworks",
    displayName: "Fireworks AI",
    description: "Llama, DeepSeek, Qwen, Mixtral on Fireworks' fast inference. OpenAI-compatible.",
    requiredEnv: ["FIREWORKS_API_KEY"],
    optionalEnv: [],
    models: [
      "fireworks:accounts/fireworks/models/llama-v3p3-70b-instruct",
      "fireworks:accounts/fireworks/models/deepseek-v3",
      "fireworks:accounts/fireworks/models/deepseek-r1",
      "fireworks:accounts/fireworks/models/qwen2p5-72b-instruct",
    ],
    healthCheck: {
      kind: "openai-compat",
      probeModel: "accounts/fireworks/models/llama-v3p1-8b-instruct",
      baseURL: "https://api.fireworks.ai/inference/v1",
    },
  },
  {
    id: "azure",
    displayName: "Azure OpenAI",
    description:
      "Azure-hosted OpenAI deployments. AZURE_OPENAI_BASE_URL must be your full deployment URL " +
      "(e.g. https://<resource>.openai.azure.com/openai/deployments/<deployment>) and the model " +
      "string after `azure:` is appended verbatim if it contains a slash, otherwise treated as a deployment name.",
    requiredEnv: ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_BASE_URL"],
    optionalEnv: ["AZURE_OPENAI_API_VERSION"],
    models: [
      "azure:gpt-4o",
      "azure:gpt-4o-mini",
      "azure:gpt-4.1",
    ],
    healthCheck: {
      kind: "openai-compat",
      probeModel: "gpt-4o-mini",
      // baseURL filled in at probe time from AZURE_OPENAI_BASE_URL
    },
  },
];

export function getManifest(providerId: string): ProviderManifest | undefined {
  return PROVIDER_MANIFESTS.find((p) => p.id === providerId);
}

export function getProviderForModel(modelString: string): ProviderManifest | undefined {
  const colonIdx = modelString.indexOf(":");
  if (colonIdx <= 0) return undefined;
  const providerId = modelString.slice(0, colonIdx);
  return getManifest(providerId);
}
