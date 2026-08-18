import { Injectable, Inject } from "@nestjs/common";
import { REDIS_TOKEN } from "../shared/redis.provider";
import type Redis from "ioredis";
import type { RequestScope } from "./scope.guard";
import { PROVIDER_MANIFESTS, getManifest, type ProviderManifest } from "../providers/manifests";
import { ScopedEnvService } from "../providers/scoped-env.service";
import { ProviderRuntimeError } from "../providers/provider-runtime.error";

export type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

export interface ProviderHealthResult {
  provider: string;
  status: "healthy" | "invalid_key" | "error" | "not_configured";
  latencyMs: number;
  error?: string;
  model?: string;
  /** Which required same-Environment credential references are available. */
  requiredEnv: Array<{ name: string; set: boolean }>;
}

type ProviderProbeErrorCode =
  | "provider_auth_failed"
  | "provider_request_failed"
  | "probe_configuration_error";

class ProviderProbeError extends Error {
  constructor(readonly code: ProviderProbeErrorCode) {
    super(code);
    this.name = "ProviderProbeError";
  }
}

function rejectUpstreamStatus(status: number): never {
  throw new ProviderProbeError(
    status === 401 || status === 403 ? "provider_auth_failed" : "provider_request_failed",
  );
}

function scopeKey(scope: ScopeTuple): string {
  return `${scope.organizationId}:${scope.projectId}:${scope.environmentId}`;
}

/**
 * ProviderHealthService — probes each LLM provider's API with a 1-token call
 * to verify the configured env var actually works.
 *
 * Credentials resolve only through Environment-owned ProviderKey/Credential
 * rows. Deployment environment variables are not a tenant credential source.
 *
 * Results cached in Redis for 5 minutes (1 minute on error).
 */
@Injectable()
export class ProviderHealthService {
  constructor(
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
    private readonly scopedEnv: ScopedEnvService,
  ) {}

  private async resolveEnv(
    scope: ScopeTuple,
    name: string,
    provider: string,
  ): Promise<string | undefined> {
    return this.scopedEnv.getForProvider(scope, name, provider);
  }

  private resolveProviderConfiguration(
    scope: ScopeTuple,
    name: string,
    provider: string,
  ): Promise<string | undefined> {
    return this.scopedEnv.getProviderConfiguration(scope, name, provider);
  }

  private resolveApiKey(scope: ScopeTuple, manifest: ProviderManifest): Promise<string | undefined> {
    return this.scopedEnv.getProviderApiKey(
      scope,
      manifest.id,
      manifest.requiredEnv[0] ?? "",
      null,
    );
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
        error: "unknown_provider",
      };
    }

    const requiredEnv = await Promise.all(manifest.requiredEnv.map(async (name, index) => ({
      name,
      set: index === 0
        ? await this.scopedEnv.hasProviderCredential(scope, manifest.id)
        : !!(await this.resolveEnv(scope, name, manifest.id)),
    })));
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
      if (error instanceof ProviderRuntimeError) throw error;
      const code = error instanceof ProviderProbeError ? error.code : "provider_request_failed";
      const result: ProviderHealthResult = {
        provider: providerId,
        status: code === "provider_auth_failed" ? "invalid_key" : "error",
        latencyMs: Date.now() - start,
        error: code,
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
    const apiKey = async (): Promise<string> => {
      const key = await this.resolveApiKey(scope, manifest);
      if (!key) throw new ProviderProbeError("probe_configuration_error");
      return key;
    };
    switch (manifest.healthCheck.kind) {
      case "anthropic": {
        const key = await apiKey();
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
          rejectUpstreamStatus(res.status);
        }
        return { model: manifest.healthCheck.probeModel };
      }

      case "openai": {
        const key = await apiKey();
        const base =
          (await this.resolveProviderConfiguration(scope, "OPENAI_BASE_URL", manifest.id)) ||
          "https://api.openai.com";
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
          rejectUpstreamStatus(res.status);
        }
        return { model: manifest.healthCheck.probeModel };
      }

      case "google": {
        const key = await apiKey();
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
          rejectUpstreamStatus(res.status);
        }
        return { model: manifest.healthCheck.probeModel };
      }

      case "vertex-file": {
        const serialized = await apiKey();
        let content: { project_id?: string };
        try {
          content = JSON.parse(serialized);
        } catch {
          throw new ProviderProbeError("probe_configuration_error");
        }
        if (!content.project_id) {
          throw new ProviderProbeError("probe_configuration_error");
        }
        return { model: `${manifest.healthCheck.probeModel} (project: ${content.project_id})` };
      }

      case "openai-compat": {
        // One probe for every OpenAI-compatible upstream (Groq, Mistral,
        // xAI, DeepSeek, Cerebras, Perplexity, Together, Fireworks, Azure).
        // The manifest carries the `baseURL`; for Azure the deployment URL
        // is supplied via AZURE_OPENAI_BASE_URL since it's per-resource.
        const key = await apiKey();
        let baseURL = manifest.healthCheck.baseURL;
        if (manifest.id === "azure") {
          baseURL =
            (await this.resolveProviderConfiguration(
              scope,
              "AZURE_OPENAI_BASE_URL",
              manifest.id,
            )) || baseURL;
        }
        if (!baseURL) {
          throw new ProviderProbeError("probe_configuration_error");
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
          rejectUpstreamStatus(res.status);
        }
        return { model: manifest.healthCheck.probeModel };
      }
    }
  }
}
