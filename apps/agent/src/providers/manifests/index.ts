/**
 * Provider manifests.
 *
 * Each manifest declares:
 *  - id              — stable identifier used by the UI, DB, and model strings
 *  - displayName     — human-readable label
 *  - requiredEnv     — env var names that must be present for the provider to work
 *  - optionalEnv     — env var names that refine behavior but are not required
 *  - models          — curated/fallback models shown in the picker when dynamic
 *                      discovery is unavailable. Always present as the "blessed"
 *                      defaults; dynamic discovery unions on top.
 *  - healthCheck     — minimal API call descriptor used by ProviderHealthService
 *  - modelsEndpoint  — (optional) live model-list endpoint. When set, the
 *                      ModelCatalogService fetches it with the scoped API key
 *                      and unions the result with `models`. Providers without
 *                      this field stay on the static list (Perplexity has no
 *                      endpoint; Azure is per-deployment; Vertex needs OAuth).
 *
 * Per Theme B + PLATOS_SPEC §4.4: provider API keys live **only** in the
 * trigger.dev Environment Variables table. We never store them in a
 * Platos-owned row or Redis cache. The `/agent-providers` UI is a
 * "link-env" checklist — the webapp reads the env var presence for the
 * current scope and shows each provider as `Set | Not set`.
 */

export type ModelsEndpointShape =
  /** OpenAI-canonical `{ object: "list", data: [{ id, ... }] }`. */
  | "openai"
  /** Together returns a bare JSON array `[ { id, type, ... } ]`. */
  | "together"
  /** Anthropic `{ data: [{ id, display_name, ... }], has_more, ... }`. */
  | "anthropic"
  /** Google AI `{ models: [{ name: "models/<id>", supportedGenerationMethods }] }`. */
  | "google"
  /** Fireworks `{ data: [{ id, supports_chat, kind }] }`. */
  | "fireworks"
  /** Mistral `{ data: [{ id, capabilities: { completion_chat } }] }`. */
  | "mistral"
  /** Groq `{ data: [{ id, active, ... }] }`. */
  | "groq";

export type ModelsEndpointAuth =
  /** `Authorization: Bearer <key>` — used by OpenAI/Together/Groq/xAI/DeepSeek/Cerebras/Fireworks/Mistral. */
  | "bearer"
  /** `x-api-key: <key>` + `anthropic-version: 2023-06-01` — used by Anthropic. */
  | "anthropic"
  /** `?key=<key>` query string — used by Google AI Studio. */
  | "google-query";

export interface ModelsEndpoint {
  /** Full URL of the GET-models endpoint. */
  url: string;
  auth: ModelsEndpointAuth;
  shape: ModelsEndpointShape;
}

export interface ProviderManifest {
  id: string;
  displayName: string;
  description: string;
  /** Env vars that MUST be present. Provider is ready only when all are set. */
  requiredEnv: string[];
  /** Env vars that refine behavior (e.g. region, baseURL). */
  optionalEnv: string[];
  /**
   * Curated / fallback models. When `modelsEndpoint` is set the live response
   * is unioned on top of this list (curated entries appear first and stay
   * even if the upstream call fails).
   */
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
  /** Optional live model-list endpoint for the dynamic catalog. */
  modelsEndpoint?: ModelsEndpoint;
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
    modelsEndpoint: {
      url: "https://api.anthropic.com/v1/models?limit=1000",
      auth: "anthropic",
      shape: "anthropic",
    },
  },
  {
    id: "openai",
    displayName: "OpenAI",
    description: "GPT-4.1, GPT-4o and OpenAI's hosted models via OpenAI's API.",
    requiredEnv: ["OPENAI_API_KEY"],
    optionalEnv: ["OPENAI_BASE_URL"],
    models: [
      "openai:gpt-4.1",
      "openai:gpt-4.1-mini",
      "openai:gpt-4o",
      "openai:gpt-4o-mini",
    ],
    healthCheck: { kind: "openai", probeModel: "gpt-4.1-mini" },
    modelsEndpoint: {
      url: "https://api.openai.com/v1/models",
      auth: "bearer",
      shape: "openai",
    },
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
    modelsEndpoint: {
      url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
      auth: "google-query",
      shape: "google",
    },
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
    // Vertex uses GCP OAuth + per-publisher endpoints (publishers/google,
    // publishers/anthropic, publishers/meta, publishers/mistralai). The
    // single-key catalog pattern doesn't fit — fall back to the curated list
    // until we add a Vertex-aware OAuth path. Tracked in follow-up.
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
    modelsEndpoint: {
      url: "https://api.groq.com/openai/v1/models",
      auth: "bearer",
      shape: "groq",
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
    modelsEndpoint: {
      url: "https://api.mistral.ai/v1/models",
      auth: "bearer",
      shape: "mistral",
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
    modelsEndpoint: {
      url: "https://api.x.ai/v1/models",
      auth: "bearer",
      shape: "openai",
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
    modelsEndpoint: {
      // DeepSeek serves /models off the API root (no /v1 prefix on this
      // particular endpoint; /v1/chat/completions for inference is unaffected).
      url: "https://api.deepseek.com/models",
      auth: "bearer",
      shape: "openai",
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
    modelsEndpoint: {
      url: "https://api.cerebras.ai/v1/models",
      auth: "bearer",
      shape: "openai",
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
      "perplexity:sonar-deep-research",
    ],
    healthCheck: {
      kind: "openai-compat",
      probeModel: "sonar",
      baseURL: "https://api.perplexity.ai",
    },
    // Perplexity does not expose a public /models endpoint. Catalog stays
    // curated; update this list when their docs add a model.
  },
  {
    id: "together",
    displayName: "Together AI",
    description: "Llama, Qwen, Mixtral, DeepSeek-R1, gpt-oss + 200 OSS models. OpenAI-compatible.",
    requiredEnv: ["TOGETHER_API_KEY"],
    optionalEnv: [],
    models: [
      "together:meta-llama/Llama-3.3-70B-Instruct-Turbo",
      "together:meta-llama/Llama-3.1-8B-Instruct-Turbo",
      "together:Qwen/Qwen2.5-72B-Instruct-Turbo",
      "together:deepseek-ai/DeepSeek-R1",
      "together:openai/gpt-oss-120b",
      "together:openai/gpt-oss-20b",
    ],
    healthCheck: {
      kind: "openai-compat",
      probeModel: "meta-llama/Llama-3.1-8B-Instruct-Turbo",
      baseURL: "https://api.together.xyz/v1",
    },
    modelsEndpoint: {
      url: "https://api.together.xyz/v1/models",
      auth: "bearer",
      shape: "together",
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
    modelsEndpoint: {
      url: "https://api.fireworks.ai/inference/v1/models",
      auth: "bearer",
      shape: "fireworks",
    },
  },
  {
    id: "sakana",
    displayName: "Sakana AI (Fugu)",
    description:
      "Sakana Fugu — one model that orchestrates a swappable pool of frontier LLMs " +
      "(Trinity/Conductor). `fugu` for everyday work, `fugu-ultra` for hard multi-step " +
      "problems. OpenAI-compatible. Orchestrates server-side before streaming, so " +
      "responses can be slow (seconds→minutes on fugu-ultra) — use generous timeouts. " +
      "Not available in the EU/EEA, UK, or Switzerland.",
    requiredEnv: ["SAKANA_API_KEY"],
    optionalEnv: [],
    models: [
      "sakana:fugu",
      "sakana:fugu-ultra",
    ],
    healthCheck: {
      kind: "openai-compat",
      probeModel: "fugu",
      baseURL: "https://api.sakana.ai/v1",
    },
    modelsEndpoint: {
      url: "https://api.sakana.ai/v1/models",
      auth: "bearer",
      shape: "openai",
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
    // Azure's /openai/deployments is per-resource (URL needs the resource
    // subdomain) and lists deployments, not models. Catalog stays curated.
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
