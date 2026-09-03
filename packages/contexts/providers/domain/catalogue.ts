// The shipped provider catalogue.
//
// Transcribed from the live manifests, field for field. Every id, credential
// reference name, curated model string, probe model, base URL and model-list
// address below is the value the running system uses today: this is a
// re-homing, not a re-selection. Changing one of these values changes what an
// installation can reach, so a change here is a product decision and not a
// refactor.
//
// It is a DEFAULT, not a constant: every rule in `manifest.ts` takes a
// `ProviderCatalogue` parameter, and an installation may compose its own.
//
// One duplication is resolved rather than carried across. The source held each
// OpenAI-compatible root in two places — the manifest's probe descriptor and the
// turn engine's own lookup table, annotated "keep in sync" — and the two agreed
// for all nine providers at the time of transcription. `baseUrl` below is that
// single value, read by the liveness call and the routing plan alike.

import { asProvidersIdentifier } from "./identifiers.js";
import type { CredentialName, ProviderId } from "./identifiers.js";
import type { ProviderCatalogue, ProviderManifest } from "./manifest.js";

function provider(id: string): ProviderId {
  return asProvidersIdentifier<ProviderId>(id);
}

function credentials(...names: string[]): readonly CredentialName[] {
  return Object.freeze(names.map((name) => asProvidersIdentifier<CredentialName>(name)));
}

function credential(name: string): CredentialName {
  return asProvidersIdentifier<CredentialName>(name);
}

/**
 * The two settings credentials default to absent, so only the three providers
 * that actually have one say so. Every other field is spelled out on every
 * manifest: a default that hides a decision is how the source ended up with the
 * same base URL written in two places.
 */
type ManifestDraft = Omit<ProviderManifest, "baseUrlCredential" | "locationCredential"> &
  Partial<Pick<ProviderManifest, "baseUrlCredential" | "locationCredential">>;

function manifest(shape: ManifestDraft): ProviderManifest {
  return Object.freeze({
    ...shape,
    baseUrlCredential: shape.baseUrlCredential ?? null,
    locationCredential: shape.locationCredential ?? null,
    requiredCredentials: Object.freeze([...shape.requiredCredentials]),
    optionalCredentials: Object.freeze([...shape.optionalCredentials]),
    models: Object.freeze([...shape.models]),
    modelList: shape.modelList === null ? null : Object.freeze({ ...shape.modelList }),
  });
}

export const DEFAULT_PROVIDER_CATALOGUE: ProviderCatalogue = Object.freeze([
  manifest({
    id: provider("anthropic"),
    displayName: "Anthropic Claude",
    description: "Claude Sonnet / Opus / Haiku via Anthropic's API.",
    requiredCredentials: credentials("ANTHROPIC_API_KEY"),
    optionalCredentials: credentials(),
    models: [
      "anthropic:claude-sonnet-4-6",
      "anthropic:claude-opus-4-6",
      "anthropic:claude-haiku-4-5-20251001",
    ],
    dialect: "anthropic-native",
    baseUrl: null,
    probeModel: "claude-haiku-4-5-20251001",
    modelList: {
      url: "https://api.anthropic.com/v1/models?limit=1000",
      auth: "header-key",
      shape: "anthropic",
    },
  }),
  manifest({
    id: provider("openai"),
    displayName: "OpenAI",
    description: "GPT-4.1, GPT-4o and OpenAI's hosted models via OpenAI's API.",
    requiredCredentials: credentials("OPENAI_API_KEY"),
    optionalCredentials: credentials("OPENAI_BASE_URL"),
    models: ["openai:gpt-4.1", "openai:gpt-4.1-mini", "openai:gpt-4o", "openai:gpt-4o-mini"],
    dialect: "openai-native",
    baseUrl: null,
    baseUrlCredential: credential("OPENAI_BASE_URL"),
    probeModel: "gpt-4.1-mini",
    modelList: { url: "https://api.openai.com/v1/models", auth: "bearer", shape: "openai" },
  }),
  manifest({
    id: provider("google"),
    displayName: "Google AI (Gemini)",
    description: "Gemini 2.5 Pro / Flash via Google AI's generative API.",
    requiredCredentials: credentials("GOOGLE_GENERATIVE_AI_API_KEY"),
    optionalCredentials: credentials(),
    models: ["google:gemini-2.5-pro", "google:gemini-2.5-flash"],
    dialect: "google-generative",
    baseUrl: null,
    probeModel: "gemini-2.0-flash",
    modelList: {
      url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
      auth: "query-key",
      shape: "google",
    },
  }),
  manifest({
    id: provider("google-vertex"),
    displayName: "Google Vertex AI (GCP)",
    description:
      "Gemini + GLM models on Vertex AI. The credential is the full contents of a GCP " +
      "service-account JSON file, stored as GOOGLE_VERTEX_CREDENTIALS.",
    requiredCredentials: credentials("GOOGLE_VERTEX_CREDENTIALS"),
    optionalCredentials: credentials("GOOGLE_VERTEX_LOCATION"),
    models: [
      "google-vertex:gemini-2.5-pro",
      "google-vertex:gemini-2.5-flash",
      "google-vertex:gemini-3-flash-preview",
      "google-vertex:zai-org/glm-5-maas",
    ],
    dialect: "google-vertex",
    baseUrl: null,
    locationCredential: credential("GOOGLE_VERTEX_LOCATION"),
    probeModel: "gemini-2.5-flash",
    // Vertex addresses each publisher separately behind GCP OAuth, so the
    // one-key model-list pattern does not fit it. The curated list stands.
    modelList: null,
  }),
  manifest({
    id: provider("groq"),
    displayName: "Groq",
    description: "Llama, Qwen, DeepSeek, Mixtral on Groq's LPU at 600+ tok/s. OpenAI-compatible API.",
    requiredCredentials: credentials("GROQ_API_KEY"),
    optionalCredentials: credentials(),
    models: [
      "groq:llama-3.3-70b-versatile",
      "groq:llama-3.1-8b-instant",
      "groq:qwen-2.5-72b",
      "groq:deepseek-r1-distill-llama-70b",
      "groq:mixtral-8x7b-32768",
    ],
    dialect: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    probeModel: "llama-3.1-8b-instant",
    modelList: { url: "https://api.groq.com/openai/v1/models", auth: "bearer", shape: "groq" },
  }),
  manifest({
    id: provider("mistral"),
    displayName: "Mistral",
    description: "Mistral Large, Codestral, Pixtral, Ministral via Mistral's API. OpenAI-compatible.",
    requiredCredentials: credentials("MISTRAL_API_KEY"),
    optionalCredentials: credentials(),
    models: [
      "mistral:mistral-large-latest",
      "mistral:mistral-small-latest",
      "mistral:codestral-latest",
      "mistral:pixtral-large-latest",
      "mistral:ministral-8b-latest",
    ],
    dialect: "openai-compatible",
    baseUrl: "https://api.mistral.ai/v1",
    probeModel: "ministral-8b-latest",
    modelList: { url: "https://api.mistral.ai/v1/models", auth: "bearer", shape: "mistral" },
  }),
  manifest({
    id: provider("xai"),
    displayName: "xAI (Grok)",
    description: "Grok-2 / Grok-2 Vision / Grok-Beta via xAI's API. OpenAI-compatible.",
    requiredCredentials: credentials("XAI_API_KEY"),
    optionalCredentials: credentials(),
    models: ["xai:grok-2-latest", "xai:grok-2-vision-latest", "xai:grok-beta"],
    dialect: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
    probeModel: "grok-2-latest",
    modelList: { url: "https://api.x.ai/v1/models", auth: "bearer", shape: "openai" },
  }),
  manifest({
    id: provider("deepseek"),
    displayName: "DeepSeek",
    description: "DeepSeek-V3 + R1 reasoning via the DeepSeek platform. OpenAI-compatible.",
    requiredCredentials: credentials("DEEPSEEK_API_KEY"),
    optionalCredentials: credentials(),
    models: ["deepseek:deepseek-chat", "deepseek:deepseek-reasoner"],
    dialect: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    probeModel: "deepseek-chat",
    // The model list hangs off the API root here, with no `/v1` segment;
    // inference still goes to `/v1/chat/completions` under `baseUrl`.
    modelList: { url: "https://api.deepseek.com/models", auth: "bearer", shape: "openai" },
  }),
  manifest({
    id: provider("cerebras"),
    displayName: "Cerebras",
    description: "Llama 3.3 70B / 3.1 8B at 2200+ tok/s on Cerebras inference. OpenAI-compatible.",
    requiredCredentials: credentials("CEREBRAS_API_KEY"),
    optionalCredentials: credentials(),
    models: ["cerebras:llama-3.3-70b", "cerebras:llama-3.1-8b", "cerebras:llama3.1-70b"],
    dialect: "openai-compatible",
    baseUrl: "https://api.cerebras.ai/v1",
    probeModel: "llama-3.1-8b",
    modelList: { url: "https://api.cerebras.ai/v1/models", auth: "bearer", shape: "openai" },
  }),
  manifest({
    id: provider("perplexity"),
    displayName: "Perplexity",
    description: "Sonar online-search models with built-in retrieval. OpenAI-compatible.",
    requiredCredentials: credentials("PERPLEXITY_API_KEY"),
    optionalCredentials: credentials(),
    models: [
      "perplexity:sonar",
      "perplexity:sonar-pro",
      "perplexity:sonar-reasoning",
      "perplexity:sonar-reasoning-pro",
      "perplexity:sonar-deep-research",
    ],
    dialect: "openai-compatible",
    baseUrl: "https://api.perplexity.ai",
    probeModel: "sonar",
    // No public model list is published. The curated list stands.
    modelList: null,
  }),
  manifest({
    id: provider("together"),
    displayName: "Together AI",
    description: "Llama, Qwen, Mixtral, DeepSeek-R1, gpt-oss + 200 OSS models. OpenAI-compatible.",
    requiredCredentials: credentials("TOGETHER_API_KEY"),
    optionalCredentials: credentials(),
    models: [
      "together:meta-llama/Llama-3.3-70B-Instruct-Turbo",
      "together:meta-llama/Llama-3.1-8B-Instruct-Turbo",
      "together:Qwen/Qwen2.5-72B-Instruct-Turbo",
      "together:deepseek-ai/DeepSeek-R1",
      "together:openai/gpt-oss-120b",
      "together:openai/gpt-oss-20b",
    ],
    dialect: "openai-compatible",
    baseUrl: "https://api.together.xyz/v1",
    probeModel: "meta-llama/Llama-3.1-8B-Instruct-Turbo",
    modelList: { url: "https://api.together.xyz/v1/models", auth: "bearer", shape: "together" },
  }),
  manifest({
    id: provider("fireworks"),
    displayName: "Fireworks AI",
    description: "Llama, DeepSeek, Qwen, Mixtral on Fireworks' fast inference. OpenAI-compatible.",
    requiredCredentials: credentials("FIREWORKS_API_KEY"),
    optionalCredentials: credentials(),
    models: [
      "fireworks:accounts/fireworks/models/llama-v3p3-70b-instruct",
      "fireworks:accounts/fireworks/models/deepseek-v3",
      "fireworks:accounts/fireworks/models/deepseek-r1",
      "fireworks:accounts/fireworks/models/qwen2p5-72b-instruct",
    ],
    dialect: "openai-compatible",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    probeModel: "accounts/fireworks/models/llama-v3p1-8b-instruct",
    modelList: {
      url: "https://api.fireworks.ai/inference/v1/models",
      auth: "bearer",
      shape: "fireworks",
    },
  }),
  manifest({
    id: provider("sakana"),
    displayName: "Sakana AI (Fugu)",
    description:
      "Sakana Fugu — one model that orchestrates a swappable pool of frontier LLMs. " +
      "`fugu` for everyday work, `fugu-ultra` for hard multi-step problems. It orchestrates " +
      "server-side before it streams, so first-token latency runs from seconds to minutes; " +
      "give it a generous per-turn budget. Not available in the EU/EEA, UK, or Switzerland.",
    requiredCredentials: credentials("SAKANA_API_KEY"),
    optionalCredentials: credentials(),
    models: ["sakana:fugu", "sakana:fugu-ultra"],
    dialect: "openai-compatible",
    baseUrl: "https://api.sakana.ai/v1",
    probeModel: "fugu",
    modelList: { url: "https://api.sakana.ai/v1/models", auth: "bearer", shape: "openai" },
  }),
  manifest({
    id: provider("azure"),
    displayName: "Azure OpenAI",
    description:
      "Azure-hosted OpenAI models. AZURE_OPENAI_BASE_URL must be the full per-resource " +
      "endpoint URL; the model string after `azure:` is appended verbatim when it contains " +
      "a slash and is otherwise treated as the target's name.",
    requiredCredentials: credentials("AZURE_OPENAI_API_KEY", "AZURE_OPENAI_BASE_URL"),
    optionalCredentials: credentials("AZURE_OPENAI_API_VERSION"),
    models: ["azure:gpt-4o", "azure:gpt-4o-mini", "azure:gpt-4.1"],
    dialect: "azure-openai",
    // Per-resource, so it arrives as an environment credential rather than a
    // catalogue constant. `route.ts` refuses to build a plan without it.
    baseUrl: null,
    baseUrlCredential: credential("AZURE_OPENAI_BASE_URL"),
    probeModel: "gpt-4o-mini",
    // The Azure listing is per-resource and enumerates targets rather than
    // models, so the curated list stands.
    modelList: null,
  }),
]);
