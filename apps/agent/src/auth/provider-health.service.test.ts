import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderHealthService } from "./provider-health.service";
import { ProviderRuntimeError } from "../providers/provider-runtime.error";

const scope = {
  organizationId: "org-a",
  projectId: "project-a",
  environmentId: "environment-a",
};

function redis() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
  };
}

describe("ProviderHealthService clean credential path", () => {
  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    vi.unstubAllGlobals();
  });

  it("does not report configured from a populated deployment environment variable", async () => {
    process.env.OPENAI_API_KEY = "ambient-key-must-not-count";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const service = new ProviderHealthService(
      redis() as any,
      {
        hasProviderCredential: vi.fn().mockResolvedValue(false),
        getForProvider: vi.fn().mockResolvedValue(undefined),
        getProviderConfiguration: vi.fn().mockResolvedValue(undefined),
      } as any,
    );

    const result = await service.testProvider(scope, "openai");

    expect(result).toMatchObject({
      provider: "openai",
      status: "not_configured",
      requiredEnv: [{ name: "OPENAI_API_KEY", set: false }],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns a stable auth error without reflecting the upstream response body", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: vi.fn().mockResolvedValue("upstream-body-with-tenant-secret"),
    });
    vi.stubGlobal("fetch", fetchSpy);
    const service = new ProviderHealthService(
      redis() as any,
      {
        hasProviderCredential: vi.fn().mockResolvedValue(true),
        getProviderApiKey: vi.fn().mockResolvedValue("tenant-provider-key"),
        getForProvider: vi.fn().mockResolvedValue(undefined),
        getProviderConfiguration: vi.fn().mockResolvedValue(undefined),
      } as any,
    );

    const result = await service.testProvider(scope, "openai");

    expect(result.status).toBe("invalid_key");
    expect(result.error).toBe("provider_auth_failed");
    expect(JSON.stringify(result)).not.toContain("upstream-body-with-tenant-secret");
    expect(JSON.stringify(result)).not.toContain("tenant-provider-key");
  });

  it("escapes a stable safe error and makes no request when configured base URL is unreadable", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const cryptoDetail = "AES-GCM authentication failed for sentinel-ciphertext";
    const service = new ProviderHealthService(
      redis() as any,
      {
        hasProviderCredential: vi.fn().mockResolvedValue(true),
        getProviderApiKey: vi.fn().mockResolvedValue("tenant-provider-key"),
        getForProvider: vi.fn().mockResolvedValue(undefined),
        getProviderConfiguration: vi.fn().mockRejectedValue(
          new ProviderRuntimeError("provider_configuration_unavailable"),
        ),
      } as any,
    );

    const error = await service
      .testProvider(scope, "openai")
      .catch((value) => value as ProviderRuntimeError);

    expect(error).toBeInstanceOf(ProviderRuntimeError);
    expect(error).toMatchObject({
      code: "provider_configuration_unavailable",
      message: "Provider configuration is unavailable for this environment.",
    });
    expect(JSON.stringify(error)).not.toContain(cryptoDetail);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
