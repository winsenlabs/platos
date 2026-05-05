import { Injectable, Logger, Optional } from "@nestjs/common";
import * as crypto from "node:crypto";
import { ScopedEnvService } from "../providers/scoped-env.service";
import type { RequestScope } from "../auth/scope.guard";
import { CostService } from "../monitoring/cost.service";
import { env } from "../shared/env";

// EOBD.32 — price table for embedding models (USD / 1M tokens).
// Values as of 2025-04; update when providers adjust pricing.
const EMBEDDING_RATE_CENTS_PER_MTOK: Record<string, number> = {
  // OpenAI
  "text-embedding-3-small": 2,      // $0.02
  "text-embedding-3-large": 13,     // $0.13
  "text-embedding-ada-002": 10,     // $0.10
  // Voyage (Anthropic's recommended embedding provider)
  "voyage-large-2": 12,             // $0.12
  "voyage-large-2-instruct": 12,    // $0.12
  "voyage-3": 6,                    // $0.06
  "voyage-3-large": 18,             // $0.18
  "voyage-code-3": 18,              // $0.18
};

type EmbeddingProvider = "openai" | "voyage";

/**
 * Default model per provider. Must return 1536-dim vectors to fit the
 * existing `PlatosMemory.embedding vector(1536)` column without a schema
 * migration. Voyage's `voyage-large-2` is 1536-native; its newer
 * `voyage-3` / `voyage-3-large` families default to 1024 (with an
 * `output_dimension` override) so we avoid those as defaults.
 */
const DEFAULT_MODEL: Record<EmbeddingProvider, string> = {
  openai: "text-embedding-3-small",
  voyage: "voyage-large-2",
};

/**
 * Theme L.4 — embedding pipeline.
 *
 * Computes 1536-dim vectors for memory content via the OpenAI embeddings
 * API. Default model is `text-embedding-3-small`; override with the
 * `PLATOS_EMBEDDING_MODEL` env var. The OpenAI API key is resolved
 * through the same `ScopedEnvService` the LLM providers use — first the
 * per-scope SecretStore (what the webapp writes through the providers
 * UI), then `process.env.OPENAI_API_KEY` as a last-resort fallback.
 *
 * Requests are deduped via an LRU cache keyed on `sha256(model + text)`.
 * The model is part of the cache key so switching
 * `PLATOS_EMBEDDING_MODEL` across a running cluster never serves a
 * stale-dimension vector.
 *
 * Batch embedding is used by bulk-insert paths (Theme O extractor).
 * Single-shot `embed()` is what `MemoryService.add()` calls on every
 * `remember` meta-tool invocation.
 */
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly provider: EmbeddingProvider;
  private readonly model: string;
  /// pgvector column is fixed at `vector(1536)` — this constant must
  /// match the schema declaration.
  public static readonly DIMENSION = 1536;
  private static readonly MAX_BATCH = 100;
  private static readonly CACHE_CAP = 512;

  // Simple LRU: Map preserves insertion order; touching a key reinserts
  // it at the tail so eviction removes the coldest entry. Cache key
  // includes the provider + model so switching providers at runtime
  // never serves a stale vector.
  private cache = new Map<string, number[]>();

  constructor(
    @Optional() private readonly scopedEnv?: ScopedEnvService,
    @Optional() private readonly costService?: CostService,
  ) {
    this.provider = (env.PLATOS_EMBEDDING_PROVIDER ?? "voyage") as EmbeddingProvider;
    this.model = env.PLATOS_EMBEDDING_MODEL || DEFAULT_MODEL[this.provider];

    // Boot-time loud warning. Without a provider key, the hourly memory
    // extraction cron, every `remember` call, and every RAG retrieval
    // throw at write time — and the failure is per-thread inside the
    // sweep, so it's invisible unless the operator greps for it. Surface
    // it ONCE at boot so they see it in `docker compose up` output.
    const envKey =
      this.provider === "voyage" ? env.VOYAGE_API_KEY : env.OPENAI_API_KEY;
    if (!envKey) {
      this.logger.warn(
        `[memory] No ${this.provider === "voyage" ? "VOYAGE_API_KEY" : "OPENAI_API_KEY"} set on the agent container env. ` +
          `Memory writes (incl. the hourly extraction cron) will throw until you ` +
          `either set the key in /opt/platos/.env or link it via the dashboard ` +
          `Providers UI per-scope. See https://platos.dev/docs/memory#setup`,
      );
    }
  }

  private cacheKey(text: string): string {
    const h = crypto.createHash("sha256");
    h.update(this.provider);
    h.update("\0");
    h.update(this.model);
    h.update("\0");
    h.update(text);
    return h.digest("hex");
  }

  private cacheGet(key: string): number[] | undefined {
    const hit = this.cache.get(key);
    if (!hit) return undefined;
    // Touch: refresh LRU position.
    this.cache.delete(key);
    this.cache.set(key, hit);
    return hit;
  }

  private cacheSet(key: string, value: number[]): void {
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, value);
    while (this.cache.size > EmbeddingService.CACHE_CAP) {
      // Map iterator starts at oldest — delete one to keep the cap.
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async resolveApiKey(
    scope?: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">,
  ): Promise<string | undefined> {
    const keyName = this.provider === "voyage" ? "VOYAGE_API_KEY" : "OPENAI_API_KEY";
    if (scope && this.scopedEnv) {
      const fromStore = await this.scopedEnv.get(scope, keyName);
      if (fromStore) return fromStore;
    }
    return this.provider === "voyage" ? env.VOYAGE_API_KEY : env.OPENAI_API_KEY;
  }

  private missingKeyError(): Error {
    const keyName = this.provider === "voyage" ? "VOYAGE_API_KEY" : "OPENAI_API_KEY";
    return new Error(
      `${keyName} not configured — link it via the Providers UI or set it in the agent container env (embedding provider: ${this.provider})`,
    );
  }

  /**
   * Single-shot embed. Returns a 1536-dim float vector.
   *
   * `scope` is optional so callers that don't have a scope (e.g. dev
   * scripts) still work via `process.env.OPENAI_API_KEY`. In request
   * paths (meta-tools, REST endpoints) always pass the scope so
   * per-scope API keys resolve correctly.
   */
  async embed(
    text: string,
    scope?: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">,
  ): Promise<number[]> {
    const normalized = text.trim();
    if (!normalized) {
      throw new Error("EmbeddingService.embed: empty text");
    }
    const key = this.cacheKey(normalized);
    const cached = this.cacheGet(key);
    if (cached) return cached;

    const apiKey = await this.resolveApiKey(scope);
    if (!apiKey) throw this.missingKeyError();

    // EOBD.32 (Wave 11b fix) — pass scope as an explicit parameter to
    // the provider-specific call instead of stashing on `this`. The
    // service is a Nest singleton; two concurrent callers from different
    // scopes would have raced over `this.currentScope` and mis-attributed
    // cost cross-tenant.
    const vector = await this.callProvider([normalized], apiKey, scope);
    const out = vector[0];
    if (!out || out.length !== EmbeddingService.DIMENSION) {
      throw new Error(
        `Embedding provider returned unexpected dimension ${out?.length ?? 0}, expected ${EmbeddingService.DIMENSION}`,
      );
    }
    this.cacheSet(key, out);
    return out;
  }

  /**
   * Batch embed. Splits `texts` into chunks of up to 100 (the OpenAI
   * API limit) and concatenates the results. Cached entries are
   * returned immediately without a network round-trip.
   */
  async embedBatch(
    texts: string[],
    scope?: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">,
  ): Promise<number[][]> {
    if (texts.length === 0) return [];
    const normalized = texts.map((t) => t.trim());
    const apiKey = await this.resolveApiKey(scope);
    if (!apiKey) throw this.missingKeyError();

    const results: (number[] | undefined)[] = new Array(normalized.length);
    const missingIdx: number[] = [];
    const missingText: string[] = [];
    for (let i = 0; i < normalized.length; i++) {
      const text = normalized[i];
      if (!text) {
        throw new Error(`EmbeddingService.embedBatch: empty text at index ${i}`);
      }
      const cached = this.cacheGet(this.cacheKey(text));
      if (cached) {
        results[i] = cached;
      } else {
        missingIdx.push(i);
        missingText.push(text);
      }
    }

    // EOBD.32 (Wave 11b fix) — scope threaded as a positional arg, not
    // stashed on `this`. Required for multi-tenant correctness on a
    // singleton service.
    for (let start = 0; start < missingText.length; start += EmbeddingService.MAX_BATCH) {
      const chunk = missingText.slice(start, start + EmbeddingService.MAX_BATCH);
      const vectors = await this.callProvider(chunk, apiKey, scope);
      for (let j = 0; j < chunk.length; j++) {
        const vec = vectors[j];
        const text = chunk[j];
        if (!vec || vec.length !== EmbeddingService.DIMENSION || !text) {
          throw new Error(
            `Embedding provider returned unexpected dimension ${vec?.length ?? 0}, expected ${EmbeddingService.DIMENSION}`,
          );
        }
        this.cacheSet(this.cacheKey(text), vec);
        results[missingIdx[start + j]!] = vec;
      }
    }

    return results as number[][];
  }

  private async callProvider(
    inputs: string[],
    apiKey: string,
    scope?: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">,
  ): Promise<number[][]> {
    if (this.provider === "voyage") {
      return this.callVoyage(inputs, apiKey, scope);
    }
    return this.callOpenAi(inputs, apiKey, scope);
  }

  private async callOpenAi(
    inputs: string[],
    apiKey: string,
    scope?: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">,
  ): Promise<number[][]> {
    const resp = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: inputs,
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(
        `OpenAI embeddings failed (${resp.status} ${resp.statusText}): ${body.slice(0, 400)}`,
      );
    }
    const json = (await resp.json()) as {
      data?: Array<{ embedding?: number[]; index?: number }>;
      usage?: { prompt_tokens?: number; total_tokens?: number };
    };
    if (!json.data || !Array.isArray(json.data)) {
      throw new Error("OpenAI embeddings response missing `data` array");
    }
    // EOBD.32 — record embedding cost in the central cost table so
    // dashboards don't undercount spend. Fire-and-forget so a
    // CostService hiccup doesn't fail the embedding.
    this.recordEmbeddingCost(json.usage?.total_tokens ?? json.usage?.prompt_tokens ?? 0, scope);
    // The API preserves input order but defensively sort by `index`
    // when it's present (some SDKs deliver out of order).
    const sorted = [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return sorted.map((d) => d.embedding || []);
  }

  /**
   * Voyage AI embeddings (https://docs.voyageai.com/reference/embeddings-api).
   *
   * Request shape mirrors OpenAI's (model + input array). Response shape
   * is identical enough that the post-processing (sort by index, extract
   * `embedding`) is the same. Usage object uses `total_tokens` only
   * (Voyage doesn't split prompt_tokens).
   *
   * Dimension: `voyage-large-2` returns 1536-dim vectors by default,
   * matching the existing pgvector column. Other Voyage models default
   * to 1024 and would require `output_dimension: 1536` — which currently
   * only `voyage-3` / `voyage-3-large` support. If you set
   * PLATOS_EMBEDDING_MODEL to one of those, we pass output_dimension
   * through so the column-size invariant holds.
   */
  private async callVoyage(
    inputs: string[],
    apiKey: string,
    scope?: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">,
  ): Promise<number[][]> {
    const body: Record<string, unknown> = {
      model: this.model,
      input: inputs,
    };
    // Voyage-3 family supports runtime dimension selection via
    // `output_dimension`. Older models (voyage-large-2) reject this
    // field, so gate it. Same DIMENSION we enforce in `embed()`.
    if (this.model.startsWith("voyage-3")) {
      body.output_dimension = EmbeddingService.DIMENSION;
    }
    const resp = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      throw new Error(
        `Voyage embeddings failed (${resp.status} ${resp.statusText}): ${errBody.slice(0, 400)}`,
      );
    }
    const json = (await resp.json()) as {
      data?: Array<{ embedding?: number[]; index?: number }>;
      usage?: { total_tokens?: number };
    };
    if (!json.data || !Array.isArray(json.data)) {
      throw new Error("Voyage embeddings response missing `data` array");
    }
    this.recordEmbeddingCost(json.usage?.total_tokens ?? 0, scope);
    const sorted = [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return sorted.map((d) => d.embedding || []);
  }

  private recordEmbeddingCost(
    totalTokens: number,
    scope?: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">,
  ): void {
    if (!this.costService || totalTokens <= 0 || !scope) return;
    const rate = EMBEDDING_RATE_CENTS_PER_MTOK[this.model];
    // Non-OpenAI embedding models (Cohere/Voyage/Mistral) silently
    // bypass until their rates are added to EMBEDDING_RATE_CENTS_PER_MTOK.
    // Known gap — tolerable for MVP since only OpenAI is wired today.
    if (!rate) return;
    const costCents = (totalTokens * rate) / 1_000_000;
    this.costService
      .recordAuxiliaryCost({
        scope,
        kind: "embedding",
        model: this.model,
        costCents,
        inputTokens: totalTokens,
      })
      .catch(() => undefined);
  }
}
