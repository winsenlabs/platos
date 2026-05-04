import { Injectable, Inject } from "@nestjs/common";
import { REDIS_TOKEN } from "../shared/redis.provider";
import type Redis from "ioredis";
import type { RequestScope } from "./scope.guard";
import { PROVIDER_MANIFESTS, getManifest, type ProviderManifest } from "../providers/manifests";
import { ScopedEnvService } from "../providers/scoped-env.service";

export type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

export interface ProviderHealthResult {
  provider: string;
  status: "healthy" | "invalid_key" | "error" | "not_configured";
  latencyMs: number;
  error?: string;
  model?: string;
  /** Which required env vars are currently set in the agent container. */
  requiredEnv: Array<{ name: string; set: boolean }>;
}

function scopeKey(scope: ScopeTuple): string {
  return `${scope.organizationId}:${scope.projectId}:${scope.environmentId}`;
}

/**
 * ProviderHealthService — probes each LLM provider's API with a 1-token call
 * to verify the configured env var actually works.
 *
 * Credentials are never stored by Platos. All provider API keys live in
 * trigger.dev's Environment Variables table and are injected into the
 * agent container's `process.env` by the deploy pipeline. This service
 * only reads `process.env` for the probe — there is no decrypt path.
 *
 * Results cached in Redis for 5 minutes (1 minute on error).
 */
@Injectable()
export class ProviderHealthService {
  constructor(
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
    private readonly scopedEnv: ScopedEnvService,
  ) {}

  /**
   * Resolve an env var with the SecretStore (per-scope, what the webapp
   * env-var UI writes) taking priority over the agent container's ambient
   * process.env.
   */
  private async resolveEnv(
    scope: ScopeTuple,
    name: string,
  ): Promise<string | undefined> {
    const fromStore = await this.scopedEnv.get(scope, name);
    if (fromStore) return fromStore;
    return process.env[name];
  }

  /** Test a single provider's configured env. */
  async testProvider(scope: ScopeTuple, providerId: string): Promise<ProviderHealthResult> {
    const manifest = getManifest(providerId);
    if (!manifest) {
      return {
        provider: providerId,
        status: "not_configured",
        latencyMs: 0,
        requiredEnv: [],
        error: `Unknown provider "${providerId}". See PROVIDER_MANIFESTS.`,
      };
    }

    const setMap = await this.scopedEnv.setMap(scope, manifest.requiredEnv);
    const requiredEnv = manifest.requiredEnv.map((name) => ({
      name,
      set: setMap[name] || !!process.env[name],
    }));
    const allSet = requiredEnv.every((e) => e.set);
    if (!allSet) {
      return {
        provider: providerId,
        status: "not_configured",
        latencyMs: 0,
        requiredEnv,
      };
    }

    const cacheKey = `provider-health:${scopeKey(scope)}:${providerId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as ProviderHealthResult;
      } catch {
        // fall through
      }
    }

    const start = Date.now();
    try {
      const probe = await this.probe(manifest, scope);
      const result: ProviderHealthResult = {
        provider: providerId,
        status: "healthy",
        latencyMs: Date.now() - start,
        model: probe.model,
        requiredEnv,
      };
      await this.redis.set(cacheKey, JSON.stringify(result), "EX", 300);
      return result;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      const isAuthError =
        msg.includes("401") ||
        msg.includes("403") ||
        /invalid[_\s-]?api[_\s-]?key/i.test(msg) ||
        msg.includes("Unauthorized");
      const result: ProviderHealthResult = {
        provider: providerId,
        status: isAuthError ? "invalid_key" : "error",
        latencyMs: Date.now() - start,
        error: msg.slice(0, 200),
        requiredEnv,
      };
      await this.redis.set(cacheKey, JSON.stringify(result), "EX", 60);
      return result;
    }
  }

  /** Test every manifest provider. */
  async testAllProviders(scope: ScopeTuple): Promise<ProviderHealthResult[]> {
    return Promise.all(PROVIDER_MANIFESTS.map((m) => this.testProvider(scope, m.id)));
  }

  /** Models exposed when a provider is healthy. */
  async getAvailableModels(scope: ScopeTuple): Promise<Array<{ provider: string; models: string[] }>> {
    const health = await this.testAllProviders(scope);
    return health
      .filter((h) => h.status === "healthy")
      .map((h) => ({
        provider: h.provider,
        models: getManifest(h.provider)?.models ?? [],
      }));
  }

  private async probe(manifest: ProviderManifest, scope: ScopeTuple): Promise<{ model: string }> {
    switch (manifest.healthCheck.kind) {
      case "anthropic": {
        const key = (await this.resolveEnv(scope, "ANTHROPIC_API_KEY"))!;
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: manifest.healthCheck.probeModel,
            max_tokens: 1,
            messages: [{ role: "user", content: "hi" }],
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 100)}`);
        }
        return { model: manifest.healthCheck.probeModel };
      }

      case "openai": {
        const key = (await this.resolveEnv(scope, "OPENAI_API_KEY"))!;
        const base = (await this.resolveEnv(scope, "OPENAI_BASE_URL")) || "https://api.openai.com";
        const res = await fetch(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            model: manifest.healthCheck.probeModel,
            max_tokens: 1,
            messages: [{ role: "user", content: "hi" }],
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`OpenAI API ${res.status}: ${body.slice(0, 100)}`);
        }
        return { model: manifest.healthCheck.probeModel };
      }

      case "google": {
        const key = (await this.resolveEnv(scope, "GOOGLE_GENERATIVE_AI_API_KEY"))!;
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${manifest.healthCheck.probeModel}:generateContent?key=${key}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: "hi" }] }],
              generationConfig: { maxOutputTokens: 1 },
            }),
            signal: AbortSignal.timeout(10000),
          },
        );
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`Google AI API ${res.status}: ${body.slice(0, 100)}`);
        }
        return { model: manifest.healthCheck.probeModel };
      }

      case "vertex-file": {
        const saPath = (await this.resolveEnv(scope, "GOOGLE_APPLICATION_CREDENTIALS"))!;
        const fs = require("fs");
        if (!fs.existsSync(saPath)) {
          throw new Error(`Service account file not found: ${saPath}`);
        }
        const content = JSON.parse(fs.readFileSync(saPath, "utf-8"));
        if (!content.project_id) {
          throw new Error("Invalid service account file: missing project_id");
        }
        return { model: `${manifest.healthCheck.probeModel} (project: ${content.project_id})` };
      }

      case "openai-compat": {
        // One probe for every OpenAI-compatible upstream (Groq, Mistral,
        // xAI, DeepSeek, Cerebras, Perplexity, Together, Fireworks, Azure).
        // The manifest carries the `baseURL`; for Azure the deployment URL
        // is supplied via AZURE_OPENAI_BASE_URL since it's per-resource.
        const keyEnv = manifest.requiredEnv[0];
        const key = (await this.resolveEnv(scope, keyEnv))!;
        let baseURL = manifest.healthCheck.baseURL;
        if (manifest.id === "azure") {
          baseURL = (await this.resolveEnv(scope, "AZURE_OPENAI_BASE_URL")) || baseURL;
        }
        if (!baseURL) {
          throw new Error(`${manifest.id}: healthCheck.baseURL missing`);
        }
        const url = `${baseURL.replace(/\/$/, "")}/chat/completions`;
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        };
        if (manifest.id === "azure") {
          headers["api-key"] = key;
        }
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: manifest.healthCheck.probeModel,
            max_tokens: 1,
            messages: [{ role: "user", content: "hi" }],
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`${manifest.displayName} ${res.status}: ${body.slice(0, 100)}`);
        }
        return { model: manifest.healthCheck.probeModel };
      }
    }
  }
}
