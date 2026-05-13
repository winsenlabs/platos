import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "crypto";
import type { ProviderManifest, ModelsEndpoint } from "./manifests";
import { ScopedEnvService, type ScopeTuple } from "./scoped-env.service";

/**
 * Per-provider live model discovery.
 *
 * For every provider whose manifest declares `modelsEndpoint`, this service
 * calls the upstream `/v1/models` (or equivalent) endpoint with the scoped
 * API key, parses the response to a flat array of `<providerId>:<modelId>`
 * strings, and caches in memory for `CATALOG_TTL_MS`.
 *
 * The caller (`ProviderRegistryService`) unions the result with the
 * manifest's curated list so:
 *   - Curated models always show up (even if upstream is down)
 *   - Live additions (e.g. Together adding `openai/gpt-oss-120b`) surface
 *     automatically the next time the cache TTL elapses
 *   - Providers WITHOUT a `modelsEndpoint` (Perplexity, Azure, Vertex)
 *     fall through to the static list with no extra HTTP calls
 *
 * Failure mode: any fetch / parse error logs a warning and returns the empty
 * array, so the caller falls back cleanly to the static manifest. Auth-style
 * errors (401/403) are particularly common during key rotation — we don't
 * want them to break the picker.
 *
 * Cache key: `<providerId>:<sha256(apiKey)>`. We never put the plaintext key
 * in the cache key. Two scopes that share an API key share the cache hit.
 */
@Injectable()
export class ModelCatalogService {
  private readonly logger = new Logger(ModelCatalogService.name);
  /** 10-minute TTL. Live model lists change rarely; this is a sane trade-off
   * between freshness and not hammering the upstream on every UI tick. */
  private static readonly CATALOG_TTL_MS = 10 * 60 * 1000;
  /** 5s per-provider fetch budget — picker is on the loader's critical path. */
  private static readonly FETCH_TIMEOUT_MS = 5000;

  private cache = new Map<string, { models: string[]; expiresAt: number }>();
  /** In-flight de-dup so concurrent loaders don't fan out duplicate fetches. */
  private inflight = new Map<string, Promise<string[]>>();

  constructor(private readonly scopedEnv: ScopedEnvService) {}

  /**
   * Returns the live model list for a provider in this scope, prefixed with
   * the provider id (`<id>:<model>`). Returns `[]` when:
   *   - the manifest has no `modelsEndpoint`
   *   - no API key is configured for the scope
   *   - the upstream fetch / parse failed
   *
   * Caller is expected to union this with `manifest.models` and de-dup.
   */
  async listFor(scope: ScopeTuple, manifest: ProviderManifest): Promise<string[]> {
    if (!manifest.modelsEndpoint) return [];

    const legacyEnv = manifest.requiredEnv[0];
    const apiKey = await this.scopedEnv.getProviderApiKey(scope, manifest.id, legacyEnv);
    if (!apiKey) return [];

    const cacheKey = `${manifest.id}:${sha256(apiKey)}`;
    const now = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.models;

    const existing = this.inflight.get(cacheKey);
    if (existing) return existing;

    const promise = this.fetchAndCache(manifest, apiKey, cacheKey);
    this.inflight.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(cacheKey);
    }
  }

  /**
   * Drop every cached entry for a provider. Called when a user adds / rotates
   * a provider key so the picker reflects the new credential's reach
   * immediately, not after the next 10-minute tick.
   */
  invalidate(providerId: string): void {
    const prefix = `${providerId}:`;
    for (const k of this.cache.keys()) {
      if (k.startsWith(prefix)) this.cache.delete(k);
    }
  }

  private async fetchAndCache(
    manifest: ProviderManifest,
    apiKey: string,
    cacheKey: string,
  ): Promise<string[]> {
    try {
      const ids = await this.fetchUpstream(manifest.modelsEndpoint!, apiKey);
      const prefixed = ids.map((id) => `${manifest.id}:${id}`);
      this.cache.set(cacheKey, {
        models: prefixed,
        expiresAt: Date.now() + ModelCatalogService.CATALOG_TTL_MS,
      });
      return prefixed;
    } catch (err: any) {
      this.logger.warn(
        `model-catalog fetch failed for ${manifest.id}: ${err?.message ?? String(err)}`,
      );
      // Cache the negative result briefly so we don't hammer a broken
      // upstream on every loader call. 30s is short enough that a fixed
      // upstream recovers quickly.
      this.cache.set(cacheKey, {
        models: [],
        expiresAt: Date.now() + 30_000,
      });
      return [];
    }
  }

  private async fetchUpstream(endpoint: ModelsEndpoint, apiKey: string): Promise<string[]> {
    const url = endpoint.auth === "google-query"
      ? `${endpoint.url}${endpoint.url.includes("?") ? "&" : "?"}key=${encodeURIComponent(apiKey)}`
      : endpoint.url;

    const headers: Record<string, string> = { Accept: "application/json" };
    if (endpoint.auth === "bearer") {
      headers.Authorization = `Bearer ${apiKey}`;
    } else if (endpoint.auth === "anthropic") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    }

    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(ModelCatalogService.FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${res.status} ${res.statusText}: ${body.slice(0, 120)}`);
    }
    const json = await res.json();
    return parseModelsResponse(endpoint.shape, json);
  }
}

function parseModelsResponse(shape: ModelsEndpoint["shape"], json: any): string[] {
  switch (shape) {
    case "openai": {
      // { object: "list", data: [{ id, object, owned_by }] }
      const data = Array.isArray(json?.data) ? json.data : [];
      return data
        .map((m: any) => (typeof m?.id === "string" ? m.id : null))
        .filter((id: string | null): id is string => !!id && !isNonChatOpenAIModel(id));
    }

    case "together": {
      // Bare JSON array. Each entry has { id, type, ... }.
      const arr = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
      return arr
        .filter((m: any) => {
          if (typeof m?.id !== "string") return false;
          // Together's `type` is one of: chat | language | code | embedding |
          // image | moderation | rerank. Keep chat + language + code; gpt-oss
          // ships as "chat" today but Together has historically tagged some
          // OSS models as "language" — accept both so we don't accidentally
          // filter out a hosted model.
          const t = m.type;
          if (!t) return true; // be permissive when type is missing
          return t === "chat" || t === "language" || t === "code";
        })
        .map((m: any) => m.id as string);
    }

    case "anthropic": {
      // { data: [{ id, display_name, type: "model" }], has_more, first_id, last_id }
      const data = Array.isArray(json?.data) ? json.data : [];
      return data
        .map((m: any) => (typeof m?.id === "string" ? m.id : null))
        .filter((id: string | null): id is string => !!id);
    }

    case "google": {
      // { models: [{ name: "models/gemini-2.5-pro", supportedGenerationMethods: [...] }] }
      const models = Array.isArray(json?.models) ? json.models : [];
      return models
        .filter((m: any) => {
          const methods = Array.isArray(m?.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
          // Keep anything that supports `generateContent` (chat-style).
          return methods.includes("generateContent");
        })
        .map((m: any) => {
          const name = typeof m?.name === "string" ? m.name : "";
          return name.startsWith("models/") ? name.slice("models/".length) : name;
        })
        .filter((id: string) => !!id);
    }

    case "fireworks": {
      // { data: [{ id, supports_chat, kind }] }
      const data = Array.isArray(json?.data) ? json.data : [];
      return data
        .filter((m: any) => typeof m?.id === "string" && m.supports_chat !== false)
        .map((m: any) => m.id as string);
    }

    case "mistral": {
      // { data: [{ id, capabilities: { completion_chat }, deprecation: string | null }] }
      const data = Array.isArray(json?.data) ? json.data : [];
      return data
        .filter((m: any) => {
          if (typeof m?.id !== "string") return false;
          if (m.deprecation) return false;
          const caps = m.capabilities;
          // Default to true when the field is missing (older accounts).
          return caps ? caps.completion_chat !== false : true;
        })
        .map((m: any) => m.id as string);
    }

    case "groq": {
      // { object: "list", data: [{ id, active, ... }] }
      const data = Array.isArray(json?.data) ? json.data : [];
      return data
        .filter((m: any) => typeof m?.id === "string" && m.active !== false)
        .map((m: any) => m.id as string);
    }

    default:
      return [];
  }
}

/**
 * Filter OpenAI's flat /v1/models response down to chat-capable models.
 * OpenAI doesn't expose a type field — we filter by id prefix, dropping the
 * non-chat families (embeddings, TTS, transcription, image, moderation).
 */
function isNonChatOpenAIModel(id: string): boolean {
  return (
    id.startsWith("text-embedding-") ||
    id.startsWith("text-similarity-") ||
    id.startsWith("text-search-") ||
    id.startsWith("dall-e") ||
    id.startsWith("whisper") ||
    id.startsWith("tts-") ||
    id.startsWith("babbage") ||
    id.startsWith("davinci") ||
    id.startsWith("omni-moderation") ||
    id.startsWith("text-moderation")
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
